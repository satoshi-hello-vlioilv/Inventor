// Jw_cad の図面（jww/index.js が読んだもの）→ 図面のモデル（model.js）。
//   座標は用紙の mm（用紙の中心が原点）のまま。1 枚の紙のレイアウト（用紙の大きさ）に全ての図形を置く
//   画層: 16 の画層グループ × 16 の画層 → 「グループ番号-画層番号 名前」（例 "0-1 寸法"）。状態 0（非表示）の画層・グループは隠す。
//         画層グループの縮尺（1/scale）は画層に持たせる（layer.scale。実寸 = 用紙の mm × scale）
//   色: 線の色の番号 1〜9 は見出しの画面の色、100〜356 は SXF の色、10 は塗りの図形が持つ RGB。画面の地の色の反対の色（黒地の白）は前景色
//   線種: 1 実線・2〜8 と 16〜19 は見出しの模様（印刷の長さ）・30〜62 は SXF の線種。
//   線幅（図形の penWidth）は意味を確かめられないので使わない（Jw_cad の画面では 500 も太く描かれない）
//   補助線（線種 9。印刷しない線）は、画層グループごとの「補助線（印刷しない）」の画層にまとめる（Jw_cad の DXF の書き出しも
//   専用の画層 ADD_LINE に分ける）。色は Jw_cad の画面と同じ (255,128,255)・点線。Jw_cad が内部の設定を書いた文字（用紙の外）は描かない

import { JwwError, PAPER_SIZES, isJww, readJww } from "../jww/index.js";
import { createDrawing, unitsOf } from "./model.js";

export { JwwError, isJww };

const TAU = Math.PI * 2;
const AUX_COLOR = { index: 211, rgb: 0xff80ff }; // 補助線の色（Jw_cad の画面で測った色。DXF の書き出しの色番号は 211）
const isAux = (e) => e.penStyle === 9 && e.kind !== "block"; // 補助線（ブロックの参照の線種は使わない）
/** Jw_cad が内部の設定を書いた文字（"Printer_PaperSize = 0" など）: 用紙の外 (0, -1000) の長さ 0 の文字で、中身が「名前 = 値」 */
const isSettingText = (e) => e.kind === "text" && [e.start, e.end].every((p) => p[0] === 0 && p[1] === -1000) && /^\s*\w+\s*=/.test(e.text);
const RAD = Math.PI / 180;

/** Jw_cad の既定の画面の色（見出しが読めないとき。番号 0 は地） */
const DEFAULT_PENS = [0x000000, 0xffff00, 0xffffff, 0x00ff00, 0xffff00, 0xff00ff, 0x0000ff, 0x00ffff, 0xff0000, 0x808080];

