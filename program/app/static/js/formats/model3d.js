// 3D の PDF の中の 3D（drawing.models3d の 1 つ。U3D・PRC）を、3D 表示のメッシュと部品の一覧にする（DOM に依存しない）。
//   read3d({ format, bytes, view }) → { meshes, view（viewer.show({ meshes, view }) に渡す）, parts, warnings }
// 形式ごとの読み取りは、同じ形の結果を返す:
//   { meshes: [{ name, instance, positions, normals, index, groups: [{ start, count, color }], matrix（列優先の 4×4）, faces, vertices }],
//     views: [{ name, matrix（カメラ → 世界。列優先。−Z の向きを見て +Y が上）}], warnings }
// 最初の視点 view = { direction（注視点 → カメラの向き）, up（画面の上の向き）}。PDF の既定の視点（/3DV。行列か、3D の中の視点の名前）
// があればそれ、無ければ 3D の中の既定の視点（"DefaultView"、無ければ最初の視点）。どちらも無ければ null（表示の既定の向き）

import { U3dError, readU3d } from "./u3d/index.js";

export class Model3dError extends Error {}

const READERS = { U3D: readU3d };

/** @param {{ format: string, bytes: Uint8Array, view?: { c2w: number[] } | { node: string } | null }} model3d  pdf/three-d.js の extract3d の結果 */
export function read3d({ format, bytes, view = null }) {
  const read = READERS[format];
  if (!read) throw new Model3dError(`${format} 形式の 3D は、まだ表示できません。`);
  let result;
  try {
    result = read(bytes);
  } catch (error) {
    if (error instanceof U3dError) throw new Model3dError(`${format} として読めませんでした（${error.message}）。`);
    throw error;
  }
  return { ...viewerMeshes(result), view: pdfView(view) ?? fileView(result.views ?? [], view?.node), warnings: result.warnings };
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
