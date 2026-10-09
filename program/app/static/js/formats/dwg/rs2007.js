// R2007（AC1021）の DWG のファイルの組み立て（仕様書 5 章）。R2004 と同じく「ページの地図 → 節の地図 → 節のページ」の順にたどるが、
//   ・ページはリード・ソロモン符号（255 バイトの符号語。誤りを直すための 16 または 4 バイトが付く）で、いくつかの符号語を 1 バイトずつ交互に並べてある
//   ・圧縮は R2004 とは別の LZ77（命令の形が違い、文字（リテラル）は 8 バイトごとなどの順に入れ替えて書かれている）
//   ・見出し・ページの地図・節の地図の数は 8 バイト（R2004 は 4 バイト）。節の名前は UTF-16
// 誤りの訂正はしない（壊れていないファイルなら、符号語の頭のデータの部分をそのまま並べ直せばよい）。
// 読み方は ACadSharp（MIT）の DwgReader（readFileHeaderAC21・getSectionBuffer21）と DwgLZ77AC21Decompressor を、仕様書と突き合わせて移したもの。
// 返す形は file.js の readDwgFile と同じ: { version, maintenance, codepage, section(name) → Uint8Array | null }

import { DwgError, R2007 } from "./bits.js";

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 2 ** 32;
const i64 = (b, i) => u32(b, i) + (u32(b, i + 4) | 0) * 2 ** 32;
// ページの位置は、ファイルの 0x480（最初のページ）から数える
const PAGES_START = 0x480;

/**
 * リード・ソロモン符号の交互の並び（インターリーブ）を解く: factor 個の符号語（各 255 バイト）が 1 バイトずつ交互に並んでいる
 * （符号語 i の j バイトめは start + j × factor + i）。各符号語の頭の dataSize バイト（データの部分）をつなげ、length バイトを返す
 */
export function deinterleave(bytes, start, factor, dataSize, length) {
  if (start + 255 * factor > bytes.length) throw new DwgError("DWG のファイルが途中で切れています（ページが足りません）。");
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < factor && o < length; i++) {
    for (let j = 0; j < dataSize && o < length; j++) out[o++] = bytes[start + j * factor + i];
  }
  return out;
}

// 文字（リテラル）の並べ替え: 32 バイトずつ、8 バイトの組の順を逆に書いてある。端数（1〜31 バイト）は長さごとに決まった並び。
// 「元の位置+長さ」を、解いた先の順に書く（2・3 バイトの組はバイトの順も逆、16 バイトの組は 8 バイトずつ逆）
const LITERAL_ORDER = [
  "", "0+1", "0+2", "0+3", "0+4", "4+1 0+4", "5+1 1+4 0+1", "5+2 1+4 0+1", "0+8", "8+1 0+8", "9+1 1+8 0+1", "9+2 1+8 0+1",
  "8+4 0+8", "12+1 8+4 0+8", "13+1 9+4 1+8 0+1", "13+2 9+4 1+8 0+1", "0+16", "9+8 8+1 0+8", "17+1 1+16 0+1", "16+3 0+16",
  "16+4 8+8 0+8", "20+1 16+4 8+8 0+8", "20+2 16+4 8+8 0+8", "20+3 16+4 8+8 0+8", "16+8 0+16", "17+8 16+1 0+16",
  "25+1 17+8 16+1 0+16", "25+2 17+8 16+1 0+16", "24+4 16+8 8+8 0+8", "28+1 24+4 16+8 8+8 0+8", "28+2 24+4 16+8 8+8 0+8",
  "30+1 26+4 18+8 10+8 2+8 0+2", "24+8 16+8 8+8 0+8",
].map((order) => order.split(" ").filter(Boolean).flatMap((item) => {
  const [from, size] = item.split("+").map(Number);
  const run = Array.from({ length: size }, (_, k) => from + k);
  if (size === 2 || size === 3) return run.reverse();
  return size === 16 ? [...run.slice(8), ...run.slice(0, 8)] : run;
}));

