// SXF（.sfc・.p21。sxf/index.js が読んだフィーチャの並び）→ 図面のモデル（model.js）。
//   座標は用紙の mm（用紙の左下が原点）。1 枚の紙のレイアウト（drawing_sheet の大きさ）に置く
//   並びの読み方（SXF Ver.3 の「フィーチャの並び」。ezsxf（MIT）の読みと突き合わせた: tools/sxf-check.mjs）:
//     ・図形は順に「部品の入れ物」にたまり、次の 3 つが入れ物を閉じる:
//         composite_curve … たまった図形が 1 本の複合曲線になる（番号は 1 から出てきた順。ハッチングの境界が番号で指す）
//         sfig_org        … たまった図形が複合図形（名前で sfig_locate が置く。部分図は縮尺 ratio で用紙に置く）
//         drawing_sheet   … たまった図形が用紙そのもの
//     ・表（画層・色・線種・線幅・文字の書体）はファイルのどこに書いてもよい（実物は用紙の後に画層を書く）ので、先に全てを読む:
//         画層 … 出てきた順に 1 から。色 … 既定の 16 色は名前で 1〜16、利用者の色は 17 から。
//         線種 … 既定の 15 種は名前で 1〜15、利用者の線種は 17 から。線幅 … 既定の 9 つ（0.13〜2.0）はその番号、ほかは 11 から
//   用紙の上の大きさで決まるもの（線種のピッチ・矢印）は、部分図の縮尺で割って、部分図の中の長さにする
//     線種のピッチ … sxf/tables.js
//     矢印 … 大きさ = 尺度 × 10 mm（用紙）と推定（基準の大きさは仕様で確かめられない。実物は縮尺の違う部分図でも同じ尺度 0.2667）
//   黒と白（色 1・8）は前景色（白地の黒・黒地の白）。CAD の地の色に合わせて白で書いた図面も読めるように

import { SxfError, isSxf, readSxf } from "../sxf/index.js";
import { COLOURS, LINETYPES, SHEETS, WIDTHS } from "../sxf/tables.js";
import { completeSpline } from "./curves.js";
import { createDrawing, unitsOf } from "./model.js";

export { SxfError, isSxf };

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

const ARROW_MM = 10; // 矢印の尺度 1 の大きさ（用紙の mm。推定）
const SEGMENTS = 64; // 曲線を折れ線にするときの、円 1 周の分け数

// フィーチャごとの数の引数の並び（style = 画層・色・線種・線幅）
const STYLE4 = ["layer", "color", "type", "width"];
const TEXT12 = ["flag", "font", "text", "x", "y", "height", "width", "spacing", "angle", "slant", "base", "direction"];
const ARROW5 = ["code", "flag", "x", "y", "scale"];
const EXT7 = ["flag", "bx", "by", "x1", "y1", "x2", "y2"];

export function drawingFromSxf(bytes) {
  const sxf = readSxf(bytes);
  const drawing = createDrawing({ format: "sxf", version: `${sxf.kind.toUpperCase()}${versionOf(sxf.header)}` });
  drawing.units = unitsOf(4);
  for (const w of sxf.warnings) drawing.failures.push({ message: w });
  const tables = readTables(sxf.features, drawing);
  const ratios = paperRatios(sxf.features);
  build(sxf.features, tables, ratios, drawing);
  return drawing;
}

/** 見出しの版（FILE_NAME の前処理系 'SCADEC_API_Ver3.10$$3.0' → " Ver.3.0"）と作ったソフト */
function versionOf(header) {
  const v = /\$\$([\d.]+)/.exec(header?.preprocessor ?? "")?.[1];
  return v ? ` Ver.${v}` : "";
}

// ---- 表 ------------------------------------------------------------------------------------------------------------
function readTables(features, drawing) {
  const layers = [], colours = new Map(), types = new Map(), widths = new Map(), fonts = [];
  let userColour = 17, userType = 17, userWidth = 11;
  COLOURS.forEach(([, rgb], i) => colours.set(i + 1, rgb));
  LINETYPES.forEach(([name], i) => types.set(i + 1, name));
  WIDTHS.forEach((w, i) => widths.set(i + 1, w));
  const register = (name, dashes, description = name) => {
    if (!drawing.linetypes.has(name)) drawing.linetypes.set(name, { name, description, dashes });
  };
  LINETYPES.forEach(([name, dashes]) => register(name, dashes));
  for (const f of features) {
    const p = f.params;
    switch (f.name) {
      case "layer": layers.push({ name: p[0] || `画層 ${layers.length + 1}`, visible: p[1] !== "0" }); break;
      case "pre_defined_colour": break; // 番号は名前で決まる（既定の 1〜16）
      case "user_defined_colour": colours.set(userColour++, (num(p[0]) << 16) | (num(p[1]) << 8) | num(p[2])); break;
      case "pre_defined_font": break;
      case "user_defined_font": {
        const pitch = list(p[2]);
        const name = p[0] || `線種 ${userType}`;
        register(name, pitch.map((v, i) => (i % 2 ? -Math.abs(v) : Math.abs(v))), `${name}（利用者の線種）`);
        types.set(userType++, name);
        break;
      }
      case "width": {
        const w = num(p[0]);
        const i = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6);
        if (i < 0) widths.set(userWidth++, w);
        break;
      }
      case "text_font": fonts.push(p[0] ?? ""); break;
    }
  }
  for (const l of layers) {
    if (!drawing.layers.has(l.name)) {
      drawing.layers.set(l.name, { name: l.name, color: { index: 7 }, off: !l.visible, frozen: false, locked: false, plot: true,
        linetype: "continuous", lineweight: -3 });
    }
  }
  return { layers, colours, types, widths, fonts };
}

