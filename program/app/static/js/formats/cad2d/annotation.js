// 注記（幾何公差・マルチ引出線）を、描く部品（線・円弧・文字・塗り・ブロック参照・複数行の文字）に分ける。
// 画面（viewer2d/scene.js）はこの部品を描き、DXF の書き出し（to-dxf.js）は部品をそのまま書く（描き方を 1 か所に持つ）。
//   annotationParts(図形, 図面, width) → [図形]（model.js の図形。座標は注記と同じ座標系）
//     width(1 行の文字, 高さ) → 幅（画面のフォントで測る。無ければ見積もる）。文字の枠・下線の長さが文字の幅で決まる
//   部品の色・線種・太さの「ブロック」（色 0・BYBLOCK・-2）は、注記そのものの値を継ぐ（寸法のブロックと同じ）。
//   resolveParts(部品, 図形) … 継ぐ値を注記の値にした部品（DXF に書くとき）
//
// 幾何公差（TOLERANCE）: 段（改行）ごとに、欄（%%v）を左から箱に入れて並べる。置く点 = 1 段目の左の真ん中。
//   箱の高さ = 文字の高さの 2 倍（教材の記述。AutoCAD の正確な決まりは公開されていない）。横は文字の幅 ＋ 両側に DIMGAP（記号だけの欄は正方形）。
//   大きさ・色は寸法スタイル（DIMTXT・DIMGAP・DIMSCALE・DIMCLRD・DIMCLRT）から。記号は gdt.js の形
// マルチ引出線（MULTILEADER）: ezdxf の RenderEngine と同じ手順。中身（文字かブロック）→ 引出線ごとに線・矢印・折れ線 → 文字の枠・下線。
//   矢印は、線の最初の区間が矢印の 2 倍より長いときだけ（AutoCAD と同じ）。文字の枠の引出線の側の辺は、つなぐ点（折れ線の先）まで

import { completeSpline, ocsAxes, toOcs } from "./curves.js";
import { GDT, gdtRuns } from "./gdt.js";
import { dimVar } from "./model.js";
import { baselineOffsets, estimateTextWidth, mtextLines, wrapLines } from "../../viewer2d/text.js";

const BYBLOCK = { color: { index: 0 }, linetype: "BYBLOCK", lineweight: -2 };
// 矢印のブロックのうち、線を矢印の先まで引くもの（矢印の長さ 0: 点・斜線など。ezdxf の ORIGIN_ZERO と同じ）
const ZERO_LENGTH_ARROWS = new Set(["_archtick", "_oblique", "_dotsmall", "_small", "_integral", "_none"]);
const ATTACH_H = ["left", "center", "right"];
const ATTACH_V = ["top", "middle", "bottom"];

