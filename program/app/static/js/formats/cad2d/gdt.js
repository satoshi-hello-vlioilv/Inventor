// 幾何公差の記号（AutoCAD の GDT フォントの文字 → 線と円）。幾何公差の枠（TOLERANCE）の文字の {\Fgdt;x} を描く。
// 記号は画面のフォントに頼らず形で描く（⌖ ⏥ などは、Windows の普通のフォントに無いことがある。SXF・DXF へもそのまま線で出る）。
//   gdtRuns(欄の文字) → [{ glyph: "j" } | { text: "0.05" }]（左から順）
//   GDT[文字] → { lines: [[[x, y], …]], arcs: [{ c, r, from, to }], letter?, name }（1 × 1 の升目。下端 = 文字の基線・上端 = 文字の高さ）

import { mtextLines } from "../../viewer2d/text.js";

const circle = (x, y, r) => ({ c: [x, y], r, from: 0, to: 2 * Math.PI });
const circled = (letter, name) => ({ name, lines: [], arcs: [circle(0.5, 0.5, 0.5)], letter });

export const GDT = {
  a: { name: "傾斜度", lines: [[[1, 0], [0, 0], [0.95, 0.55]]], arcs: [] },
  b: { name: "直角度", lines: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]], arcs: [] },
  c: { name: "平面度", lines: [[[0, 0.2], [0.72, 0.2], [1, 0.8], [0.28, 0.8], [0, 0.2]]], arcs: [] },
  d: { name: "面の輪郭度", lines: [[[0, 0.25], [1, 0.25]]], arcs: [{ c: [0.5, 0.25], r: 0.5, from: 0, to: Math.PI }] },
  e: { name: "真円度", lines: [], arcs: [circle(0.5, 0.5, 0.5)] },
  f: { name: "平行度", lines: [[[0.1, 0], [0.5, 1]], [[0.5, 0], [0.9, 1]]], arcs: [] },
  g: { name: "円筒度", lines: [[[0, 0], [0.55, 1]], [[0.45, 0], [1, 1]]], arcs: [circle(0.5, 0.5, 0.36)] },
  h: { name: "円周振れ", lines: [[[0.15, 0], [0.85, 1]], [[0.85, 1], [0.55, 0.92]], [[0.85, 1], [0.8, 0.7]]], arcs: [] },
  i: { name: "対称度", lines: [[[0, 0.5], [1, 0.5]], [[0.2, 0.82], [0.8, 0.82]], [[0.2, 0.18], [0.8, 0.18]]], arcs: [] },
  j: { name: "位置度", lines: [[[0, 0.5], [1, 0.5]], [[0.5, 0], [0.5, 1]]], arcs: [circle(0.5, 0.5, 0.34)] },
  k: { name: "線の輪郭度", lines: [], arcs: [{ c: [0.5, 0.25], r: 0.5, from: 0, to: Math.PI }] },
  l: circled("L", "最小実体"),
  m: circled("M", "最大実体"),
  n: { name: "直径", lines: [[[0.05, -0.05], [0.95, 1.05]]], arcs: [circle(0.5, 0.5, 0.4)] },
  p: circled("P", "突出公差域"),
  r: { name: "同軸度", lines: [], arcs: [circle(0.5, 0.5, 0.5), circle(0.5, 0.5, 0.25)] },
  s: circled("S", "サイズに無関係"),
  t: { name: "全振れ", lines: [[[0, 0], [1, 0]], [[0.05, 0], [0.45, 1]], [[0.45, 1], [0.2, 0.9]], [[0.45, 1], [0.42, 0.72]],
    [[0.55, 0], [0.95, 1]], [[0.95, 1], [0.7, 0.9]], [[0.95, 1], [0.92, 0.72]]], arcs: [] },
  u: { name: "真直度", lines: [[[0, 0.5], [1, 0.5]]], arcs: [] },
};

// 記号のフォントへの切り替え（{\Fgdt;…} の中の 1 文字ずつが記号）
const SWITCH = /\{\\[Ff]gdt(?:\|[^;]*)?;([^}]*)\}/g;

/** 幾何公差の欄の文字 → 記号と文字の並び（知らない記号の文字は、そのまま文字にする） */
export function gdtRuns(field) {
  const runs = [];
  const text = (s) => {
    const t = mtextLines(s).join(" ");
    if (t) runs.push({ text: t });
  };
  let at = 0;
  for (const m of String(field).matchAll(SWITCH)) {
    text(field.slice(at, m.index));
    for (const ch of m[1]) runs.push(GDT[ch.toLowerCase()] ? { glyph: ch.toLowerCase() } : { text: ch });
    at = m.index + m[0].length;
  }
  text(field.slice(at));
  return runs;
}