/**
 * 複合図形ごとの「用紙の長さ / 図形の中の長さ」（部分図の縮尺。入れ子は掛け合わせる）。
 * 図形の置き場（sfig_locate）は、その置き場を含む入れ物（ほかの複合図形か用紙）の中にある。最初に置かれたところの縮尺を使う
 */
function paperRatios(features) {
  const placed = new Map(); // 名前 → { ratio, parent }
  let buffer = [];
  for (const f of features) {
    if (f.name === "sfig_locate") buffer.push(f);
    else if (f.name === "sfig_org" || f.name === "drawing_sheet") {
      const parent = f.name === "sfig_org" ? f.params[0] : null;
      for (const l of buffer) {
        const name = l.params[1];
        if (!placed.has(name)) placed.set(name, { ratio: Math.abs(num(l.params[5], 1)) || 1, parent });
      }
      buffer = [];
    }
  }
  const memo = new Map();
  const ratioOf = (name, depth = 0) => {
    if (name === null || depth > 32) return 1;
    if (!memo.has(name)) {
      const p = placed.get(name);
      memo.set(name, p ? p.ratio * ratioOf(p.parent, depth + 1) : 1);
    }
    return memo.get(name);
  };
  return ratioOf;
}

// ---- 図形 ----------------------------------------------------------------------------------------------------------
function build(features, tables, ratioOf, drawing) {
  let handle = 0;
  let buffer = [];
  const composites = [];
  const figures = [];
  const unsupported = (label) => drawing.unsupported.set(label, (drawing.unsupported.get(label) ?? 0) + 1);

  // 部分図の縮尺は、閉じるまで分からない（sfig_org が後に来る）。入れ物の中の図形は、閉じたときに縮尺を当てる
  const layerName = (code) => {
    const l = tables.layers[code - 1];
    if (l) return l.name;
    const name = NO_LAYER;
    if (!drawing.layers.has(name)) drawing.layers.set(name, { name, color: { index: 7 }, off: false, frozen: false, locked: false, plot: true, linetype: "continuous", lineweight: -3 });
    return name;
  };
  const colourOf = (code) => {
    const rgb = tables.colours.get(code);
    return rgb === undefined || rgb === 0 || rgb === 0xffffff ? { index: 7 } : { index: 7, rgb };
  };
  const common = (s) => ({
    handle: (++handle).toString(16).toUpperCase(), layer: layerName(int(s.layer)), color: colourOf(int(s.color)),
    linetype: tables.types.get(int(s.type)) ?? "continuous", lineweight: Math.round((tables.widths.get(int(s.width)) ?? 0.25) * 100),
    ltscale: 1, invisible: false,
  });
  const textCommon = (layer, color) => common({ layer, color, type: 1, width: 1 });
  const ctx = { common, textCommon, tables, unsupported, composites, drawing, newBlock: () => `*D${drawing.blocks.size + 1}` };

  for (const f of features) {
    const p = f.params;
    switch (f.name) {
      case "composite_curve":
      case "composite_curve_org": {
        const s = named(p, STYLE4.slice(1).concat("visible"));
        composites.push({ entities: buffer.filter((e) => e.type !== "INSERT"), color: s.color, type: s.type, width: s.width, visible: s.visible === "1" });
        buffer = [];
        break;
      }
      case "sfig_org": {
        const name = p[0] || `図形 ${figures.length + 1}`;
        figures.push({ name, kind: int(p[1]), entities: buffer });
        buffer = [];
        break;
      }
      case "drawing_sheet": {
        const [name, type, orientation, x, y] = [p[0], int(p[1]), int(p[2]), num(p[3]), num(p[4])];
        const sheet = SHEETS[type];
        let [w, h] = sheet ? [sheet[1], sheet[2]] : [x, y];
        if (sheet && orientation === 0) [w, h] = [h, w];
        if (!(w > 0 && h > 0)) [w, h] = [841, 594];
        const label = [name, sheet ? sheet[0] : `${w}×${h}`].filter(Boolean).join(" ");
        drawing.blocks.set("*Paper_Space", block("*Paper_Space", buffer));
        drawing.layouts.push({ name: label, block: "*Paper_Space", model: false, tabOrder: 0, paper: { min: [0, 0], max: [w, h] } });
        drawing.sheet = { name, size: sheet ? sheet[0] : "自由", width: w, height: h };
        buffer = [];
        break;
      }
      case "drawing_attribute": drawing.titleBlock = named(p, ["project", "work", "contract", "drawingName", "drawingNumber", "kind", "scale",
        "year", "month", "day", "contractor", "orderer"]); break;
      default: {
        const made = entitiesOf(f, ctx);
        if (made) buffer.push(...made);
        else if (!TABLES.has(f.name)) unsupported(f.name);
      }
    }
  }
  if (!drawing.layouts.length) throw new SxfError("用紙（drawing_sheet）がありません");
  if (buffer.length) drawing.failures.push({ message: `用紙の後の図形 ${buffer.length} 個は、どこにも属さないので描きません` });

  // 複合図形をブロックにする（線種のピッチ・矢印は、部分図の縮尺で割った長さ）
  const attributes = [];
  for (const fig of figures) {
    const k = ratioOf(fig.name);
    for (const e of fig.entities) scaleToPaper(e, k, drawing);
    drawing.blocks.set(fig.name, block(fig.name, fig.entities));
    if (/^\$\$ATR/.test(fig.name)) attributes.push(attributeOf(fig.name));
  }
  if (attributes.length) drawing.attributes = attributes;
  // 部分図（種類 1）の縮尺（用紙の長さ / 図形の中の長さ。見出しに出す。1 だけなら出さない）
  const scales = [...new Set(figures.filter((f) => f.kind === 1).map((f) => ratioOf(f.name)))].sort((a, b) => b - a);
  if (scales.some((k) => Math.abs(k - 1) > 1e-9)) drawing.figureScales = scales.map((k) => 1 / k);
}