const unit = (p) => {
  const n = Math.hypot(p[0], p[1], p[2] ?? 0);
  return n > 1e-12 ? [p[0] / n, p[1] / n, (p[2] ?? 0) / n] : null;
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, (a[2] ?? 0) + (b[2] ?? 0) * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + (a[2] ?? 0) * (b[2] ?? 0);

/** 平面（原点 o・横の向き x・押し出し z）。local([横, 縦]) → 点。部品を作る道具も持つ */
function plane(o, x, z) {
  const n = unit(z ?? [0, 0, 1]) ?? [0, 0, 1];
  let u = [x[0], x[1], x[2] ?? 0];
  u = add(u, n, -dot(u, n));
  const axes = ocsAxes(n);
  u = unit(u) ?? (axes ? axes[0] : [1, 0, 0]);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const local = ([a, b]) => [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, (o[2] ?? 0) + u[2] * a + v[2] * b];
  const uo = toOcs(axes, u);
  const turn = Math.atan2(uo[1], uo[0]); // 横の向きの OCS での角度
  const flat = !axes;
  return {
    local, u, v, n,
    /** 折れ線（点は平面の座標） */
    polyline(points, closed, look) {
      const pts = points.map(local);
      if (flat) return { type: "LWPOLYLINE", ...look, points: pts.map((p) => [p[0], p[1]]), bulges: pts.map(() => 0), widths: pts.map(() => [0, 0]),
        constWidth: 0, closed, elevation: pts[0]?.[2] ?? 0, extrusion: [0, 0, 1] };
      return { type: "POLYLINE", ...look, kind: "3d", closed, vertices: pts.map((p) => ({ p, bulge: 0 })), extrusion: [0, 0, 1] };
    },
    /** 円・円弧（中心は平面の座標。角度は平面の横の向きから） */
    arc(center, r, from, to, look) {
      const c = toOcs(axes, local(center));
      if (to - from >= 2 * Math.PI - 1e-9) return { type: "CIRCLE", ...look, center: c, radius: r, extrusion: n };
      return { type: "ARC", ...look, center: c, radius: r, start: from + turn, end: to + turn, extrusion: n };
    },
    /** 1 行の文字（halign 0 左・1 中央、valign 0 基線・2 真ん中） */
    text(at, h, s, look, { halign = 0, valign = 0, style = "Standard" } = {}) {
      const p = toOcs(axes, local(at));
      return { type: "TEXT", ...look, p, align: halign || valign ? p : null, height: h, rotation: turn, widthFactor: 1, oblique: 0, halign, valign,
        generation: 0, text: s, style, extrusion: n };
    },
    /** 塗った三角（SOLID は 4 点。3 点目を繰り返す） */
    triangle(points, look) {
      const pts = points.map((p) => toOcs(axes, local(p)));
      return { type: "SOLID", ...look, points: [pts[0], pts[1], pts[2], pts[2]], extrusion: n };
    },
  };
}

/** 注記 → 部品（描かない種類は空） */
export function annotationParts(e, drawing, width = estimateTextWidth) {
  if (e.type === "TOLERANCE") return toleranceParts(e, drawing, width);
  if (e.type === "MULTILEADER") return multileaderParts(e, drawing, width);
  return [];
}

/** 部品の「ブロック」の値（色 0・BYBLOCK・-2）を、注記の値にする（画層も注記の画層に） */
export function resolveParts(parts, e) {
  return parts.map((p) => ({
    ...p, layer: p.layer === "0" || !p.layer ? e.layer : p.layer,
    color: (p.color?.index ?? 256) === 0 ? e.color : p.color,
    linetype: /^byblock$/i.test(p.linetype ?? "") ? e.linetype : p.linetype,
    lineweight: p.lineweight === -2 ? e.lineweight : p.lineweight,
  }));
}

// ---- 幾何公差 ---------------------------------------------------------------------------------------------------
function toleranceParts(e, drawing, width) {
  const v = (code) => dimVar(drawing, e.dimstyle, e.overrides, code);
  const k = v(40) > 0 ? v(40) : 1, h = v(140) * k, gap = Math.abs(v(147)) * k, H = 2 * h;
  if (!(h > 0)) return [];
  const pl = plane(e.p ?? [0, 0, 0], e.direction ?? [1, 0, 0], e.extrusion);
  const frame = { ...BYBLOCK, layer: "0", color: v(176) }, ink = { ...BYBLOCK, layer: "0", color: v(178) };
  const style = [...(drawing.dimstyles?.values() ?? [])].find((s) => s.name.toLowerCase() === String(e.dimstyle ?? "").toLowerCase())?.textStyle ?? "Standard";
  const parts = [];
  String(e.text ?? "").split(/\r?\n|\^J/).forEach((row, i) => {
    const y = -i * H;
    let x = 0;
    for (const field of row.split(/%%v/i)) {
      const runs = gdtRuns(field);
      if (!runs.length) continue;
      const widths = runs.map((r) => (r.glyph ? h : width(r.text, h)));
      const inner = widths.reduce((s, w) => s + w, 0) + h * 0.25 * (runs.length - 1);
      const w = runs.length === 1 && runs[0].glyph ? H : Math.max(H, inner + 2 * gap);
      parts.push(pl.polyline([[x, y - h], [x + w, y - h], [x + w, y + h], [x, y + h]], true, frame));
      let cx = x + (w - inner) / 2;
      runs.forEach((r, j) => {
        if (r.glyph) parts.push(...glyphParts(GDT[r.glyph], cx, y - h / 2, h, pl, ink, style));
        else parts.push(pl.text([cx, y - h / 2], h, r.text, ink, { style }));
        cx += widths[j] + h * 0.25;
      });
      x += w;
    }
  });
  return parts;
}

/** 幾何公差の記号 1 つ（1 × 1 の升目を、左下 (x, y)・大きさ h で） */
function glyphParts(g, x, y, h, pl, look, style) {
  const to = ([a, b]) => [x + a * h, y + b * h];
  const parts = g.lines.map((line) => pl.polyline(line.map(to), false, look));
  for (const arc of g.arcs) parts.push(pl.arc(to(arc.c), arc.r * h, arc.from, arc.to, look));
  if (g.letter) parts.push(pl.text(to([0.5, 0.5]), h * 0.55, g.letter, look, { halign: 1, valign: 2, style }));
  return parts;
}

// ---- マルチ引出線 -----------------------------------------------------------------------------------------------
function multileaderParts(e, drawing, width) {
  if (!(Math.abs(e.scale ?? 1) > 1e-9)) return []; // 尺度 0: 消える
  const parts = [];
  const text = e.text, z = text?.extrusion ?? e.content?.extrusion ?? [0, 0, 1];
  const line = { layer: "0", color: e.lineColor ?? { index: 0 }, linetype: e.lineLinetype ?? "BYBLOCK", lineweight: e.lineLineweight ?? -2 };
  let extents = null;
  if (text) {
    parts.push({ type: "MTEXT", layer: "0", color: text.color, linetype: "BYBLOCK", lineweight: -2, p: text.p, direction: text.direction ?? [1, 0, 0],
      extrusion: z, height: e.textHeight, width: text.width ?? 0, attach: text.attach ?? 1, drawing: 1, text: text.text, style: text.style ?? "Standard",
      lineSpacing: text.lineSpacing ?? 1 });
    extents = mtextExtents(text, e.textHeight, width);
  } else if (e.content?.block) {
    const c = e.content;
    parts.push({ type: "INSERT", layer: "0", color: c.color, linetype: "BYBLOCK", lineweight: -2, block: c.block, p: toOcs(ocsAxes(c.extrusion ?? z), c.p),
      scale: c.scale ?? [1, 1, 1], rotation: c.rotation ?? 0, extrusion: c.extrusion ?? z, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] });
  }
  const pl = plane(text?.p ?? e.base ?? [0, 0, 0], text?.direction ?? [1, 0, 0], z);
  const dogleg = (leader) => (unit(leader.doglegDirection ?? [1, 0, 0]) ?? [1, 0, 0]).map((c) => c * (leader.doglegLength ?? 0));
  if (e.leaderType !== 0) {
    for (const leader of e.leaders ?? []) {
      for (const l of leader.lines ?? []) parts.push(...leaderLine(e, leader, l, dogleg(leader), line, drawing, z));
      if (!text || !extents || !leader.last) continue;
      const a = e.attachment ?? {}, d = pl.u;
      if (!leader.vertical) {
        // 横に付ける文字の下線（付け方 5・6・8）: 折れ線の先から、文字の向きに文字の幅 ＋ 余白
        const cp = add(leader.last, dogleg(leader));
        const leftSide = dot([cp[0] - text.p[0], cp[1] - text.p[1], (cp[2] ?? 0) - (text.p[2] ?? 0)], d) < 0;
        const length = extents.width + (e.landingGap ?? 0);
        if ((leftSide ? [5, 6, 8].includes(a.left) : [5, 6, 8].includes(a.right)) && length > 1e-9) parts.push(segment(cp, add(cp, d, leftSide ? length : -length), line));
      } else {
        // 縦に付ける文字の上・下の線（付け方 10）: 最後の点を中心に、文字の幅
        const s = add(leader.last, d, -extents.width / 2), t = add(leader.last, d, extents.width / 2);
        const bottom = (t[0] - s[0]) * (text.p[1] - s[1]) - (t[1] - s[1]) * (text.p[0] - s[0]) > 0; // 文字が線の上: 引出線は下に付く
        if ((bottom && a.bottom === 10) || (!bottom && a.top === 10)) parts.push(segment(s, t, line));
      }
    }
  }
  if (e.frame && text && extents) {
    // 枠 = 文字の外形 ＋ 余白。横に付く引出線の側の辺は、つなぐ点（折れ線の先）まで（文字の幅の見積もりの誤差が出ない）
    const g = e.landingGap ?? 0;
    let [x0, x1] = [extents.left - g, extents.right + g];
    for (const leader of e.leaders ?? []) {
      if (leader.vertical || !leader.last) continue;
      const cp = add(leader.last, dogleg(leader));
      const along = dot([cp[0] - text.p[0], cp[1] - text.p[1], (cp[2] ?? 0) - (text.p[2] ?? 0)], pl.u);
      if (along < (x0 + x1) / 2) x0 = along;
      else x1 = along;
    }
    const [y0, y1] = [extents.bottom - g, extents.top + g];
    parts.push(pl.polyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, line));
  }
  return parts;
}