export function drawingFromJww(bytes) {
  const jw = readJww(bytes);
  const drawing = createDrawing({ format: "jww", version: String(jw.version) });
  drawing.units = unitsOf(4);
  drawing.memo = jw.memo;
  for (const w of jw.warnings) drawing.failures.push({ message: w });

  // 色: COLORREF（0x00BBGGRR）→ RGB。地（番号 0）の反対の色は前景色（白地の黒・黒地の白）
  const pens = jw.palette?.pens ?? DEFAULT_PENS.map(bgr);
  const background = rgbOf(pens[0]);
  const foreground = 0xffffff - background;
  const colorOf = (pen, rgb = null) => {
    if (pen === 10 && rgb !== null) return { index: 7, rgb: rgbOf(rgb) };
    const ref = pen >= 100 ? jw.palette?.extended?.[pen - 100] : pens[pen];
    if (ref === undefined) return { index: 7 };
    const c = rgbOf(ref);
    return c === foreground ? { index: 7 } : { index: 7, rgb: c };
  };

  // 線種（名前は番号）。1 = 実線
  for (const [number, segments] of jw.lineTypes) {
    if (!segments.length) continue;
    drawing.linetypes.set(`JW${number}`, { name: `JW${number}`, description: `Jw_cad の線種 ${number}`, dashes: segments.map((v, i) => (i % 2 ? -v : v)) });
  }
  const linetypeOf = (style) => (drawing.linetypes.has(`JW${style}`) ? `JW${style}` : "CONTINUOUS");

  // 画層（図形のある画層だけ作る）
  const layerName = (g, l) => {
    const name = (jw.groups[g]?.layers[l]?.name ?? "").trim();
    const id = `${g.toString(16).toUpperCase()}-${l.toString(16).toUpperCase()}`;
    const same = [id, String(l), l.toString(16).toUpperCase()].includes(name.toUpperCase()); // 名前が番号だけなら添えない
    return name && !same ? `${id} ${name}` : id;
  };
  const layerOf = (e) => {
    const g = e.layerGroup & 15, l = e.layer & 15, aux = isAux(e);
    const name = aux ? `${g.toString(16).toUpperCase()} 補助線（印刷しない）` : layerName(g, l);
    if (!drawing.layers.has(name)) {
      const group = jw.groups[g], layer = group?.layers[l];
      drawing.layers.set(name, { name, color: aux ? AUX_COLOR : { index: 7 }, off: !group?.state || (!aux && !layer?.state), frozen: false, locked: false,
        plot: !aux, linetype: aux ? linetypeOf(9) : "CONTINUOUS", lineweight: -3, group: group?.name ?? "", scale: group?.scale || 1 });
    }
    return name;
  };

  let handle = 0;
  const common = (e) => ({
    handle: (++handle).toString(16).toUpperCase(), layer: layerOf(e), color: isAux(e) ? AUX_COLOR : colorOf(e.penColor, e.rgb ?? null),
    linetype: linetypeOf(e.penStyle), lineweight: -3, ltscale: 1, invisible: false,
  });
  const blockName = new Map(jw.blockDefs.map((d) => [d.number, d.name || `BLOCK${d.number}`]));
  const convert = (list, out) => {
    for (const e of list) {
      if (isSettingText(e)) continue;
      const made = entityOf(e, common, blockName, drawing);
      if (made) out.push(...made);
    }
    return out;
  };
  for (const def of jw.blockDefs) {
    const name = blockName.get(def.number);
    drawing.blocks.set(name, { name, handle: "", base: [0, 0, 0], anonymous: false, xref: false, entities: convert(def.entities, []) });
  }
  const [label, w, h] = PAPER_SIZES[jw.paperSize] ?? PAPER_SIZES[3];
  drawing.blocks.set("*Paper_Space", { name: "*Paper_Space", handle: "", base: [0, 0, 0], anonymous: false, xref: false, entities: convert(jw.entities, []) });
  drawing.layouts.push({ name: label, block: "*Paper_Space", model: false, tabOrder: 0, paper: { min: [-w / 2, -h / 2], max: [w / 2, h / 2] } });
  return drawing;
}

const bgr = (rgb) => ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16);
/** COLORREF（0x00BBGGRR）→ 0xRRGGBB */
const rgbOf = (ref) => ((ref & 0xff) << 16) | (ref & 0xff00) | ((ref >> 16) & 0xff);
const at = (p) => [p[0], p[1], 0];

/** Jw_cad の図形 1 つ → 図面の図形（0 個以上） */
function entityOf(e, common, blockName, drawing) {
  switch (e.kind) {
    case "line": return [{ ...common(e), type: "LINE", a: at(e.a), b: at(e.b) }];
    case "arc": return [arcOf(e, common(e))];
    case "point": {
      if (e.temporary) return []; // 仮点は印刷しない
      return [{ ...common(e), type: "POINT", p: at(e.p) }];
    }
    case "text": return [textOf(e, common(e))];
    case "solid": return [{ ...common(e), type: "PATH", fill: "nonzero", alpha: 1, width: 0, dashes: [], cap: 0,
      subpaths: [{ points: e.points.flat(), curves: [], closed: true }] }];
    case "circleSolid": return [circleSolidOf(e, common(e))];
    case "block": {
      const block = blockName.get(e.number);
      if (!block) return [];
      return [{ ...common(e), type: "INSERT", block, p: at(e.p), scale: [e.scale[0], e.scale[1], 1], rotation: e.rotation,
        columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] }];
    }
    case "dimension": {
      // 寸法: 寸法線・文字・補助線を無名のブロックにまとめ、寸法の図形から指す（指したときに寸法の値を出す）
      const name = `*D${drawing.blocks.size + 1}`;
      const parts = [{ ...common(e.line), type: "LINE", a: at(e.line.a), b: at(e.line.b) }, textOf(e.text, common(e.text)),
        ...e.aux.filter((l) => l.a[0] !== l.b[0] || l.a[1] !== l.b[1]).map((l) => ({ ...common(l), type: "LINE", a: at(l.a), b: at(l.b) }))];
      drawing.blocks.set(name, { name, handle: "", base: [0, 0, 0], anonymous: true, xref: false, entities: parts });
      const length = Math.hypot(e.line.b[0] - e.line.a[0], e.line.b[1] - e.line.a[1]);
      return [{ ...common(e), type: "DIMENSION", kind: "aligned", block: name, text: e.text.text, measurement: length,
        p10: at(e.line.a), p13: at(e.line.a), p14: at(e.line.b) }];
    }
    default: return [];
  }
}

