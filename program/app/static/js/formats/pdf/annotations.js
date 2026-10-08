// 見た目（/AP）を持たない注記の見た目を作る（ISO 32000-1 の 12.5.6。PDF の読み手が普通にすること）。
// 図面の確認でよく使う注記（朱書き）: 強調・下線・取り消し線・波線・四角・円・線・多角形・折れ線・手書き（Ink）・文字（FreeText）・
// 付箋（Text）の印・フォームの欄（枠・背景・値）。座標は受け手の座標にして sink に渡す（content.js と同じ受け手）。

import { colorSpaceColor } from "./colorspace.js";
import { PdfName, PdfString } from "./objects.js";

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const SANS = { name: "Helvetica", family: "sans-serif", weight: 400, italic: false, widthsKnown: false };
const KAPPA = 0.5522847498; // 円を 4 つの 3 次ベジェで近似する係数

/** 注記を描く（描けた = true）。base: ページの空間 → 受け手の座標 */
export function drawAnnotation(pdf, annot, subtype, base, sink, layer) {
  const color = colorOf(pdf, pdf.value(annot, "C"));
  const fillColor = colorOf(pdf, pdf.value(annot, "IC"));
  const alpha = Number(pdf.value(annot, "CA", 1));
  const bs = pdf.value(annot, "BS");
  const border = pdf.value(annot, "Border");
  const width = bs instanceof Map ? Number(pdf.value(bs, "W", 1)) : Array.isArray(border) ? Number(pdf.get(border[2]) ?? 1) : 1;
  const dashes = bs instanceof Map && pdf.name(bs, "S") === "D" ? (pdf.numbers(bs, "D") ?? [3]) : [];
  const scale = Math.sqrt(Math.abs(base[0] * base[3] - base[1] * base[2]));
  const rect = normalize(pdf.numbers(annot, "Rect"));
  const at = (x, y) => apply(base, x, y);
  const poly = (pts, closed) => ({ points: pts.flatMap(([x, y]) => at(x, y)), curves: [], closed });
  const stroke = (subpaths, c = color, w = width) => c && w > 0 && sink.path({ subpaths, layer, clip: null, fill: null,
    stroke: { color: c, width: w * scale, dashes: dashes.map((d) => d * scale), cap: 1, alpha } });
  const fill = (subpaths, c, a = alpha) => c && sink.path({ subpaths, layer, clip: null, stroke: null, fill: { color: c, rule: "nonzero", alpha: a } });
  const quads = () => {
    const q = pdf.numbers(annot, "QuadPoints") ?? [];
    const out = [];
    for (let i = 0; i + 7 < q.length; i += 8) out.push([[q[i], q[i + 1]], [q[i + 2], q[i + 3]], [q[i + 6], q[i + 7]], [q[i + 4], q[i + 5]]]);
    return out; // 左上・右上・右下・左下（QuadPoints は 左上・右上・左下・右下 の順）
  };
  switch (subtype) {
    case "Highlight":
      for (const q of quads()) fill([poly(q, true)], color ?? "#ffff00", Math.min(alpha, 0.4));
      return true;
    case "Underline": case "StrikeOut": case "Squiggly":
      for (const [ul, ur, lr, ll] of quads()) {
        const h = Math.hypot(ul[0] - ll[0], ul[1] - ll[1]);
        const t = subtype === "StrikeOut" ? 0.5 : 0.1;
        const a = [ll[0] + (ul[0] - ll[0]) * t, ll[1] + (ul[1] - ll[1]) * t], b = [lr[0] + (ur[0] - lr[0]) * t, lr[1] + (ur[1] - lr[1]) * t];
        if (subtype !== "Squiggly") stroke([poly([a, b], false)], color, Math.max(1, h / 14));
        else {
          const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / (h / 6)));
          stroke([poly(Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n + (i % 2 ? h / 12 : 0)]), false)],
            color, Math.max(1, h / 20));
        }
      }
      return true;
    case "Square": case "Circle": {
      if (!rect) return false;
      const d = width / 2;
      const [x0, y0, x1, y1] = [rect[0] + d, rect[1] + d, rect[2] - d, rect[3] - d];
      const sub = subtype === "Square" ? poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true) : ellipse(at, x0, y0, x1, y1);
      fill([sub], fillColor);
      stroke([sub]);
      return true;
    }
    case "Line": {
      const l = pdf.numbers(annot, "L");
      if (l?.length === 4) stroke([poly([[l[0], l[1]], [l[2], l[3]]], false)]);
      return true;
    }
    case "Polygon": case "PolyLine": {
      const v = pdf.numbers(annot, "Vertices") ?? [];
      const pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      if (pts.length > 1) {
        if (subtype === "Polygon") fill([poly(pts, true)], fillColor);
        stroke([poly(pts, subtype === "Polygon")]);
      }
      return true;
    }
    case "Ink":
      for (const list of pdf.value(annot, "InkList") ?? []) {
        const v = (pdf.get(list) ?? []).map((x) => Number(pdf.get(x)));
        const pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
        if (pts.length > 1) stroke([poly(pts, false)]);
      }
      return true;
    case "FreeText": {
      if (!rect) return false;
      const { size, color: textColor } = defaultAppearance(pdf, annot);
      const text = textOf(pdf.value(annot, "Contents"));
      if (fillColor || color) fill([poly([[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]], true)], color);
      text.split(/\r\n|\r|\n/).forEach((line, i) => line && emitText(sink, line, at, rect[0] + 2, rect[3] - 2 - size * (i + 1), size, scale, base, textColor, layer));
      return true;
    }
    case "Text": {
      // 付箋: 小さな紙の印（線 3 本）
      if (!rect) return false;
      const s = 14, x = rect[0], y = Math.max(rect[1], rect[3]) - s;
      const sub = poly([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], true);
      fill([sub], color ?? "#ffd83a", 1);
      stroke([sub], "#5a5040", 0.6);
      for (let i = 1; i <= 3; i++) stroke([poly([[x + 3, y + s - 3.5 * i], [x + s - 3, y + s - 3.5 * i]], false)], "#5a5040", 0.6);
      return true;
    }
    case "Link": return true; // リンクの枠は画面の飾り（印刷されない）。MuPDF と同じく描かない
    case "Widget": return widget(pdf, annot, rect, at, scale, base, sink, layer, { fill, stroke, poly, width });
  }
  return false;
}