/** 画層の番号 0（どの画層にも属さない。部分図を置く sfig_locate の多く）の画層の名前 */
const NO_LAYER = "画層なし";

const TABLES = new Set(["layer", "pre_defined_colour", "user_defined_colour", "pre_defined_font", "user_defined_font", "width", "text_font"]);

const block = (name, entities) => ({ name, handle: "", base: [0, 0, 0], anonymous: name.startsWith("*D"), xref: false, entities });

/** 用紙の上の大きさで決まるもの（線種・矢印・ハッチングの模様のピッチ）を、図形の中の長さにする */
function scaleToPaper(e, k, drawing) {
  if (!(k > 0) || k === 1) return;
  e.ltscale = (e.ltscale ?? 1) / k;
  if (e.type === "HATCH" && e.lines) for (const l of e.lines) l.dashes = l.dashes.map((d) => d / k);
  if (e.arrow) Object.assign(e, scaleArrow(e, k));
  if (e.type === "DIMENSION") {
    for (const part of drawing.blocks.get(e.block)?.entities ?? []) {
      if (part.arrow) Object.assign(part, scaleArrow(part, k));
      part.ltscale = (part.ltscale ?? 1) / k;
    }
  }
}

/** 属性の図形の名前 $$ATRU$$番号$$図形の名前$$属性の名前$$値（$$型$$単位） → { mechanism, figure, name, value } */
function attributeOf(name) {
  const [, mechanism, id, figure, attribute, value, type, unit] = name.split("$$");
  return { mechanism: mechanism?.replace(/^ATR/, ""), id, figure, name: attribute, value, type, unit };
}

// ---- 引数 ----------------------------------------------------------------------------------------------------------
const num = (s, fallback = 0) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
};
const int = (s) => Math.trunc(num(s));
/** '(1,2,3)' → [1, 2, 3]（数の並び） */
const list = (s) => (s ?? "").replace(/[()]/g, "").split(",").map((v) => v.trim()).filter(Boolean).map(Number);
/** 引数の並びに名前を付ける */
const named = (p, names, from = 0) => Object.fromEntries(names.map((n, i) => [n, p[from + i]]));
const at = (x, y) => [x, y, 0];

