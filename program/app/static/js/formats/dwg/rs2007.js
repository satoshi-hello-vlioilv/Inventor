// R2007（AC1021）の DWG のファイルの組み立て（仕様書 5 章）。リード・ソロモン符号と、R2004 とは別の LZ77 を使う。
import { DwgError } from "./bits.js";

export function readFile2007() {
  throw new DwgError("R2007 形式の DWG にはまだ対応していません。");
}