/**
 * R2007 の LZ77 の圧縮を解く（仕様書 5.3）。src の start から length バイトを解き、size バイトの中身を返す。
 * 文字の長さ → 文字 → [コピーの命令（長さ・後ろへの距離）…] を繰り返す。命令の下 3 ビットが 0 でなければ、それが次の文字の数
 */
export function decompress2007(src, start, length, size) {
  const out = new Uint8Array(size);
  const end = start + length;
  let ip = start, op = 0, count = 0, distance = 0;
  const next = () => {
    if (ip >= end) throw new DwgError("圧縮したページのデータが途中で切れています。");
    return src[ip++];
  };
  const literal = (n) => {
    if (op + n > size || ip + n > end) throw new DwgError("圧縮を解いた大きさが合いません。");
    for (; n > 0; n -= 32) {
      const order = LITERAL_ORDER[Math.min(n, 32)];
      for (let k = 0; k < order.length; k++) out[op + k] = src[ip + order[k]];
      ip += order.length;
      op += order.length;
    }
  };
  const copy = () => {
    if (distance > op || op + count > size) throw new DwgError("圧縮の参照が範囲の外です。");
    for (let i = 0; i < count; i++, op++) out[op] = out[op - distance];
  };
  // 命令（上位 4 ビットで形が決まる）から、コピーの長さと距離。命令の続きのバイトが、次の命令（opcode）になる
  let opcode = next();
  const instruction = () => {
    switch (opcode >> 4) {
      case 0:
        count = (opcode & 0xf) + 0x13;
        distance = next();
        opcode = next();
        count += (opcode >> 3) & 0x10;
        distance += ((opcode & 0x78) << 5) + 1;
        break;
      case 1:
        count = (opcode & 0xf) + 3;
        distance = next();
        opcode = next();
        distance += ((opcode & 0xf8) << 5) + 1;
        break;
      case 2:
        distance = next() | (next() << 8);
        count = opcode & 7;
        if (opcode & 8) {
          distance++;
          count += next() << 3;
          opcode = next();
          count += ((opcode & 0xf8) << 8) + 0x100;
        } else {
          opcode = next();
          count += opcode & 0xf8;
        }
        break;
      default:
        count = opcode >> 4;
        distance = opcode & 0xf;
        opcode = next();
        distance += ((opcode & 0xf8) << 1) + 1;
    }
  };

  // 先頭が 0x2X なら、続く 3 バイトめの下 3 ビットが最初の文字の数
  if ((opcode & 0xf0) === 0x20) {
    ip += 3;
    count = src[ip - 1] & 7;
  }
  while (ip < end) {
    if (!count) {
      // 文字の長さ: 命令 + 8。0x17 なら続くバイトを足し、0xFF なら 2 バイトずつ 0xFFFF でなくなるまで足す
      count = opcode + 8;
      if (count === 0x17) {
        let n = next();
        count += n;
        if (n === 0xff) {
          do {
            n = next() | (next() << 8);
            count += n;
          } while (n === 0xffff);
        }
      }
    }
    literal(count);
    if (ip >= end) break;
    opcode = next();
    instruction();
    for (;;) {
      copy();
      count = opcode & 7;
      if (count || ip >= end) break;
      opcode = next();
      if (!(opcode >> 4)) break;
      if (opcode >> 4 === 15) opcode &= 15;
      instruction();
    }
  }
  return out;
}

/** システムのページ（ページの地図・節の地図）: 符号語のデータは 239 バイト。圧縮した大きさ（8 の倍数に切り上げ）× 重ねの数 だけ並ぶ */
function systemPage(bytes, offset, compressed, size, repeat) {
  const total = Math.ceil(compressed / 8) * 8 * repeat;
  const data = deinterleave(bytes, PAGES_START + offset, Math.ceil(total / 239), 239, total);
  return decompress2007(data, 0, compressed, size);
}