/** フィーチャ 1 つ → 図面の図形（0 個以上）。描かない（知らない）ものは null */
function entitiesOf(f, ctx) {
  const p = f.params;
  const s = named(p, STYLE4);
  const c = () => ctx.common(s);
  switch (f.name) {
    case "line": return [{ ...c(), type: "LINE", a: at(num(p[4]), num(p[5])), b: at(num(p[6]), num(p[7])) }];
    case "polyline": {
      const xs = list(p[5]), ys = list(p[6]);
      return [{ ...c(), type: "LWPOLYLINE", points: xs.map((x, i) => [x, ys[i] ?? 0]), bulges: [], widths: [], constWidth: 0, closed: false, elevation: 0 }];
    }
    case "circle": return [{ ...c(), type: "CIRCLE", center: at(num(p[4]), num(p[5])), radius: Math.abs(num(p[6])) }];
    case "arc": {
      const [start, end] = sweep(num(p[8]), num(p[9]), int(p[7]));
      return [{ ...c(), type: "ARC", center: at(num(p[4]), num(p[5])), radius: Math.abs(num(p[6])), start, end }];
    }
    case "ellipse": return [ellipseOf(c(), num(p[4]), num(p[5]), num(p[6]), num(p[7]), num(p[8]), 0, TAU)];
    case "ellipse_arc": {
      const [start, end] = sweep(num(p[10]), num(p[11]), int(p[8]));
      return [ellipseOf(c(), num(p[4]), num(p[5]), num(p[6]), num(p[7]), num(p[9]), start, end)];
    }
    case "spline": return [splineOf(c(), list(p[6]), list(p[7]), p[4] === "0")];
    case "clothoid": return [{ ...c(), type: "LWPOLYLINE", points: clothoidPoints(p.slice(4).map(Number)), bulges: [], widths: [], constWidth: 0, closed: false, elevation: 0 }];
    case "text_string": {
      const t = named(p, TEXT12.slice(1), 2);
      return [textOf(ctx.common({ layer: p[0], color: p[1], type: 1, width: 1 }), t, ctx)];
    }
    case "point_marker": return [{ ...ctx.textCommon(p[0], p[1]), type: "POINT", p: at(num(p[2]), num(p[3])) }];
    case "symbol_externally_defined": {
      ctx.unsupported("外部定義の記号（置く点だけ）");
      return [{ ...ctx.textCommon(p[0], p[1] === "1" ? p[2] : 1), type: "POINT", p: at(num(p[4]), num(p[5])) }];
    }
    case "linear_dim": return dimensionOf("linear", p, ctx);
    case "curve_dim": return dimensionOf("arc", p, ctx);
    case "angular_dim": return dimensionOf("angular", p, ctx);
    case "radius_dim": return dimensionOf("radius", p, ctx);
    case "diameter_dim": return dimensionOf("diameter", p, ctx);
    case "label": return leaderOf(p, false, ctx);
    case "balloon": return leaderOf(p, true, ctx);
    case "externally_defined_hatch": return hatchOf(f.name, p, ctx);
    case "fill_area_style_colour": return hatchOf(f.name, p, ctx);
    case "fill_area_style_hatching": return hatchOf(f.name, p, ctx);
    case "fill_area_style_tiles_hatching": return hatchOf(f.name, p, ctx);
    case "terminator": { // P21 の矢印（sxf/p21.js）
      const [layer, color, code, x, y, ux, uy, scale] = p;
      return arrowOf(ctx.textCommon(layer, color), int(code), [num(x), num(y)], [num(ux), num(uy)], num(scale, 1));
    }
    case "nurbs": { // P21 の B スプライン
      const b = JSON.parse(p[4]);
      return [{ ...c(), type: "SPLINE", degree: b.degree, knots: b.knots, controls: b.controls, weights: b.weights, fit: [], closed: b.closed, periodic: false }];
    }
    case "callout": return calloutOf(f, ctx); // P21 の寸法
    case "sfig_locate": return [{ ...ctx.textCommon(p[0], 1), color: { index: 0 }, linetype: "BYBLOCK", lineweight: -2, type: "INSERT",
      block: p[1], p: at(num(p[2]), num(p[3])), scale: [num(p[5], 1), num(p[6], 1), 1], rotation: num(p[4]) * RAD,
      columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] }];
    default: return null;
  }
}

/** SXF の円弧の向き（0 = 反時計回り・1 = 時計回り）→ 反時計回りの [始まり, 終わり]（ラジアン） */
function sweep(start, end, direction) {
  return direction === 1 ? [end * RAD, start * RAD] : [start * RAD, end * RAD];
}

/** 楕円（半径 rx は傾き rot の向き）。始まり・終わりは媒介変数。rx < ry なら長軸を 90° 回す */
function ellipseOf(c, cx, cy, rx, ry, rot, start, end) {
  const t = rot * RAD;
  let major = [rx * Math.cos(t), rx * Math.sin(t), 0], ratio = ry / (rx || 1);
  if (Math.abs(ratio) > 1) {
    major = [-ry * Math.sin(t), ry * Math.cos(t), 0];
    ratio = rx / ry;
    start -= Math.PI / 2;
    end -= Math.PI / 2;
  }
  return { ...c, type: "ELLIPSE", center: at(cx, cy), major, ratio: Math.abs(ratio), start, end, extrusion: [0, 0, 1] };
}

/**
 * スプライン。点の数が 3n+1 なら 3 次のベジェ曲線の制御点の並び（ezsxf の読み）→ 同じ形の B スプライン（つなぎ目のノットを 3 重に）。
 * そうでなければ、点を通る 3 次のスプライン
 */
