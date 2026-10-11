// 図面のモデル（model.js）の 1 つのレイアウト → SXF の SFC（電子納品の図面。国土交通省の CAD 製図基準の SXF Ver.3.1 のフィーチャの並び）。
//   drawingToSfc(drawing, layout, { hidden, shown, fileName, measure, now }) → { bytes（SFC のファイルの中身）, notes, plan }
//     hidden・shown … 画面で隠した・表示にした画層（viewer2d/scene.js と同じ。見えているものを書く）
//     measure(text, line) → 文字の 1 行の幅（画面のフォントで測る。無ければ見積もる: viewer2d/text.js の estimateTextWidth）
//   sfcNotes(notes) → 書けなかったもの・変えたものの説明（画面と評価で使う）
//   sheetPlan(drawing, layout, extents) → 用紙と、図を置く尺度・位置
//
// 書くもの: 画面に描いたもの（viewer2d/scene.js の描画）。図面の形式に関わらず同じ規則で、描いた線・塗り・文字・点を SXF の図形にする。
//   線・円・円弧・楕円・ポリライン（太さの無いもの）… レイアウトに直に置かれ、切り取られていなければ、SXF の同じ図形で書く（形が正確に残る）
//   ほかの線（スプライン・寸法やブロックの中・ビューポートの中など）… 描いた点の列の折れ線。ビューポートの枠の外は切り取る
//   幅のある線（ポリラインの幅）… 区間ごとの四角の塗り。PDF の線の太さ … 線幅
//   塗り … 境界の複合曲線（見えない）＋塗り（fill_area_style_colour）。穴は内側の境界（含まれる深さで外側と穴を分ける）
//   文字 … 1 行ずつ text_string。基準点は揃え（左・中・右）の下（基線）、幅は画面で描いた幅（SXF の読み手は幅に合わせて描く）
//   点 … 点マーカー。画像は書かない（SXF の画像は別のファイルが要る）
// 用紙: 紙のレイアウトで用紙の大きさが分かれば（SXF・PDF・Jw_cad。DXF・DWG は範囲 limits に描いたものが収まるとき。範囲の単位は
//   知られた用紙の大きさから見分ける）、その用紙
//   （A0〜A4 は種類で、ほかは自由な大きさ）に直に書く。
//   モデル（と大きさの分からない紙のレイアウト）は部分図（sfig_org の種類 1）にし、収まるいちばん大きい尺度（1:1・1:2・1:5 …）と、
//   その尺度で収まるいちばん小さい用紙（A4〜A0）に置く（用紙の真ん中）。図の中の座標・長さは元のまま（単位が分かれば mm に直す）
// 色: 前景色（白地の黒・黒地の白）は white（SXF の CAD の多くは黒地。読み手は black・white を前景色にする）。既定の 16 色に無い色は利用者の色
// 線種: 描く破線（用紙の mm に直した長さ）が既定の 15 種と同じならその番号、ほかは利用者の線種。長さ 0 の点は 0.25 mm（既定の線種の点と同じ）
// 符号: Shift_JIS（日本の CAD と同じ）・改行は CRLF。直径の記号 ⌀・Ø は φ に（日本の図面の書き方。Shift_JIS に ⌀ は無い）、ほかの
//   Shift_JIS に無い文字は ?。文字の中の ' は ’ に（SFC の文字の区切りと紛れる）。sfcString(文字) → 書いて読み直した文字（評価で使う）
// 並び: 表（画層・色・線種・線幅・書体）→ 塗りの境界（複合曲線は、それまでにたまった図形を全て自分の線にするので先に書く）→
//   図形（描く順）→ 部分図を閉じる → 置く → 図面の属性（読んだ SXF にあれば）→ 用紙。読み直しの評価は tools/sxf-write-check.mjs

import { encodeShiftJis } from "../../core/sjis.js";
import { buildScene } from "../../viewer2d/scene.js";
import { baselineOffsets, estimateTextWidth, wrapLines } from "../../viewer2d/text.js";
import { COLOURS, LINETYPES, SHEETS, WIDTHS } from "../sxf/tables.js";
import { bulgeArc } from "./curves.js";

export const MARGIN = 10; // 用紙の縁から図までの余白（mm）
const SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const DOT_MM = 0.25; // 破線の点（長さ 0）の長さ（用紙の mm）
const FOREGROUND = 8; // 前景色 → white
// SXF の表の上限（番号の最大: 画層 256・色 256・線種 32・線幅 16。ezsxf の読みで確かめた）
const MAX_LAYERS = 256, MAX_USER_COLOURS = 240, MAX_USER_TYPES = 16, MAX_USER_WIDTHS = 6;
export const MAX_TEXT_BYTES = 256; // 文字列の長さの上限（Shift_JIS のバイト。ezsxf の読みで確かめた）
const DEG = 180 / Math.PI;
// 長さの単位（model.js の units.name）→ mm
const MM = { inch: 25.4, ft: 304.8, mi: 1609344, mm: 1, cm: 10, m: 1000, km: 1e6, "µin": 25.4e-6, mil: 0.0254, yd: 914.4, "Å": 1e-7, nm: 1e-6,
  "µm": 1e-3, dm: 100, dam: 1e4, hm: 1e5 };