/** フォームの欄: 背景（/MK /BG）・枠（/MK /BC）・値（文字の欄）・チェック（チェックの欄） */
function widget(pdf, annot, rect, at, scale, base, sink, layer, { fill, stroke, poly, width }) {
  if (!rect) return false;
  const mk = pdf.value(annot, "MK");
  const box = poly([[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]], true);
  fill([box], colorOf(pdf, pdf.value(mk, "BG")), 1);
  const borderColor = colorOf(pdf, pdf.value(mk, "BC"));
  if (borderColor) stroke([poly([[rect[0] + width / 2, rect[1] + width / 2], [rect[2] - width / 2, rect[1] + width / 2],
    [rect[2] - width / 2, rect[3] - width / 2], [rect[0] + width / 2, rect[3] - width / 2]], true)], borderColor, width);
  const field = fieldValue(pdf, annot, "FT");
  const { size, color } = defaultAppearance(pdf, annot);
  if (field === "Tx") {
    const value = textOf(fieldValue(pdf, annot, "V"));
    const h = rect[3] - rect[1];
    const s = size || Math.min(12, h * 0.7);
    if (value) emitText(sink, value, at, rect[0] + 2, rect[1] + (h - s * 0.7) / 2, s, scale, base, color, layer);
  } else if (field === "Btn") {
    const state = pdf.name(annot, "AS");
    if (state && state !== "Off") {
      const h = rect[3] - rect[1];
      emitText(sink, "✓", at, rect[0] + h * 0.15, rect[1] + h * 0.2, h * 0.8, scale, base, color, layer);
    }
  }
  return true;
}

/** 欄の値（欄の親から受け継ぐ） */
function fieldValue(pdf, annot, key) {
  for (let node = annot, depth = 0; node instanceof Map && depth < 16; node = pdf.value(node, "Parent"), depth++) {
    if (node.has(key)) {
      const v = pdf.value(node, key);
      return v instanceof PdfName ? v.name : v;
    }
  }
  return null;
}

/** /DA（"/Helv 12 Tf 0 0 1 rg" など）→ 文字の大きさと色 */
function defaultAppearance(pdf, annot) {
  const da = textOf(fieldValue(pdf, annot, "DA") ?? pdf.value(pdf.catalog, "AcroForm")?.get?.("DA"));
  const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 0;
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const gray = /([\d.]+)\s+g\b/.exec(da);
  const color = rgb ? colorOf(pdf, rgb.slice(1, 4).map(Number)) : gray ? colorOf(pdf, [Number(gray[1])]) : "#000000";
  return { size: size || 10, color };
}

function emitText(sink, text, at, x, y, size, scale, base, color, layer) {
  const angle = Math.atan2(base[1], base[0]);
  sink.text({ text, origin: at(x, y), end: null, height: size * scale, angle, oblique: 0, mirror: false, color: color ?? "#000000", font: SANS, layer, clip: null });
}

/** 楕円（4 つの 3 次ベジェ） */
function ellipse(at, x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  const pts = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry], [cx + rx, cy]];
  const ctrl = [[[cx + rx, cy + ky], [cx + kx, cy + ry]], [[cx - kx, cy + ry], [cx - rx, cy + ky]], [[cx - rx, cy - ky], [cx - kx, cy - ry]], [[cx + kx, cy - ry], [cx + rx, cy - ky]]];
  return {
    points: pts.flatMap(([x, y]) => at(x, y)),
    curves: ctrl.map(([a, b], i) => [i, ...at(...a), ...at(...b)]),
    closed: true,
  };
}

const normalize = (r) => (r?.length === 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : null);
const textOf = (v) => (v instanceof PdfString ? v.text() : typeof v === "string" ? v : "");

/** 注記の色の配列（0 成分 = 色なし・1 灰・3 RGB・4 CMYK）→ "#rrggbb" か null */
function colorOf(pdf, v) {
  v = pdf.get(v);
  if (!Array.isArray(v) || !v.length) return null;
  return colorSpaceColor(v.map((x) => Number(pdf.get(x)) || 0));
}