function splineOf(c, xs, ys, closed) {
  const pts = xs.map((x, i) => at(x, ys[i] ?? 0));
  if (pts.length >= 4 && (pts.length - 1) % 3 === 0) {
    const n = (pts.length - 1) / 3;
    const knots = [0, 0, 0, 0];
    for (let i = 1; i < n; i++) knots.push(i, i, i);
    knots.push(n, n, n, n);
    return { ...c, type: "SPLINE", degree: 3, knots, controls: pts, weights: [], fit: [], closed, periodic: false };
  }
  return completeSpline({ ...c, type: "SPLINE", degree: 3, knots: [], controls: [], weights: [], fit: pts, closed, periodic: false });
}

/**
 * クロソイド（緩和曲線）: 基点 (bx, by)・パラメータ A・向き（1 = 右回り）・基点の接線の角度・曲線の長さ l1〜l2 の区間。
 * 長さ l の点は、接線の角度 l² / (2A²) を積み上げる（ezsxf と同じ。向きの印の意味は仕様で確かめていない）
 */
function clothoidPoints([bx, by, A, direction, angle, l1, l2]) {
  const a = Math.min(l1, l2), b = Math.max(l1, l2);
  if (!(A > 0) || !(b > 0)) return [[bx, by]];
  const n = Math.min(Math.max(8, Math.ceil((SEGMENTS * b) / A)), SEGMENTS * 16);
  const sign = direction === 1 ? -1 : 1, r = angle * RAD;
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i <= n; i++) {
    const l = (b * i) / n;
    if (i > 0) {
      const m = (b * (i - 0.5)) / n, t = (sign * m * m) / (2 * A * A), d = b / n;
      x += Math.cos(t) * d;
      y += Math.sin(t) * d;
    }
    if (l + 1e-12 >= a) out.push([bx + x * Math.cos(r) - y * Math.sin(r), by + x * Math.sin(r) + y * Math.cos(r)]);
  }
  return l1 > l2 ? out.reverse() : out;
}

/**
 * 文字: 文字列の外形（幅 width × 高さ height）の基準点（1 左下・2 下の中・3 右下・4 左の中・… 9 右上）が (x, y)。
 * 左下と右下の間に収める（幅に合わせる）。向き 2（縦書き）は横に倒した向きで近似する
 */
function textOf(c, t, ctx) {
  const h = Math.abs(num(t.height)), w = Math.abs(num(t.width));
  const base = Math.min(Math.max(int(t.base) || 1, 1), 9) - 1;
  const angle = (num(t.angle) - (int(t.direction) === 2 ? 90 : 0)) * RAD;
  const u = [Math.cos(angle), Math.sin(angle)], v = [-u[1], u[0]];
  const dx = -((base % 3) * w) / 2, dy = -(Math.floor(base / 3) * h) / 2;
  const x = num(t.x) + u[0] * dx + v[0] * dy, y = num(t.y) + u[1] * dx + v[1] * dy;
  if (int(t.direction) === 2) ctx.unsupported("縦書きの文字（横に倒して描く）");
  const font = ctx.tables.fonts[int(t.font) - 1] ?? "";
  return {
    ...c, type: "TEXT", p: at(x, y), align: w > 0 ? at(x + u[0] * w, y + u[1] * w) : null, halign: w > 0 ? 5 : 0, valign: 0, height: h,
    rotation: angle, widthFactor: 1, oblique: num(t.slant) * RAD, generation: 0, text: unescape(t.text ?? ""), style: font || "SXF",
    font: { family: /明朝|Mincho/i.test(font) ? "serif" : null, weight: 400, italic: false }, extrusion: [0, 0, 1],
  };
}
/** 文字の中の \\ は \（SFC の文字の逃がし） */
const unescape = (s) => s.replace(/\\\\/g, "\\");

// ---- 寸法・引出線 --------------------------------------------------------------------------------------------------
/**
 * 寸法 → DIMENSION（見た目は無名のブロック: 寸法線・補助線・矢印・文字）。引数の位置:
 *   長さ（44）: 寸法線 4〜7・補助線 8・15・矢印 22・27・文字 32
 *   弧長・角度（45）: 中心・半径・始まりと終わりの角 4〜8・補助線 9・16・矢印 23・28・文字 33
 *   半径（25）: 寸法線 4〜7・矢印 8・文字 13。直径（30）: 寸法線 4〜7・矢印 8・13・文字 18
 */
