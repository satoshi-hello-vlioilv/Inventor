// PDF の画像（ISO 32000-1 の 8.9）→ 描ける画像。
//   { kind: "rgba", width, height, data: Uint8ClampedArray }              … 標本を解いた画像（大きすぎれば間引く）
//   { kind: "jpeg", width, height, bytes, alpha?: { width, height, data } } … JPEG（DCTDecode）は画面の側が解く
//   { kind: "box", width, height, unsupported }                              … 解けない符号化（JPEG 2000・JBIG2・CCITT）: 枠だけ描く
// 色: 色空間（色の番号の表・特色の関数を含む）・/Decode・型抜き（/ImageMask: いまの塗りの色で塗る）・透明（/SMask・/Mask）

import { colorSpace, rgbOf } from "./colorspace.js";
import { PdfStream } from "./objects.js";

const MAX_PIXELS = 4_000_000; // これを越える画像は間引いて持つ（画面の表示には十分。メモリを抑える）

/**
 * @param {import("./file.js").PdfFile} pdf
 * @param {Map} dict 画像の辞書
 * @param {{ data: Uint8Array, imageFilter: string | null }} decoded 解いたストリーム（画像の符号化は解かれていない）
 */
export function decodeImage(pdf, dict, decoded, { fillColor = "#000000", resources = null } = {}) {
  if (!decoded) return null;
  const width = Number(pdf.value(dict, "Width", 0)), height = Number(pdf.value(dict, "Height", 0));
  if (!(width > 0 && height > 0)) return null;
  const { data, imageFilter } = decoded;
  const interpolate = Boolean(pdf.value(dict, "Interpolate", false)); // 引き伸ばすときにぼかすか（無ければ画素のまま）
  if (imageFilter === "DCTDecode") return { kind: "jpeg", width, height, bytes: data, alpha: softMask(pdf, dict), interpolate };
  if (imageFilter) {
    const label = { JPXDecode: "JPEG 2000", JBIG2Decode: "JBIG2", CCITTFaxDecode: "CCITT（ファクスの符号）" }[imageFilter] ?? imageFilter;
    return { kind: "box", width, height, unsupported: `画像（${label}）` };
  }
  const mask = Boolean(pdf.value(dict, "ImageMask", false));
  const bpc = mask ? 1 : Number(pdf.value(dict, "BitsPerComponent", 8));
  const space = mask ? null : colorSpace(pdf, dict.get("ColorSpace"), resources);
  const n = mask ? 1 : space.n || 1;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_PIXELS)));
  const w = Math.ceil(width / step), h = Math.ceil(height / step);
  const out = new Uint8ClampedArray(w * h * 4);
  const rowBytes = Math.ceil((width * n * bpc) / 8);
  const maxValue = 2 ** bpc - 1;
  const decode = pdf.numbers(dict, "Decode") ?? (space?.indexed ? [0, maxValue] : Array.from({ length: n }, () => [0, 1]).flat());
  // 標本（行 y・列 x・成分 c）→ 0〜maxValue
  const sample = (x, y, c) => {
    const bit = y * rowBytes * 8 + (x * n + c) * bpc;
    if (bpc === 8) return data[bit >> 3] ?? 0;
    if (bpc === 16) return (((data[bit >> 3] ?? 0) << 8) | (data[(bit >> 3) + 1] ?? 0)) >>> 8; // 上位 8 ビット
    let v = 0;
    for (let k = 0; k < bpc; k++) v = (v << 1) | (((data[(bit + k) >> 3] ?? 0) >> (7 - ((bit + k) & 7))) & 1);
    return v;
  };
  const top = bpc === 16 ? 255 : maxValue;
  const value = (s, c) => decode[2 * c] + (s / top) * (decode[2 * c + 1] - decode[2 * c]); // /Decode を通した成分
  if (mask) {
    // 型抜き: 0（/Decode [1 0] なら 1）の所を塗りの色で塗る
    const [r, g, b] = rgbOf(fillColor).map((v) => v * 255);
    const paintOn = decode[0] === 1 ? 1 : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (sample(x * step, y * step, 0) === paintOn) [out[i], out[i + 1], out[i + 2], out[i + 3]] = [r, g, b, 255];
    }
    return { kind: "rgba", width: w, height: h, data: out, interpolate };
  }
  // 色: 成分の組 → RGB（同じ組は覚えておく。1 成分なら全ての値を先に作る）
  const cache = new Map();
  const colorOf = (comps) => {
    const key = comps.join(",");
    let rgb = cache.get(key);
    if (!rgb) {
      rgb = space.indexed ? rgbOf(space.rgb([comps[0]])) : rgbOf(space.rgb(comps.map((s, c) => value(s, c))));
      rgb = rgb.map((v) => v * 255);
      if (cache.size < 65536) cache.set(key, rgb);
    }
    return rgb;
  };
  const isRgb = n === 3 && !space.indexed && space.rgb([1, 0, 0]) === "#ff0000" && bpc === 8 && isDefaultDecode(decode);
  const keyMask = colorKey(pdf, dict, n);
  const comps = new Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < n; c++) comps[c] = sample(x * step, y * step, c);
      if (isRgb) [out[i], out[i + 1], out[i + 2]] = comps;
      else [out[i], out[i + 1], out[i + 2]] = colorOf(comps);
      out[i + 3] = keyMask && keyMask(comps) ? 0 : 255;
    }
  }
  const alpha = softMask(pdf, dict);
  if (alpha) applyAlpha(out, w, h, alpha);
  return { kind: "rgba", width: w, height: h, data: out, interpolate };
}

const isDefaultDecode = (d) => d.every((v, i) => v === (i % 2 ? 1 : 0));

/** 色の範囲の透明（/Mask が配列: 成分ごとの [下 上] に全て入る画素を透かす） */
function colorKey(pdf, dict, n) {
  const m = pdf.value(dict, "Mask");
  if (!Array.isArray(m)) return null;
  const r = m.map((v) => Number(pdf.get(v)));
  return (comps) => comps.every((s, c) => s >= r[2 * c] && s <= r[2 * c + 1]);
}

/** 透明の画像（/SMask・型抜きの /Mask）→ { width, height, data: 0〜255 }（解けなければ null） */
function softMask(pdf, dict) {
  for (const key of ["SMask", "Mask"]) {
    const m = pdf.value(dict, key);
    if (!(m instanceof PdfStream)) continue;
    try {
      const img = decodeImage(pdf, m.dict, pdf.stream(m), { fillColor: "#ffffff" });
      if (img?.kind !== "rgba") continue;
      const data = new Uint8Array(img.width * img.height);
      // /SMask は灰色の濃さ = 不透明度。型抜きの /Mask は、標本 0 の所（型抜きとして塗った所）が描かれ、1 の所が隠れる
      for (let i = 0; i < data.length; i++) data[i] = key === "SMask" ? img.data[i * 4] : img.data[i * 4 + 3];
      return { width: img.width, height: img.height, data };
    } catch {
      // 読めない透明は無視（不透明として描く）
    }
  }
  return null;
}

function applyAlpha(rgba, w, h, alpha) {
  for (let y = 0; y < h; y++) {
    const ay = Math.min(alpha.height - 1, Math.floor((y * alpha.height) / h));
    for (let x = 0; x < w; x++) {
      const ax = Math.min(alpha.width - 1, Math.floor((x * alpha.width) / w));
      const i = (y * w + x) * 4 + 3;
      rgba[i] = (rgba[i] * alpha.data[ay * alpha.width + ax]) / 255;
    }
  }
}
