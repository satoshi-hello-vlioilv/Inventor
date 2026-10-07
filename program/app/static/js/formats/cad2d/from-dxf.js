// DXF（AutoCAD の交換形式。ASCII とバイナリ）を、図面のモデル（model.js。DWG と共通）に読む。
// 節: HEADER（版・文字コード・単位）・TABLES（画層・線種・文字スタイル・ブロックの記録）・BLOCKS・ENTITIES・OBJECTS（レイアウト）。
// 角度は度（DXF）→ ラジアン（モデル）に直す。文字コード: R2007 以降は UTF-8、それより前は $DWGCODEPAGE（ANSI_932 なら Shift_JIS）。

import { completeSpline } from "./curves.js";
import { cadText, createDrawing, normalizeLayouts, unitsOf } from "./model.js";

export class DxfError extends Error {}

const BINARY_SENTINEL = "AutoCAD Binary DXF\r\n\x1a\0";
const RAD = Math.PI / 180;
// $DWGCODEPAGE → 文字コード
const CODEPAGES = {
  ansi_874: "windows-874", ansi_932: "shift_jis", ansi_936: "gbk", ansi_949: "euc-kr", ansi_950: "big5", ansi_1250: "windows-1250",
  ansi_1251: "windows-1251", ansi_1252: "windows-1252", ansi_1253: "windows-1253", ansi_1254: "windows-1254", ansi_1255: "windows-1255",
  ansi_1256: "windows-1256", ansi_1257: "windows-1257", ansi_1258: "windows-1258", dos932: "shift_jis",
};
const VERSIONS = { AC1006: "R10", AC1009: "R12", AC1012: "R13", AC1014: "R14", AC1015: "R2000", AC1018: "R2004", AC1021: "R2007", AC1024: "R2010",
  AC1027: "R2013", AC1032: "R2018" };

/** DXF か（バイナリの印、または先頭が「0 / SECTION」。UTF-8 の BOM と 999 の注釈は飛ばす） */
export const isDxf = (bytes) =>
  isBinaryDxf(bytes) || /^(\xef\xbb\xbf)?\s*(999\s*\r?\n[^\n]*\r?\n\s*)*0\s*\r?\nSECTION/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)));
const isBinaryDxf = (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 22)) === BINARY_SENTINEL;

// ---- 群（グループコードと値）の並び ---------------------------------------------------------------------------
// 値の型はグループコードの範囲で決まる（DXF の説明書「グループコードの値の型」）。ここに無いコードは文字列
const RANGES = [
  ["d", 10, 59], ["d", 110, 149], ["d", 210, 239], ["d", 460, 469], ["d", 1010, 1059],
  ["i16", 60, 79], ["i16", 170, 179], ["i16", 270, 289], ["i16", 370, 389], ["i16", 400, 409], ["i16", 1060, 1070],
  ["i32", 90, 99], ["i32", 420, 429], ["i32", 440, 459], ["i32", 1071, 1071],
  ["i64", 160, 169], ["bool", 290, 299], ["bin", 310, 319], ["bin", 1004, 1004],
];
const TYPES = new Map();
for (const [type, from, to] of RANGES) for (let c = from; c <= to; c++) TYPES.set(c, type);
const valueType = (code) => TYPES.get(code) ?? "s";

/** ASCII の DXF → [[コード, 値]] */
function asciiTags(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const tags = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) throw new DxfError(`DXF の ${i + 1} 行目のグループコードが数ではありません。`);
    const raw = lines[i + 1];
    const type = valueType(code);
    tags.push([code, type === "s" ? cadText(raw) : type === "d" ? parseFloat(raw) : type === "bin" ? raw.trim() : parseInt(raw, 10)]);
  }
  return tags;
}

