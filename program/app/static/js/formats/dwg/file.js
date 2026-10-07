// DWG のファイルの組み立て（Open Design Specification for .dwg files の 3〜8 章）: 版を見分け、データの節（セクション）を取り出す。
//   R13〜R2000（AC1012〜AC1015）… 節の場所の表（レコード番号・位置・大きさ）。オブジェクトはファイルの中の位置で直接読む
//   R2004・R2010〜R2018（AC1018・AC1024・AC1027・AC1032）… 暗号化した見出し → ページの地図 → 節の地図。各ページは LZ77 で圧縮
//   R2007（AC1021）… リード・ソロモン符号と別の LZ77（rs2007.js）
// 返す: { version, maintenance, codepage, section(name) → Uint8Array | null, objectsBase }
//   R2000 までの節の名前は R2004 以降に合わせる（AcDb:Header・AcDb:Classes・AcDb:Handles・AcDb:AcDbObjects）。

import { DwgError, R13, R2000, R2004, R2007, R2010, R2013, R2018 } from "./bits.js";
import { readFile2007 } from "./rs2007.js";

const VERSIONS = { AC1012: R13, AC1014: 1014, AC1015: R2000, AC1018: R2004, AC1021: R2007, AC1024: R2010, AC1027: R2013, AC1032: R2018 };
// 古い版（R12 まで）の印。読めないと知らせる
const OLD = /^(MC0\.0|AC1\.2|AC1\.40|AC1\.50|AC2\.10|AC1001|AC1002|AC1003|AC1004|AC1006|AC1009)/;
export const VERSION_NAME = { [R13]: "R13", 1014: "R14", [R2000]: "R2000", [R2004]: "R2004", [R2007]: "R2007", [R2010]: "R2010", [R2013]: "R2013", [R2018]: "R2018" };

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 2 ** 32;

/** 版の文字列（先頭 6 バイト）から版の番号。読めない版は理由つきの DwgError */
export function dwgVersion(bytes) {
  const tag = String.fromCharCode(...bytes.subarray(0, 6));
  if (VERSIONS[tag]) return VERSIONS[tag];
  if (OLD.test(tag)) throw new DwgError(`古い DWG（${tag}・R12 以前）には対応していません。AutoCAD などで R2000 以降の形式に保存し直してください。`);
  throw new DwgError("DWG のファイルではありません（先頭に版の印 AC10xx がありません）。");
}

/** ファイルを読み、節を取り出せるようにする */
export function readDwgFile(bytes) {
  const version = dwgVersion(bytes);
  if (version <= R2000) return readFile2000(bytes, version);
  if (version === R2007) return readFile2007(bytes);
  return readFile2004(bytes, version);
}

// ---- R13〜R2000 ---------------------------------------------------------------------------------------------
// 0x13: 文字コード（RS）、0x15: レコードの数（RL）、そのあとに 番号（RC）・位置（RL）・大きさ（RL）
const RECORD_NAMES = ["AcDb:Header", "AcDb:Classes", "AcDb:Handles"];

function readFile2000(bytes, version) {
  const codepage = u16(bytes, 0x13);
  const count = u32(bytes, 0x15);
  const records = new Map();
  for (let i = 0; i < count; i++) {
    const at = 0x19 + i * 9;
    records.set(bytes[at], { offset: u32(bytes, at + 1), size: u32(bytes, at + 5) });
  }
  const section = (name) => {
    if (name === "AcDb:AcDbObjects") return bytes; // オブジェクトの位置はファイルの先頭から
    const record = records.get(RECORD_NAMES.indexOf(name));
    return record ? bytes.subarray(record.offset, record.offset + record.size) : null;
  };
  return { version, maintenance: version === 1014 ? bytes[0x0b] : 0, codepage, section };
}

// ---- R2004・R2010〜R2018 ---------------------------------------------------------------------------------
/** 0x80 からの 0x6C バイトは、線形合同法の乱数の列との XOR で暗号化されている */
function decryptHeader(bytes) {
  const out = bytes.slice(0x80, 0x80 + 0x6c);
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0;
    out[i] ^= (seed >> 16) & 0xff;
  }
  return out;
}

/** ページの見出し（0x14 バイト）と、そのあとの LZ77 の圧縮を解いた中身（システムの節: ページの地図・節の地図） */
function systemPage(bytes, at) {
  const size = u32(bytes, at + 4), compressed = u32(bytes, at + 8);
  const type = u32(bytes, at + 12);
  const start = at + 0x14;
  return type === 2 ? decompress2004(bytes, start, compressed, size) : bytes.slice(start, start + size);
}

