// 2D の図面（DWG・DXF・PDF・Jw_cad・SXF）を読む入口。中身で形式を見分け、図面のモデル（model.js）にする。
//   isDrawing(name, bytes) → "dwg" | "dxf" | "pdf" | "jww" | "sxf" | null（SXF は見出しで 3D の STEP と見分ける）
//   readDrawing(bytes, name) → 図面のモデル

import { DwgError } from "../dwg/index.js";
import { DxfError, drawingFromDxf, isDxf } from "./from-dxf.js";
import { drawingFromDwg } from "./from-dwg.js";
import { JwwError, drawingFromJww, isJww } from "./from-jww.js";
import { PdfError, drawingFromPdf, isPdf } from "./from-pdf.js";
import { SxfError, drawingFromSxf, isSxf } from "./from-sxf.js";

export { DwgError, DxfError, JwwError, PdfError, SxfError };

/** DWG の先頭の版の印（AC1012〜AC1032・古い AC1.40〜AC2.10・MC0.0） */
const isDwg = (bytes) => /^(AC1\d{3}|AC[12]\.\d\d|MC0\.0)/.test(String.fromCharCode(...bytes.subarray(0, 6)));

/** 名前（拡張子）と中身から、図面の形式を決める（図面でなければ null） */
export function isDrawing(name, bytes) {
  if (isDwg(bytes)) return "dwg";
  if (isDxf(bytes)) return "dxf";
  if (isPdf(bytes)) return "pdf";
  if (isJww(bytes)) return "jww";
  if (isSxf(bytes)) return "sxf";
  // 中身で分からなくても、拡張子が図面なら図面として読んでみる（読めなければ、読み取りが理由を説明する）
  if (/\.(sfc|p21)$/i.test(name)) return "sxf";
  return name.match(/\.(dwg|dxf|pdf|jww)$/i)?.[1].toLowerCase() ?? null;
}

const READERS = { dwg: drawingFromDwg, dxf: drawingFromDxf, pdf: drawingFromPdf, jww: drawingFromJww, sxf: drawingFromSxf };

export function readDrawing(bytes, name = "") {
  return (READERS[isDrawing(name, bytes)] ?? drawingFromDwg)(bytes);
}
