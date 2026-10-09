// SXF の SFC・P21 で共通のもの: 読めないときの失敗の型と、既定の表（SXF Ver.3.1 の共通要素。番号は 1 から並びの順）
//   色 … 既定の 16 色（名前・RGB）。利用者の色は 17 から
//   線種 … 既定の 15 種（名前・用紙の mm のピッチ。正 = 線・負 = すき間）。利用者の線種は 17 から
//     ピッチは ezsxf（MIT）が SXF Ver.3.1 の共通要素の仕様から引いたとする値（原典は確かめていない）
//   線幅 … 既定の 9 つ（mm）。ほかの線幅は 11 から
//   用紙 … drawing_sheet の種類 0〜4 = A0〜A4（横置きの幅・高さ mm）。9 = 自由
//   矢印 … 番号 1〜11 の名前（P21 の PRE_DEFINED_TERMINATOR_SYMBOL の名前）

/** 利用者に見せる説明を持つ読み取りの失敗 */
export class SxfError extends Error {}

export const COLOURS = [
  ["black", 0x000000], ["red", 0xff0000], ["green", 0x00ff00], ["blue", 0x0000ff], ["yellow", 0xffff00], ["magenta", 0xff00ff],
  ["cyan", 0x00ffff], ["white", 0xffffff], ["deeppink", 0xc00080], ["brown", 0xc08040], ["orange", 0xff8000], ["lightgreen", 0x80c080],
  ["lightblue", 0x0080ff], ["lavender", 0x8040ff], ["lightgray", 0xc0c0c0], ["darkgray", 0x808080],
];

const DASH = 6, LONG = 12, CHAIN = 3.5, DOT = 0.25, GAP = 1.5;
const repeat = (n, ...v) => Array.from({ length: n }, () => v).flat();
export const LINETYPES = [
  ["continuous", []], ["dashed", [DASH, -GAP]], ["dashed spaced", [DASH, -DASH]],
  ["long dashed dotted", [LONG, -GAP, ...repeat(1, DOT, -GAP)]], ["long dashed double-dotted", [LONG, -GAP, ...repeat(2, DOT, -GAP)]],
  ["long dashed triplicate-dotted", [LONG, -GAP, ...repeat(3, DOT, -GAP)]], ["dotted", [DOT, -GAP]],
  ["chain", [LONG, -GAP, CHAIN, -GAP]], ["chain double dash", [LONG, -GAP, ...repeat(2, CHAIN, -GAP)]],
  ["dashed dotted", [DASH, -GAP, DOT, -GAP]], ["double-dashed dotted", [...repeat(2, DASH, -GAP), DOT, -GAP]],
  ["dashed double-dotted", [DASH, -GAP, ...repeat(2, DOT, -GAP)]], ["double-dashed double-dotted", [...repeat(2, DASH, -GAP), ...repeat(2, DOT, -GAP)]],
  ["dashed triplicate-dotted", [DASH, -GAP, ...repeat(3, DOT, -GAP)]],
  ["double-dashed triplicate-dotted", [...repeat(2, DASH, -GAP), ...repeat(3, DOT, -GAP)]],
];

export const WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0];

export const SHEETS = [["A0", 1189, 841], ["A1", 841, 594], ["A2", 594, 420], ["A3", 420, 297], ["A4", 297, 210]];

export const ARROWS = ["blanked arrow", "blanked box", "blanked dot", "dimension origin", "filled box", "filled arrow", "filled dot",
  "integral symbol", "open arrow", "slash", "unfilled arrow"];

/** 名前（大文字・小文字・空白の違いは問わない）→ 1 からの番号。無ければ 0 */
export const codeOf = (list, name) => {
  const key = String(name ?? "").toLowerCase().replace(/[\s_]+/g, " ").trim();
  return list.findIndex((item) => (Array.isArray(item) ? item[0] : item) === key) + 1;
};