/** バイナリの DXF → [[コード, 値]]（R13 以降はコードが 2 バイト。R12 は 1 バイトで 255 のとき続く 2 バイト） */
function binaryTags(bytes, decode) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = [];
  let p = 22;
  // R12 か R13+ かは、最初の群（0 SECTION）のコードの幅で見分ける
  const wide = bytes[p + 1] === 0 && bytes[p + 2] === 0x53;
  const readString = () => {
    const end = bytes.indexOf(0, p);
    const s = decode(bytes.subarray(p, end));
    p = end + 1;
    return s;
  };
  while (p < bytes.length) {
    let code;
    if (wide) {
      code = view.getUint16(p, true);
      p += 2;
    } else {
      code = bytes[p++];
      if (code === 255) {
        code = view.getUint16(p, true);
        p += 2;
      }
    }
    const type = valueType(code);
    let value;
    if (type === "s") value = cadText(readString());
    else if (type === "d") {
      value = view.getFloat64(p, true);
      p += 8;
    } else if (type === "bin") {
      const n = bytes[p++];
      value = Array.from(bytes.subarray(p, p + n), (b) => b.toString(16).padStart(2, "0")).join("");
      p += n;
    } else if (type === "i32") {
      value = view.getInt32(p, true);
      p += 4;
    } else if (type === "i64") {
      value = Number(view.getBigInt64(p, true));
      p += 8;
    } else if (type === "bool") value = bytes[p++];
    else {
      value = view.getInt16(p, true);
      p += 2;
    }
    tags.push([code, value]);
    if (code === 0 && value === "EOF") break;
  }
  return tags;
}

/** 文字コードを決めて、群の並びにする */
function readTags(bytes) {
  const binary = isBinaryDxf(bytes);
  // 先頭の見出しを latin1 で読み、版と文字コードを知る
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  let version = (head.match(/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/) ?? [])[1];
  const codepage = ((head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([\w-]+)/) ?? [])[1] ?? "").toLowerCase();
  if (binary) {
    // バイナリでは見出しの値が文字列のまま入っている
    version = (head.match(/\$ACADVER\0[\s\S]{1,3}(AC\d{4})/) ?? [])[1] ?? version;
  }
  const utf8 = (version && version >= "AC1021") || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  let label = utf8 ? "utf-8" : CODEPAGES[codepage] ?? "windows-1252";
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    label = "windows-1252";
    decoder = new TextDecoder(label);
  }
  const decode = (b) => decoder.decode(b);
  return { tags: binary ? binaryTags(bytes, decode) : asciiTags(decode(bytes).replace(/^﻿/, "")), version, binary };
}

// ---- 節と図形のまとまり ---------------------------------------------------------------------------------------------
/** 群の並びを、0 の群で区切ったまとまり（{ type, tags }）にする */
function* records(tags, start, end) {
  let i = start;
  while (i < end) {
    if (tags[i][0] !== 0) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < end && tags[j][0] !== 0) j++;
    yield { type: tags[i][1], tags: tags.slice(i + 1, j) };
    i = j;
  }
}

function sections(tags) {
  const out = {};
  for (let i = 0; i < tags.length; i++) {
    if (tags[i][0] === 0 && tags[i][1] === "SECTION" && tags[i + 1]?.[0] === 2) {
      const name = tags[i + 1][1];
      let j = i + 2;
      while (j < tags.length && !(tags[j][0] === 0 && tags[j][1] === "ENDSEC")) j++;
      out[name] = [i + 2, j];
      i = j;
    }
  }
  return out;
}

/** 群から値を取り出す道具 */
const get = (tags, code, fallback = undefined) => {
  const t = tags.find((x) => x[0] === code);
  return t ? t[1] : fallback;
};
const point = (tags, code, fallback = [0, 0, 0]) => {
  const i = tags.findIndex((x) => x[0] === code);
  if (i < 0) return fallback;
  return [tags[i][1], get(tags, code + 10, 0), get(tags, code + 20, 0)];
};
const extrusion = (tags) => point(tags, 210, [0, 0, 1]);
/** サブクラス（100 の群）の中の群だけ（同じコードが別のサブクラスにもあるとき: LAYOUT の 1 など） */
const subclass = (tags, name) => {
  const start = tags.findIndex((t) => t[0] === 100 && t[1] === name);
  if (start < 0) return [];
  const end = tags.findIndex((t, i) => i > start && t[0] === 100);
  return tags.slice(start + 1, end < 0 ? tags.length : end);
};

