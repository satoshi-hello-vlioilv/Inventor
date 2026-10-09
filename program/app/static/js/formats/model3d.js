// 図面の中の 3D（drawing.models3d の 1 つ。3D の PDF の U3D・PRC と、DWG の 3D ソリッドの ACIS）を、3D 表示のメッシュと部品の一覧にする
// （DOM に依存しない）。
//   read3d(models3d の 1 つ) → { meshes, view（viewer.show({ meshes, view }) に渡す）, parts, warnings, units（"mm" か null = ファイルの単位） }
// 形式ごとの読み取りは、同じ形の結果を返す:
//   { meshes: [{ name, instance, positions, normals, index, groups: [{ start, count, color }], matrix（列優先の 4×4）, faces, vertices }],
//     views: [{ name, matrix（カメラ → 世界。列優先。−Z の向きを見て +Y が上）}], warnings, lengthUnit? }
// 最初の視点 view = { direction（注視点 → カメラの向き）, up（画面の上の向き）}。PDF の既定の視点（/3DV。行列か、3D の中の視点の名前）
// があればそれ、無ければ 3D の中の既定の視点（"DefaultView"、無ければ最初の視点）。どちらも無ければ null（表示の既定の向き）

import { apply, multiply, translation } from "../core/matrix.js";
import { acisMesh, acisShape } from "./acis/index.js";
import { U3dError, readU3d } from "./u3d/index.js";

export class Model3dError extends Error {}

// 形式ごとの読み取り（model3d の項目 → 上の同じ形の結果）
const READERS = { U3D: ({ bytes }) => readU3d(bytes), ACIS: readSolids };

/**
 * @param {{ format: string, bytes?: Uint8Array, view?: { c2w: number[] } | { node: string } | null }} model3d
 *   PDF の 3D（pdf/three-d.js の extract3d の結果。U3D）か、図面の 3D ソリッド（cad2d/solids3d.js。ACIS）
 */
export function read3d(model3d) {
  const { format, view = null } = model3d;
  const read = READERS[format];
  if (!read) throw new Model3dError(`${format} 形式の 3D は、まだ表示できません。`);
  let result;
  try {
    result = read(model3d);
  } catch (error) {
    if (error instanceof U3dError) throw new Model3dError(`${format} として読めませんでした（${error.message}）。`);
    throw error;
  }
  return { ...viewerMeshes(result), view: pdfView(view) ?? fileView(result.views ?? [], view?.node), warnings: result.warnings, units: result.lengthUnit ?? null };
}

const unit = (v) => {
  const n = Math.hypot(...v);
  return n > 0 && Number.isFinite(n) ? v.map((x) => x / n) : null;
};
const viewOf = (direction, up) => (direction && up ? { direction, up } : null);

/**
 * PDF の既定の視点の C2W（カメラ → 世界の 3×4。列は x・y・z の軸と位置）。軸の取り方は、C2W を書く実装の libharu
 * （HPDF_3DView_SetCamera）に従う: x = 左・y = 上・z = 見る向き（/3DV を持つ実物の PDF では、まだ確かめていない）
 */
function pdfView(view) {
  const c = view?.c2w;
  if (c?.length !== 12) return null;
  return viewOf(unit([-c[6], -c[7], -c[8]]), unit([c[3], c[4], c[5]]));
}

/** 3D の中の視点（カメラのノード。−Z の向きを見て +Y が上）。名前の指定（PDF の /U3DPath）が無ければ "DefaultView" */
function fileView(views, name = "DefaultView") {
  const m = (views.find((v) => v.name === name) ?? views.find((v) => v.name === "DefaultView") ?? views[0])?.matrix;
  return m ? viewOf(unit([m[8], m[9], m[10]]), unit([m[4], m[5], m[6]])) : null;
}

/**
 * 読んだ結果 → 3D 表示のメッシュ。部品（モデルのノードの置き方）ごとに 1 つ、陰影ごとに群（色はファイルの材質の色）。
 * parts: 部品の一覧（名前・面と頂点の数・群の id。id で 3D と欄の行を結ぶ）
 */
