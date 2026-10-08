// PDF のストリームの符号化を解く（ISO 32000-1 の 7.4）。
//   FlateDecode（fflate）・LZWDecode・ASCIIHexDecode・ASCII85Decode・RunLengthDecode と、その予測子（TIFF 2・PNG）。
//   画像だけの符号化（DCTDecode = JPEG・JPXDecode・JBIG2Decode・CCITTFaxDecode）は解かずに止め、残りの符号化の名前を返す
//   （JPEG は画面の側が画像として解く）。

import { Inflate } from "fflate";
import { PdfName } from "./objects.js";

const IMAGE_FILTERS = new Set(["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"]);

/** 名前か名前の配列 → 名前の文字列の配列 */
const names = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((n) => (n instanceof PdfName ? n.name : String(n)));

/**
 * ストリームの中身を解く。
 * @param {Uint8Array} data 符号化されたままの中身
 * @param {Map} dict ストリームの辞書（/Filter・/DecodeParms）
 * @param {(v: any) => any} resolve 参照を値にする
 * @returns {{ data: Uint8Array, imageFilter: string | null, params: Map | null }} imageFilter: 解かずに残した画像の符号化
 */
export function decodeStream(data, dict, resolve = (v) => v) {
  const filters = names(resolve(dict.get("Filter") ?? dict.get("F")));
  let params = resolve(dict.get("DecodeParms") ?? dict.get("DP"));
  params = Array.isArray(params) ? params.map(resolve) : filters.map(() => params);
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i], p = params[i] instanceof Map ? params[i] : null;
    if (IMAGE_FILTERS.has(f)) return { data, imageFilter: f === "DCT" ? "DCTDecode" : f === "CCF" ? "CCITTFaxDecode" : f, params: p };
    data = decodeOne(f, data, p, resolve);
  }
  return { data, imageFilter: null, params: null };
}

function decodeOne(filter, data, params, resolve) {
  switch (filter) {
    case "FlateDecode": case "Fl": return predict(inflate(data), params, resolve);
    case "LZWDecode": case "LZW": return predict(lzw(data, resolve(params?.get("EarlyChange")) ?? 1), params, resolve);
    case "ASCIIHexDecode": case "AHx": return asciiHex(data);
    case "ASCII85Decode": case "A85": return ascii85(data);
    case "RunLengthDecode": case "RL": return runLength(data);
    case "Crypt": return data;
    default: throw new Error(`符号化 ${filter} は読めません`);
  }
}

/** zlib（RFC 1950）の展開。終わりが壊れていても、そこまでに解けた分を返す（PDF によくある） */
export function inflate(data) {
  const chunks = [];
  let total = 0;
  const run = (bytes) => {
    const inf = new Inflate((chunk) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    inf.push(bytes, true);
  };
  // zlib の見出し（2 バイト）を飛ばして生の Deflate として解く（見出しの検査に落ちる PDF もあるため）
  const raw = data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0 ? data.subarray(2) : data;
  try {
    run(raw);
  } catch (error) {
    if (!total) throw error;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 予測子（/Predictor 2 = TIFF、10〜15 = PNG。行ごとに前の値との差で持つ） */
function predict(data, params, resolve) {
  const predictor = resolve(params?.get("Predictor")) ?? 1;
  if (predictor < 2) return data;
  const colors = resolve(params.get("Colors")) ?? 1, bits = resolve(params.get("BitsPerComponent")) ?? 8;
  const columns = resolve(params.get("Columns")) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8)); // 1 画素のバイト数（左隣の距離）
  const rowLength = Math.ceil((colors * bits * columns) / 8);
  if (predictor === 2) {
    if (bits !== 8) return data; // 8 ビット以外の TIFF の予測子はまれ
    const out = data.slice();
    for (let r = 0; r + rowLength <= out.length; r += rowLength) for (let i = bpp; i < rowLength; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    return out;
  }
  // PNG: 行の先頭の 1 バイトが、その行の予測の種類
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const row = out.subarray(r * rowLength, (r + 1) * rowLength);
    row.set(data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1)));
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? row[i - bpp] : 0, up = prev[i], upLeft = i >= bpp ? prev[i - bpp] : 0;
      switch (type) {
        case 1: row[i] = (row[i] + left) & 0xff; break;
        case 2: row[i] = (row[i] + up) & 0xff; break;
        case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
          break;
        }
      }
    }
    prev = row;
  }
  return out;
}

/** LZW（可変長の符号 9〜12 ビット。EarlyChange = 1 なら 1 つ早く長さを変える） */
function lzw(data, earlyChange) {
  const out = [];
  let dict = [], width = 9, bitBuf = 0, bitCount = 0, prev = null;
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256 = 初めに戻す、257 = 終わり
    width = 9;
    prev = null;
  };
  reset();
  for (let i = 0; i < data.length; i++) {
    bitBuf = (bitBuf << 8) | data[i];
    bitCount += 8;
    while (bitCount >= width) {
      const code = (bitBuf >> (bitCount - width)) & ((1 << width) - 1);
      bitCount -= width;
      bitBuf &= (1 << bitCount) - 1;
      if (code === 256) {
        reset();
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else continue;
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + earlyChange >= 1 << width && width < 12) width++;
    }
  }
  return Uint8Array.from(out);
}

function asciiHex(data) {
  const out = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85(data) {
  const out = [];
  const group = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // <~
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && !group.length) { // z = 0 が 4 つ
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLength(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      out.push(...data.subarray(i, i + n + 1));
      i += n + 1;
    } else {
      const v = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}