function dimensionOf(kind, p, ctx) {
  const s = named(p, STYLE4);
  const c = () => ctx.common(s);
  const parts = [];
  const line = (a, b) => parts.push({ ...c(), type: "LINE", a: at(...a), b: at(...b) });
  const ext = (i) => {
    const e = named(p, EXT7, i);
    if (int(e.flag) !== 0) line([num(e.x1), num(e.y1)], [num(e.x2), num(e.y2)]);
    return [num(e.bx), num(e.by)];
  };
  let measurement, textAt, arrows = [], dimText;
  const fields = { linear: [22, 27, 32], arc: [23, 28, 33], angular: [23, 28, 33], radius: [8, null, 13], diameter: [8, 13, 18] }[kind];
  if (kind === "arc" || kind === "angular") {
    const [cx, cy, r, a0, a1] = [num(p[4]), num(p[5]), Math.abs(num(p[6])), num(p[7]) * RAD, num(p[8]) * RAD];
    parts.push({ ...c(), type: "ARC", center: at(cx, cy), radius: r, start: a0, end: a1 });
    ext(9);
    ext(16);
    let span = a1 - a0;
    while (span <= 0) span += TAU;
    measurement = kind === "angular" ? span : r * span;
    const tangent = (a, sign) => [-Math.sin(a) * sign, Math.cos(a) * sign];
    arrows = [[fields[0], tangent(a0, -1)], [fields[1], tangent(a1, 1)]];
  } else {
    const a = [num(p[4]), num(p[5])], b = [num(p[6]), num(p[7])];
    line(a, b);
    measurement = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (kind === "linear") {
      const e1 = ext(8), e2 = ext(15);
      // 補助線の元の点の距離を寸法線の向きに測る（寸法線が元の点より長く引かれていても、測った長さは変わらない）
      const u = [(b[0] - a[0]) / (measurement || 1), (b[1] - a[1]) / (measurement || 1)];
      const along = Math.abs((e2[0] - e1[0]) * u[0] + (e2[1] - e1[1]) * u[1]);
      if (along > 0) measurement = along;
    }
    // 矢印の向き（印 1 = 内側のとき）: 長さ・直径は、近い方の端から外へ。半径は中心（始まり）から円弧（終わり）の向き
    const outward = (i) => {
      if (kind === "radius") return [b[0] - a[0], b[1] - a[1]];
      const x = num(p[i + 2]), y = num(p[i + 3]);
      const [near, far] = Math.hypot(x - a[0], y - a[1]) <= Math.hypot(x - b[0], y - b[1]) ? [a, b] : [b, a];
      return [near[0] - far[0], near[1] - far[1]];
    };
    arrows = fields.slice(0, 2).filter((i) => i !== null).map((i) => [i, outward(i)]);
  }
  for (const [i, dir] of arrows) {
    const ar = named(p, ARROW5, i);
    const sign = int(ar.flag) === 2 ? -1 : 1;
    parts.push(...arrowOf(c(), int(ar.code), [num(ar.x), num(ar.y)], [dir[0] * sign, dir[1] * sign], num(ar.scale, 1)));
  }
  const t = named(p, TEXT12, fields[2]);
  if (int(t.flag) !== 0 && (t.text ?? "").trim()) {
    const te = textOf(ctx.common({ layer: s.layer, color: s.color, type: 1, width: 1 }), { ...t }, ctx);
    parts.push(te);
    dimText = te.text;
    textAt = te.align ? [(te.p[0] + te.align[0]) / 2, (te.p[1] + te.align[1]) / 2, 0] : te.p;
  }
  const name = ctx.newBlock();
  ctx.drawing.blocks.set(name, block(name, parts));
  const kindName = kind === "linear" ? "aligned" : kind;
  return [{ ...c(), type: "DIMENSION", kind: kindName, block: name, text: dimText ?? "", measurement, textMid: textAt ?? null,
    p10: at(num(p[4]), num(p[5])) }];
}

/** P21 の寸法（中身の線・文字・矢印のフィーチャ）→ DIMENSION。測った値は寸法線（最初の線か円弧）の長さ（角度寸法は開き） */
function calloutOf(f, ctx) {
  const parts = f.children.flatMap((child) => entitiesOf(child, ctx) ?? []);
  const curve = parts.find((e) => e.type === "LINE" || e.type === "ARC");
  const text = parts.find((e) => e.type === "TEXT");
  let measurement = 0;
  if (curve?.type === "LINE") measurement = Math.hypot(curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]);
  if (curve?.type === "ARC") {
    let span = curve.end - curve.start;
    while (span <= 0) span += TAU;
    measurement = f.kind === "angular" ? span : curve.radius * span;
  }
  const name = ctx.newBlock();
  ctx.drawing.blocks.set(name, block(name, parts));
  const first = curve ?? parts[0];
  const p10 = first?.a ?? first?.center ?? at(0, 0);
  const textMid = text ? (text.align ? [(text.p[0] + text.align[0]) / 2, (text.p[1] + text.align[1]) / 2, 0] : text.p) : null;
  return [{ ...ctx.common({ layer: f.params[0], color: 1, type: 1, width: 1 }), type: "DIMENSION", kind: f.kind === "linear" ? "aligned" : f.kind,
    block: name, text: text?.text ?? "", measurement, textMid, p10 }];
}