function viewerMeshes(result, prefix = "3d") {
  const parts = [];
  const meshes = result.meshes.map((m, i) => {
    const ids = m.groups.map((g, k) => `${prefix}:${i}:${k}`);
    parts.push({ name: m.instance ? `${m.name}（${m.instance + 1}）` : m.name, faces: m.faces, vertices: m.vertices, ids });
    return {
      positions: m.positions, normals: m.normals, index: m.index, matrix: m.matrix,
      groups: m.groups.map((g, k) => ({ start: g.start, count: g.count, id: ids[k], tone: "exact", color: g.color })),
    };
  });
  return { meshes, parts };
}

// ---- 図面の 3D ソリッド（ACIS）----------------------------------------------------------------------------------

const SOLID_LABEL = { "3DSOLID": "3D ソリッド", REGION: "リージョン", BODY: "ボディ", PLANESURFACE: "平面サーフェス", EXTRUDEDSURFACE: "押し出しサーフェス",
  LOFTEDSURFACE: "ロフトサーフェス", REVOLVEDSURFACE: "回転サーフェス", SWEPTSURFACE: "スイープサーフェス", NURBSURFACE: "NURBS サーフェス" };
// AutoCAD の「南東の等角図」（右手前の上から見る。Z が上）
const SOUTH_EAST = { direction: [1, -1, 1].map((v) => v / Math.sqrt(3)), up: [-1, 1, 2].map((v) => v / Math.sqrt(6)) };

/**
 * 図面の 3D ソリッド → 3D 表示のメッシュ。ソリッドごとに 1 つ（同じ形を何か所にも置くなら、三角形は 1 回だけ作って使い回す）。
 * 置き方は図面の座標（行優先）→ 列優先、図面の単位 → mm
 */
function readSolids({ solids, unit = 1 }) {
  const meshOf = new Map(), warnings = [];
  let faces = 0, drawn = 0, unreadable = 0;
  for (const s of solids) {
    if (!meshOf.has(s.acis)) {
      const shape = acisShape(s.acis);
      meshOf.set(s.acis, shape.error ? null : acisMesh(shape));
    }
  }
  // 建物の図面などは原点から遠い（数千 inch）。表示の単精度で面がちらつかないよう、形ごとの中心と全体の中心を原点へ寄せる
  const placed = solids.map((s) => ({ s, m: meshOf.get(s.acis) })).filter(({ m }) => m);
  const centers = placed.map(({ s, m }) => apply(s.matrix, m.center));
  const middle = centers.length ? [0, 1, 2].map((k) => (Math.min(...centers.map((c) => c[k])) + Math.max(...centers.map((c) => c[k]))) / 2) : [0, 0, 0];
  const meshes = [];
  solids.forEach((s, i) => {
    const m = meshOf.get(s.acis);
    if (!m) return void (unreadable += 1);
    faces += m.faces;
    drawn += m.drawn;
    const a = multiply(multiply(translation(middle.map((v) => -v)), s.matrix), translation(m.center));
    const k = unit;
    const matrix = [a[0] * k, a[4] * k, a[8] * k, 0, a[1] * k, a[5] * k, a[9] * k, 0, a[2] * k, a[6] * k, a[10] * k, 0, a[3] * k, a[7] * k, a[11] * k, 1];
    meshes.push({
      name: `${SOLID_LABEL[s.solid] ?? s.solid} ${i + 1}（画層 ${s.layer}）`, instance: 0,
      positions: m.positions, normals: m.normals, index: m.index, matrix,
      groups: [{ start: 0, count: m.index.length, color: s.color }], faces: m.index.length / 3, vertices: m.positions.length / 3,
    });
  });
  if (unreadable) warnings.push(`形を読めないソリッドが ${unreadable} 個あります（描いていません）。`);
  if (drawn < faces) warnings.push(`まだ描けない種類の面が ${faces - drawn} 枚あります（${faces} 枚中。穴が空いて見えます）。`);
  const d = SOUTH_EAST.direction, u = SOUTH_EAST.up;
  return { meshes, views: [{ name: "DefaultView", matrix: [0, 0, 0, 0, ...u, 0, ...d, 0, 0, 0, 0, 1] }], warnings, lengthUnit: "mm" };
}