function header(tags, [start, end]) {
  const vars = {};
  let name = null;
  for (let i = start; i < end; i++) {
    const [code, value] = tags[i];
    if (code === 9) {
      name = value;
      vars[name] = [];
    } else if (name) vars[name].push([code, value]);
  }
  return vars;
}

// ---- 図形 ----------------------------------------------------------------------------------------------------
function common(type, tags, handle) {
  const lw = get(tags, 370);
  const rgb = get(tags, 420);
  const color = { index: get(tags, 62, 256) };
  if (rgb !== undefined) color.rgb = rgb & 0xffffff;
  return {
    type, handle: String(get(tags, 5, handle ?? "")).toUpperCase(), layer: String(get(tags, 8, "0")),
    color, linetype: String(get(tags, 6, "BYLAYER")).toUpperCase() === "BYLAYER" ? "BYLAYER" : normalizeLinetype(get(tags, 6, "BYLAYER")),
    lineweight: lw === undefined ? -1 : lw, ltscale: get(tags, 48, 1), invisible: get(tags, 60, 0) === 1,
    paper: get(tags, 67, 0) === 1,
  };
}
const normalizeLinetype = (name) => (/^(byblock|continuous)$/i.test(name) ? name.toUpperCase() : name);

/** 繰り返す点（LWPOLYLINE の頂点など）: コード 10 が来るたびに新しい点 */
function lwpolyline(tags) {
  const points = [], bulges = [], widths = [];
  for (const [code, value] of tags) {
    if (code === 10) {
      points.push([value, 0]);
      bulges.push(0);
      widths.push([0, 0]);
    } else if (code === 20 && points.length) points.at(-1)[1] = value;
    else if (code === 42 && points.length) bulges[bulges.length - 1] = value;
    else if (code === 40 && points.length) widths.at(-1)[0] = value;
    else if (code === 41 && points.length) widths.at(-1)[1] = value;
  }
  return { points, bulges, widths };
}

function text(tags) {
  return {
    p: point(tags, 10), align: tags.some((t) => t[0] === 11) ? point(tags, 11) : null, height: get(tags, 40, 0),
    rotation: get(tags, 50, 0) * RAD, widthFactor: get(tags, 41, 1), oblique: get(tags, 51, 0) * RAD,
    halign: get(tags, 72, 0), valign: get(tags, 73, 0) || get(tags, 74, 0), generation: get(tags, 71, 0) & 6, // 2 左右・4 上下の反転だけが意味を持つ
    text: String(get(tags, 1, "")), style: String(get(tags, 7, "Standard")), extrusion: extrusion(tags),
  };
}

function spline(tags) {
  const knots = [], controls = [], weights = [], fit = [];
  for (let i = 0; i < tags.length; i++) {
    const [code, value] = tags[i];
    if (code === 40) knots.push(value);
    else if (code === 41) weights.push(value);
    else if (code === 10) controls.push([value, get(tags.slice(i), 20, 0), get(tags.slice(i), 30, 0)]);
    else if (code === 11) fit.push([value, get(tags.slice(i), 21, 0), get(tags.slice(i), 31, 0)]);
  }
  const flags = get(tags, 70, 0);
  return { degree: get(tags, 71, 3), knots, controls, weights: weights.length === controls.length ? weights : [], fit, fitTolerance: get(tags, 44, 0),
    closed: Boolean(flags & 1), periodic: Boolean(flags & 2), rational: Boolean(flags & 4),
    startTangent: tags.some((t) => t[0] === 12) ? point(tags, 12) : null, endTangent: tags.some((t) => t[0] === 13) ? point(tags, 13) : null };
}

function mtext(tags) {
  let value = "";
  for (const [code, v] of tags) if (code === 3) value += v;
  value += get(tags, 1, "");
  const direction = tags.some((t) => t[0] === 11) ? point(tags, 11) : [Math.cos(get(tags, 50, 0) * RAD), Math.sin(get(tags, 50, 0) * RAD), 0];
  return { p: point(tags, 10), direction, extrusion: extrusion(tags), height: get(tags, 40, 1), width: get(tags, 41, 0),
    attach: get(tags, 71, 1), drawing: get(tags, 72, 1), text: value, style: String(get(tags, 7, "Standard")), lineSpacing: get(tags, 44, 1) };
}