/** 引出線（label: 折れ線・矢印・文字）・バルーン（balloon: それに円） */
function leaderOf(p, balloon, ctx) {
  const s = named(p, STYLE4);
  const c = () => ctx.common(s);
  const xs = list(p[5]), ys = list(p[6]);
  const pts = xs.map((x, i) => [x, ys[i] ?? 0]);
  const out = [{ ...c(), type: "LWPOLYLINE", points: pts, bulges: [], widths: [], constWidth: 0, closed: false, elevation: 0 }];
  let i = 7;
  if (balloon) {
    out.push({ ...c(), type: "CIRCLE", center: at(num(p[7]), num(p[8])), radius: Math.abs(num(p[9])) });
    i = 10;
  }
  if (pts.length >= 2) {
    const dir = [pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]];
    out.push(...arrowOf(c(), int(p[i]), pts[0], dir, num(p[i + 1], 1)));
  }
  const t = named(p, TEXT12, i + 2);
  if (int(t.flag) !== 0 && (t.text ?? "").trim()) out.push(textOf(ctx.common({ layer: s.layer, color: s.color, type: 1, width: 1 }), t, ctx));
  return out;
}

/**
 * 矢印（先端 tip・向き dir・尺度 scale）。大きさは用紙の mm（部分図の中では、閉じたときに縮尺で割る: scaleArrow）。
 * 種類: 1 白抜きの矢・2 白抜きの四角・3 白抜きの点・4 寸法の起点・5 塗りの四角・6 塗りの矢・7 塗りの点・8 積分記号・9 開いた矢・
 * 10 斜線・11 白抜きの矢（線の無いもの）。0 は描かない
 */
function arrowOf(c, code, tip, dir, scale) {
  if (!code) return [];
  const len = Math.hypot(dir[0], dir[1]);
  if (!(len > 0)) return [];
  const a = { ...c, type: "PATH", fill: null, alpha: 1, width: 0, dashes: [], cap: 0, subpaths: [], arrow: { code, tip, u: [dir[0] / len, dir[1] / len], size: Math.abs(scale) * ARROW_MM } };
  return [Object.assign(a, arrowShape(a.arrow))];
}

/** 矢印の大きさを部分図の中の長さにする（k = 用紙の長さ / 図形の中の長さ） */
function scaleArrow(part, k) {
  const arrow = { ...part.arrow, size: part.arrow.size / k };
  return { arrow, ...arrowShape(arrow) };
}

function arrowShape({ code, tip, u, size }) {
  const n = [-u[1], u[0]];
  const pt = (along, side) => [tip[0] + u[0] * along + n[0] * side, tip[1] + u[1] * along + n[1] * side];
  const flat = (pts) => pts.flat();
  const half = size * Math.tan(15 * RAD);
  const sub = (pts, closed) => ({ points: flat(pts), curves: [], closed });
  const circle = (center, r) => sub(Array.from({ length: 24 }, (_, i) => [center[0] + r * Math.cos((i * TAU) / 24), center[1] + r * Math.sin((i * TAU) / 24)]), true);
  const box = (r) => sub([pt(r, r), pt(r, -r), pt(-r, -r), pt(-r, r)], true);
  switch (code) {
    case 1: case 11: return { fill: null, subpaths: [sub([pt(-size, half), tip, pt(-size, -half)], true)] };
    case 6: return { fill: "nonzero", subpaths: [sub([pt(-size, half), tip, pt(-size, -half)], true)] };
    case 9: return { fill: null, subpaths: [sub([pt(-size, half), tip, pt(-size, -half)], false)] };
    case 2: return { fill: null, subpaths: [box(size / 4)] };
    case 5: return { fill: "nonzero", subpaths: [box(size / 4)] };
    case 3: case 4: return { fill: null, subpaths: [circle(tip, size / 4)] };
    case 7: return { fill: "nonzero", subpaths: [circle(tip, size / 4)] };
    case 10: return { fill: null, subpaths: [sub([pt(-size / 2, -size / 2), pt(size / 2, size / 2)], false)] };
    default: return { fill: null, subpaths: [sub([pt(-size / 2, -size / 2), pt(size / 2, size / 2)], false)] }; // 8 積分記号など: 斜線で近似
  }
}

// ---- ハッチング ----------------------------------------------------------------------------------------------------
/**
 * ハッチング: 境界は複合曲線の番号（外側 1 つ・内側 n 個）。
 *   externally_defined_hatch … layer, 名前, 外側, n, 内側（模様の中身は外部の定義なので、境界だけ描く）
 *   fill_area_style_colour   … layer, 色, 外側, n, 内側（塗り）
 *   fill_area_style_hatching … layer, 模様の数, 模様 ×（色, 線種, 線幅, 基点 x, y, 間隔, 角度）, 外側, n, 内側
 *   fill_area_style_tiles_hatching … 15 個（外側 12・n 13・内側 14。タイルの模様は描かず境界だけ）
 *   複合曲線が「見える」（印 1）なら、その線も描く
 */