const FONTS = { sans: "ＭＳ ゴシック", serif: "ＭＳ 明朝" };
const NATIVE = new Set(["LINE", "CIRCLE", "ARC", "ELLIPSE", "LWPOLYLINE"]);
const DIAMETER = /[⌀∅Øø]/g; // 直径の記号 → φ

/** 文字を SFC に書いて読み直したときの文字（' → ’・*\/ → * /・⌀ → φ・Shift_JIS に無い文字 → ?） */
export function sfcString(s) {
  const t = String(s ?? "").replaceAll("'", "’").replaceAll("*/", "* /").replace(DIAMETER, "φ");
  return new TextDecoder("shift_jis").decode(encodeShiftJis(t, () => "?").bytes);
}

// ---- 用紙と置き方 ---------------------------------------------------------------------------------------------------

/** 用紙の大きさ（mm）→ drawing_sheet の種類（A0〜A4 = 0〜4・自由 = 9）と向き（1 横・0 縦） */
function sheetOf(w, h) {
  const i = SHEETS.findIndex(([, sw, sh]) => (Math.abs(w - sw) <= 1 && Math.abs(h - sh) <= 1) || (Math.abs(w - sh) <= 1 && Math.abs(h - sw) <= 1));
  if (i >= 0) return { type: i, orientation: w >= h ? 1 : 0, width: w >= h ? SHEETS[i][1] : SHEETS[i][2], height: w >= h ? SHEETS[i][2] : SHEETS[i][1] };
  return { type: 9, orientation: 1, width: Math.ceil(w - 1e-6), height: Math.ceil(h - 1e-6) };
}

// 知られた用紙の大きさ（mm。A 判と米国の判）。紙のレイアウトの範囲の単位を見分ける
const KNOWN_PAPERS = [...SHEETS.map(([, w, h]) => [w, h]), [279.4, 215.9], [355.6, 215.9], [431.8, 279.4], [558.8, 431.8], [863.6, 558.8], [1117.6, 863.6]];
const isKnownPaper = (w, h) => KNOWN_PAPERS.some(([a, b]) => (Math.abs(w - a) <= 0.02 * a && Math.abs(h - b) <= 0.02 * b) || (Math.abs(w - b) <= 0.02 * b && Math.abs(h - a) <= 0.02 * a));

/**
 * 紙のレイアウトの用紙 → { box（図面の座標の { min, max }）, k（図面の長さ → mm）} | null。
 * 読んだ用紙の大きさ（SXF・PDF・Jw_cad。mm）か、DXF・DWG のレイアウトの範囲（limits）。limits は既定の値（0,0〜12,9）のままのことも多いので、
 * 既定の値でなく、描いたものが範囲に収まるとき（はみ出しが範囲の 5% まで）だけ使う。範囲の単位はモデルの単位と違うことがある
 * （モデルは mm、紙はインチなど）ので、範囲が知られた用紙の大きさになる倍率（図面の単位・インチ・mm の順）を選ぶ。どれでもなければ図面の単位
 */
function paperOf(layout, extents, unit) {
  if (layout.paper) return { box: layout.paper, k: 1 };
  const [min, max] = layout.limits ?? [];
  if (layout.model || !min || !max || !(max[0] > min[0] && max[1] > min[1]) || !extents) return null;
  if (min[0] === 0 && min[1] === 0 && max[0] === 12 && max[1] === 9) return null; // AutoCAD の既定の範囲（インチの 12×9）のまま
  const tol = 0.05 * Math.max(max[0] - min[0], max[1] - min[1]);
  const within = extents.min[0] >= min[0] - tol && extents.min[1] >= min[1] - tol && extents.max[0] <= max[0] + tol && extents.max[1] <= max[1] + tol;
  if (!within) return null;
  const [w, h] = [max[0] - min[0], max[1] - min[1]];
  const k = [unit, 25.4, 1].find((f) => isKnownPaper(w * f, h * f)) ?? unit;
  return { box: { min, max }, k };
}

/**
 * 用紙と置き方 → { sheet: { type, orientation, width, height, name }, figure: null | { name, ratio, at }, k, origin }
 *   k … 図面の長さ → mm（単位が分かれば。読んだ用紙の大きさのある図面は mm で読んでいるので 1）
 *   figure が無ければ用紙に直に書く: 用紙の点 = (図面の点 − origin) × k
 *   figure があれば部分図: 図の中の点 = 図面の点 × k。用紙の点 = 図の中の点 × ratio + at（ratio … 1:S なら 1/S）
 */