/** HATCH の境界と模様（コードの並びを順に読む） */
function hatch(tags) {
  let i = tags.findIndex((t) => t[0] === 91);
  const loops = [];
  const take = () => tags[i++];
  const n = i >= 0 ? tags[i][1] : 0;
  i = i >= 0 ? i + 1 : tags.length;
  const xy = () => [take()[1], take()[1]];
  for (let k = 0; k < n && i < tags.length; k++) {
    while (i < tags.length && tags[i][0] !== 92) i++;
    const flags = take()[1];
    const loop = { flags, edges: [] };
    if (flags & 2) {
      const bulged = tags[i]?.[0] === 72 ? take()[1] : 0;
      loop.closed = tags[i]?.[0] === 73 ? Boolean(take()[1]) : true;
      const count = tags[i]?.[0] === 93 ? take()[1] : 0;
      loop.points = [];
      loop.bulges = [];
      for (let v = 0; v < count; v++) {
        while (i < tags.length && tags[i][0] !== 10) i++;
        loop.points.push(xy());
        loop.bulges.push(bulged && tags[i]?.[0] === 42 ? take()[1] : 0);
      }
    } else {
      while (i < tags.length && tags[i][0] !== 93) i++;
      const count = take()[1];
      for (let e = 0; e < count; e++) {
        while (i < tags.length && tags[i][0] !== 72) i++;
        const kind = take()[1];
        const edge = {};
        const until = (code) => {
          while (i < tags.length && tags[i][0] !== code) i++;
        };
        if (kind === 1) {
          until(10);
          Object.assign(edge, { kind: "line", a: xy() });
          until(11);
          edge.b = xy();
        } else if (kind === 2) {
          until(10);
          Object.assign(edge, { kind: "arc", center: xy(), radius: take()[1], start: take()[1] * RAD, end: take()[1] * RAD, ccw: take()[1] === 1 });
        } else if (kind === 3) {
          until(10);
          Object.assign(edge, { kind: "ellipse", center: xy() });
          until(11);
          Object.assign(edge, { major: xy(), ratio: take()[1], start: take()[1] * RAD, end: take()[1] * RAD, ccw: take()[1] === 1 });
        } else if (kind === 4) {
          Object.assign(edge, { kind: "spline", degree: take()[1], rational: take()[1] === 1, periodic: take()[1] === 1, knots: [], controls: [], weights: [], fit: [] });
          const knots = take()[1], controls = take()[1];
          for (let q = 0; q < knots; q++) edge.knots.push(take()[1]);
          for (let q = 0; q < controls; q++) {
            edge.controls.push(xy());
            if (tags[i]?.[0] === 42) edge.weights.push(take()[1]);
          }
          if (tags[i]?.[0] === 97) {
            const fits = take()[1];
            for (let q = 0; q < fits; q++) edge.fit.push(xy());
          }
        }
        loop.edges.push(edge);
      }
    }
    loops.push(loop);
  }
  // 模様の線（53 角度・43/44 基点・45/46 ずれ・79 破線の数・49 破線）
  const lines = [];
  for (let j = 0; j < tags.length; j++) {
    if (tags[j][0] !== 53) continue;
    const line = { angle: tags[j][1] * RAD, base: [get(tags.slice(j), 43, 0), get(tags.slice(j), 44, 0)],
      offset: [get(tags.slice(j), 45, 0), get(tags.slice(j), 46, 0)], dashes: [] };
    const count = get(tags.slice(j), 79, 0);
    let k = tags.findIndex((t, idx) => idx > j && t[0] === 79);
    for (let q = 0; q < count && k >= 0; q++) {
      k++;
      if (tags[k]?.[0] === 49) line.dashes.push(tags[k][1]);
    }
    lines.push(line);
  }
  return { loops, solid: get(tags, 70, 0) === 1, pattern: String(get(tags, 2, "")), angle: get(tags, 52, 0) * RAD, scale: get(tags, 41, 1), lines,
    elevation: get(tags, 30, 0), extrusion: extrusion(tags), style: get(tags, 75, 0), gradient: get(tags, 450, 0) === 1 };
}