function hatchOf(name, p, ctx) {
  const tail = name === "fill_area_style_tiles_hatching" ? 12 : p.length - 3;
  const outer = int(p[tail]), inner = list(p[tail + 2]);
  const loops = [outer, ...inner].map((code) => ctx.composites[code - 1]).filter(Boolean);
  if (!loops.length) {
    ctx.unsupported("境界の分からないハッチング");
    return [];
  }
  const out = [];
  for (const cc of loops) {
    if (!cc.visible) continue;
    for (const e of cc.entities) out.push({ ...e, ...ctx.common({ layer: p[0], color: cc.color, type: cc.type, width: cc.width }) });
  }
  const rings = loops.map((cc) => ({ points: chain(cc.entities), closed: true })).filter((l) => l.points.length >= 3);
  if (!rings.length) return out;
  const base = (color) => ({ ...ctx.common({ layer: p[0], color, type: 1, width: 1 }), type: "HATCH", loops: rings, solid: false, pattern: "",
    angle: 0, scale: 1, lines: [], elevation: 0, extrusion: [0, 0, 1] });
  if (name === "fill_area_style_colour") out.push({ ...base(p[1]), solid: true, pattern: "SOLID" });
  else if (name === "fill_area_style_hatching") {
    const count = int(p[1]);
    for (let i = 0; i < count; i++) {
      const [color, type, width, x, y, spacing, angle] = list(p[2 + i]);
      const a = angle * RAD;
      const lt = ctx.drawing.linetypes.get(ctx.tables.types.get(type) ?? "continuous");
      out.push({ ...base(color), ...lineStyle(ctx, width), pattern: "SXF", lines: [{ angle: a, base: [x, y], offset: [-Math.sin(a) * spacing, Math.cos(a) * spacing],
        dashes: lt?.dashes ?? [] }] });
    }
  } else ctx.unsupported(name === "externally_defined_hatch" ? "外部定義のハッチング（境界だけ）" : "タイルのハッチング（境界だけ）");
  return out;
}
const lineStyle = (ctx, width) => ({ lineweight: Math.round((ctx.tables.widths.get(width) ?? 0.25) * 100) });

/** 複合曲線の図形を、つながる順に 1 本の点の列にする（向きの逆のものは裏返す） */
function chain(entities) {
  const parts = entities.map(pointsOf).filter((pts) => pts.length >= 2);
  if (!parts.length) return [];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (parts.length > 1) {
    const [first, second] = parts;
    const end = (pts) => [pts[0], pts.at(-1)];
    if (Math.min(...end(second).map((q) => d(first[0], q))) < Math.min(...end(second).map((q) => d(first.at(-1), q)))) first.reverse();
  }
  const out = [...parts[0]];
  for (const pts of parts.slice(1)) {
    const last = out.at(-1);
    if (d(last, pts.at(-1)) < d(last, pts[0])) pts.reverse();
    out.push(...(d(last, pts[0]) < 1e-9 ? pts.slice(1) : pts));
  }
  if (out.length > 1 && d(out[0], out.at(-1)) < 1e-9) out.pop();
  return out;
}

/** 図形 → 点の列（境界にするため。曲線は折れ線に） */
function pointsOf(e) {
  const arc = (cx, cy, r, a0, a1) => {
    let span = a1 - a0;
    while (span <= 0) span += TAU;
    const n = Math.max(4, Math.ceil((SEGMENTS * span) / TAU));
    return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(a0 + (span * i) / n), cy + r * Math.sin(a0 + (span * i) / n)]);
  };
  switch (e.type) {
    case "LINE": return [e.a.slice(0, 2), e.b.slice(0, 2)];
    case "LWPOLYLINE": return e.points.map((q) => [q[0], q[1]]);
    case "CIRCLE": return arc(e.center[0], e.center[1], e.radius, 0, TAU).slice(0, -1);
    case "ARC": return arc(e.center[0], e.center[1], e.radius, e.start, e.end);
    case "ELLIPSE": {
      let span = e.end - e.start;
      while (span <= 0) span += TAU;
      const m = e.major, len = Math.hypot(m[0], m[1]), b = len * e.ratio, u = [m[0] / len, m[1] / len];
      const n = Math.max(4, Math.ceil((SEGMENTS * span) / TAU));
      return Array.from({ length: n + 1 }, (_, i) => {
        const t = e.start + (span * i) / n, x = len * Math.cos(t), y = b * Math.sin(t);
        return [e.center[0] + x * u[0] - y * u[1], e.center[1] + x * u[1] + y * u[0]];
      });
    }
    case "SPLINE": return bezierPoints(e);
    default: return [];
  }
}

/** ベジェの並び（つなぎ目のノットが 3 重の B スプライン）か通過点 → 点の列 */
function bezierPoints(e) {
  const c = e.controls ?? [];
  const isBezier = e.degree === 3 && c.length >= 4 && (c.length - 1) % 3 === 0 && e.knots?.[4] === e.knots?.[5];
  if (!isBezier) return (e.fit?.length ? e.fit : c).map((q) => [q[0], q[1]]);
  const out = [];
  for (let k = 0; k + 3 < c.length; k += 3) {
    for (let i = k ? 1 : 0; i <= 16; i++) {
      const t = i / 16, s = 1 - t;
      const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
      out.push([0, 1].map((j) => w.reduce((sum, wi, m) => sum + wi * c[k + m][j], 0)));
    }
  }
  return out;
}
