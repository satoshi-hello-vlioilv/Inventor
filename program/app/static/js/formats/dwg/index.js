// DWG（AutoCAD の図面）を読む。Inventor・AutoCAD が無くても、このアプリの中だけで読む（仕様: Open Design Specification for .dwg files）。
//   readDwgObjects(bytes) → { version, codepage, header, headerError, objects: Map<ハンドル, オブジェクト>, failures: [{ handle, kind, message }] }
//   header … 見出しの変数（header.js: 線種の尺度・単位）。読めなければ null で、わけを headerError に（図形は読む）
// 図面のモデル（画層・ブロック・レイアウト・図形）への組み立ては ../cad2d/（DXF と共通）。

import { readAcDs } from "./acds.js";
import { DwgError, latin1, R2013 } from "./bits.js";
import { readDwgFile, VERSION_NAME } from "./file.js";
import { readHeader } from "./header.js";
import { readObject } from "./objects.js";
import { readClasses, readObjectMap } from "./sections.js";

export { DwgError, VERSION_NAME };

// DWG の文字コードの番号 → WHATWG の文字コードの名前（R2004 までの文字列。R2007+ は UTF-16）
const CODEPAGES = {
  1: "us-ascii", 2: "iso-8859-1", 3: "iso-8859-2", 4: "iso-8859-3", 5: "iso-8859-4", 6: "iso-8859-5", 7: "iso-8859-6", 8: "iso-8859-7",
  9: "iso-8859-8", 10: "iso-8859-9", 22: "shift_jis", 23: "macintosh", 24: "big5", 25: "euc-kr", 27: "ibm866",
  28: "windows-1250", 29: "windows-1251", 30: "windows-1252", 31: "gbk", 32: "windows-1253", 33: "windows-1254", 34: "windows-1255",
  35: "windows-1256", 36: "windows-1257", 37: "windows-874", 38: "shift_jis", 39: "gbk", 40: "euc-kr", 41: "big5", 44: "windows-1258",
};

/** 文字コードの番号から、バイト列 → 文字列 */
export function codepageDecoder(codepage) {
  const label = CODEPAGES[codepage];
  if (!label) return latin1;
  try {
    const decoder = new TextDecoder(label);
    return (bytes) => decoder.decode(bytes);
  } catch {
    return latin1;
  }
}

/** DWG のすべてのオブジェクトを読む（読めなかったものは failures に。1 つ読めなくても、ほかは読む） */
export function readDwgObjects(bytes) {
  const file = readDwgFile(bytes);
  const decode = codepageDecoder(file.codepage);
  const ctx = { version: file.version, decode, classes: null };
  ctx.classes = readClasses(file.section("AcDb:Classes"), { version: file.version, maintenance: file.maintenance, decode });
  const handles = file.section("AcDb:Handles");
  if (!handles) throw new DwgError("DWG のオブジェクトの地図（AcDb:Handles）が見つかりません。");
  const map = readObjectMap(handles);
  const data = file.section("AcDb:AcDbObjects");
  if (!data) throw new DwgError("DWG のオブジェクトの節（AcDb:AcDbObjects）が見つかりません。");
  const objects = new Map();
  const failures = [];
  for (const [handle, offset] of map) {
    try {
      objects.set(handle, readObject(data, offset, ctx));
    } catch (error) {
      failures.push({ handle, kind: error.kind ?? null, message: error.message });
    }
  }
  // R2013+: 3D ソリッドなどの形は AcDs の節にある（オブジェクトの中は空）。ハンドルで引いて入れる
  if (file.version >= R2013) {
    const solids = [...objects.values()].filter((o) => o.acis === null);
    if (solids.length) {
      try {
        const store = readAcDs(file.section("AcDb:AcDsPrototype_1b"));
        for (const o of solids) o.acis = store.get(o.handle) ?? null;
      } catch (error) {
        failures.push({ handle: 0, kind: "AcDs", message: `3D ソリッドの形の置き場（AcDs）を読めませんでした: ${error.message}` });
      }
    }
  }
  let header = null, headerError = null;
  try {
    header = readHeader(file.section("AcDb:Header"), { version: file.version, maintenance: file.maintenance });
  } catch (error) {
    headerError = error.message;
  }
  return { version: file.version, codepage: file.codepage, classes: ctx.classes, header, headerError, objects, failures };
}