export function sheetPlan(drawing, layout, extents) {
  const unit = MM[drawing.units?.name] ?? 1;
  const paper = paperOf(layout, extents, unit);
  if (paper) {
    const { box, k } = paper;
    const [w, h] = [(box.max[0] - box.min[0]) * k, (box.max[1] - box.min[1]) * k];
    // 読んだ SXF の用紙は、その名前のまま（レイアウトの名前は「名前 A3」のように大きさを足してある）
    const name = drawing.format === "sxf" && drawing.sheet ? drawing.sheet.name : layout.name;
    return { sheet: { ...sheetOf(w, h), name }, figure: null, k, origin: box.min };
  }
  const k = unit;
  const min = extents ? extents.min : [0, 0], max = extents ? extents.max : [0, 0];
  const size = [(max[0] - min[0]) * k, (max[1] - min[1]) * k];
  const fits = (w, h, s) => size[0] / s + 2 * MARGIN <= w && size[1] / s + 2 * MARGIN <= h;
  let chosen = null;
  for (const s of SCALES) {
    for (let i = SHEETS.length - 1; i >= 0 && !chosen; i--) { // A4 → A0
      const [, w, h] = SHEETS[i];
      if (fits(w, h, s)) chosen = { s, w, h };
      else if (fits(h, w, s)) chosen = { s, w: h, h: w };
    }
    if (chosen) break;
  }
  const s = chosen?.s ?? SCALES.at(-1);
  const sheet = chosen ? sheetOf(chosen.w, chosen.h) : sheetOf(size[0] / s + 2 * MARGIN, size[1] / s + 2 * MARGIN);
  const ratio = 1 / s;
  // 図の外形の中心を用紙の中心に（書く値と同じ小数 6 桁に丸める: 1:S の図では、丸めの差が図の中で S 倍になる）
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  const at = [round6(sheet.width / 2 - ((min[0] + max[0]) / 2) * k * ratio), round6(sheet.height / 2 - ((min[1] + max[1]) / 2) * k * ratio)];
  return { sheet: { ...sheet, name: layout.name }, figure: { name: layout.name || "図", ratio, at }, k, origin: [0, 0] };
}

// ---- 書く道具 -------------------------------------------------------------------------------------------------------