/** 2 点の線（WCS） */
const segment = (a, b, look) => ({ type: "LINE", ...look, a: [a[0], a[1], a[2] ?? 0], b: [b[0], b[1], b[2] ?? 0], extrusion: [0, 0, 1] });

/** マルチ引出線の文字の外形（文字の点からの横・縦。折り返しは幅で）→ { left, right, top, bottom, width } */
function mtextExtents(text, h, width) {
  let lines = mtextLines(text.text);
  if (text.width > 0) lines = wrapLines(lines, text.width, (s) => width(s, h));
  const w = Math.max(0, ...lines.map((s) => width(s, h)));
  const attach = Math.min(Math.max((text.attach ?? 1) - 1, 0), 8);
  const offsets = baselineOffsets({ mtext: true, lineSpacing: text.lineSpacing ?? 1, valign: ATTACH_V[Math.floor(attach / 3)] }, lines.length);
  const left = { left: 0, center: -w / 2, right: -w }[ATTACH_H[attach % 3]];
  return { left, right: left + w, top: (offsets[0] + 1) * h, bottom: offsets.at(-1) * h, width: w };
}

/** 引出線の 1 本: 点の並び ＋ 最後の点（と折れ線）。先に矢印（線の最初の区間が矢印の 2 倍より長いとき） */
function leaderLine(e, leader, l, doglegVector, line, drawing, z) {
  const vertices = l.points.map((p) => [p[0], p[1], p[2] ?? 0]);
  if (leader.last) {
    if (leader.vertical) vertices.push(leader.last);
    else {
      if (e.dogleg && e.leaderType !== 2) vertices.push(leader.last);
      vertices.push(add(leader.last, doglegVector));
    }
  }
  if (vertices.length < 2) return [];
  const look = { ...line, ...(l.color && l.color.index !== 0 && { color: l.color }) };
  const parts = [];
  const first = [vertices[1][0] - vertices[0][0], vertices[1][1] - vertices[0][1], vertices[1][2] - vertices[0][2]];
  const size = e.arrowSize ?? 0, direction = unit(first) ?? [1, 0, 0];
  if (size > 0 && Math.hypot(...first) > size * 2) {
    const name = (e.arrows ?? []).find(([index]) => index === l.index)?.[1] || e.arrow || "";
    parts.push(arrowHead(name, vertices[0], direction, size, look, drawing, z));
    if (!ZERO_LENGTH_ARROWS.has(name.toLowerCase())) vertices[0] = add(vertices[0], direction, size);
  }
  if (e.leaderType === 2 && vertices.length > 2) {
    parts.push(completeSpline({ type: "SPLINE", ...look, degree: 3, knots: [], controls: [], weights: [], fit: vertices, fitTolerance: 0,
      closed: false, periodic: false, rational: false, startTangent: null, endTangent: null }));
  } else {
    for (let i = 0; i + 1 < vertices.length; i++) parts.push(segment(vertices[i], vertices[i + 1], look));
  }
  return parts;
}

/** 矢印: 図面にあるブロック（_DOT など）はブロック参照（大きさ = 矢印の大きさ・向き = 線の向き ＋ 180°）。無ければ塗った三角（開き 18.92°） */
function arrowHead(name, tip, direction, size, look, drawing, z) {
  const pl = plane(tip, direction, z);
  const block = name && [...drawing.blocks.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
  if (block) {
    const axes = ocsAxes(pl.n), d = toOcs(axes, direction);
    return { type: "INSERT", ...look, block, p: toOcs(axes, tip), scale: [size, size, size], rotation: Math.atan2(d[1], d[0]) + Math.PI, extrusion: pl.n,
      columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
  }
  return pl.triangle([[0, 0], [size, size / 6], [size, -size / 6]], look);
}