/** 円・円弧・楕円（扁平率 ≠ 1 か傾き）。始まりと開きの角は、傾けた軸の座標でのラジアン（楕円は媒介変数） */
function arcOf(e, c) {
  const sweep = e.full ? TAU : e.sweep;
  let start = e.full ? 0 : e.start, end = start + sweep;
  if (sweep < 0) [start, end] = [end, start];
  if (Math.abs(e.flatness - 1) < 1e-9) {
    const tilted = { start: start + e.tilt, end: end + e.tilt };
    if (e.full) return { ...c, type: "CIRCLE", center: at(e.center), radius: e.radius };
    return { ...c, type: "ARC", center: at(e.center), radius: e.radius, ...tilted };
  }
  // 楕円: 長軸が傾きの向き（扁平率 > 1 なら短い方が傾きの向きなので、軸を 90° 回して率を逆に）
  let major = [e.radius * Math.cos(e.tilt), e.radius * Math.sin(e.tilt), 0], ratio = e.flatness;
  if (ratio > 1) {
    major = [-e.radius * ratio * Math.sin(e.tilt), e.radius * ratio * Math.cos(e.tilt), 0];
    ratio = 1 / ratio;
    start -= Math.PI / 2;
    end -= Math.PI / 2;
  }
  return { ...c, type: "ELLIPSE", center: at(e.center), major, ratio, start, end };
}

/** 文字: 基線の始点と終点の間に収める（幅は Jw_cad が文字の大きさと間隔から決めたもの）。高さは文字の大きさ（用紙の mm） */
function textOf(e, c) {
  const bold = e.textType >= 20000 && e.textType < 30000, italic = e.textType >= 10000 && e.textType < 20000;
  const family = /明朝|Mincho/i.test(e.font) ? "serif" : null;
  const fits = Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]) > 1e-9;
  return {
    ...c, type: "TEXT", p: at(e.start), align: fits ? at(e.end) : null, halign: fits ? 5 : 0, valign: 0, height: e.size[1],
    rotation: e.angle * RAD, widthFactor: 1, oblique: 0, generation: 0, text: e.text, style: e.font || "Jw_cad",
    font: { family, weight: bold ? 700 : 400, italic }, extrusion: [0, 0, 1],
  };
}

/**
 * 円の塗り（線種 101: 円・扇形・弓形。105・106: 輪で、mode は内側の半径）→ 塗りのパス（折れ線で近似）。
 * 101 の mode: 100 = 円・0 = 扇形（中心を通る）・-1 と 5 = 弓形（弦で閉じる）。
 * 楕円の輪の内側: 105 は外側と相似（扁平率が同じ）、106 は帯の幅が一定（短い半径も同じ幅だけ小さい。Jw_cad の画面で確かめた）
 */
function circleSolidOf(e, c) {
  const ring = e.penStyle === 105 || e.penStyle === 106;
  const full = Math.abs(Math.abs(e.sweep) - TAU) < 1e-6 || (!ring && e.mode === 100);
  const [start, sweep] = full ? [0, TAU] : [e.start, e.sweep];
  const cos = Math.cos(e.tilt), sin = Math.sin(e.tilt);
  /** 半径 a（傾きの向き）・b の楕円の弧 */
  const arc = (a, b, reverse) => {
    const n = Math.max(16, Math.ceil((Math.abs(sweep) / TAU) * 128));
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const t = start + (sweep * (reverse ? n - k : k)) / n;
      const x = a * Math.cos(t), y = b * Math.sin(t);
      pts.push(e.center[0] + x * cos - y * sin, e.center[1] + x * sin + y * cos);
    }
    return pts;
  };
  const a = Math.abs(e.radius), b = a * e.flatness;
  let subpaths;
  if (ring) {
    const inner = Math.abs(e.mode), innerB = e.penStyle === 106 ? b - (a - inner) : inner * e.flatness;
    subpaths = inner > 1e-12 && inner < a && innerB > 1e-12
      ? full ? [{ points: arc(a, b, false), curves: [], closed: true }, { points: arc(inner, innerB, true), curves: [], closed: true }]
        : [{ points: [...arc(a, b, false), ...arc(inner, innerB, true)], curves: [], closed: true }]
      : [{ points: arc(a, b, false), curves: [], closed: true }];
  } else {
    const chord = e.mode === -1 || e.mode === 5;
    const pts = arc(a, b, false);
    if (!full && !chord) pts.push(e.center[0], e.center[1]);
    subpaths = [{ points: pts, curves: [], closed: true }];
  }
  return { ...c, type: "PATH", fill: "evenodd", alpha: 1, width: 0, dashes: [], cap: 0, subpaths };
}
