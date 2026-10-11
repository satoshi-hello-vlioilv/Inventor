// 2 次元の図面のモデル（DWG・DXF・PDF・Jw_cad で共通。表示は viewer2d/ が受け持つ）。
//
// 図面: { format: "dwg"|"dxf"|"pdf"|"jww", version, codepage, units: { code, name }, ltscale, layers, linetypes, styles, dimstyles, blocks, layouts,
//   unsupported, failures }
//   ltscale   … 線種の尺度（$LTSCALE。DWG で見出しの変数を読めなければ 1 で、わけを headerError に）
//   layers    … Map<名前, { name, color: { index, rgb? }, off, frozen, locked, plot, linetype, lineweight, scale? }>
//               scale … 画層の縮尺（実寸 = 図面の長さ × scale。Jw_cad の画層グループの縮尺 1/scale。無ければ 1）
//   linetypes … Map<名前, { name, description, dashes: [長さ（正 = 線・負 = すき間・0 = 点）] }>
//   styles    … Map<名前, { name, font, bigFont, height, widthFactor, oblique }>
//   dimstyles … Map<名前, { name, values: { 寸法変数の DXF の番号: 値 }, textStyle }>（幾何公差が使う値だけ: DIM_VARS。無い値は AutoCAD の既定。
//               色（176・178）は色番号か { index, rgb? }。値は dimVar で引く）
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
//   ACAD_TABLE { block（中身を描いた無名のブロック *T…）, p, scale, direction（表の横の向き。WCS） }（ブロック参照と同じに描く）
//   TOLERANCE（幾何公差の枠）{ p, direction, text（%%v で欄・改行で段を区切る。{\Fgdt;x} は幾何公差の記号）, dimstyle, overrides（寸法変数の上書き） }
//   MULTILEADER { scale, base, textHeight, arrowSize, landingGap（全体の尺度を掛け済み）, leaderType（0 見えない・1 直線・2 スプライン）,
//     lineColor, lineLinetype, lineLineweight（引出線の色・線種・太さ）, arrow（矢印のブロックの名前。"" = 塗った三角）, arrows: [[線の番号, ブロック]],
//     landing, dogleg, frame（文字の枠）, attachment: { vertical, left, right, top, bottom }（文字への付け方。下線などの番号）,
//     text: { text（MTEXT の書式）, p, direction, extrusion, width, lineSpacing, color, attach, style } | null,
//     content: { block, p, scale, rotation, extrusion, color } | null（ブロックの中身）,
//     leaders: [{ last（最後の点）, doglegDirection, doglegLength, vertical, lines: [{ points, index, color? }] }] }
//     色は { index, rgb? }（index 0 = 図形の色を継ぐ・256 = 画層）
//   ACIS { solid（3DSOLID・REGION・BODY・PLANESURFACE など）, acis（ACIS の形のデータ。SAB か SAT のバイト列。無ければ null） }
//     2D では稜線を描き、3D の表示（drawing.models3d の format: "ACIS"。cad2d/solids3d.js）では面を描く

export function createDrawing({ format, version, codepage = null }) {
  return {
    format, version, codepage, units: unitsOf(0), ltscale: 1,
    layers: new Map(), linetypes: new Map(), styles: new Map(), dimstyles: new Map(), blocks: new Map(), layouts: [],
    unsupported: new Map(), failures: [],
  };
}

// 寸法変数（DXF の番号 → AutoCAD の既定。インチの図面の既定。メートルの図面の寸法スタイルは値を書いてある）
export const DIM_VARS = { 40: 1, 41: 0.18, 140: 0.18, 147: 0.09, 176: 0, 178: 0 }; // DIMSCALE・DIMASZ・DIMTXT・DIMGAP・DIMCLRD・DIMCLRT

/** 寸法スタイル（読み手が番号 → 値を引く value(番号) を渡す。340 = DIMTXSTY の文字スタイルのハンドル） */
export function dimstyle(name, value) {
  const values = {};
  for (const code of Object.keys(DIM_VARS)) {
    const v = value(Number(code));
    if (v !== undefined) values[code] = v;
  }
  return { name, values, refs: { textStyle: value(340) } };
}

const DIM_COLORS = new Set([176, 178]); // 色の寸法変数（値は色番号か { index, rgb? }）

/** 寸法変数の値（図形の上書き → 寸法スタイル → 既定）。色の変数は { index, rgb? } で返す */
export function dimVar(drawing, styleName, overrides, code) {
  const key = String(styleName ?? "").toLowerCase();
  const style = [...(drawing.dimstyles?.values() ?? [])].find((s) => s.name.toLowerCase() === key) ?? drawing.dimstyles?.get("Standard");
  const v = overrides?.[code] ?? style?.values[code] ?? DIM_VARS[code];
  return DIM_COLORS.has(code) && typeof v === "number" ? { index: v } : v;
}

/** 色の 32 ビットの値（マルチ引出線など: 上の 8 ビットが種類 C0 画層・C1 ブロック・C2 RGB・C3 色番号）→ { index, rgb? } */
export function rawColor(v) {
  const kind = (v >>> 24) & 0xff;
  if (kind === 0xc0) return { index: 256 };
  if (kind === 0xc1) return { index: 0 };
  if (kind === 0xc2) return { index: 7, rgb: v & 0xffffff };
  if (kind === 0xc3) return { index: v & 0xff || 7 };
  return { index: 256 };
}

/**
 * ハンドルで指す値を名前にする（読み手は、まず refs にハンドルを入れておく）。names: { linetypes, styles, blocks: Map<ハンドル（大文字）, 名前> }
 * マルチ引出線の線種・矢印・文字スタイル・ブロック、寸法スタイルの文字スタイル
 */
export function nameReferences(drawing, names) {
  const of = (map, handle) => (handle === undefined || handle === null ? undefined : map.get(String(handle).toUpperCase()));
  for (const s of drawing.dimstyles.values()) {
    s.textStyle = of(names.styles, s.refs?.textStyle) ?? "Standard";
    delete s.refs;
  }
  for (const block of drawing.blocks.values()) {
    for (const e of block.entities) {
      if (e.type !== "MULTILEADER" || !e.refs) continue;
      const lt = of(names.linetypes, e.refs.linetype) ?? "ByBlock";
      e.lineLinetype = /^(bylayer|byblock|continuous)$/i.test(lt) ? lt.toUpperCase() : lt;
      e.arrow = of(names.blocks, e.refs.arrow) ?? "";
      e.arrows = (e.refs.arrows ?? []).map(([index, h]) => [index, of(names.blocks, h) ?? ""]);
      if (e.text) e.text.style = of(names.styles, e.text.refs?.style) ?? "Standard";
      if (e.content) e.content.block = of(names.blocks, e.content.refs?.block) ?? "";
      for (const part of [e, e.text, e.content]) if (part) delete part.refs;
    }
  }
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