const DIMENSION_KIND = ["linear", "aligned", "angular", "diameter", "radius", "angular3", "ordinate"];

/** DXF の図形 1 つ（と、続く子: POLYLINE の VERTEX・INSERT の ATTRIB）→ モデルの図形。描かない種類は null */
function entity(record, children, unsupported) {
  const { type, tags } = record;
  const e = (t) => common(t, tags);
  switch (type) {
    case "LINE": return { ...e("LINE"), a: point(tags, 10), b: point(tags, 11), extrusion: extrusion(tags) };
    case "POINT": return { ...e("POINT"), p: point(tags, 10) };
    case "CIRCLE": return { ...e("CIRCLE"), center: point(tags, 10), radius: get(tags, 40, 0), extrusion: extrusion(tags) };
    case "ARC":
      return { ...e("ARC"), center: point(tags, 10), radius: get(tags, 40, 0), start: get(tags, 50, 0) * RAD, end: get(tags, 51, 0) * RAD, extrusion: extrusion(tags) };
    case "ELLIPSE":
      return { ...e("ELLIPSE"), center: point(tags, 10), major: point(tags, 11), ratio: get(tags, 40, 1), start: get(tags, 41, 0),
        end: get(tags, 42, 2 * Math.PI), extrusion: extrusion(tags) };
    case "LWPOLYLINE": {
      const flags = get(tags, 70, 0);
      return { ...e("LWPOLYLINE"), ...lwpolyline(tags), constWidth: get(tags, 43, 0), closed: Boolean(flags & 1),
        elevation: get(tags, 38, 0), extrusion: extrusion(tags) };
    }
    case "POLYLINE": {
      const flags = get(tags, 70, 0);
      const kind = flags & 64 ? "pface" : flags & 16 ? "mesh" : flags & 8 ? "3d" : "2d";
      let vertices = children.filter((c) => c.type === "VERTEX");
      const elevation = point(tags, 10)[2];
      const vflags = (v) => get(v.tags, 70, 0);
      if (kind === "2d" || kind === "3d") {
        const fitted = vertices.filter((v) => vflags(v) & 8);
        vertices = fitted.length ? fitted : vertices.filter((v) => !(vflags(v) & 16));
      }
      const real = kind === "pface" ? vertices.filter((v) => vflags(v) & 64) : vertices;
      return { ...e("POLYLINE"), kind, closed: Boolean(flags & 1), extrusion: extrusion(tags), elevation, m: get(tags, 71, 0), n: get(tags, 72, 0),
        vertices: real.map((v) => { const p = point(v.tags, 10); return { p: kind === "2d" ? [p[0], p[1], elevation] : p, bulge: get(v.tags, 42, 0) }; }),
        faces: kind === "pface" ? vertices.filter((v) => (vflags(v) & 192) === 128).map((v) => [71, 72, 73, 74].map((c) => get(v.tags, c, 0))) : undefined };
    }
    case "SPLINE": return completeSpline({ ...e("SPLINE"), ...spline(tags) });
    case "TEXT": return { ...e("TEXT"), ...text(tags) };
    case "ATTDEF": return { ...e("ATTDEF"), ...text(tags), tag: String(get(tags, 2, "")), prompt: String(get(tags, 3, "")), flags: get(tags, 70, 0) };
    case "MTEXT": return { ...e("MTEXT"), ...mtext(tags) };
    case "INSERT": {
      const attribs = children.filter((c) => c.type === "ATTRIB").map((c) => ({ ...common("ATTRIB", c.tags), ...text(c.tags),
        tag: String(get(c.tags, 2, "")), flags: get(c.tags, 70, 0) }));
      return { ...e("INSERT"), block: String(get(tags, 2, "")), p: point(tags, 10), scale: [get(tags, 41, 1), get(tags, 42, 1), get(tags, 43, 1)],
        rotation: get(tags, 50, 0) * RAD, extrusion: extrusion(tags), columns: get(tags, 70, 1), rows: get(tags, 71, 1),
        columnSpacing: get(tags, 44, 0), rowSpacing: get(tags, 45, 0), attribs };
    }
    case "DIMENSION":
      return { ...e("DIMENSION"), kind: DIMENSION_KIND[get(tags, 70, 0) & 7] ?? "linear", block: String(get(tags, 2, "")), text: String(get(tags, 1, "")),
        measurement: get(tags, 42), textMid: point(tags, 11), extrusion: extrusion(tags), p10: point(tags, 10), p13: point(tags, 13),
        p14: point(tags, 14), p15: point(tags, 15), p16: point(tags, 16), dimstyle: String(get(tags, 3, "")) };
    case "HATCH": return { ...e("HATCH"), ...hatch(tags) };
    case "SOLID": case "TRACE":
      return { ...e("SOLID"), points: [10, 11, 12, 13].map((c) => point(tags, c)), extrusion: extrusion(tags) };
    case "3DFACE": return { ...e("3DFACE"), points: [10, 11, 12, 13].map((c) => point(tags, c)), invisibleEdges: get(tags, 70, 0) };
    case "LEADER": {
      const points = [];
      for (let i = 0; i < tags.length; i++) if (tags[i][0] === 10) points.push([tags[i][1], get(tags.slice(i), 20, 0), get(tags.slice(i), 30, 0)]);
      return { ...e("LEADER"), points, arrow: get(tags, 71, 1) === 1, pathType: get(tags, 72, 0), extrusion: extrusion(tags) };
    }
    case "RAY": return { ...e("RAY"), p: point(tags, 10), direction: point(tags, 11) };
    case "XLINE": return { ...e("XLINE"), p: point(tags, 10), direction: point(tags, 11) };
    case "VIEWPORT":
      return { ...e("VIEWPORT"), center: point(tags, 10), width: get(tags, 40, 0), height: get(tags, 41, 0), viewCenter: [get(tags, 12, 0), get(tags, 22, 0)],
        viewHeight: get(tags, 45, 0), twist: get(tags, 51, 0) * RAD, viewTarget: point(tags, 17), viewDirection: point(tags, 16, [0, 0, 1]),
        id: get(tags, 69, 0) };
    case "SEQEND": case "VERTEX": case "ATTRIB": case "ENDBLK": case "BLOCK": return null;
    default:
      unsupported.set(type, (unsupported.get(type) ?? 0) + 1);
      return null;
  }
}