export function readFile2007(bytes) {
  if (bytes.length < PAGES_START) throw new DwgError("DWG のファイルが途中で切れています。");
  const maintenance = bytes[0x0b];
  const codepage = u16(bytes, 0x13);

  // 0x80 からの見出し: 3 つの符号語（データ 239 バイト）。頭の 0x20 バイトは CRC など、0x18 が圧縮した大きさ（負なら圧縮なし）
  const head = deinterleave(bytes, 0x80, 3, 239, 3 * 239);
  const headLength = u32(head, 0x18) | 0;
  if (!headLength || Math.abs(headLength) > head.length - 0x20) throw new DwgError("DWG の見出しを読めませんでした（R2007 の見出しの大きさが合いません）。");
  const meta = headLength < 0 ? head.subarray(0x20, 0x20 - headLength) : decompress2007(head, 0x20, headLength, 0x110);
  const m = (at) => u64(meta, at);

  // ページの地図: (大きさ, 番号) の 8 バイトずつの組。位置は 0x480 からの大きさの和（番号が負のものは空き）
  const pageMap = systemPage(bytes, m(0x38), m(0x50), m(0x58), m(0x18));
  const pages = new Map();
  for (let i = 0, offset = 0; i + 16 <= pageMap.length; i += 16) {
    const size = i64(pageMap, i);
    pages.set(Math.abs(i64(pageMap, i + 8)), offset);
    offset += size;
  }

  // 節の地図: 節ごとに 64 バイトの頭（大きさ・暗号・符号の種類・ページの数など）、名前（UTF-16）、ページの並び（56 バイトずつ）
  const mapAt = pages.get(m(0xc0));
  if (mapAt === undefined) throw new DwgError("DWG の節の地図が見つかりません。");
  const map = systemPage(bytes, mapAt, m(0xb0), m(0xc8), m(0xd8));
  const utf16 = new TextDecoder("utf-16le");
  const sections = new Map();
  for (let p = 0; p + 64 <= map.length;) {
    const encrypted = u64(map, p + 16), nameLength = u64(map, p + 32), encoding = u64(map, p + 48), pageCount = u64(map, p + 56);
    const name = utf16.decode(map.subarray(p + 64, p + 64 + nameLength)).replace(/\0/g, "");
    p += 64 + nameLength;
    const list = [];
    for (let i = 0; i < pageCount; i++, p += 56) {
      // 解いた中身での開始位置・ファイルの中の大きさ・ページ番号・解いた大きさ・圧縮した大きさ（そのあと検査の値が 2 つ）
      list.push({ start: u64(map, p), number: u64(map, p + 16), size: u64(map, p + 24), compressed: u64(map, p + 32) });
    }
    if (name) sections.set(name, { encrypted, encoding, pages: list });
  }

  const cache = new Map();
  const section = (name) => {
    if (cache.has(name)) return cache.get(name);
    const info = sections.get(name);
    const data = info ? sectionData(bytes, info, pages) : null;
    cache.set(name, data);
    return data;
  };
  return { version: R2007, maintenance, codepage, section };
}

/** 節の中身をページから組み立てる（0 だけのページはファイルに書かれず、開始位置が飛ぶ。その分は 0 のまま） */
function sectionData(bytes, info, pages) {
  if (info.encrypted === 1) throw new DwgError("暗号化（パスワード付き）の DWG には対応していません。");
  const out = new Uint8Array(Math.max(0, ...info.pages.map((page) => page.start + page.size)));
  for (const page of info.pages) {
    const at = pages.get(page.number);
    if (at === undefined) continue;
    let data;
    if (info.encoding === 4) {
      // 符号つきのページ: 符号語のデータは 251 バイト（誤りを直す部分は 4 バイト）
      const factor = Math.ceil((Math.ceil(page.compressed / 8) * 8) / 251);
      data = deinterleave(bytes, PAGES_START + at, factor, 251, factor * 251);
    } else data = bytes.subarray(PAGES_START + at, PAGES_START + at + page.compressed);
    if (page.compressed !== page.size) data = decompress2007(data, 0, page.compressed, page.size);
    out.set(data.subarray(0, page.size), page.start);
  }
  return out;
}