/** 数の引数（小数 6 桁まで。末尾の 0 を省く） */
const fmt = (v) => {
  const s = (Number.isFinite(v) ? v : 0).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const S = (s) => ({ s: String(s ?? "") });
const I = (v) => ({ raw: String(Math.trunc(Number(v) || 0)) });
const F = (v) => ({ raw: fmt(v) });
const L = (list) => ({ raw: `(${list.map((v) => (Number.isInteger(v) ? String(v) : fmt(v))).join(",")})` });

// SXF Ver.3 で増えたフィーチャの注記の印（/*SXF3 … SXF3*/）
const MARKS = { drawing_attribute: "3" };

class Writer {
  features = [];
  notes = { dropped: new Map(), split: 0, quotes: 0, diameters: 0, unmapped: 0, mirrored: 0, faint: 0, layers: 0, colours: 0, types: 0, widths: 0, scale: null, sheet: null, units: null };

  add(name, ...params) {
    this.features.push({ name, params });
  }

  /** 文字の引数を逃がす: \ は \\、' は ’（SFC の文字の区切り \' と紛れる）、*\/ は * /（注記の終わりと紛れる） */
  text(s) {
    let out = String(s ?? "");
    if (out.includes("'")) {
      this.notes.quotes += out.split("'").length - 1;
      out = out.replaceAll("'", "’");
    }
    const diameters = out.match(DIAMETER)?.length ?? 0;
    if (diameters) {
      this.notes.diameters += diameters;
      out = out.replace(DIAMETER, "φ");
    }
    return out.replaceAll("\\", "\\\\").replaceAll("*/", "* /").replace(/[\r\n]+/g, " ");
  }

  drop(label, n = 1) {
    this.notes.dropped.set(label, (this.notes.dropped.get(label) ?? 0) + n);
  }

  serialize(header) {
    const body = this.features.map((f, i) => {
      const mark = MARKS[f.name] ?? "";
      const params = f.params.map((p) => (p.s !== undefined ? `\\'${this.text(p.s)}\\'` : `'${p.raw}'`)).join(",");
      return `/*SXF${mark}\n#${(i + 1) * 10} = ${f.name}_feature(${params})\nSXF${mark}*/\n`;
    });
    return header + body.join("") + "ENDSEC;\nEND-ISO-10303-21;\n";
  }
}

/** 表（画層・色・線種・線幅・書体）: 使ったものに番号を付け、最後に表のフィーチャを並べる */
class Tables {
  layers = new Map(); colours = new Map(); userColours = []; types = new Map(); userTypes = []; widths = new Map(); userWidths = []; fonts = new Map();

  constructor(writer) {
    this.w = writer;
  }

  /** 画層の番号。SFC に書く名前（sfcString）が重なる画層（Shift_JIS に無い文字だけ違うなど）は、名前に番号を足して分ける */
  /** 表の上限を越えて近いものにまとめた値（種類の数を知らせる） */
  #mergedValues = { colours: new Set(), types: new Set(), widths: new Set() };
  #merged(kind, value) {
    this.#mergedValues[kind].add(value);
    this.w.notes[kind] = this.#mergedValues[kind].size;
  }

  layer(name) {
    const key = String(name ?? "0");
    if (!this.layers.has(key)) {
      if (this.layers.size >= MAX_LAYERS) {
        this.w.notes.layers++;
        return MAX_LAYERS;
      }
      let written = sfcString(key);
      for (let n = 2; this.#names.has(written); n++) written = `${sfcString(key)}_${n}`;
      this.#names.add(written);
      this.layers.set(key, { code: this.layers.size + 1, written });
    }
    return this.layers.get(key).code;
  }
  #names = new Set();

  /** "#rrggbb"（null は前景色）→ 色の番号 */
  colour(hex) {
    if (hex === null || hex === undefined) return this.#use(FOREGROUND);
    const rgb = parseInt(hex.slice(1), 16);
    const pre = COLOURS.findIndex(([, v]) => v === rgb);
    if (pre >= 0) return this.#use(pre + 1);
    if (!this.colours.has(rgb)) {
      if (this.userColours.length >= MAX_USER_COLOURS) {
        this.#merged("colours", rgb);
        return this.#nearest(rgb);
      }
      this.userColours.push(rgb);
      this.colours.set(rgb, 16 + this.userColours.length);
    }
    return this.colours.get(rgb);
  }
  #used = new Set();
  #use(code) {
    this.#used.add(code);
    return code;
  }
  #nearest(rgb) {
    const parts = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    const d = (a, b) => parts(a).reduce((s, x, i) => s + (x - parts(b)[i]) ** 2, 0);
    const all = [...COLOURS.map(([, v], i) => [v, i + 1]), ...this.userColours.map((v, i) => [v, 17 + i])];
    const [, code] = all.reduce((best, c) => (d(c[0], rgb) < d(best[0], rgb) ? c : best));
    return code < 17 ? this.#use(code) : code;
  }

  /** 破線（用紙の mm。正 = 線・負 = すき間・0 = 点）→ 線種の番号 */
  type(dashes, toPaper) {
    const pitch = pitchOf(dashes, toPaper);
    if (!pitch) return this.#useType(1);
    const pre = LINETYPES.findIndex(([, d]) => d.length === pitch.length && d.every((v, i) => Math.abs(Math.abs(v) - pitch[i]) <= 1e-4 * Math.max(1, pitch[i])));
    if (pre >= 0) return this.#useType(pre + 1);
    const key = pitch.map(fmt).join(",");
    if (!this.types.has(key)) {
      if (this.userTypes.length >= MAX_USER_TYPES) {
        this.#merged("types", key);
        return this.#nearestType(pitch);
      }
      this.userTypes.push(pitch);
      this.types.set(key, 16 + this.userTypes.length);
    }
    return this.types.get(key);
  }
  /** いちばん近い線種（数の同じピッチの差の和。数が違えば 1 周期の差に大きな重み） */
  #nearestType(pitch) {
    const period = (p) => p.reduce((a, b) => a + Math.abs(b), 0);
    const d = (q) => (q.length === pitch.length ? q.reduce((s, v, i) => s + Math.abs(Math.abs(v) - pitch[i]), 0) : 1e3 + Math.abs(period(q) - period(pitch)));
    const all = [...LINETYPES.slice(1).map(([, q], i) => [q, i + 2]), ...this.userTypes.map((q, i) => [q, 17 + i])];
    const [, code] = all.reduce((best, c) => (d(c[0]) < d(best[0]) ? c : best));
    return code < 17 ? this.#useType(code) : code;
  }
  #usedTypes = new Set();
  #useType(code) {
    this.#usedTypes.add(code);
    return code;
  }

  /** 線幅（用紙の mm）→ 番号（既定の 9 つは 1〜9、ほかは 11 から） */
  width(mm) {
    const w = mm > 0.005 ? Math.round(mm * 100) / 100 : WIDTHS[0];
    const pre = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6);
    if (pre >= 0) {
      this.#usedWidths.add(pre + 1);
      return pre + 1;
    }
    if (!this.widths.has(w)) {
      if (this.userWidths.length >= MAX_USER_WIDTHS) { // いちばん近い線幅に
        this.#merged("widths", w);
        const all = [...WIDTHS.map((v, i) => [v, i + 1]), ...this.userWidths.map((v, i) => [v, 11 + i])];
        const [, code] = all.reduce((best, c) => (Math.abs(c[0] - w) < Math.abs(best[0] - w) ? c : best));
        if (code < 10) this.#usedWidths.add(code);
        return code;
      }
      this.userWidths.push(w);
      this.widths.set(w, 10 + this.userWidths.length);
    }
    return this.widths.get(w);
  }
  #usedWidths = new Set();

  font(family) {
    const name = family === "serif" ? FONTS.serif : FONTS.sans;
    if (!this.fonts.has(name)) this.fonts.set(name, this.fonts.size + 1);
    return this.fonts.get(name);
  }

  /** 表のフィーチャ（ファイルの先頭に置く） */
  features() {
    const out = [];
    const add = (name, ...params) => out.push({ name, params });
    for (const { written } of this.layers.values()) add("layer", S(written), I(1));
    for (const code of [...this.#used].sort((a, b) => a - b)) add("pre_defined_colour", S(COLOURS[code - 1][0]));
    for (const rgb of this.userColours) add("user_defined_colour", I((rgb >> 16) & 255), I((rgb >> 8) & 255), I(rgb & 255));
    for (const code of [...this.#usedTypes].sort((a, b) => a - b)) add("pre_defined_font", S(LINETYPES[code - 1][0]));
    this.userTypes.forEach((pitch, i) => add("user_defined_font", S(`線種${i + 1}`), I(pitch.length), L(pitch)));
    for (const code of [...this.#usedWidths].sort((a, b) => a - b)) add("width", F(WIDTHS[code - 1]));
    for (const w of this.userWidths) add("width", F(w));
    for (const name of this.fonts.keys()) add("text_font", S(name));
    return out;
  }
}

/**
 * 破線 → SXF のピッチ（線・すき間を交互に、線から始める。用紙の mm）。実線なら null。
 * 同じ種類が続けば足し、すき間で始まれば先頭のすき間を末尾へ回す（位相が少しずれるだけ）
 */
export function pitchOf(dashes, toPaper) {
  if (!dashes?.length) return null;
  let runs = dashes.map((d) => ({ on: d >= 0, len: d === 0 ? DOT_MM : Math.abs(d) * toPaper }));
  const merge = (list) => list.reduce((out, r) => {
    if (out.length && out.at(-1).on === r.on) out.at(-1).len += r.len;
    else out.push({ ...r });
    return out;
  }, []);
  runs = merge(runs);
  const firstLine = runs.findIndex((r) => r.on);
  if (firstLine < 0) return null;
  runs = merge([...runs.slice(firstLine), ...runs.slice(0, firstLine)]);
  if (runs.length > 1 && runs.at(-1).on) runs[0].len += runs.pop().len;
  return runs.length >= 2 ? runs.map((r) => r.len) : null;
}

// ---- 切り取り（ビューポート・PDF の枠） -------------------------------------------------------------------------------

const inside = (p, c) => p[0] >= c.min[0] - 1e-9 && p[0] <= c.max[0] + 1e-9 && p[1] >= c.min[1] - 1e-9 && p[1] <= c.max[1] + 1e-9;

/** 折れ線を枠で切る（Liang–Barsky）→ 枠の中の折れ線の並び */
function clipPolyline(pts, c) {
  const out = [];
  let current = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegment(pts[i], pts[i + 1], c);
    if (!seg) {
      current = null;
      continue;
    }
    const [a, b] = seg;
    if (current && Math.hypot(current.at(-1)[0] - a[0], current.at(-1)[1] - a[1]) < 1e-9) current.push(b);
    else {
      current = [a, b];
      out.push(current);
    }
  }
  return out;
}
function clipSegment(a, b, c) {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [[-d[0], a[0] - c.min[0]], [d[0], c.max[0] - a[0]], [-d[1], a[1] - c.min[1]], [d[1], c.max[1] - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 > t1) return null;
  return [[a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1]];
}
/** 多角形を枠で切る（Sutherland–Hodgman） */
function clipRing(ring, c) {
  let pts = ring;
  const edges = [[0, c.min[0], 1], [0, c.max[0], -1], [1, c.min[1], 1], [1, c.max[1], -1]];
  for (const [axis, v, sign] of edges) {
    const out = [];
    const keep = (p) => (p[axis] - v) * sign >= -1e-12;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (keep(p)) out.push(p);
      if (keep(p) !== keep(q)) {
        const t = (v - p[axis]) / (q[axis] - p[axis]);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}

const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);

/** 塗りの輪 → [{ outer, holes }]（ほかの輪に含まれる深さが偶数なら外側、奇数ならすぐ外の輪の穴） */
function groupRings(rings) {
  const boxes = rings.map((r) => r.reduce((b, p) => ({ min: [Math.min(b.min[0], p[0]), Math.min(b.min[1], p[1])], max: [Math.max(b.max[0], p[0]), Math.max(b.max[1], p[1])] }),
    { min: [Infinity, Infinity], max: [-Infinity, -Infinity] }));
  const area = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]);
  const containers = rings.map((r, i) => rings.map((_, j) => j).filter((j) => j !== i && area(boxes[j]) >= area(boxes[i]) && inside(r[0], boxes[j]) && pointInRing(r[0], rings[j])));
  const groups = new Map();
  const depth = containers.map((list) => list.length);
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) groups.set(i, { outer: r, holes: [] });
  });
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    const parent = containers[i].filter((j) => depth[j] === depth[i] - 1)[0];
    if (parent !== undefined && groups.has(parent)) groups.get(parent).holes.push(r);
    else groups.set(i, { outer: r, holes: [] });
  });
  return [...groups.values()];
}
function pointInRing([x, y], r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- 書く ---------------------------------------------------------------------------------------------------------

export function drawingToSfc(drawing, layout, { hidden, shown, fileName = "drawing.sfc", measure = null, now = new Date() } = {}) {
  const scene = buildScene(drawing, layout, { hidden, shown });
  const plan = sheetPlan(drawing, layout, scene.extents);
  const w = new Writer();
  const tables = new Tables(w);
  const { k, origin, figure } = plan;
  const toPaper = figure ? k * figure.ratio : k; // 図面の長さ → 用紙の mm
  const P = figure ? ([x, y]) => [x * k, y * k] : ([x, y]) => [(x - origin[0]) * k, (y - origin[1]) * k];
  if (k !== 1) w.notes.units = k === MM[drawing.units?.name] ? drawing.units.name : "inch"; // 紙の範囲をインチと見分けたとき（paperOf）
  if (figure && figure.ratio !== 1) w.notes.scale = Math.round(1 / figure.ratio);
  w.notes.sheet = plan.sheet;

  const boundaries = []; // 塗りの境界（先に書く）
  const body = []; // 図形（描く順）
  const style = (layer, color, dashes, mm) => [I(tables.layer(layer)), I(tables.colour(color)), I(tables.type(dashes, toPaper)), I(tables.width(mm))];
  const xs = (pts) => L(pts.map((p) => p[0])), ys = (pts) => L(pts.map((p) => p[1]));
  const polyline = (list, st, pts) => {
    if (pts.length === 2) list.push(["line", ...st, F(pts[0][0]), F(pts[0][1]), F(pts[1][0]), F(pts[1][1])]);
    else list.push(["polyline", ...st, I(pts.length), xs(pts), ys(pts)]);
  };
  let composites = 0;
  /** 塗り: 境界の複合曲線を先に、塗りを描く順に。separate … 輪をそれぞれ外側に（重なり合う幅のある線の四角。穴と見なさない） */
  const fill = (layer, color, rings, separate = false) => {
    for (const { outer, holes } of separate ? rings.map((outer) => ({ outer, holes: [] })) : groupRings(rings)) {
      const ids = [outer, ...holes].map((ring) => {
        const pts = ring.map(P);
        boundaries.push(["polyline", I(tables.layer(layer)), I(tables.colour(color)), I(tables.type(null)), I(tables.width(0)), I(pts.length + 1), xs([...pts, pts[0]]), ys([...pts, pts[0]])]);
        boundaries.push(["composite_curve_org", I(tables.colour(color)), I(tables.type(null)), I(tables.width(0)), I(0)]);
        return ++composites;
      });
      body.push(["fill_area_style_colour", I(tables.layer(layer)), I(tables.colour(color)), I(ids[0]), I(ids.length - 1), L(ids.slice(1))]);
    }
  };

  // 描いたものを描く順に（scene の z）
  const prims = [];
  for (const s of scene.strokes) for (const line of s.lines) prims.push({ z: line.z, item: line.item, stroke: s, line });
  for (const f of scene.fills) prims.push({ z: f.z, item: f.item, fill: f });
  for (const t of scene.texts) prims.push({ z: t.z, item: t.item, text: t });
  for (const p of scene.points) prims.push({ z: p.z, item: p.item, point: p });
  for (const img of scene.images) prims.push({ z: img.z, item: img.item, image: img });
  prims.sort((a, b) => a.z - b.z);
  // SXF の同じ図形で書く図形: 描いたものが切り取りの無い太さの無い線 1 本だけの、直に置かれた線・円・円弧・楕円・ポリライン
  const count = new Map();
  for (const p of prims) count.set(p.item, (count.get(p.item) ?? 0) + 1);
  const native = (p) => {
    const item = scene.items[p.item];
    const e = item?.entity;
    return p.stroke && count.get(p.item) === 1 && !p.line.width && !p.line.clip && !p.line.alpha && item.viewport === undefined && NATIVE.has(e?.type) &&
      upright(e) && !(e.type === "LWPOLYLINE" && (e.constWidth > 0 || e.widths?.some(([a, b]) => a > 0 || b > 0)));
  };

  for (const p of prims) {
    const item = scene.items[p.item];
    const layer = item?.layer ?? "0";
    if (p.stroke) {
      const { stroke: s, line } = p;
      if (line.alpha < 1) {
        w.notes.faint++;
        continue;
      }
      if (line.width > 0 && !line.weight) { // 幅のある線: 区間ごとの四角の塗り（枠で切るのは四角。帯は中心線より太い）
        const quads = segmentQuads(pairs(line.points), line.width).map((q) => (line.clip ? clipRing(q, line.clip) : q)).filter((q) => q.length >= 3);
        if (quads.length) fill(layer, s.color, quads, true);
        continue;
      }
      const mm = line.weight ? line.width * toPaper : s.lineweight / 100;
      const st = style(layer, s.color, s.dashes, mm);
      if (native(p)) {
        body.push(...nativeFeatures(item.entity, st, P, k));
        continue;
      }
      const runs = line.clip ? clipPolyline(pairs(line.points), line.clip) : [pairs(line.points)];
      for (const pts of runs) if (pts.length >= 2) polyline(body, st, pts.map(P));
    } else if (p.fill) {
      const f = p.fill;
      if (f.alpha < 1) {
        w.notes.faint++;
        continue;
      }
      const rings = f.rings.map(pairs).map((r) => (f.clip ? clipRing(r, f.clip) : r)).filter((r) => r.length >= 3);
      if (rings.length) fill(layer, f.color, rings);
    } else if (p.text) {
      const t = p.text;
      if (t.clip && !inside([t.x, t.y], t.clip)) continue;
      body.push(...textFeatures(t, layer, tables, w, P, k, measure));
    } else if (p.point) {
      if (p.point.clip && !inside([p.point.x, p.point.y], p.point.clip)) continue;
      const [x, y] = P([p.point.x, p.point.y]);
      body.push(["point_marker", I(tables.layer(layer)), I(tables.colour(p.point.color)), F(x), F(y), I(1), F(0), F(1)]);
    } else if (p.image) w.drop("画像");
  }
  for (const [type, n] of scene.unsupported ?? []) w.drop(type, n);

  // 並べる: 表 → 境界 → 図形 → （部分図を閉じて置く）→ 図面の属性 → 用紙
  for (const f of [...boundaries, ...body]) w.add(...f);
  if (figure) {
    w.add("sfig_org", S(figure.name), I(1));
    w.add("sfig_locate", I(0), S(figure.name), F(figure.at[0]), F(figure.at[1]), F(0), F(figure.ratio), F(figure.ratio));
  }
  const tb = drawing.titleBlock;
  if (tb) {
    w.add("drawing_attribute", S(tb.project), S(tb.work), S(tb.contract), S(tb.drawingName), S(tb.drawingNumber), S(tb.kind), S(tb.scale),
      I(tb.year), I(tb.month), I(tb.day), S(tb.contractor), S(tb.orderer));
  }
  const sh = plan.sheet;
  w.add("drawing_sheet", S(sh.name), I(sh.type), I(sh.orientation), I(sh.width), I(sh.height));
  w.features.unshift(...tables.features());

  const text = w.serialize(header(fileName, now)).replace(/\r?\n/g, "\r\n");
  const { bytes, unmapped } = encodeShiftJis(text, () => "?");
  w.notes.unmapped = unmapped;
  return { bytes, notes: w.notes, plan };
}

/** 角度（ラジアン）→ 度の 0 以上 360 未満（SXF の決まり）。書く桁（小数 6 桁）に丸めてから 360 を 0 に（−0.0000001° が 360 にならないように） */
export function degrees360(rad) {
  const v = Math.round(((((rad * DEG) % 360) + 360) % 360) * 1e6) / 1e6;
  return v >= 360 ? v - 360 : v;
}

/** 押し出しの向きが +Z（か無い）: 図形の座標がそのまま図面の XY */
function upright(e) {
  const n = e.extrusion;
  return !n || (Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] > 0);
}

