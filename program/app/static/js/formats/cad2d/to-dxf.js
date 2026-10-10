// 図面のモデル（model.js）→ DXF（ASCII）。直した 2D の図面を、AutoCAD・Inventor・ほかの CAD で開ける形で渡す。
//   prepareForDxf(drawing) → { drawing: 書ける形に整えた写し, notes }
//   drawingToDxf(drawing, { version }) → { bytes（DXF のファイルの中身）, notes, drawing: 書いた図面（prepareForDxf の写し） }
//   dxfNotes(notes) → 書けなかったもの・変えたものの説明（画面と評価で使う）
//
// 版: R2013（AC1027。既定。文字は UTF-8）と R2000（AC1015。文字は Shift_JIS（ANSI_932）、Shift_JIS に無い文字は \U+XXXX で逃がす。
// 日本語の AutoCAD・Jw_cad が R2000 の DXF を書くときの形）。
// 読むのは from-dxf.js（同じ図面に戻ることを dxf-write-check.mjs と試験で確かめる）。
//
// 整え方（prepareForDxf。読んだ形式に関わらず同じ規則）:
//   - 名前（画層・線種・文字スタイル・ブロック）: AutoCAD で使えない文字（< > / \ " : ; ? * | = `）を _ に。大文字・小文字だけ違う名前は分ける
//   - レイアウト: モデルのブロックは *Model_Space、紙のレイアウトはタブの順に *Paper_Space・*Paper_Space0 …（DXF の決まり）。
//     モデルが無い図面（Jw_cad・SXF・PDF）は空のモデルを足し、開いたときに紙のレイアウトを出す（$TILEMODE 0）
//   - 図形: ハンドルが無い・16 進でない・重なるものは新しいハンドルに。参照する画層・線種・文字スタイルが無ければ足す。
//     線の太さは AutoCAD の決まった値の近いものに。書けない図形（3D の立体など）・値の壊れた図形・無いブロックを参照する図形は書かない
//   - DXF に無いもの: 画層の縮尺（Jw_cad）・外部参照（ブロックとして書く）

import { encodeShiftJis } from "../../core/sjis.js";

