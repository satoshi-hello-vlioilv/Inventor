// .ipt の B-rep 層: SAB エンティティからトポロジを辿り、形式によらない中立な面・稜線（model/）にする。

import { length, sub } from "../../core/vec.js";
import { sampleCurve } from "../../model/curves.js";
import { isConcave, summarizeFaces, topologySummary } from "../../model/summary.js";
import { Tag } from "./sab.js";

// ASM 231 における refs の並び。先頭 2 つ (attrib, history) は全エンティティ共通。
export const SLOTS = {
  body: ["attrib", "history", "lump", "wire", "transform"],
  lump: ["attrib", "history", "next", "shell", "body"],
  shell: ["attrib", "history", "next", "subshell", "face", "wire", "lump"],
  face: ["attrib", "history", "next", "loop", "shell", "subshell", "surface"],
  loop: ["attrib", "history", "next", "coedge", "face"],
  coedge: ["attrib", "history", "next", "prev", "partner", "edge", "loop", "pcurve"],
  edge: ["attrib", "history", "start", "end", "coedge", "curve"],
  vertex: ["attrib", "history", "edge", "point"],
};
const THREAD_TAG = "INV_NMX_THREAD_TAG";
const ATTRIB_NEXT = 1; // 属性の refs: [attrib, next, prev, owner]（同じ持ち主の属性が next でつながる）
const PERIODIC = 2;

// ---- 解析曲線・曲面 -----------------------------------------------------------
/**
 * 交線など（intcurve）が持つ B スプライン（ACIS の bs3_curve）を読む。読めない形なら null。
 * 並び: "nubs"（有理なら "nurbs"）, 次数, 閉じ方, ノット数, (ノット値, 重複度) × ノット数,
 *       制御点 (x, y, z[, 重み]) × (重複度の合計 − 次数 + 1)
 * ACIS は両端のノットを「次数」重で持つので、標準の形（次数 + 1 重）に揃える。
 */
function splineOf(e) {
  const f = e.fields;
  let i = f.findIndex(([t, v]) => t === Tag.IDENT && (v === "nubs" || v === "nurbs"));
  if (i < 0) return null;
  const rational = f[i++][1] === "nurbs";
  const take = (...tags) => (i < f.length && tags.includes(f[i][0]) ? f[i++][1] : NaN);
  const degree = take(Tag.LONG);
  const closure = take(Tag.ENUM); // 0: 開いている, 1: 閉じている, 2: 周期的（パラメータが周期で巡る。制御点は全て並ぶ）
  const count = take(Tag.LONG);
  const knots = [];
  for (let k = 0; k < count; k++) {
    const value = take(Tag.DOUBLE), multiplicity = take(Tag.LONG);
    for (let m = 0; m < multiplicity; m++) knots.push(value);
  }
  const points = [], weights = [];
  for (let k = 0; k < knots.length - degree + 1; k++) {
    points.push([take(Tag.DOUBLE), take(Tag.DOUBLE), take(Tag.DOUBLE)]);
    weights.push(rational ? take(Tag.DOUBLE) : 1);
  }
  if (!(degree >= 1) || points.length <= degree || [...knots, ...points.flat(), ...weights].some(Number.isNaN)) return null;
  const period = closure === PERIODIC ? knots.at(-1) - knots[0] : 0;
  knots.unshift(knots[0]);
  knots.push(knots.at(-1));
  return { kind: "spline", degree, knots, points, weights, period, reversed: e.bools[0] === true };
}

export function curveOf(e) {
  if (!e) return { kind: "none" };
  if (e.type === "straight-curve") return { kind: "line", origin: e.positions[0], direction: e.vectors[0] };
  if (e.type === "ellipse-curve") {
    return { kind: "ellipse", origin: e.positions[0], direction: e.vectors[0], major: e.vectors[1], ratio: e.doubles[0] };
  }
  if (e.type === "intcurve-curve") return splineOf(e) ?? { kind: e.type };
  return { kind: e.type };
}

export function surfaceOf(e) {
  if (!e) return { kind: "none" };
  if (e.type === "plane-surface") return { kind: "plane", origin: e.positions[0], direction: e.vectors[0] };
  if (e.type === "cone-surface") {
    // doubles: ratio, [u 範囲], sin(半頂角), cos(半頂角), u スケール。
    // 半径は軸方向の高さ h（origin から軸の向きに測る）に比例して変わる: ρ(h) = |major| + h・sin / cos
    const d = e.doubles;
    const [sinAngle, cosAngle, ratio] = [d.at(-3), d.at(-2), d[0]];
    const circular = Math.abs(ratio - 1) < 1e-12;
    const kind = !circular ? e.type : Math.abs(sinAngle) < 1e-12 ? "cylinder" : "cone";
    return {
      kind, origin: e.positions[0], direction: e.vectors[0], major: e.vectors[1], radius: length(e.vectors[1]),
      slope: kind === "cone" ? sinAngle / cosAngle : 0, normalOutward: cosAngle >= 0,
    };
  }
  return { kind: e.type };
}

