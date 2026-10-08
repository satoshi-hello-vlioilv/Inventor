// PDF の 3D（ISO 32000-1 の 13.6・ISO 32000-2 の 13.7 RichMedia）: 3D の注記から、3D のデータ（U3D・PRC）を取り出す。
//   3D の注記（/Subtype /3D）の /3DD … 3D のストリーム（/Subtype /U3D | /PRC）か、それを指す 3D の参照（/3DD）
//   RichMedia の注記 … /RichMediaContent /Assets の名前の木の、埋め込みのファイル（拡張子 .u3d・.prc）
// 既定の視点（/3DV）も取り出す（3D の表示の最初の向き）: 行列で書く（/MS /M。/C2W = カメラ → 世界・/CO = 回転の中心までの距離）か、
// U3D の中の視点の名前で指す（/MS /U3D の /U3DPath）。

import { PdfStream, PdfString } from "./objects.js";

/**
 * @param {import("./file.js").PdfFile} pdf
 * @param {{ annot: Map, rect, subtype, page }} found 3D の注記（content.js が集めたもの）
 * @returns {{ format: "U3D" | "PRC", bytes: Uint8Array, name: string, view: { c2w: number[], co: number } | { node: string } | null } | null}
 */
export function extract3d(pdf, found) {
  const { annot, subtype } = found;
  if (subtype === "3D") {
    let dd = pdf.value(annot, "3DD");
    if (dd instanceof Map && !(dd instanceof PdfStream)) dd = pdf.value(dd, "3DD"); // 3D の参照
    if (!(dd instanceof PdfStream)) return null;
    const format = pdf.name(dd.dict, "Subtype");
    const bytes = pdf.bytesOf(dd);
    if (!bytes || !(format === "U3D" || format === "PRC")) return null;
    return { format, bytes, name: textOf(pdf.value(annot, "Contents")) || textOf(pdf.value(annot, "NM")) || `3D（${format}）`, view: defaultView(pdf, annot, dd) };
  }
  if (subtype === "RichMedia") {
    const assets = pdf.value(pdf.value(annot, "RichMediaContent"), "Assets");
    for (const [name, spec] of nameTree(pdf, assets)) {
      const format = /\.u3d$/i.test(name) ? "U3D" : /\.prc$/i.test(name) ? "PRC" : null;
      const file = pdf.value(pdf.value(spec, "EF"), "F");
      const bytes = format && file instanceof PdfStream ? pdf.bytesOf(file) : null;
      if (bytes) return { format, bytes, name, view: null };
    }
  }
  return null;
}

/** 既定の視点: 注記の /3DV（名前・番号・F/L）か、ストリームの /VA の /DV 番目 */
function defaultView(pdf, annot, stream) {
  const views = pdf.value(stream.dict, "VA") ?? [];
  let v = pdf.value(annot, "3DV");
  if (typeof v === "number") v = views[v];
  else if (v?.name === "F") v = views[0];
  else if (v?.name === "L") v = views.at(-1);
  else if (!(v instanceof Map)) v = views[pdf.value(stream.dict, "DV", 0)] ?? null;
  v = pdf.get(v);
  if (!(v instanceof Map)) return null;
  if (pdf.name(v, "MS") === "U3D") {
    const path = pdf.value(v, "U3DPath");
    const node = Array.isArray(path) ? pdf.get(path[0]) : path;
    return node instanceof PdfString ? { node: node.text() } : null;
  }
  const c2w = pdf.numbers(v, "C2W");
  return c2w?.length === 12 ? { c2w, co: Number(pdf.value(v, "CO", 0)) || 0 } : null;
}

/** 名前の木（/Names の [名前 値 …] と /Kids）→ [[名前, 値]] */
function nameTree(pdf, node, depth = 0) {
  node = pdf.get(node);
  if (!(node instanceof Map) || depth > 16) return [];
  const out = [];
  const names = pdf.value(node, "Names");
  if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) out.push([textOf(pdf.get(names[i])), pdf.get(names[i + 1])]);
  for (const kid of pdf.value(node, "Kids") ?? []) out.push(...nameTree(pdf, kid, depth + 1));
  return out;
}

const textOf = (v) => (v instanceof PdfString ? v.text() : "");