/** 図形のまとまりの並び → モデルの図形の並び（POLYLINE・INSERT は続く子を SEQEND まで集める） */
function entities(list, unsupported) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const record = list[i];
    const children = [];
    const hasChildren = record.type === "POLYLINE" || (record.type === "INSERT" && get(record.tags, 66, 0) === 1);
    if (hasChildren) {
      while (i + 1 < list.length && list[i + 1].type !== "SEQEND" && (list[i + 1].type === "VERTEX" || list[i + 1].type === "ATTRIB")) children.push(list[++i]);
      if (list[i + 1]?.type === "SEQEND") i++;
    }
    const e = entity(record, children, unsupported);
    if (e) out.push(e);
  }
  return out;
}

/** DXF のバイト列 → 図面のモデル */
export function drawingFromDxf(bytes) {
  const { tags, version } = readTags(bytes);
  const parts = sections(tags);
  if (!parts.ENTITIES && !parts.BLOCKS) throw new DxfError("DXF の図形の節（ENTITIES・BLOCKS）が見つかりません。");
  const vars = parts.HEADER ? header(tags, parts.HEADER) : {};
  const acadver = get(vars.$ACADVER ?? [], 1, version ?? "");
  const drawing = createDrawing({ format: "dxf", version: VERSIONS[acadver] ?? acadver, codepage: get(vars.$DWGCODEPAGE ?? [], 3, null) });
  drawing.units = unitsOf(get(vars.$INSUNITS ?? [], 70, 0));
  drawing.ltscale = get(vars.$LTSCALE ?? [], 40, 1) || 1;
  const unsupported = drawing.unsupported;

  // 表
  if (parts.TABLES) {
    for (const r of records(tags, ...parts.TABLES)) {
      const t = r.tags;
      if (r.type === "LAYER") {
        const index = get(t, 62, 7), rgb = get(t, 420);
        const flags = get(t, 70, 0);
        drawing.layers.set(String(get(t, 2, "")), { name: String(get(t, 2, "")), color: { index: Math.abs(index), ...(rgb !== undefined && { rgb: rgb & 0xffffff }) },
          off: index < 0, frozen: Boolean(flags & 1), locked: Boolean(flags & 4), plot: get(t, 290, 1) !== 0,
          linetype: String(get(t, 6, "Continuous")), lineweight: get(t, 370, -3) });
      } else if (r.type === "LTYPE") {
        const dashes = t.filter((x) => x[0] === 49).map((x) => x[1]);
        drawing.linetypes.set(String(get(t, 2, "")), { name: String(get(t, 2, "")), description: String(get(t, 3, "")), dashes });
      } else if (r.type === "STYLE") {
        drawing.styles.set(String(get(t, 2, "")), { name: String(get(t, 2, "")), font: String(get(t, 3, "")), bigFont: String(get(t, 4, "")),
          height: get(t, 40, 0), widthFactor: get(t, 41, 1), oblique: get(t, 50, 0) * RAD });
      }
    }
  }

  // ブロック
  if (parts.BLOCKS) {
    const list = [...records(tags, ...parts.BLOCKS)];
    for (let i = 0; i < list.length; i++) {
      if (list[i].type !== "BLOCK") continue;
      const t = list[i].tags;
      const name = String(get(t, 2, ""));
      const body = [];
      while (i + 1 < list.length && list[i + 1].type !== "ENDBLK") body.push(list[++i]);
      drawing.blocks.set(name, { name, handle: get(t, 330) === undefined ? undefined : String(get(t, 330)).toUpperCase(), base: point(t, 10), anonymous: Boolean(get(t, 70, 0) & 1), xref: Boolean(get(t, 70, 0) & 4),
        entities: entities(body, unsupported) });
    }
  }
  // 図形の節: モデル空間と、選ばれている紙のレイアウトの図形（67 = 1）
  const modelName = [...drawing.blocks.keys()].find((n) => /^\*model_space$/i.test(n)) ?? "*Model_Space";
  const paperName = [...drawing.blocks.keys()].find((n) => /^\*paper_space$/i.test(n)) ?? "*Paper_Space";
  if (parts.ENTITIES) {
    const all = entities([...records(tags, ...parts.ENTITIES)], unsupported);
    const model = all.filter((x) => !x.paper), paper = all.filter((x) => x.paper);
    const ensure = (name) => drawing.blocks.get(name) ?? drawing.blocks.set(name, { name, base: [0, 0, 0], entities: [] }).get(name);
    ensure(modelName).entities.push(...model);
    if (paper.length) ensure(paperName).entities.push(...paper);
  }

  // レイアウト（OBJECTS の LAYOUT。330 のブロックの記録のハンドル → ブロックの名前は、TABLES の BLOCK_RECORD から）
  const recordNames = new Map();
  if (parts.TABLES) for (const r of records(tags, ...parts.TABLES)) if (r.type === "BLOCK_RECORD") recordNames.set(String(get(r.tags, 5, "")).toUpperCase(), String(get(r.tags, 2, "")));
  const layouts = [];
  if (parts.OBJECTS) {
    for (const r of records(tags, ...parts.OBJECTS)) {
      if (r.type !== "LAYOUT") continue;
      const t = subclass(r.tags, "AcDbLayout");
      const owners = t.filter((x) => x[0] === 330).map((x) => String(x[1]).toUpperCase());
      const block = owners.map((h) => recordNames.get(h)).find(Boolean);
      layouts.push({ name: String(get(t, 1, "")), block, tabOrder: get(t, 71, 0),
        limits: [[get(t, 10, 0), get(t, 20, 0)], [get(t, 11, 0), get(t, 21, 0)]] });
    }
  }
  if (!layouts.length && drawing.blocks.get(paperName)?.entities.length) layouts.push({ name: "Layout1", block: paperName, tabOrder: 1 });
  drawing.layouts = normalizeLayouts(layouts, drawing.blocks, modelName);
  return drawing;
}