function readFile2004(bytes, version) {
  if (bytes.length < 0x100) throw new DwgError("DWG のファイルが途中で切れています。");
  const maintenance = bytes[0x0b];
  const codepage = u16(bytes, 0x13);
  const header = decryptHeader(bytes);
  if (String.fromCharCode(...header.subarray(0, 11)) !== "AcFssFcAJMB") throw new DwgError("DWG の見出しを解読できませんでした（暗号の解けない見出し）。");
  const pageMapAddress = u64(header, 0x54) + 0x100;
  const sectionMapId = u32(header, 0x5c);

  // ページの地図: ページ番号 → ファイルの中の位置（0x100 から、各ページの大きさを足していく）
  const pageMap = systemPage(bytes, pageMapAddress);
  const pages = new Map();
  let address = 0x100;
  for (let i = 0; i + 8 <= pageMap.length;) {
    const number = u32(pageMap, i) | 0, size = u32(pageMap, i + 4);
    i += 8;
    if (number >= 0) pages.set(number, address);
    else i += 16; // 空き（親・左・右・0）
    address += size;
  }

  // 節の地図: 節ごとに、ページの並び（ページ番号・圧縮した大きさ・解いた中身での開始位置）
  const at = pages.get(sectionMapId);
  if (at === undefined) throw new DwgError("DWG の節の地図が見つかりません。");
  const map = systemPage(bytes, at);
  const sections = new Map();
  const count = u32(map, 0);
  let p = 0x14;
  for (let s = 0; s < count; s++) {
    const total = u64(map, p), pageCount = u32(map, p + 8), maxSize = u32(map, p + 12);
    const compressed = u32(map, p + 20) === 2, encrypted = u32(map, p + 28);
    const name = String.fromCharCode(...map.subarray(p + 32, p + 96)).replace(/\0[\s\S]*$/, "");
    p += 96;
    const list = [];
    for (let i = 0; i < pageCount; i++) {
      list.push({ number: u32(map, p), size: u32(map, p + 4), start: u64(map, p + 8) });
      p += 16;
    }
    sections.set(name, { total, maxSize, compressed, encrypted, pages: list });
  }

  const cache = new Map();
  const section = (name) => {
    if (cache.has(name)) return cache.get(name);
    const info = sections.get(name);
    const data = info ? sectionData(bytes, info, pages) : null;
    cache.set(name, data);
    return data;
  };
  return { version, maintenance, codepage, section };
}

/** 節の中身をページから組み立てる（書かれていないページは 0 のまま） */
function sectionData(bytes, info, pages) {
  if (info.encrypted === 1) throw new DwgError("暗号化（パスワード付き）の DWG には対応していません。");
  const out = new Uint8Array(info.total);
  for (const page of info.pages) {
    const at = pages.get(page.number);
    if (at === undefined || page.start >= out.length) continue;
    // データのページの見出し（0x20 バイト）は、位置に応じた値との XOR で隠されている
    const mask = (0x4164536b ^ at) >>> 0;
    const compressedSize = (u32(bytes, at + 8) ^ mask) >>> 0;
    const start = at + 0x20;
    // 解いた大きさは、ページの最大（普通 0x7400）まで。節の大きさを越えた分は捨てる
    const data = info.compressed ? decompress2004(bytes, start, compressedSize, info.maxSize) : bytes.subarray(start, start + info.maxSize);
    out.set(data.subarray(0, Math.min(data.length, out.length - page.start)), page.start);
  }
  return out;
}

/**
 * R2004 の LZ77 の圧縮を解く（仕様書 4.7。オフセットの 0x4000 の位（命令 0x18〜0x1F）は実装の振る舞いに合わせる）。
 * 文字（リテラル）の長さ → 以降、[命令（コピーの長さ・後ろへの距離・続く文字の数）] を 0x11 まで繰り返す。
 * size は解いた中身の最大の大きさ。返すのは実際に解いた分
 */
export function decompress2004(src, start, length, size) {
  const out = new Uint8Array(size);
  let ip = start, op = 0;
  const end = start + length;
  const next = () => {
    if (ip >= end) throw new DwgError("圧縮したページのデータが途中で切れています。");
    return src[ip++];
  };
  // 長さの続き: 0 なら 0xFF を足して次へ、0 でなければ足して終わり
  const longLength = (base) => {
    let n = base;
    for (let b = next(); ; b = next()) {
      if (b) return n + b;
      n += 0xff;
    }
  };
  const literalLength = (code) => (code ? code + 3 : longLength(0x0f) + 3);
  const literal = (count) => {
    if (op + count > size || ip + count > end) throw new DwgError("圧縮を解いた大きさが合いません。");
    out.set(src.subarray(ip, ip + count), op);
    ip += count;
    op += count;
  };
  const copy = (count, distance) => {
    if (distance > op || op + count > size) throw new DwgError("圧縮の参照が範囲の外です。");
    for (let i = 0; i < count; i++, op++) out[op] = out[op - distance];
  };

  let opcode = next();
  if ((opcode & 0xf0) === 0) {
    literal(literalLength(opcode));
    opcode = next();
  }
  while (opcode !== 0x11) {
    let count, distance, lit;
    if (opcode >= 0x40) {
      count = (opcode >> 4) - 1;
      const second = next();
      distance = ((second << 2) | ((opcode >> 2) & 3)) + 1;
      lit = opcode & 3;
    } else if (opcode >= 0x20) {
      count = (opcode & 0x1f ? opcode & 0x1f : longLength(0x1f)) + 2;
      const first = next();
      distance = ((first >> 2) | (next() << 6)) + 1;
      lit = first & 3;
    } else if (opcode >= 0x10) {
      count = (opcode & 7 ? opcode & 7 : longLength(7)) + 2;
      const first = next();
      distance = ((opcode & 8) << 11) + ((first >> 2) | (next() << 6)) + 0x4000;
      lit = first & 3;
    } else throw new DwgError(`圧縮の命令 0x${opcode.toString(16)} が分かりません。`);
    copy(count, distance);
    if (!lit) {
      opcode = next();
      if ((opcode & 0xf0) === 0) {
        literal(literalLength(opcode));
        opcode = next();
      }
    } else {
      literal(lit);
      opcode = next();
    }
  }
  return out.subarray(0, op);
}