// ---- 属性（Inventor が面に付ける情報）------------------------------------------
/**
 * ねじ（INV_NMX_THREAD_TAG）。穴・ねじフィーチャが面に付ける。
 *   doubles: ピッチ, ねじ山の高さ / positions: ねじの始点, 終点, … / strings: 名前, 呼び径, 呼び, 種類, , , 等級, …
 * 始点・終点の座標系はフィーチャごとに異なる（穴の中心と一致しないことがある）ので、使うのは両者の距離（ねじ長さ）だけ。
 */
function threadOf(attrib) {
  const [, , designation, type, , , grade] = attrib.strings;
  const [start, end] = attrib.positions;
  if (!designation || !start || !end) return null;
  return { designation, type: type ?? "", class: grade ?? "", pitch: attrib.doubles[0], length: length(sub(end, start)) };
}

// ---- トポロジ ----------------------------------------------------------------
export class Topology {
  constructor(doc) {
    this.doc = doc;
  }

  ref(e, slot) {
    return this.doc.get(e.refs[SLOTS[e.type].indexOf(slot)]);
  }

  /** next 参照で連結されたリストを辿る（循環していても 1 周で止める）。 */
  chain(first, slot = "next") {
    const out = [], seen = new Set();
    for (let e = first; e && !seen.has(e.index); e = this.ref(e, slot)) {
      seen.add(e.index);
      out.push(e);
    }
    return out;
  }

  bodies() { return this.doc.ofType("body"); }
  shells(body) { return this.chain(this.ref(body, "lump")).flatMap((lump) => this.chain(this.ref(lump, "shell"))); }
  faces(body) { return this.shells(body).flatMap((shell) => this.chain(this.ref(shell, "face"))); }
  loops(face) { return this.chain(this.ref(face, "loop")); }
  coedges(face) { return this.loops(face).flatMap((loop) => this.chain(this.ref(loop, "coedge"))); }

  vertexPoint(vertex) {
    const point = vertex ? this.ref(vertex, "point") : null;
    return point ? point.positions[0] : null;
  }

  /** 面などに付いた属性（持ち主ごとに next でつながったリスト）。 */
  attributes(e) {
    const out = [], seen = new Set();
    for (let a = this.ref(e, "attrib"); a && !seen.has(a.index); a = this.doc.get(a.refs[ATTRIB_NEXT])) {
      seen.add(a.index);
      out.push(a);
    }
    return out;
  }

  edge(e) {
    const curve = curveOf(this.ref(e, "curve"));
    let [t0, t1] = e.doubles;
    const againstCurve = Boolean(e.bools[0]);
    if (againstCurve) [t0, t1] = [-t1, -t0]; // 稜線が曲線と逆向きなら、曲線上のパラメータは符号反転した区間
    let points = sampleCurve(curve, t0, t1);
    if (againstCurve) points.reverse();
    const ends = ["start", "end"].map((s) => this.vertexPoint(this.ref(e, s)));
    if (!points.length) points = ends.filter(Boolean);
    // 端点は頂点の座標にそろえる（交線の B スプラインは近似で、端が許容差の範囲でずれうる。隣の稜線と点を合わせるため）
    else ends.forEach((p, i) => p && (points[i ? points.length - 1 : 0] = p));
    return { index: e.index, curve, t0, t1, points };
  }

  /** ループを 1 本の閉じた折れ線にする（コエッジが逆向きなら稜線の点列を反転）。 */
  loopPolyline(loop) {
    const out = [];
    for (const coedge of this.chain(this.ref(loop, "coedge"))) {
      let { points } = this.edge(this.ref(coedge, "edge"));
      if (coedge.bools[0]) points = [...points].reverse();
      out.push(...(out.length ? points.slice(1) : points));
    }
    return out;
  }

  face(e) {
    const edges = this.coedges(e).map((c) => this.edge(this.ref(c, "edge")));
    const loops = this.loops(e).map((loop) => this.loopPolyline(loop));
    const threads = this.attributes(e).filter((a) => a.strings[0] === THREAD_TAG).map(threadOf).filter(Boolean);
    const face = { index: e.index, surface: surfaceOf(this.ref(e, "surface")), reversed: Boolean(e.bools[0]), edges, loops, threads };
    face.concave = isConcave(face);
    return face;
  }

  isClosed(body) {
    return this.faces(body).every((f) => this.coedges(f).every((c) => this.ref(c, "partner") !== null));
  }
}

// ---- 要約 --------------------------------------------------------------------
export function summarize(doc) {
  const topo = new Topology(doc);
  return topo.bodies().map((body) => summarizeBody(topo, body, doc.mmPerUnit));
}

function summarizeBody(topo, body, scale) {
  const faceEntities = topo.faces(body);
  const faces = faceEntities.map((f) => topo.face(f));
  const edgeIds = new Set(faceEntities.flatMap((f) => topo.coedges(f).map((c) => topo.ref(c, "edge").index)));
  const vertexIds = new Set();
  for (const id of edgeIds) {
    for (const s of ["start", "end"]) {
      const v = topo.ref(topo.doc.get(id), s);
      if (v) vertexIds.add(v.index);
    }
  }
  const counts = {
    shells: topo.shells(body).length,
    faces: faces.length,
    loops: faceEntities.reduce((n, f) => n + topo.loops(f).length, 0),
    edges: edgeIds.size,
    vertices: vertexIds.size,
  };
  return { index: body.index, ...topologySummary(counts, topo.isClosed(body)), ...summarizeFaces(faces, scale) };
}