/** SXF の同じ図形（座標は P で図の中・用紙の座標に、長さは k 倍） */
function nativeFeatures(e, st, P, k) {
  const pt = (p) => P(p).map(F);
  const angle = (a) => F(degrees360(a));
  switch (e.type) {
    case "LINE": return [["line", ...st, ...pt(e.a), ...pt(e.b)]];
    case "CIRCLE": return [["circle", ...st, ...pt(e.center), F(e.radius * k)]];
    case "ARC": return [["arc", ...st, ...pt(e.center), F(e.radius * k), I(0), angle(e.start), angle(e.end)]];
    case "ELLIPSE": {
      const rx = Math.hypot(e.major[0], e.major[1]), rot = Math.atan2(e.major[1], e.major[0]);
      const full = Math.abs(e.end - e.start - 2 * Math.PI) < 1e-9 || (e.start === 0 && e.end === 0);
      const head = [...pt(e.center), F(rx * k), F(rx * e.ratio * k)];
      return full ? [["ellipse", ...st, ...head, angle(rot)]] : [["ellipse_arc", ...st, ...head, I(0), angle(rot), angle(e.start), angle(e.end)]];
    }
    case "LWPOLYLINE": {
      const pts = e.points, n = pts.length, out = [];
      let run = [];
      const flush = () => {
        if (run.length === 2) out.push(["line", ...st, ...pt(run[0]), ...pt(run[1])]);
        else if (run.length > 2) {
          const q = run.map(P);
          out.push(["polyline", ...st, I(q.length), L(q.map((v) => v[0])), L(q.map((v) => v[1]))]);
        }
        run = [];
      };
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % n], arc = bulgeArc(a, b, e.bulges?.[i] ?? 0);
        if (!arc) {
          if (!run.length) run.push(a);
          run.push(b);
          continue;
        }
        flush();
        const [s0, s1] = arc.theta > 0 ? [arc.start, arc.start + arc.theta] : [arc.start + arc.theta, arc.start];
        out.push(["arc", ...st, ...pt(arc.center), F(arc.radius * k), I(0), angle(s0), angle(s1)]);
      }
      flush();
      return out;
    }
    default: return [];
  }
}

