// AutoCAD の色番号（ACI）→ 色。1〜9 は決まった色、10〜249 は色相 15° 刻み × 明るさ 5 段 × 彩度 2 段、250〜255 は灰色。
// 7 は背景で白か黒が替わる（ここでは null。描く側が背景に合わせる）。0 = ブロックごと・256 = 画層ごと（描く側が解く）。

const FIXED = [null, "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", null, "#808080", "#c0c0c0"];
const GRAYS = [51, 91, 132, 173, 214, 255]; // 250〜255（AutoCAD 2000 以降の値）
const VALUES = [255, 165, 127, 76, 38]; // 下 1 桁 0・1 → 255、2・3 → 165 …（偶数は彩度 1、奇数は 0.5）

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
// 色番号の色は切り捨て（AutoCAD の値: 13 番 = 165,82,82・15 番 = 127,63,63）
const floorHex = (r, g, b) => hex(Math.floor(r + 1e-9), Math.floor(g + 1e-9), Math.floor(b + 1e-9));

function hsv(hue, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

export const ACI = Array.from({ length: 256 }, (_, i) => {
  if (i < 10) return FIXED[i];
  if (i >= 250) return hex(GRAYS[i - 250], GRAYS[i - 250], GRAYS[i - 250]);
  const hue = Math.floor((i - 10) / 10) * 15, k = i % 10;
  return floorHex(...hsv(hue, k % 2 ? 0.5 : 1, VALUES[k >> 1]));
});

/** 真の色（24 ビットの整数）→ "#rrggbb" */
export const rgbHex = (rgb) => `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;

// ---- 地に対して読める色 ------------------------------------------------------------------------------------------
const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const parse = (css) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const r = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css);
  return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** コントラスト比（WCAG。1〜21） */
export function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

/**
 * 地 background に対してコントラスト比が minimum に届かない色を、色相を保ったまま前景（ink）の側へ寄せて読めるようにする。
 * 白地のシアン・黄色（寸法・中心線によく使う）を、青緑・黄土色にする。届いている色はそのまま。
 */
export function readable(color, background, ink, minimum) {
  const c = parse(color), bg = parse(background), fg = parse(ink);
  if (!c || !bg || !fg || !(minimum > 1) || contrast(c, bg) >= minimum) return color;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const mixed = c.map((v, i) => Math.round(v + (fg[i] - v) * t));
    if (contrast(mixed, bg) >= minimum) return hex(...mixed);
  }
  return ink;
}
