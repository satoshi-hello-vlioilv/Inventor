// B-rep 層: SAB エンティティからトポロジを辿り、寸法情報にまとめる。
// 対応する Python 実装: ipt_inspect/brep.py

import { add, cross, dot, length, mul, reject, sub, unit } from "./vec.js";

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
const ARC_STEP = Math.PI / 32; // 円弧のサンプリング刻み（外接箱・表示用の折れ線）
const FULL_TURN_DEG = 360;
const ANGLE_TOL_DEG = 1e-3;
const DIGITS = 6;

/** 小数第 d 位に丸める（-0 は 0 に揃える）。配列は要素ごと。 */
export const round = (v, d = DIGITS) => (Array.isArray(v) ? v.map((x) => round(x, d)) : Number(v.toFixed(d)) + 0);

/** 最小値と最大値（大きな配列でも引数展開の上限に当たらないようループで求める）。 */
function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function canonicalDirection(a) {
  a = unit(a);
  const first = a.find((c) => Math.abs(c) > 1e-9) ?? 0;
  return first < 0 ? mul(a, -1) : a;
}

// ---- 解析曲線・曲面 -----------------------------------------------------------
export function curveOf(e) {
  if (!e) return { kind: "none" };
  if (e.type === "straight-curve") return { kind: "line", origin: e.positions[0], direction: e.vectors[0] };
  if (e.type === "ellipse-curve") {
    return { kind: "ellipse", origin: e.positions[0], direction: e.vectors[0], major: e.vectors[1], ratio: e.doubles[0] };
  }
  return { kind: e.type };
}

function curvePoint(c, t) {
  if (c.kind === "line") return add(c.origin, mul(c.direction, t));
  const minor = mul(cross(unit(c.direction), c.major), c.ratio);
  return add(c.origin, add(mul(c.major, Math.cos(t)), mul(minor, Math.sin(t))));
}

function sampleCurve(c, t0, t1) {
  if (c.kind === "line") return [curvePoint(c, t0), curvePoint(c, t1)];
  if (c.kind === "ellipse") {
    const n = Math.max(2, Math.ceil(Math.abs(t1 - t0) / ARC_STEP));
    return Array.from({ length: n + 1 }, (_, i) => curvePoint(c, t0 + ((t1 - t0) * i) / n));
  }
  return [];
}

export function surfaceOf(e) {
  if (!e) return { kind: "none" };
  if (e.type === "plane-surface") return { kind: "plane", origin: e.positions[0], direction: e.vectors[0] };
  if (e.type === "cone-surface") {
    // doubles: ratio, [u 範囲], sin(半頂角), cos(半頂角), u スケール
    const d = e.doubles;
    const [sinAngle, cosAngle, ratio] = [d.at(-3), d.at(-2), d[0]];
    const kind = Math.abs(sinAngle) < 1e-12 && Math.abs(ratio - 1) < 1e-12 ? "cylinder" : "cone";
    return { kind, origin: e.positions[0], direction: e.vectors[0], radius: length(e.vectors[1]), normalOutward: cosAngle >= 0 };
  }
  return { kind: e.type };
}

const sweepDeg = (edge) => (edge.curve.kind === "ellipse" ? (Math.abs(edge.t1 - edge.t0) * 180) / Math.PI : 0);
/** 円筒・円錐面が凹（面の法線が軸を向く）か。穴と軸・角R と隅R の判別に使う。 */
const isConcave = (face) => (face.surface.normalOutward === undefined ? null : face.surface.normalOutward === face.reversed);

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

  edge(e) {
    const curve = curveOf(this.ref(e, "curve"));
    let [t0, t1] = e.doubles;
    const againstCurve = Boolean(e.bools[0]);
    if (againstCurve) [t0, t1] = [-t1, -t0]; // 稜線が曲線と逆向きなら、曲線上のパラメータは符号反転した区間
    let points = sampleCurve(curve, t0, t1);
    if (againstCurve) points.reverse();
    if (!points.length) points = ["start", "end"].map((s) => this.vertexPoint(this.ref(e, s))).filter(Boolean);
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
    const face = { index: e.index, surface: surfaceOf(this.ref(e, "surface")), reversed: Boolean(e.bools[0]), edges, loops };
    face.concave = isConcave(face);
    return face;
  }

  isClosed(body) {
    return this.faces(body).every((f) => this.coedges(f).every((c) => this.ref(c, "partner") !== null));
  }
}

// ---- 要約 --------------------------------------------------------------------
const CYLINDER_KIND = { "true,true": "hole", "false,true": "boss", "false,false": "round", "true,false": "inner_round" };

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
  const shells = topo.shells(body).length;
  const loops = faceEntities.reduce((n, f) => n + topo.loops(f).length, 0);
  const closed = topo.isClosed(body);
  // V - E + F - (L - F) = 2(S - G)  →  G = S - (V - E + 2F - L) / 2
  const euler = vertexIds.size - edgeIds.size + 2 * faces.length - loops;
  const genus = closed && euler % 2 === 0 ? shells - euler / 2 : null;
  const points = faces.flatMap((f) => f.edges.flatMap((e) => e.points));
  const ranges = [0, 1, 2].map((k) => (points.length ? extent(points.map((p) => p[k] * scale)) : [0, 0]));
  const lo = ranges.map((r) => r[0]);
  const hi = ranges.map((r) => r[1]);
  const surfaces = {};
  for (const f of faces) surfaces[f.surface.kind] = (surfaces[f.surface.kind] ?? 0) + 1;
  return {
    index: body.index,
    closed,
    shells,
    faces: faces.length,
    loops,
    edges: edgeIds.size,
    vertices: vertexIds.size,
    genus,
    surfaces,
    bbox_min: round(lo),
    bbox_max: round(hi),
    size: round(sub(hi, lo)),
    cylinders: cylinderFeatures(faces, scale),
  };
}

function cylinderFeatures(faces, scale) {
  const groups = new Map();
  for (const f of faces) {
    const s = f.surface;
    if (s.kind !== "cylinder") continue;
    const axis = round(canonicalDirection(s.direction));
    const foot = round(reject(s.origin, canonicalDirection(s.direction)), 5); // 軸上で原点に最も近い点
    const key = [round(s.radius, 5), axis, foot, f.concave].join("|");
    if (!groups.has(key)) groups.set(key, { axis, concave: f.concave, members: [] });
    groups.get(key).members.push(f);
  }

  const features = [];
  for (const { axis, concave, members } of groups.values()) {
    const surface = members[0].surface;
    const sweep = Math.min(FULL_TURN_DEG, members.reduce((sum, f) => sum + Math.max(0, ...f.edges.map(sweepDeg)), 0));
    const heights = members.flatMap((f) => f.edges.flatMap((e) => e.points.map((p) => dot(p, axis))));
    const [h0, h1] = extent(heights);
    const center = add(reject(surface.origin, axis), mul(axis, (h0 + h1) / 2));
    const full = sweep >= FULL_TURN_DEG - ANGLE_TOL_DEG;
    features.push({
      kind: CYLINDER_KIND[`${Boolean(concave)},${full}`],
      diameter: round(surface.radius * 2 * scale),
      radius: round(surface.radius * scale),
      axis,
      center: round(mul(center, scale)),
      length: round((h1 - h0) * scale),
      sweep_deg: round(sweep),
      face_ids: members.map((f) => f.index),
    });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return features.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.center[0], b.center[0]) || cmp(a.center[1], b.center[1]) || cmp(a.center[2], b.center[2]));
}
