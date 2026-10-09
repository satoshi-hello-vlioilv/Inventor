// 2 次元の図面のモデル（DWG・DXF・PDF・Jw_cad で共通。表示は viewer2d/ が受け持つ）。
//
// 図面: { format: "dwg"|"dxf"|"pdf"|"jww", version, codepage, units: { code, name }, ltscale, layers, linetypes, styles, blocks, layouts, unsupported, failures }
//   ltscale   … 線種の尺度（$LTSCALE。DWG で見出しの変数を読めなければ 1 で、わけを headerError に）
//   layers    … Map<名前, { name, color: { index, rgb? }, off, frozen, locked, plot, linetype, lineweight, scale? }>
//               scale … 画層の縮尺（実寸 = 図面の長さ × scale。Jw_cad の画層グループの縮尺 1/scale。無ければ 1）
//   linetypes … Map<名前, { name, description, dashes: [長さ（正 = 線・負 = すき間・0 = 点）] }>
//   styles    … Map<名前, { name, font, bigFont, height, widthFactor, oblique }>
//   blocks    … Map<名前, { name, handle（ブロックの記録のハンドル。16 進）, base: [x, y, z], anonymous, xref, entities: [図形] }>
//               （*Model_Space・*Paper_Space… も 1 つのブロック。DWG の無名のブロックは名前に番号が無いので、読み取りが番号を振る）
//   layouts   … [{ name, block, model: bool, tabOrder, limits?, extents? }]（モデルが先、残りはタブの順）
//   unsupported … Map<種類, 数>（読んだが、まだ描かない図形）、failures … 読めなかったオブジェクト
//
// 図形（共通の値）: { type, handle, layer, color: { index（256 = 画層・0 = ブロック・1〜255 = 色番号）, rgb? }, linetype（名前・"BYLAYER"・
//   "BYBLOCK"・"CONTINUOUS"）, lineweight（1/100 mm。-1 = 画層・-2 = ブロック・-3 = 既定）, ltscale, invisible }
// 種類ごと（座標は WCS。円・円弧・ポリライン・文字・ブロック参照などは OCS の値と extrusion を持つ）:
//   LINE { a, b }・POINT { p }・CIRCLE { center, radius }・ARC { center, radius, start, end（ラジアン・反時計回り） }
//   ELLIPSE { center, major（長軸の端までのベクトル）, ratio, start, end（媒介変数） }
//   LWPOLYLINE { points: [[x, y]], bulges, widths, constWidth, closed, elevation }
//   POLYLINE { kind: "2d"|"3d"|"mesh"|"pface", vertices: [{ p, bulge }], closed, m?, n?, faces? }
//   SPLINE { degree, knots, controls, weights, fit, closed, periodic }（通過点だけのものも、制御点とノットを計算して入れる: curves.js）
//   TEXT・ATTDEF・ATTRIB { p, align, height, rotation, widthFactor, oblique, halign, valign, generation, text, style, tag? }
//   MTEXT { p, direction, height, width, attach, text（書式の符号つき）, style, lineSpacing }
//   文字列は、文字の逃がし（\U+XXXX・\M+NXXXX）を文字に戻してある（cadText）。書式の符号（%%c・\P など）は表示が解く
//   INSERT { block, p, scale, rotation, columns, rows, columnSpacing, rowSpacing, attribs: [ATTRIB] }
//   DIMENSION { kind, block（見た目の無名のブロック）, text, measurement, textMid, p10〜p16 }
//   HATCH { loops: [{ edges } | { points, bulges, closed }], solid, pattern, angle, scale, lines, elevation }
//   SOLID { points: [4 点] }・3DFACE { points, invisibleEdges }・LEADER { points, arrow }・RAY・XLINE { p, direction }
//   VIEWPORT { center, width, height, viewCenter, viewHeight, twist }

export function createDrawing({ format, version, codepage = null }) {
  return {
    format, version, codepage, units: unitsOf(0), ltscale: 1,
    layers: new Map(), linetypes: new Map(), styles: new Map(), blocks: new Map(), layouts: [],
    unsupported: new Map(), failures: [],
  };
}

/** レイアウトの並び: モデルを先に、紙のレイアウトはタブの順。モデルのレイアウトが無ければ作る */
export function normalizeLayouts(layouts, blocks, modelName = "*Model_Space") {
  const isModel = (l) => /^\*model_space$/i.test(l.block ?? "");
  const out = layouts.filter((l) => l.block && blocks.has(l.block)).map((l) => ({ ...l, model: isModel(l) }));
  if (!out.some((l) => l.model) && blocks.has(modelName)) out.push({ name: "Model", block: modelName, model: true, tabOrder: 0 });
  out.sort((a, b) => Number(b.model) - Number(a.model) || (a.tabOrder ?? 0) - (b.tabOrder ?? 0));
  return out;
}

/** 画層の縮尺（layers の scale）の並び（小さい順）。どの画層も 1 なら空（実寸と図面の長さが同じ） */
export function layerScales(drawing) {
  const scales = [...new Set([...drawing.layers.values()].map((l) => l.scale).filter((k) => k > 0))].sort((a, b) => a - b);
  return scales.some((k) => k !== 1) ? scales : [];
}

/** 尺度の表記（1:2・2:1 など。きれいな比でなければ小数）。k は図面の長さ / 実寸（ビューポートなら紙の長さ / モデルの長さ） */
export function scaleText(k) {
  if (!(k > 0)) return "—";
  const near = (v) => Math.abs(v - Math.round(v)) < 1e-6 * Math.max(1, v);
  if (k >= 1 && near(k)) return `${Math.round(k)}:1`;
  if (k < 1 && near(1 / k)) return `1:${Math.round(1 / k)}`;
  return String(Number(k.toFixed(4)));
}

// $INSUNITS の番号 → 単位（DXF の説明書）
const UNITS = ["", "inch", "ft", "mi", "mm", "cm", "m", "km", "µin", "mil", "yd", "Å", "nm", "µm", "dm", "dam", "hm", "Gm", "AU", "ly", "pc"];
export function unitsOf(code) {
  return { code, name: UNITS[code] ?? "" };
}

// 文字の逃がし: \U+XXXX（Unicode）・\M+NXXXX（N の文字コードの 2 バイト文字）。前の \ が偶数個のときだけ（\\ は \ そのもの）
const MULTIBYTE = { 1: "shift_jis", 2: "big5", 3: "euc-kr", 4: "euc-kr", 5: "gbk" };
const ESCAPE = /(?<!\\)((?:\\\\)*)\\(?:U\+([0-9A-Fa-f]{4})|M\+([1-5])([0-9A-Fa-f]{4}))/g;
const decoders = new Map();
function multibyte(n, hex) {
  const label = MULTIBYTE[n];
  try {
    if (!decoders.has(label)) decoders.set(label, new TextDecoder(label));
    return decoders.get(label).decode(Uint8Array.of(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)));
  } catch {
    return "?";
  }
}
export function cadText(s) {
  if (typeof s !== "string" || !s.includes("\\")) return s;
  return s.replace(ESCAPE, (_, slashes, u, n, hex) => slashes + (u ? String.fromCodePoint(parseInt(u, 16)) : multibyte(n, hex)));
}
