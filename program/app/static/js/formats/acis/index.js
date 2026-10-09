// ACIS の形のデータ（DWG・DXF の 3D ソリッド・リージョン・ボディ・面）を、表示の形にする（DOM に依存しない）。
//   acisShape(バイト列) → { bodies: [{ faces（シーン JSON の面）, edges（稜線の折れ線） }], faces, kernel } | { error }
//     座標は図面の単位のまま（ACIS の単位 = 図面の単位。AutoCAD は SAB の単位の欄に 1 を書く）
//   acisMesh(形) → { positions（center を原点にした座標）, center, normals, index, faces, drawn }（3D 表示の三角形。描けない面は数だけ）
// 読みは Inventor（.ipt）と同じ（sab.js・brep.js）。形は同じバイト列なら 1 回だけ作る。

import { exportFace } from "../../model/scene.js";
import { faceGeometry } from "../../viewer/tessellate.js";
import { placeFace, Topology } from "./brep.js";
import { parseSab, SabError } from "./sab.js";

const shapes = new WeakMap();
const SAB = ["ACIS BinaryFile", "ASM BinaryFile"]; // ASM は "ASM BinaryFile4"（R2013+ の AcDs の節・Inventor）
const isSab = (bytes) => SAB.some((sig) => bytes.length > sig.length && [...sig].every((c, i) => bytes[i] === c.charCodeAt(0)));

/** ACIS のデータ → 形（同じバイト列なら作り直さない） */
export function acisShape(bytes) {
  if (!bytes?.length) return { error: "形のデータがありません" };
  if (!shapes.has(bytes)) shapes.set(bytes, build(bytes));
  return shapes.get(bytes);
}

function build(bytes) {
  if (!isSab(bytes)) return { error: "文字の形式（SAT）の 3D ソリッドは、まだ読めません" };
  let doc;
  try {
    doc = parseSab(bytes, 0);
  } catch (error) {
    if (error instanceof SabError) return { error: `形のデータを読めませんでした（${error.message}）` };
    throw error;
  }
  const topo = new Topology(doc);
  let faces = 0;
  const bodies = topo.bodies().map((body) => {
    const place = topo.placement(body); // ボディの置き方（AutoCAD は形を原点の近くに作り、置き方で移すことがある）
    const list = topo.faces(body).map((f) => placeFace(topo.face(f), place));
    faces += list.length;
    const edges = new Map(list.flatMap((f) => f.edges.map((e) => [e.index, e.points])));
    return { faces: list.map((f) => exportFace(f, 1)), edges: [...edges.values()] };
  });
  return { bodies, faces, kernel: doc.kernel };
}

/** 形 → 3D 表示の三角形（面ごとに分けて 1 つにまとめる）。drawn … 描けた面の数 */
export function acisMesh(shape) {
  const positions = [], normals = [], index = [];
  let drawn = 0;
  for (const body of shape.bodies ?? []) {
    for (const face of body.faces) {
      const g = faceGeometry(face);
      if (!g) continue;
      drawn += 1;
      const base = positions.length / 3;
      positions.push(...g.getAttribute("position").array);
      normals.push(...g.getAttribute("normal").array);
      for (const i of g.index.array) index.push(base + i);
      g.dispose();
    }
  }
  // 頂点は外形の中心を原点にして単精度にする（図面の座標は原点から遠いことが多い。center を置き方に足し戻す）
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) [lo[k], hi[k]] = [Math.min(lo[k], positions[i + k]), Math.max(hi[k], positions[i + k])];
  const center = positions.length ? lo.map((v, k) => (v + hi[k]) / 2) : [0, 0, 0];
  const local = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) local[i + k] = positions[i + k] - center[k];
  return { positions: local, center, normals: new Float32Array(normals), index: new Uint32Array(index), faces: shape.faces ?? 0, drawn };
}