export const DXF_VERSIONS = { R2013: "AC1027", R2000: "AC1015" };
const DEG = 180 / Math.PI;
const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const BAD_NAME = /[<>/\\":;?*|=`\x00-\x1f]/g;
const MODEL = "*Model_Space";
const PAPER = "*Paper_Space";
const SPECIAL_LINETYPES = { BYLAYER: "ByLayer", BYBLOCK: "ByBlock", CONTINUOUS: "Continuous" };
const TEXTS = new Set(["TEXT", "ATTDEF", "ATTRIB", "MTEXT"]);

// ---- 整える -------------------------------------------------------------------------------------------------------

/** 名前の付け替え表: 使えない文字を _ に、大文字・小文字だけ違う名前に番号（正しい名前を先に取る）。star … 先頭の * を残す（無名のブロック） */
function renamer(names, { star = false, reserved = [] } = {}) {
  const used = new Set(reserved.map((n) => n.toLowerCase()));
  const map = new Map();
  const clean = (name) => {
    const s = String(name ?? "");
    const lead = star && s.startsWith("*") ? "*" : "";
    return (lead + s.slice(lead.length).replace(BAD_NAME, "_")).slice(0, 255) || "_";
  };
  const ordered = [...new Set(names)].sort((a, b) => Number(clean(a) !== a) - Number(clean(b) !== b));
  for (const name of ordered) {
    const base = clean(name);
    let out = base;
    for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base}_${n}`;
    used.add(out.toLowerCase());
    map.set(name, out);
  }
  return map;
}

const isHandle = (h) => typeof h === "string" && /^[0-9A-F]+$/.test(h) && !/^0+$/.test(h);
const finite = (v) => (typeof v === "number" ? Number.isFinite(v) : Array.isArray(v) ? v.every(finite)
  : v && typeof v === "object" ? Object.values(v).every(finite) : true);
const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const lineweight = (w, layer = false) => {
  if (w === -3 || (!layer && (w === -1 || w === -2))) return w;
  if (!(w >= 0)) return layer ? -3 : -1;
  return LINEWEIGHTS.reduce((best, v) => (Math.abs(v - w) < Math.abs(best - w) ? v : best));
};

/** 書ける図形の種類（書き方は WRITERS） */
const writable = (e) => Object.hasOwn(WRITERS, e.type);

export function prepareForDxf(source) {
  const notes = { dropped: new Map(), converted: new Map(), renamed: new Map(), lineweights: 0, added: new Map(), layerScales: 0, xrefs: 0, handles: 0, emptyModel: false };
  const blocks = [...source.blocks.values()];
  const layouts = [...source.layouts].sort((a, b) => Number(b.model) - Number(a.model) || (a.tabOrder ?? 0) - (b.tabOrder ?? 0));

  // レイアウトのブロックの名前（DXF の決まり）。紙のレイアウトでないのに *Paper_Space… の名前のブロックは書かない（読み手がレイアウトとみなす）
  const layoutBlock = new Map();
  const model = layouts.find((l) => l.model);
  if (model) layoutBlock.set(model.block, MODEL);
  layouts.filter((l) => !l.model).forEach((l, i) => layoutBlock.set(l.block, i === 0 ? PAPER : `${PAPER}${i - 1}`));
  const isLayoutName = (name) => /^\*(model|paper)_space/i.test(name);
  const kept = blocks.filter((b) => layoutBlock.has(b.name) || !isLayoutName(b.name));
  for (const b of blocks) if (!kept.includes(b)) count(notes.dropped, "レイアウトの無い紙の空間", b.entities.length);
  const blockNames = renamer(kept.filter((b) => !layoutBlock.has(b.name)).map((b) => b.name), { star: true, reserved: [MODEL, PAPER, ...[...layoutBlock.values()]] });
  for (const [from, to] of layoutBlock) blockNames.set(from, to);
  const keptNames = new Set(kept.map((b) => b.name));

  // 名前の表（参照されているが表に無い名前も入れる）
  const withDefault = (names, name) => new Set(names.some((n) => String(n).toLowerCase() === name.toLowerCase()) ? names : [name, ...names]);
  const layerNames = withDefault([...source.layers.keys()], "0");
  const linetypeNames = new Set(["ByBlock", "ByLayer", "Continuous", ...source.linetypes.keys()]);
  // パスの破線（PDF の mm）は、模様ごとに 1 つの線種にする
  const dashTypes = new Map();
  const pathEntities = (e) => {
    count(notes.converted, "PATH");
    return pathToEntities(e, (dashes) => {
      const key = dashes.join(",");
      if (!dashTypes.has(key)) {
        const name = `DASH_${dashTypes.size + 1}`;
        dashTypes.set(key, { name, description: dashes.map((d) => (d > 0 ? "__" : " ")).join(""), dashes });
        linetypeNames.add(name);
      }
      return dashTypes.get(key).name;
    }).map((x, i) => ({ ...x, handle: i === 0 ? e.handle : null }));
  };
  const styleNames = withDefault([...source.styles.keys()].filter((n) => n !== ""), "Standard");
  const visit = (e) => {
    layerNames.add(e.layer || "0");
    if (e.linetype && !SPECIAL_LINETYPES[String(e.linetype).toUpperCase()]) linetypeNames.add(e.linetype);
    if (TEXTS.has(e.type) && e.style) styleNames.add(e.style);
    for (const a of e.attribs ?? []) visit(a);
  };
  const converted = new Map(kept.map((b) => [b, b.entities.flatMap((e) => (e.type === "PATH" ? pathEntities(e) : [e]))]));
  for (const b of kept) converted.get(b).forEach(visit);
  for (const l of source.layers.values()) if (l.linetype && !SPECIAL_LINETYPES[String(l.linetype).toUpperCase()]) linetypeNames.add(l.linetype);
  // 線種の ByBlock・ByLayer・Continuous は大文字・小文字に関わらず 1 つ
  const specials = new Map(Object.values(SPECIAL_LINETYPES).map((n) => [n.toLowerCase(), n]));
  const linetypeOthers = [...linetypeNames].filter((n) => !specials.has(String(n).toLowerCase()));
  const layerMap = renamer([...layerNames], { star: true }); // AutoCAD の系の画層（*ADSK_…）は * で始まる
  const linetypeMap = renamer(linetypeOthers, { reserved: [...specials.values()] });
  for (const n of linetypeNames) if (specials.has(String(n).toLowerCase())) linetypeMap.set(n, specials.get(String(n).toLowerCase()));
  const styleMap = renamer([...styleNames]);
  for (const [kind, map] of [["画層", layerMap], ["線種", linetypeMap], ["文字スタイル", styleMap], ["ブロック", blockNames]]) {
    const changed = [...map].filter(([from, to]) => from !== to && !(kind === "ブロック" && layoutBlock.has(from)) && !(kind === "線種" && specials.has(String(from).toLowerCase())));
    if (changed.length) notes.renamed.set(kind, changed);
  }
  const ltOf = (name) => (SPECIAL_LINETYPES[String(name).toUpperCase()] && !source.linetypes.has(name) ? String(name).toUpperCase() : linetypeMap.get(name) ?? name);

  // ハンドル: 元のものを残し、無い・重なるものに新しい番号
  const used = new Set();
  let seed = 0;
  const note = (h) => {
    if (isHandle(h)) seed = Math.max(seed, parseInt(h, 16));
  };
  for (const b of kept) {
    note(b.handle);
    for (const e of converted.get(b)) {
      note(e.handle);
      for (const a of e.attribs ?? []) note(a.handle);
    }
  }
  const handle = (h) => {
    if (isHandle(h) && !used.has(h)) {
      used.add(h);
      return h;
    }
    notes.handles++;
    const fresh = (++seed).toString(16).toUpperCase();
    used.add(fresh);
    return fresh;
  };

  // 図形（1 つの図形が DXF の幾つかの図形になるもの: パス）
  const entity = (e, child = false) => {
    if (!child && !writable(e)) return count(notes.dropped, e.type), null;
    if (!finite({ ...e, attribs: undefined, solid: undefined, acis: undefined })) return count(notes.dropped, "値の壊れた図形"), null;
    if ((e.type === "INSERT" || e.type === "DIMENSION") && !keptNames.has(e.block)) return count(notes.dropped, `${e.type}（ブロックが無い）`), null;
    const out = { ...e, handle: handle(e.handle), layer: layerMap.get(e.layer || "0") };
    if (e.linetype !== undefined) out.linetype = e.linetype === "BYLAYER" ? "BYLAYER" : ltOf(e.linetype);
    if (TEXTS.has(e.type) && e.style !== undefined) out.style = styleMap.get(e.style);
    if (e.block !== undefined) out.block = blockNames.get(e.block);
    if (e.lineweight !== undefined) {
      out.lineweight = lineweight(e.lineweight);
      if (out.lineweight !== e.lineweight) notes.lineweights++;
    }
    if (e.attribs) out.attribs = e.attribs.map((a) => entity(a, true)).filter(Boolean);
    if (e.type === "DIMENSION" && !DIMENSION_KINDS.includes(e.kind)) {
      count(notes.converted, `DIMENSION ${e.kind}`);
      out.kind = "aligned";
    }
    return canonical(out);
  };
  const drawing = {
    ...source, layers: new Map(), linetypes: new Map(), styles: new Map(), blocks: new Map(), layouts: [],
    unsupported: new Map(source.unsupported), failures: [...source.failures],
  };
  for (const b of kept) {
    const name = blockNames.get(b.name);
    if (b.xref) notes.xrefs++;
    drawing.blocks.set(name, { ...b, name, handle: handle(b.handle), xref: false, anonymous: Boolean(b.anonymous) || name.startsWith("*"),
      entities: converted.get(b).map((e) => entity(e)).filter(Boolean) });
  }
  for (const l of layouts) drawing.layouts.push({ ...l, block: blockNames.get(l.block) });
  if (!model) {
    notes.emptyModel = true;
    drawing.blocks.set(MODEL, { name: MODEL, handle: handle(null), base: [0, 0, 0], anonymous: false, xref: false, entities: [] });
    drawing.layouts.unshift({ name: "Model", block: MODEL, model: true, tabOrder: 0 });
  }
  // DXF の読み手は *Model_Space・*Paper_Space の順に並べる（読み直しと比べやすく）
  drawing.blocks = new Map([...drawing.blocks].sort(([a], [b]) => rank(a) - rank(b)));

  // 表
  for (const name of layerNames) {
    const l = source.layers.get(name);
    if (!l) count(notes.added, "画層");
    if (l?.scale !== undefined && l.scale !== 1) notes.layerScales++;
    const to = layerMap.get(name);
    const index = Math.abs(l?.color?.index ?? 7);
    const lw = lineweight(l?.lineweight ?? -3, true);
    if (l && lw !== (l.lineweight ?? -3)) notes.lineweights++;
    const layer = { name: to, color: { index: index >= 1 && index <= 255 ? index : 7, ...(l?.color?.rgb !== undefined && { rgb: l.color.rgb }) },
      off: Boolean(l?.off), frozen: Boolean(l?.frozen), locked: Boolean(l?.locked), plot: l?.plot !== false,
      linetype: ltOf(l?.linetype ?? "Continuous"), lineweight: lw };
    drawing.layers.set(to, layer);
  }
  for (const name of linetypeNames) {
    const to = linetypeMap.get(name);
    if (drawing.linetypes.has(to)) continue;
    const t = source.linetypes.get(name) ?? [...dashTypes.values()].find((x) => x.name === name)
      ?? [...source.linetypes.values()].find((x) => x.name.toLowerCase() === to.toLowerCase());
    if (!t && !specials.has(to.toLowerCase())) count(notes.added, "線種");
    drawing.linetypes.set(to, { name: to, description: t?.description ?? "", dashes: specials.has(to.toLowerCase()) ? [] : (t?.dashes ?? []).filter(Number.isFinite) });
  }
  for (const name of styleNames) {
    const s = source.styles.get(name);
    if (!s && name.toLowerCase() !== "standard") count(notes.added, "文字スタイル");
    const to = styleMap.get(name);
    drawing.styles.set(to, { name: to, font: s?.font || "txt", bigFont: s?.bigFont ?? "", height: Number.isFinite(s?.height) ? s.height : 0,
      widthFactor: s?.widthFactor || 1, oblique: Number.isFinite(s?.oblique) ? s.oblique : 0 });
  }
  return { drawing, notes };
}

/** 読み手（from-dxf.js）と同じ形にそろえる: ポリラインの膨らみ・幅は頂点ごとに（無ければ 0） */
function canonical(e) {
  if (e.type === "LWPOLYLINE") {
    return { ...e, bulges: e.points.map((_, i) => e.bulges?.[i] ?? 0), widths: e.points.map((_, i) => e.widths?.[i] ?? [0, 0]) };
  }
  if (e.type === "HATCH") {
    return { ...e, loops: e.loops.map((l) => (l.points ? { ...l, bulges: l.points.map((_, i) => l.bulges?.[i] ?? 0) } : l)) };
  }
  return e;
}

/**
 * パス（PDF・Jw_cad の塗り・SXF の矢印。直線と 3 次ベジェの区切りの集まり）→ DXF の図形。
 * 塗り → 塗りつぶしのハッチング（区切りごとに境界 1 つ）。線 → 区切りごとに、直線だけならポリライン、曲線を含めば同じ形の 3 次スプライン
 * （直線の区間は 1/3・2/3 の点を制御点にした 3 次。ベジェと B スプラインは同じ曲線）。線の太さ（mm）は線の太さ（1/100 mm）に、
 * 破線は linetypeFor(破線の長さ) の線種に
 */
export function pathToEntities(e, linetypeFor) {
  const base = { ...e, subpaths: undefined, fill: undefined, alpha: undefined, width: undefined, dashes: undefined, cap: undefined, clip: undefined, arrow: undefined };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const runs = e.subpaths.map(segmentsOf).filter((r) => r.points.length >= 2);
  if (e.fill) {
    const loops = runs.map((r) => (r.curved
      ? { flags: 1, edges: r.segments.map((s) => (s.curve ? { kind: "spline", degree: 3, rational: false, periodic: false, knots: [0, 0, 0, 0, 1, 1, 1, 1], controls: [s.a, s.c1, s.c2, s.b], weights: [], fit: [] } : { kind: "line", a: s.a, b: s.b })) }
      : { flags: 3, edges: [], closed: true, points: r.points, bulges: r.points.map(() => 0) }));
    return loops.length ? [{ ...base, type: "HATCH", loops, solid: true, pattern: "SOLID", angle: 0, scale: 1, lines: [], elevation: 0, extrusion: [0, 0, 1], style: 0, gradient: false }] : [];
  }
  const dashes = e.dashes?.length ? (e.dashes.length % 2 ? [...e.dashes, ...e.dashes] : e.dashes).map((d, i) => (i % 2 ? -Math.abs(d) : Math.abs(d))) : null;
  const look = { lineweight: lineweight(Math.round((e.width ?? 0) * 100)), ...(dashes && { linetype: linetypeFor(dashes) }) };
  return runs.map((r) => {
    if (!r.curved) {
      const closed = r.closed && r.points.length > 2;
      const points = closed && same(r.points[0], r.points.at(-1)) ? r.points.slice(0, -1) : r.points;
      return { ...base, ...look, type: "LWPOLYLINE", points, bulges: points.map(() => 0), widths: points.map(() => [0, 0]), constWidth: 0, closed, elevation: 0, extrusion: [0, 0, 1] };
    }
    const controls = [[...r.segments[0].a, 0]];
    const knots = [0, 0, 0, 0];
    r.segments.forEach((s, i) => {
      controls.push([...s.c1, 0], [...s.c2, 0], [...s.b, 0]);
      knots.push(...(i + 1 < r.segments.length ? [i + 1, i + 1, i + 1] : [i + 1, i + 1, i + 1, i + 1]));
    });
    return { ...base, ...look, type: "SPLINE", degree: 3, knots, controls, weights: [], fit: [], fitTolerance: 0, closed: false, periodic: false, rational: false,
      startTangent: null, endTangent: null };
  });
}
const same = (p, q) => p[0] === q[0] && p[1] === q[1];

/** パスの区切り（points: [x, y, …]・curves: [[i, c1x, c1y, c2x, c2y]]・closed）→ 区間の並び（閉じていれば最後の点から最初の点への直線を足す） */
function segmentsOf({ points, curves = [], closed = false }) {
  const pts = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  const curveAt = new Map(curves.map((c) => [c[0], c]));
  const segments = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const c = curveAt.get(i);
    const [a, b] = [pts[i], pts[i + 1]];
    segments.push(c ? { a, b, c1: [c[1], c[2]], c2: [c[3], c[4]], curve: true } : { a, b, c1: lerp(a, b, 1 / 3), c2: lerp(a, b, 2 / 3), curve: false });
  }
  if (closed && pts.length > 2 && !same(pts[0], pts.at(-1))) {
    const [a, b] = [pts.at(-1), pts[0]];
    segments.push({ a, b, c1: lerp(a, b, 1 / 3), c2: lerp(a, b, 2 / 3), curve: false });
  }
  const curved = segments.some((s) => s.curve);
  return { points: curved ? pts : [...pts], segments, curved, closed };
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const rank = (name) => (name === MODEL ? 0 : name === PAPER ? 1 : 2);

/** 書けなかったもの・変えたもの → 説明の行（無ければ空） */
export function dxfNotes(notes) {
  const out = [];
  const dropped = [...notes.dropped].filter(([, n]) => n > 0);
  if (dropped.length) out.push(`書かなかった図形: ${dropped.map(([type, n]) => `${NAMES[type] ?? type} ${n}`).join("・")}`);
  const converted = [...notes.converted];
  if (converted.length) out.push(`DXF に同じ図形が無いので直して書いた: ${converted.map(([type, n]) => `${NAMES[type] ?? type} ${n}`).join("・")}`);
  for (const [kind, list] of notes.renamed) out.push(`${kind}の名前を DXF で使える名前に変えた: ${list.slice(0, 3).map(([a, b]) => `${a} → ${b}`).join("・")}${list.length > 3 ? ` ほか ${list.length - 3}` : ""}`);
  if (notes.lineweights) out.push(`線の太さ ${notes.lineweights} つを、AutoCAD の決まった太さの近い値にした`);
  if (notes.layerScales) out.push("画層の縮尺（Jw_cad）は DXF に無いので書かない。長さは図面の長さのまま");
  if (notes.xrefs) out.push(`外部参照 ${notes.xrefs} つは、ふつうのブロックとして書いた`);
  if (notes.escaped) out.push(`Shift_JIS に無い文字 ${notes.escaped} つは \\U+ の形で書いた（AutoCAD は文字に戻す）`);
  if (notes.replaced) out.push(`R2000 で表せない文字 ${notes.replaced} つは ? にした（R2013 なら、そのまま書ける）`);
  if (notes.emptyModel) out.push("モデル空間の無い図面なので、図形は紙のレイアウトに書いた（開くとレイアウトが出る）");
  return out;
}
const NAMES = { ACIS: "3D の立体（ACIS）", PATH: "パス（塗り → ハッチング・線 → ポリラインかスプライン）", IMAGE: "画像（DXF では別のファイルが要る）",
  "DIMENSION arc": "弧の長さの寸法（見た目のまま、長さの寸法として）", "INSERT（ブロックが無い）": "ブロックの無いブロック参照", "DIMENSION（ブロックが無い）": "見た目のブロックの無い寸法" };

// ---- 書く ---------------------------------------------------------------------------------------------------------

/** 数の書き方: 読み戻すと同じ値になる最短の表記（整数も小数点を付ける） */
const num = (v) => {
  const s = String(Number.isFinite(v) ? v + 0 : 0);
  return /[.eE]/.test(s) ? s.replace("e", "E") : `${s}.0`;
};

class Tags {
  constructor(version) {
    this.version = version;
    this.lines = [];
  }
  put(code, value) {
    this.lines.push(String(code).padStart(3), value);
  }
  str(code, s) {
    this.put(code, String(s ?? "").replace(/\^/g, "^ ").replace(/\r\n|\n/g, "^J").replace(/\r/g, "^M").replace(/\t/g, "^I"));
  }
  num(code, v) {
    this.put(code, num(v));
  }
  int(code, v) {
    this.put(code, String(Math.trunc(v)));
  }
  point(code, p, dims = 3) {
    for (let i = 0; i < dims; i++) this.num(code + 10 * i, p?.[i] ?? 0);
  }
  extrusion(v) {
    if (v && (v[0] || v[1] || (v[2] ?? 1) !== 1)) this.point(210, v);
  }
}

/** 長い文字列を、UTF-8 で 250 バイト以下のかたまりに（文字の途中で切らない） */
function chunks(s) {
  const out = [];
  let cur = "", bytes = 0;
  for (const c of s) {
    const n = new TextEncoder().encode(c).length;
    if (bytes + n > 250) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += c;
    bytes += n;
  }
  out.push(cur);
  return out;
}

function common(t, type, e, ctx) {
  t.str(0, type);
  t.put(5, e.handle);
  t.put(330, ctx.owner);
  t.str(100, "AcDbEntity");
  if (ctx.paper) t.int(67, 1);
  t.str(8, e.layer || "0");
  const lt = String(e.linetype ?? "BYLAYER");
  if (lt !== "BYLAYER") t.str(6, SPECIAL_LINETYPES[lt.toUpperCase()] && !ctx.drawing.linetypes.has(lt) ? SPECIAL_LINETYPES[lt.toUpperCase()] : lt);
  const index = e.color?.index ?? 256;
  if (index !== 256) t.int(62, index);
  if (e.color?.rgb !== undefined) t.int(420, e.color.rgb & 0xffffff);
  if ((e.lineweight ?? -1) !== -1) t.int(370, e.lineweight);
  if ((e.ltscale ?? 1) !== 1) t.num(48, e.ltscale);
  if (e.invisible) t.int(60, 1);
}

/** TEXT・ATTDEF・ATTRIB の文字の値（AcDbText） */
function textBody(t, e) {
  t.str(100, "AcDbText");
  t.point(10, e.p);
  t.num(40, e.height ?? 0);
  t.str(1, e.text ?? "");
  if (e.rotation) t.num(50, e.rotation * DEG);
  if ((e.widthFactor ?? 1) !== 1) t.num(41, e.widthFactor);
  if (e.oblique) t.num(51, e.oblique * DEG);
  t.str(7, e.style ?? "Standard");
  if (e.generation) t.int(71, e.generation);
  if (e.halign) t.int(72, e.halign);
  if (e.align) t.point(11, e.align);
  t.extrusion(e.extrusion);
}

const DIMENSION_KINDS = ["linear", "aligned", "angular", "diameter", "radius", "angular3", "ordinate"];
const HATCH_EDGE = { line: 1, arc: 2, ellipse: 3, spline: 4 };

/** 図形の種類 → 書き方（common の後ろ）。子（頂点・属性）を持つものは、自分で SEQEND まで書く */
const WRITERS = {
  LINE(t, e) {
    t.str(100, "AcDbLine");
    t.point(10, e.a);
    t.point(11, e.b);
    t.extrusion(e.extrusion);
  },
  POINT(t, e) {
    t.str(100, "AcDbPoint");
    t.point(10, e.p);
  },
  CIRCLE(t, e) {
    t.str(100, "AcDbCircle");
    t.point(10, e.center);
    t.num(40, e.radius);
    t.extrusion(e.extrusion);
  },
  ARC(t, e) {
    WRITERS.CIRCLE(t, e);
    t.str(100, "AcDbArc");
    t.num(50, e.start * DEG);
    t.num(51, e.end * DEG);
  },
  ELLIPSE(t, e) {
    t.str(100, "AcDbEllipse");
    t.point(10, e.center);
    t.point(11, e.major);
    t.extrusion(e.extrusion);
    t.num(40, e.ratio);
    t.num(41, e.start);
    t.num(42, e.end);
  },
  LWPOLYLINE(t, e) {
    t.str(100, "AcDbPolyline");
    t.int(90, e.points.length);
    t.int(70, e.closed ? 1 : 0);
    if (e.constWidth) t.num(43, e.constWidth);
    if (e.elevation) t.num(38, e.elevation);
    t.extrusion(e.extrusion);
    e.points.forEach((p, i) => {
      t.point(10, p, 2);
      const [w0, w1] = e.widths?.[i] ?? [0, 0];
      if (w0 || w1) {
        t.num(40, w0);
        t.num(41, w1);
      }
      if (e.bulges?.[i]) t.num(42, e.bulges[i]);
    });
  },
  POLYLINE(t, e, ctx) {
    const kind = e.kind ?? "2d";
    t.str(100, { "2d": "AcDb2dPolyline", "3d": "AcDb3dPolyline", mesh: "AcDbPolygonMesh", pface: "AcDbPolyFaceMesh" }[kind]);
    t.int(66, 1);
    t.point(10, [0, 0, kind === "2d" ? e.elevation ?? 0 : 0]);
    t.int(70, (e.closed ? 1 : 0) | { "2d": 0, "3d": 8, mesh: 16, pface: 64 }[kind]);
    if (kind === "mesh") {
      t.int(71, e.m ?? 0);
      t.int(72, e.n ?? 0);
    } else if (kind === "pface") {
      t.int(71, e.vertices.length);
      t.int(72, e.faces?.length ?? 0);
    }
    if (kind === "2d") t.extrusion(e.extrusion);
    const child = (sub, flags, write) => {
      t.str(0, "VERTEX");
      t.put(5, ctx.next());
      t.put(330, e.handle);
      t.str(100, "AcDbEntity");
      if (ctx.paper) t.int(67, 1);
      t.str(8, e.layer || "0");
      if (sub) t.str(100, "AcDbVertex");
      for (const s of sub ?? []) t.str(100, s);
      write();
      t.int(70, flags);
    };
    const vertexClass = { "2d": "AcDb2dVertex", "3d": "AcDb3dPolylineVertex", mesh: "AcDbPolygonMeshVertex", pface: "AcDbPolyFaceMeshVertex" }[kind];
    const vertexFlags = { "2d": 0, "3d": 32, mesh: 64, pface: 192 }[kind];
    for (const v of e.vertices) {
      child([vertexClass], vertexFlags, () => {
        t.point(10, v.p);
        if (v.bulge) t.num(42, v.bulge);
      });
    }
    for (const f of kind === "pface" ? e.faces ?? [] : []) {
      t.str(0, "VERTEX");
      t.put(5, ctx.next());
      t.put(330, e.handle);
      t.str(100, "AcDbEntity");
      t.str(8, e.layer || "0");
      t.str(100, "AcDbFaceRecord");
      t.point(10, [0, 0, 0]);
      t.int(70, 128);
      f.forEach((index, i) => index && t.int(71 + i, index));
    }
    seqend(t, e, ctx);
  },
  SPLINE(t, e) {
    t.str(100, "AcDbSpline");
    const rational = e.weights?.length === e.controls?.length && e.weights.length > 0;
    t.int(70, (e.closed ? 1 : 0) | (e.periodic ? 2 : 0) | (rational ? 4 : 0));
    t.int(71, e.degree ?? 3);
    t.int(72, e.knots?.length ?? 0);
    t.int(73, e.controls?.length ?? 0);
    t.int(74, e.fit?.length ?? 0);
    t.num(42, 1e-10);
    t.num(43, 1e-10);
    if (e.fit?.length) t.num(44, e.fitTolerance ?? 0);
    if (e.startTangent) t.point(12, e.startTangent);
    if (e.endTangent) t.point(13, e.endTangent);
    for (const k of e.knots ?? []) t.num(40, k);
    if (rational) for (const w of e.weights) t.num(41, w);
    for (const p of e.controls ?? []) t.point(10, p);
    for (const p of e.fit ?? []) t.point(11, p);
  },
  TEXT(t, e) {
    textBody(t, e);
    t.str(100, "AcDbText");
    if (e.valign) t.int(73, e.valign);
  },
  ATTDEF(t, e) {
    textBody(t, e);
    t.str(100, "AcDbAttributeDefinition");
    if (t.version >= "AC1024") t.int(280, 0);
    t.str(3, e.prompt ?? "");
    t.str(2, e.tag ?? "");
    t.int(70, e.flags ?? 0);
    if (e.valign) t.int(74, e.valign);
  },
  MTEXT(t, e) {
    t.str(100, "AcDbMText");
    t.point(10, e.p);
    t.num(40, e.height ?? 1);
    t.num(41, e.width ?? 0);
    t.int(71, e.attach ?? 1);
    t.int(72, e.drawing ?? 1);
    const parts = chunks(e.text ?? "");
    for (const part of parts.slice(0, -1)) t.str(3, part);
    t.str(1, parts.at(-1));
    t.str(7, e.style ?? "Standard");
    t.extrusion(e.extrusion);
    t.point(11, e.direction ?? [1, 0, 0]);
    t.int(73, 1);
    t.num(44, e.lineSpacing ?? 1);
  },
  INSERT(t, e, ctx) {
    const grid = (e.columns ?? 1) > 1 || (e.rows ?? 1) > 1;
    t.str(100, grid ? "AcDbMInsertBlock" : "AcDbBlockReference");
    if (e.attribs?.length) t.int(66, 1);
    t.str(2, e.block);
    t.point(10, e.p);
    const [sx, sy, sz] = e.scale ?? [1, 1, 1];
    if (sx !== 1) t.num(41, sx);
    if (sy !== 1) t.num(42, sy);
    if (sz !== 1) t.num(43, sz);
    if (e.rotation) t.num(50, e.rotation * DEG);
    if (grid) {
      t.int(70, e.columns ?? 1);
      t.int(71, e.rows ?? 1);
      t.num(44, e.columnSpacing ?? 0);
      t.num(45, e.rowSpacing ?? 0);
    }
    t.extrusion(e.extrusion);
    if (!e.attribs?.length) return;
    for (const a of e.attribs) {
      common(t, "ATTRIB", a, { ...ctx, owner: e.handle });
      textBody(t, a);
      t.str(100, "AcDbAttribute");
      if (t.version >= "AC1024") t.int(280, 0);
      t.str(2, a.tag ?? "");
      t.int(70, a.flags ?? 0);
      if (a.valign) t.int(74, a.valign);
    }
    seqend(t, e, ctx);
  },
  DIMENSION(t, e) {
    const kind = Math.max(0, DIMENSION_KINDS.indexOf(e.kind));
    t.str(100, "AcDbDimension");
    if (t.version >= "AC1024") t.int(280, 0);
    t.str(2, e.block);
    t.point(10, e.p10);
    t.point(11, e.textMid);
    t.int(70, kind | 32);
    t.int(71, 5);
    if (Number.isFinite(e.measurement)) t.num(42, e.measurement);
    t.str(1, e.text ?? "");
    t.str(3, "Standard");
    t.extrusion(e.extrusion);
    if (kind === 0 || kind === 1) {
      t.str(100, "AcDbAlignedDimension");
      t.point(13, e.p13);
      t.point(14, e.p14);
      if (kind === 0) {
        // 回した寸法の向き: 寸法線は p10 を通り、p14 から寸法線へ下ろした補助線と直交する
        const [dx, dy] = [(e.p10?.[0] ?? 0) - (e.p14?.[0] ?? 0), (e.p10?.[1] ?? 0) - (e.p14?.[1] ?? 0)];
        t.num(50, dx || dy ? Math.atan2(dy, dx) * DEG + 90 : 0);
        t.str(100, "AcDbRotatedDimension");
      }
    } else if (kind === 2) {
      t.str(100, "AcDb2LineAngularDimension");
      for (const c of [13, 14, 15, 16]) t.point(c, e[`p${c}`]);
    } else if (kind === 3 || kind === 4) {
      t.str(100, kind === 3 ? "AcDbDiametricDimension" : "AcDbRadialDimension");
      t.point(15, e.p15);
      t.num(40, 0);
    } else if (kind === 5) {
      t.str(100, "AcDb3PointAngularDimension");
      for (const c of [13, 14, 15]) t.point(c, e[`p${c}`]);
    } else {
      t.str(100, "AcDbOrdinateDimension");
      t.point(13, e.p13);
      t.point(14, e.p14);
    }
  },
  HATCH(t, e, ctx) {
    t.str(100, "AcDbHatch");
    t.point(10, [0, 0, e.elevation ?? 0]);
    t.extrusion(e.extrusion ?? [0, 0, 1]);
    if (!e.extrusion) t.point(210, [0, 0, 1]);
    t.str(2, e.pattern || (e.solid ? "SOLID" : "ANSI31"));
    t.int(70, e.solid ? 1 : 0);
    t.int(71, 0);
    t.int(91, e.loops.length);
    for (const loop of e.loops) {
      const poly = Boolean(loop.points);
      t.int(92, ((loop.flags ?? 1) & ~2) | (poly ? 2 : 0));
      if (poly) {
        const bulged = loop.bulges?.some((b) => b);
        t.int(72, bulged ? 1 : 0);
        t.int(73, loop.closed === false ? 0 : 1);
        t.int(93, loop.points.length);
        loop.points.forEach((p, i) => {
          t.point(10, p, 2);
          if (bulged) t.num(42, loop.bulges[i] ?? 0);
        });
      } else {
        t.int(93, loop.edges.length);
        for (const edge of loop.edges) hatchEdge(t, edge);
      }
      t.int(97, 0);
    }
    t.int(75, e.style ?? 0);
    t.int(76, 1);
    if (!e.solid) {
      t.num(52, (e.angle ?? 0) * DEG);
      t.num(41, e.scale ?? 1);
      t.int(77, 0);
      t.int(78, e.lines?.length ?? 0);
      for (const line of e.lines ?? []) {
        t.num(53, line.angle * DEG);
        t.num(43, line.base?.[0] ?? 0);
        t.num(44, line.base?.[1] ?? 0);
        t.num(45, line.offset?.[0] ?? 0);
        t.num(46, line.offset?.[1] ?? 0);
        t.int(79, line.dashes?.length ?? 0);
        for (const d of line.dashes ?? []) t.num(49, d);
      }
    }
    t.int(98, 0);
    if (e.gradient) {
      // グラデーション（色の値はモデルに無いので、図形の色から白へ）
      t.int(450, 1);
      t.int(451, 0);
      t.int(452, 0);
      t.int(453, 2);
      t.num(460, 0);
      t.num(461, 0);
      t.int(463, 0);
      t.int(63, ctx.colorIndex(e));
      t.num(463, 1);
      t.int(63, 7);
      t.int(421, 0xffffff);
      t.str(470, "LINEAR");
    }
  },
  SOLID(t, e) {
    t.str(100, "AcDbTrace");
    e.points.forEach((p, i) => t.point(10 + i, p));
    t.extrusion(e.extrusion);
  },
  "3DFACE"(t, e) {
    t.str(100, "AcDbFace");
    e.points.forEach((p, i) => t.point(10 + i, p));
    if (e.invisibleEdges) t.int(70, e.invisibleEdges);
  },
  LEADER(t, e) {
    t.str(100, "AcDbLeader");
    t.str(3, "Standard");
    t.int(71, e.arrow ? 1 : 0);
    t.int(72, e.pathType ?? 0);
    t.int(73, 3);
    t.int(74, 0);
    t.int(75, 0);
    t.num(40, 0);
    t.num(41, 0);
    t.int(76, e.points.length);
    for (const p of e.points) t.point(10, p);
    t.extrusion(e.extrusion);
  },
  RAY(t, e) {
    t.str(100, "AcDbRay");
    t.point(10, e.p);
    t.point(11, e.direction);
  },
  XLINE(t, e) {
    t.str(100, "AcDbXline");
    t.point(10, e.p);
    t.point(11, e.direction);
  },
  VIEWPORT(t, e) {
    t.str(100, "AcDbViewport");
    t.point(10, e.center);
    t.num(40, e.width);
    t.num(41, e.height);
    t.int(68, 1);
    t.int(69, e.id ?? 2);
    t.point(12, e.viewCenter ?? [0, 0], 2);
    t.point(13, [0, 0], 2);
    t.point(14, [10, 10], 2);
    t.point(15, [10, 10], 2);
    t.point(16, e.viewDirection ?? [0, 0, 1]);
    t.point(17, e.viewTarget ?? [0, 0, 0]);
    t.num(42, 50);
    t.num(43, 0);
    t.num(44, 0);
    t.num(45, e.viewHeight);
    t.num(50, 0);
    t.num(51, (e.twist ?? 0) * DEG);
    t.int(72, 1000);
    t.int(90, 32864);
    t.str(1, "");
    t.int(281, 0);
    t.int(71, 1);
    t.int(74, 0);
    t.point(110, [0, 0, 0]);
    t.point(111, [1, 0, 0]);
    t.point(112, [0, 1, 0]);
    t.int(79, 0);
    t.num(146, 0);
  },
};

function hatchEdge(t, edge) {
  t.int(72, HATCH_EDGE[edge.kind] ?? 1);
  if (edge.kind === "arc") {
    t.point(10, edge.center, 2);
    t.num(40, edge.radius);
    t.num(50, edge.start * DEG);
    t.num(51, edge.end * DEG);
    t.int(73, edge.ccw ? 1 : 0);
  } else if (edge.kind === "ellipse") {
    t.point(10, edge.center, 2);
    t.point(11, edge.major, 2);
    t.num(40, edge.ratio);
    t.num(50, edge.start * DEG);
    t.num(51, edge.end * DEG);
    t.int(73, edge.ccw ? 1 : 0);
  } else if (edge.kind === "spline") {
    const rational = edge.weights?.length === edge.controls.length && edge.weights.length > 0;
    t.int(94, edge.degree);
    t.int(73, rational ? 1 : 0);
    t.int(74, edge.periodic ? 1 : 0);
    t.int(95, edge.knots.length);
    t.int(96, edge.controls.length);
    for (const k of edge.knots) t.num(40, k);
    edge.controls.forEach((p, i) => {
      t.point(10, p, 2);
      if (rational) t.num(42, edge.weights[i]);
    });
    t.int(97, edge.fit?.length ?? 0);
    for (const p of edge.fit ?? []) t.point(11, p, 2);
  } else {
    t.point(10, edge.a, 2);
    t.point(11, edge.b, 2);
  }
}

function seqend(t, e, ctx) {
  t.str(0, "SEQEND");
  t.put(5, ctx.next());
  t.put(330, e.handle);
  t.str(100, "AcDbEntity");
  if (ctx.paper) t.int(67, 1);
  t.str(8, e.layer || "0");
}

/** 図形の点のおおよその広がり（開いたときの視点に使う。ブロックの中は数えない） */
function roughExtents(entities) {
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  const add = (p, r = 0) => {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    for (let i = 0; i < 2; i++) {
      min[i] = Math.min(min[i], p[i] - r);
      max[i] = Math.max(max[i], p[i] + r);
    }
  };
  for (const e of entities) {
    for (const key of ["a", "b", "p", "p10", "textMid"]) add(e[key]);
    if (e.center) add(e.center, e.radius ?? 0);
    for (const p of e.points ?? e.controls ?? []) add(p);
    for (const v of e.vertices ?? []) add(v.p);
  }
  return Number.isFinite(min[0]) ? [min, max] : [[0, 0], [100, 100]];
}

export function drawingToDxf(source, { version = "R2013" } = {}) {
  const acadver = DXF_VERSIONS[version];
  if (!acadver) throw new Error(`DXF の版 ${version} は書けません（${Object.keys(DXF_VERSIONS).join("・")}）`);
  const { drawing, notes } = prepareForDxf(source);
  const t = new Tags(acadver);
  let seed = 0;
  for (const b of drawing.blocks.values()) {
    seed = Math.max(seed, parseInt(b.handle, 16));
    for (const e of b.entities) {
      seed = Math.max(seed, parseInt(e.handle, 16));
      for (const a of e.attribs ?? []) seed = Math.max(seed, parseInt(a.handle, 16));
    }
  }
  const next = () => (++seed).toString(16).toUpperCase();
  // 先に決める番号（表・辞書・レイアウト）
  const tables = Object.fromEntries(["VPORT", "LTYPE", "LAYER", "STYLE", "VIEW", "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"].map((n) => [n, next()]));
  const dict = { root: next(), group: next(), layout: next(), plot: next(), normal: next() };
  const layoutHandles = new Map(drawing.layouts.map((l) => [l.block, next()]));
  const model = drawing.blocks.get(MODEL);
  const paperLayouts = drawing.layouts.filter((l) => !l.model);
  const tilemode = model.entities.length || !paperLayouts.length ? 1 : 0;
  const [extMin, extMax] = roughExtents(tilemode ? model.entities : drawing.blocks.get(PAPER)?.entities ?? []);
  const colorIndex = (e) => {
    const i = e.color?.index ?? 256;
    return i >= 1 && i <= 255 ? i : drawing.layers.get(e.layer)?.color.index ?? 7;
  };
  const ctxOf = (block, paper) => ({ owner: block.handle, paper, drawing, next, colorIndex });
  const writeEntities = (block, paper) => {
    const ctx = ctxOf(block, paper);
    for (const e of block.entities) {
      common(t, e.type, e, ctx);
      WRITERS[e.type](t, e, ctx);
    }
  };

  // 見出し
  const section = (name, body) => {
    t.str(0, "SECTION");
    t.str(2, name);
    body();
    t.str(0, "ENDSEC");
  };
  const variable = (name, write) => {
    t.str(9, name);
    write();
  };
  // $HANDSEED は全てを書いた後の番号なので、後で差し替える
  let handseedAt = -1;
  section("HEADER", () => {
    variable("$ACADVER", () => t.str(1, acadver));
    variable("$ACADMAINTVER", () => t.int(70, acadver >= "AC1021" ? 105 : 6));
    variable("$DWGCODEPAGE", () => t.str(3, acadver >= "AC1021" ? "ANSI_1252" : "ANSI_932"));
    variable("$INSBASE", () => t.point(10, [0, 0, 0]));
    variable("$EXTMIN", () => t.point(10, [...extMin, 0]));
    variable("$EXTMAX", () => t.point(10, [...extMax, 0]));
    variable("$LTSCALE", () => t.num(40, drawing.ltscale || 1));
    variable("$INSUNITS", () => t.int(70, drawing.units?.code ?? 0));
    variable("$MEASUREMENT", () => t.int(70, [1, 2, 3, 8, 9, 10].includes(drawing.units?.code) ? 0 : 1));
    variable("$TILEMODE", () => t.int(70, tilemode));
    variable("$CLAYER", () => t.str(8, "0"));
    variable("$TEXTSTYLE", () => t.str(7, "Standard"));
    variable("$DIMSTYLE", () => t.str(2, "Standard"));
    variable("$HANDSEED", () => {
      handseedAt = t.lines.length + 1;
      t.put(5, "0");
    });
  });
  section("CLASSES", () => {
    for (const [name, cpp] of [["ACDBDICTIONARYWDFLT", "AcDbDictionaryWithDefault"], ["ACDBPLACEHOLDER", "AcDbPlaceHolder"], ["LAYOUT", "AcDbLayout"]]) {
      t.str(0, "CLASS");
      t.str(1, name);
      t.str(2, cpp);
      t.str(3, "ObjectDBX Classes");
      t.int(90, 0);
      t.int(280, 0);
      t.int(281, 0);
    }
  });

  // 表
  const table = (name, entries, write, subclass = null) => {
    t.str(0, "TABLE");
    t.str(2, name);
    t.put(5, tables[name]);
    t.put(330, "0");
    t.str(100, "AcDbSymbolTable");
    t.int(70, entries.length);
    if (subclass) t.str(100, subclass);
    for (const entry of entries) write(entry);
    t.str(0, "ENDTAB");
  };
  const record = (type, owner, cls, name, flags = 0, handleCode = 5) => {
    t.str(0, type);
    t.put(handleCode, next());
    t.put(330, owner);
    t.str(100, "AcDbSymbolTableRecord");
    t.str(100, cls);
    t.str(2, name);
    t.int(70, flags);
  };
  const records = new Map();
  section("TABLES", () => {
    table("VPORT", ["*Active"], (name) => {
      record("VPORT", tables.VPORT, "AcDbViewportTableRecord", name);
      const size = [extMax[0] - extMin[0], extMax[1] - extMin[1]];
      t.point(10, [0, 0], 2);
      t.point(11, [1, 1], 2);
      t.point(12, [(extMin[0] + extMax[0]) / 2, (extMin[1] + extMax[1]) / 2], 2);
      t.point(13, [0, 0], 2);
      t.point(14, [10, 10], 2);
      t.point(15, [10, 10], 2);
      t.point(16, [0, 0, 1]);
      t.point(17, [0, 0, 0]);
      t.num(40, Math.max(size[1], size[0] / 1.5, 1) * 1.1);
      t.num(41, 1.5);
      t.num(42, 50);
      t.num(43, 0);
      t.num(44, 0);
      t.num(50, 0);
      t.num(51, 0);
      for (const [code, v] of [[71, 0], [72, 1000], [73, 1], [74, 3], [75, 0], [76, 0], [77, 0], [78, 0], [281, 0], [65, 1]]) t.int(code, v);
    });
    table("LTYPE", [...drawing.linetypes.values()], (lt) => {
      record("LTYPE", tables.LTYPE, "AcDbLinetypeTableRecord", lt.name);
      t.str(3, lt.description ?? "");
      t.int(72, 65);
      t.int(73, lt.dashes.length);
      t.num(40, lt.dashes.reduce((s, d) => s + Math.abs(d), 0));
      for (const d of lt.dashes) {
        t.num(49, d);
        t.int(74, 0);
      }
    });
    table("LAYER", [...drawing.layers.values()], (l) => {
      record("LAYER", tables.LAYER, "AcDbLayerTableRecord", l.name, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      t.int(62, l.off ? -l.color.index : l.color.index);
      if (l.color.rgb !== undefined) t.int(420, l.color.rgb & 0xffffff);
      t.str(6, l.linetype);
      if (!l.plot) t.int(290, 0);
      t.int(370, l.lineweight);
      t.put(390, dict.normal);
    });
    table("STYLE", [...drawing.styles.values()], (s) => {
      record("STYLE", tables.STYLE, "AcDbTextStyleTableRecord", s.name);
      t.num(40, s.height);
      t.num(41, s.widthFactor);
      t.num(50, s.oblique * DEG);
      t.int(71, 0);
      t.num(42, s.height || 2.5);
      t.str(3, s.font);
      t.str(4, s.bigFont);
    });
    table("VIEW", [], () => {});
    table("UCS", [], () => {});
    table("APPID", ["ACAD"], (name) => record("APPID", tables.APPID, "AcDbRegAppTableRecord", name));
    table("DIMSTYLE", ["Standard"], (name) => {
      record("DIMSTYLE", tables.DIMSTYLE, "AcDbDimStyleTableRecord", name, 0, 105);
      for (const [code, v] of [[40, 1], [41, 2.5], [42, 0.625], [43, 3.75], [44, 1.25], [140, 2.5], [141, 2.5], [147, 0.625]]) t.num(code, v);
      for (const [code, v] of [[77, 1], [78, 8], [271, 2], [272, 2], [279, 0], [280, 0]]) t.int(code, v);
    }, "AcDbDimStyleTable");
    table("BLOCK_RECORD", [...drawing.blocks.values()], (b) => {
      t.str(0, "BLOCK_RECORD");
      t.put(5, b.handle);
      t.put(330, tables.BLOCK_RECORD);
      t.str(100, "AcDbSymbolTableRecord");
      t.str(100, "AcDbBlockTableRecord");
      t.str(2, b.name);
      t.put(340, layoutHandles.get(b.name) ?? "0");
      if (acadver >= "AC1021") {
        t.int(70, 0);
        t.int(280, 1);
        t.int(281, 0);
      }
      records.set(b.name, b.handle);
    });
  });

  // ブロック（モデルと、選ばれている紙のレイアウトの図形は ENTITIES に書く）
  section("BLOCKS", () => {
    for (const b of drawing.blocks.values()) {
      const paper = /^\*paper_space/i.test(b.name);
      t.str(0, "BLOCK");
      t.put(5, next());
      t.put(330, b.handle);
      t.str(100, "AcDbEntity");
      if (paper) t.int(67, 1);
      t.str(8, "0");
      t.str(100, "AcDbBlockBegin");
      t.str(2, b.name);
      t.int(70, (b.anonymous ? 1 : 0) | (b.entities.some((e) => e.type === "ATTDEF") ? 2 : 0));
      t.point(10, b.base ?? [0, 0, 0]);
      t.str(3, b.name);
      t.str(1, "");
      if (b.name !== MODEL && b.name !== PAPER) writeEntities(b, paper);
      t.str(0, "ENDBLK");
      t.put(5, next());
      t.put(330, b.handle);
      t.str(100, "AcDbEntity");
      if (paper) t.int(67, 1);
      t.str(8, "0");
      t.str(100, "AcDbBlockEnd");
    }
  });
  section("ENTITIES", () => {
    writeEntities(model, false);
    const paper = drawing.blocks.get(PAPER);
    if (paper) writeEntities(paper, true);
  });

  // 辞書とレイアウト
  section("OBJECTS", () => {
    const dictionary = (h, owner, entries, cls = null, fallback = null) => {
      t.str(0, cls ? "ACDBDICTIONARYWDFLT" : "DICTIONARY");
      t.put(5, h);
      t.put(330, owner);
      t.str(100, "AcDbDictionary");
      t.int(281, 1);
      for (const [name, value] of entries) {
        t.str(3, name);
        t.put(350, value);
      }
      if (cls) {
        t.str(100, cls);
        t.put(340, fallback);
      }
    };
    dictionary(dict.root, "0", [["ACAD_GROUP", dict.group], ["ACAD_LAYOUT", dict.layout], ["ACAD_PLOTSTYLENAME", dict.plot]]);
    dictionary(dict.group, dict.root, []);
    dictionary(dict.layout, dict.root, drawing.layouts.map((l) => [l.name, layoutHandles.get(l.block)]));
    dictionary(dict.plot, dict.root, [["Normal", dict.normal]], "AcDbDictionaryWithDefault", dict.normal);
    t.str(0, "ACDBPLACEHOLDER");
    t.put(5, dict.normal);
    t.put(330, dict.plot);
    for (const l of drawing.layouts) {
      const size = l.paper ? [l.paper.max[0] - l.paper.min[0], l.paper.max[1] - l.paper.min[1]] : [420, 297];
      const limits = l.limits ?? [[0, 0], size];
      t.str(0, "LAYOUT");
      t.put(5, layoutHandles.get(l.block));
      t.put(330, dict.layout);
      t.str(100, "AcDbPlotSettings");
      t.str(1, "");
      t.str(4, "");
      t.str(6, "");
      for (const [code, v] of [[40, 0], [41, 0], [42, 0], [43, 0], [44, size[0]], [45, size[1]], [46, 0], [47, 0], [48, 0], [49, 0], [140, 0], [141, 0], [142, 1], [143, 1]]) t.num(code, v);
      t.int(70, l.model ? 1024 : 0);
      t.int(72, 1);
      t.int(73, 0);
      t.int(74, 5);
      t.str(7, "");
      t.int(75, 16);
      t.int(76, 0);
      t.int(77, 2);
      t.int(78, 300);
      t.num(147, 1);
      t.num(148, 0);
      t.num(149, 0);
      t.str(100, "AcDbLayout");
      t.str(1, l.name);
      t.int(70, 1);
      t.int(71, l.tabOrder ?? 0);
      t.point(10, limits[0], 2);
      t.point(11, limits[1], 2);
      t.point(12, [0, 0, 0]);
      t.point(14, [1e20, 1e20, 1e20]);
      t.point(15, [-1e20, -1e20, -1e20]);
      t.num(146, 0);
      t.point(13, [0, 0, 0]);
      t.point(16, [1, 0, 0]);
      t.point(17, [0, 1, 0]);
      t.int(76, 1);
      t.put(330, records.get(l.block));
    }
  });
  t.str(0, "EOF");
  t.lines[handseedAt] = next();
  const text = `${t.lines.join("\r\n")}\r\n`;
  if (acadver >= "AC1021") return { bytes: new TextEncoder().encode(text), notes, drawing };
  // R2000: Shift_JIS に無い文字は \U+XXXX（AutoCAD の逃がし方）。4 桁に収まらない文字（𠮷 など）は R2000 で表せないので ?
  notes.escaped = 0;
  notes.replaced = 0;
  const { bytes } = encodeShiftJis(text, (c) => {
    const code = c.codePointAt(0);
    if (code > 0xffff) return notes.replaced++, "?";
    notes.escaped++;
    return `\\U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
  return { bytes, notes, drawing };
}