/** 幅のある線の区間ごとの四角 */
function segmentQuads(pts, width) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(len > 0)) continue;
    const n = [(-(b[1] - a[1]) / len) * (width / 2), ((b[0] - a[0]) / len) * (width / 2)];
    out.push([[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]]);
  }
  return out;
}

/** Shift_JIS のバイト数（SFC に書いた後の文字で数える） */
const sjisBytes = (text) => encodeShiftJis(sfcString(text), () => "?").bytes.length;

/** 文字列を、Shift_JIS で MAX_TEXT_BYTES バイト以内のまとまりに分ける（文字の途中では分けない） */
export function splitText(text) {
  const out = [];
  let current = "";
  for (const ch of text) {
    if (current && sjisBytes(current + ch) > MAX_TEXT_BYTES) {
      out.push(current);
      current = "";
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 文字 → 1 行ずつ text_string。基準点 = 揃え（1 左・2 中・3 右）の下（基線）。幅は画面で描いた幅（2 点の間に収める文字は、その長さ）。
 * Shift_JIS で 256 バイトを越える行は、越えないまとまりに分けて、左から続けて並べる（幅は測った幅の比で分ける）。
 * 書く高さが 0 になる文字は書かない（SXF の決まり）。鏡に映した文字は、映さずに同じ場所に書く（SXF に無い）
 */
function textFeatures(t, layer, tables, w, P, k, measure) {
  if (!(t.height > 0) || !t.lines.length) return [];
  if (fmt(t.height * k) === "0") {
    w.drop("高さ 0 の文字");
    return [];
  }
  const width = (line) => (measure ? measure(t, line) : estimateTextWidth(line, t.height));
  const factor = t.widthFactor || 1;
  const lines = t.mtext && t.width > 0 ? wrapLines(t.lines, t.width / factor, width) : t.lines;
  if (t.mirror || t.flip) w.notes.mirrored++;
  const offsets = baselineOffsets(t, lines.length);
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const col = t.align === "center" ? 1 : t.align === "right" ? 2 : 0;
  const angle = F(degrees360(t.rotation));
  const out = [];
  const put = (text, at, h, len, base) => out.push(["text_string", I(tables.layer(layer)), I(tables.colour(t.color)), I(tables.font(t.font?.family)), S(text),
    ...P(at).map(F), F(h * k), F(len * k), F(0), angle, F((t.oblique ?? 0) * DEG), I(base), I(1)]);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let h = t.height, len = width(line) * factor;
    if (t.fit && i === 0) {
      if (t.fit.mode === "aligned" && width(line) > 0) h *= t.fit.length / width(line);
      len = t.fit.length;
    }
    const up = offsets[i] * t.height;
    const anchor = [t.x - s * up, t.y + c * up];
    const parts = splitText(line);
    if (parts.length === 1) return put(line, anchor, h, len, col + 1);
    w.notes.split++;
    const widths = parts.map(width), sum = widths.reduce((a, b) => a + b, 0) || 1;
    let along = -(col / 2) * len; // 行の左の端から
    parts.forEach((part, j) => {
      const l = (widths[j] / sum) * len;
      put(part, [anchor[0] + c * along, anchor[1] + s * along], h, l, 1);
      along += l;
    });
  });
  return out;
}

/** ISO 10303-21 の見出し（文字は '…'。' は '' に） */
function header(fileName, now) {
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const stamp = new Date(now).toISOString().slice(0, 19);
  return ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');",
    `FILE_NAME(${q(fileName)},${q(stamp)},(''),(''),'Inventor 3Dツール$$3.1','Inventor 3Dツール','');`,
    "FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));", "ENDSEC;", "DATA;", ""].join("\n");
}

