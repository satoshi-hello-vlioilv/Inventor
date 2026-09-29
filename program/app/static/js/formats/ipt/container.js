// コンテナ層: .ipt (OLE2) から RSe セグメントを取り出し、Zstandard を展開する。

import { decompress } from "fzstd";
import { readCfb } from "./cfb.js";

const RSE_STORAGE = "RSeStorage/";
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0x49, 0x45, 0x4e, 0x44]; // "IEND"
const HEADER_SCAN_LIMIT = 512;
const SEGMENT_NAME = /(?:[A-Za-z0-9_]\x00)+?S\x00e\x00g\x00m\x00e\x00n\x00t\x00/;

export function indexOf(bytes, pattern, from = 0, to = bytes.length) {
  const last = Math.min(to, bytes.length) - pattern.length;
  outer: for (let i = from; i <= last; i++) {
    for (let k = 0; k < pattern.length; k++) if (bytes[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

function inflate(raw) {
  const at = indexOf(raw, ZSTD_MAGIC, 0, HEADER_SCAN_LIMIT);
  if (at < 0) return { data: raw, compressed: false };
  try {
    return { data: decompress(raw.subarray(at)), compressed: true };
  } catch {
    return { data: raw, compressed: false };
  }
}

function segmentName(metaRaw, fallback) {
  const head = String.fromCharCode(...metaRaw.subarray(0, HEADER_SCAN_LIMIT));
  const match = SEGMENT_NAME.exec(head);
  return match ? match[0].replace(/\x00/g, "") : fallback;
}

function extractPng(raw) {
  const start = indexOf(raw, PNG_MAGIC);
  if (start < 0) return null;
  const end = indexOf(raw, PNG_END, start);
  return end >= 0 ? raw.slice(start, end + 8) : null; // IEND = 種別(4) + CRC(4)
}

function pngSize(png) {
  // IHDR: シグネチャ(8) + 長さ(4) + 種別(4) の直後に幅・高さ（ビッグエンディアン）
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

/**
 * @param {Uint8Array} bytes  .ipt ファイルの中身
 */
export function openIpt(bytes) {
  const { clsid, streams } = readCfb(bytes);
  const keys = [...streams.keys()]
    .filter((p) => p.startsWith(RSE_STORAGE + "B") && !p.slice(RSE_STORAGE.length).includes("/"))
    .map((p) => p.slice(RSE_STORAGE.length + 1))
    .sort();
  const segments = keys.map((key) => {
    const dataRaw = streams.get(`${RSE_STORAGE}B${key}`);
    const metaRaw = streams.get(`${RSE_STORAGE}M${key}`) ?? new Uint8Array();
    const data = inflate(dataRaw);
    return {
      key,
      name: segmentName(metaRaw, key),
      meta: inflate(metaRaw).data,
      data: data.data,
      metaStoredSize: metaRaw.length,
      dataStoredSize: dataRaw.length,
      compressed: data.compressed,
    };
  });
  let thumbnail = null;
  for (const [path, content] of streams) {
    if (path.startsWith("\x05") && (thumbnail = extractPng(content))) break;
  }
  return {
    fileSize: bytes.length,
    clsid,
    streams: [...streams].map(([path, content]) => ({ path, size: content.length })),
    streamData: streams, // パス → 中身（組立のファイル参照など、セグメント以外を読むため）
    segments,
    thumbnail,
    thumbnailSize: thumbnail ? pngSize(thumbnail) : null,
  };
}
