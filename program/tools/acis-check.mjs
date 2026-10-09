// DWG の 3D ソリッド（ACIS）の表示の評価（開発用）: ソリッドごとに、面を描けたか・三角形が閉じた立体になっているか・体積。
//   node program/tools/acis-check.mjs [--json 書き出し先] 図面.dwg …
//   描けた面 / 全ての面、相手のいない辺（同じ位置の頂点を 1 つにまとめて数える。0 なら隙間なく閉じている）、体積（図面の単位の 3 乗）
// --json で、ハンドルごとの体積を書き出す（ezdxf（MIT）の別の読み取りで平面だけのソリッドの体積を出し、突き合わせる: acis_check.py）
import fs from "node:fs";
import path from "node:path";
import { acisMesh, acisShape } from "../app/static/js/formats/acis/index.js";
import { readDwgObjects } from "../app/static/js/formats/dwg/index.js";

/** 三角形（中心をずらした座標）の相手のいない辺の数と体積。tol … 同じ点とみなす距離 */
export function closure({ positions, index }, tol) {
  const key = (i) => [0, 1, 2].map((k) => Math.round(positions[3 * i + k] / tol)).join(",");
  const ids = new Map(), at = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const k = key(i);
    if (!ids.has(k)) ids.set(k, ids.size);
    at.push(ids.get(k));
  }
  const edges = new Map();
  let volume = 0;
  for (let t = 0; t < index.length; t += 3) {
    const v = [index[t], index[t + 1], index[t + 2]];
    const [a, b, c] = v.map((i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const w = v.map((i) => at[i]);
    if (new Set(w).size < 3) continue;
    for (let i = 0; i < 3; i++) {
      const k = `${w[i]}>${w[(i + 1) % 3]}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [k, n] of edges) {
    const [x, y] = k.split(">");
    open += Math.max(0, n - (edges.get(`${y}>${x}`) ?? 0));
  }
  return { open, volume };
}

/** 図面の 3D ソリッドをすべて調べる → [{ handle, kind, faces, drawn, open, volume, error? }] */
export function checkDwg(bytes) {
  const { objects } = readDwgObjects(bytes);
  return [...objects.values()].filter((o) => o.acis !== undefined).map((o) => {
    const shape = acisShape(o.acis);
    if (shape.error) return { handle: o.handle.toString(16).toUpperCase(), kind: o.kind, error: shape.error };
    const mesh = acisMesh(shape);
    const size = Math.max(1e-9, ...[0, 1, 2].map((k) => { const v = Array.from(mesh.positions.filter((_, i) => i % 3 === k)); return Math.max(...v) - Math.min(...v); }));
    return { handle: o.handle.toString(16).toUpperCase(), kind: o.kind, faces: mesh.faces, drawn: mesh.drawn, ...closure(mesh, size * 1e-6) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--json");
  const jsonOut = at >= 0 ? args.splice(at, 2)[1] : null;
  const all = {};
  console.log("図面\tソリッド\t読めない\t面（描けた / 全て）\t閉じた立体\t体積が負");
  for (const file of args) {
    const rows = checkDwg(new Uint8Array(fs.readFileSync(file)));
    all[path.basename(file)] = rows;
    const ok = rows.filter((r) => !r.error);
    const faces = ok.reduce((n, r) => n + r.faces, 0), drawn = ok.reduce((n, r) => n + r.drawn, 0);
    console.log(`${path.basename(file)}\t${rows.length}\t${rows.length - ok.length}\t${drawn} / ${faces}\t${ok.filter((r) => r.open === 0).length} / ${ok.length}\t${ok.filter((r) => r.volume < 0).length}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(all, null, 1));
}