/** 書けなかったもの・変えたものの説明 */
export function sfcNotes(notes) {
  const out = [];
  const sh = notes.sheet;
  if (sh) {
    const size = sh.type === 9 ? `自由な大きさ ${sh.width}×${sh.height} mm` : `${SHEETS[sh.type][0]} ${sh.orientation ? "横" : "縦"}`;
    out.push(`用紙は ${size}${notes.scale ? `、図は 1:${notes.scale}（図の中の長さは元のまま）` : ""}`);
  }
  if (notes.units) out.push(`長さは ${notes.units} から mm に直した`);
  const dropped = [...notes.dropped].filter(([, n]) => n > 0);
  if (dropped.length) out.push(`書かなかったもの: ${dropped.map(([type, n]) => `${type} ${n}`).join("・")}`);
  if (notes.faint) out.push(`薄く描いた塗り・線 ${notes.faint} つ（細かすぎるハッチング・透明な塗り）は書かない`);
  if (notes.split) out.push(`長い文字の行 ${notes.split} つは、SXF の上限（256 バイト）に収まるよう分けて、続けて並べた`);
  if (notes.mirrored) out.push(`鏡に映した文字 ${notes.mirrored} つは、映さずに同じ場所に書いた`);
  if (notes.quotes) out.push(`文字の ' ${notes.quotes} つは ’ にした（SXF の文字の区切りと紛れる）`);
  if (notes.diameters) out.push(`直径の記号 ⌀ ${notes.diameters} つは φ にした（Shift_JIS に無い。日本の図面の書き方）`);
  if (notes.unmapped) out.push(`Shift_JIS に無い文字 ${notes.unmapped} つは ? にした`);
  if (notes.layers) out.push(`画層が 256 を越えたので、越えた分は 256 番めの画層に入れた（${notes.layers} 個）`);
  if (notes.colours) out.push(`色が多すぎるので、${notes.colours} 個は近い色にした`);
  if (notes.types) out.push(`線種が多すぎるので（SXF は利用者の線種 16 まで）、${notes.types} 種は近い線種にした`);
  if (notes.widths) out.push(`線幅が多すぎるので（SXF は既定の 9 つのほかに 6 つまで）、${notes.widths} 種は近い線幅にした`);
  return out;
}
