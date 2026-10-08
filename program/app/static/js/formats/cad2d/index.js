// 2D の図面（DWG・DXF・PDF）を読む入口。中身で形式を見分け、図面のモデル（model.js）にする。
//   isDrawing(name, bytes) → "dwg" | "dxf" | "pdf" | null
//   readDrawing(bytes, name) → 図面のモデル

import { DwgError } from "../dwg/index.js";
import { DxfError, drawingFromDxf, isDxf } from "./from-dxf.js";
import { drawingFromDwg } from "./from-dwg.js";
import { PdfError, drawingFromPdf, isPdf } from "./from-pdf.js";

export { DwgError, DxfError, PdfError };

/** DWG の先頭の版の印（AC1012〜AC1032・古い AC1.40〜AC2.10・MC0.0） */
const isDwg = (bytes) => /^(AC1\d{3}|AC[12]\.\d\d|MC0\.0)/.test(String.fromCharCode(...bytes.subarray(0, 6)));

/** 名前（拡張子）と中身から、図面の形式を決める（図面でなければ null） */
export function isDrawing(name, bytes) {
  if (isDwg(bytes)) return "dwg";
  if (isDxf(bytes)) return "dxf";
  if (isPdf(bytes)) return "pdf";
  // 中身で分からなくても、拡張子が図面なら図面として読んでみる（読めなければ、読み取りが理由を説明する）
  return /\.dwg$/i.test(name) ? "dwg" : /\.dxf$/i.test(name) ? "dxf" : /\.pdf$/i.test(name) ? "pdf" : null;
}

const READERS = { dwg: drawingFromDwg, dxf: drawingFromDxf, pdf: drawingFromPdf };

export function readDrawing(bytes, name = "") {
  return (READERS[isDrawing(name, bytes)] ?? drawingFromDwg)(bytes);
}
