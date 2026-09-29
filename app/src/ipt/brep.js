// B-rep 層: SAB エンティティからトポロジを辿り、寸法情報にまとめる。
// 対応する Python 実装: ipt_inspect/brep.py

import { add, cross, dot, length, mul, reject, sub, unit } from "./vec.js";
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
const ARC_STEP = Math.PI / 32; // 円弧のサンプリング刻み（外接箱・表示用の折れ線）
const SPLINE_STEPS = 4; // B スプラインの 1 区間（ノット間）の分割数
const PERIODIC = 2;
const FULL_TURN_DEG = 360;
const HALF_TURN_DEG = 180;
const ANGLE_TOL_DEG = 1e-3;
const OVERLAP_TOL = 1e-7; // 軸方向の範囲の重なりとみなす長さ（モデル単位）。端で接するだけの面は重なりとしない
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

/** B スプライン上の点（de Boor 法。有理なら同次座標で計算する）。周期的なら t を 1 周期の範囲に戻す。 */
function splinePoint(c, t) {
  const { degree: p, knots: u, points, weights } = c;
  if (c.period) {
    let r = (t - u[0]) % c.period;
    if (r < 0) r += c.period;
    t = u[0] + r;
  }
  let k = p;
  while (k < points.length - 1 && t >= u[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= p; j++) {
    const [x, y, z] = points[k - p + j], w = weights[k - p + j];
    d.push([x * w, y * w, z * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const span = u[i + p - r + 1] - u[i];
      const a = span === 0 ? 0 : (t - u[i]) / span;
      d[j] = [0, 1, 2, 3].map((m) => (1 - a) * d[j - 1][m] + a * d[j][m]);
    }
  }
  const [x, y, z, w] = d[p];
  return [x / w, y / w, z / w];
}

function curvePoint(c, t) {
  if (c.kind === "line") return add(c.origin, mul(c.direction, t));
  if (c.kind === "spline") return splinePoint(c, c.reversed ? -t : t);
  const minor = mul(cross(unit(c.direction), c.major), c.ratio);
  return add(c.origin, add(mul(c.major, Math.cos(t)), mul(minor, Math.sin(t))));
}

/** 等分点 a → b（両端を含む n + 1 点）。 */
const divide = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

function sampleCurve(c, t0, t1) {
  if (c.kind === "line") return [curvePoint(c, t0), curvePoint(c, t1)];
  if (c.kind === "ellipse") return divide(t0, t1, Math.max(2, Math.ceil(Math.abs(t1 - t0) / ARC_STEP))).map((t) => curvePoint(c, t));
  if (c.kind === "spline") {
    // ノットの位置で区切り、各区間を等分する（曲がり具合はノットの細かさに表れている）。周期的なら周期ずらしたノットも使う
    const [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
    const unique = [...new Set(c.knots)];
    const base = (c.period ? unique.slice(0, -1) : unique).map((k) => (c.reversed ? -k : k)); // 周期的なら末尾 = 先頭 + 周期
    const shifts = [];
    if (c.period) {
      const [kmin, kmax] = extent(base);
      for (let m = Math.floor((lo - kmax) / c.period); m <= Math.ceil((hi - kmin) / c.period); m++) shifts.push(m * c.period);
    } else shifts.push(0);
    const inside = shifts.flatMap((d) => base.map((k) => k + d)).filter((t) => t > lo && t < hi);
    const breaks = [t0, ...inside.sort((a, b) => (t1 >= t0 ? a - b : b - a)), t1];
    return breaks.slice(1).flatMap((b, i) => divide(breaks[i], b, SPLINE_STEPS).slice(i ? 1 : 0)).map((t) => curvePoint(c, t));
  }
  return [];
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

const sweepDeg = (edge) => (edge.curve.kind === "ellipse" ? (Math.abs(edge.t1 - edge.t0) * 180) / Math.PI : 0);
/** 円筒・円錐面が凹（面の法線が軸を向く）か。穴と軸・角R と隅R の判別に使う。 */
const isConcave = (face) => (face.surface.normalOutward === undefined ? null : face.surface.normalOutward === face.reversed);

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
// 円筒の呼び名: 凹凸と周回角で決める。半周を超える円弧は直径（Φ）、半周以下は半径（R）で表す（JIS の寸法記入の規則）
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
    cones: coneFeatures(faces, scale),
  };
}

/**
 * 同じ曲面の上にある面を、1 つの形状要素ごとにまとめる。次のどちらかなら同じ要素とみなす。
 *   ・稜線を共有している（1 つの穴が 2 枚の半円筒に分かれている場合など）
 *   ・軸方向の範囲が重なっている（切り欠きで周方向に分断された外周など）
 * 同じ軸・同じ径でも軸方向に離れた面（向かい合う壁のねじ穴など）は別の要素になる。
 */
function connectedGroups(faces, keyOf) {
  const byKey = new Map();
  for (const f of faces) {
    const key = keyOf(f);
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const groups = [];
  for (const members of byKey.values()) {
    const parent = members.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (i, j) => (parent[find(i)] = find(j));
    const owner = new Map(); // 稜線 → 最初に見つけた面
    members.forEach((f, i) => {
      for (const e of f.edges) {
        if (owner.has(e.index)) union(i, owner.get(e.index));
        else owner.set(e.index, i);
      }
    });
    const axis = canonicalDirection(members[0].surface.direction);
    const spans = members.map((f) => extent(f.edges.flatMap((e) => e.points.map((p) => dot(p, axis)))));
    spans.forEach(([a0, a1], i) => spans.forEach(([b0, b1], j) => j > i && Math.min(a1, b1) - Math.max(a0, b0) > OVERLAP_TOL && union(i, j)));
    const roots = new Map();
    members.forEach((f, i) => {
      const r = find(i);
      if (!roots.has(r)) roots.set(r, []);
      roots.get(r).push(f);
    });
    groups.push(...roots.values());
  }
  return groups;
}

/** 回転面の要素に共通する値: 軸（向きを正規化）、軸方向の範囲、中心（範囲の中央の軸上の点）、軸からの距離の範囲。 */
function revolvedExtent(members, scale) {
  const surface = members[0].surface;
  const axis = round(canonicalDirection(surface.direction));
  const points = members.flatMap((f) => f.edges.flatMap((e) => e.points));
  const [h0, h1] = extent(points.map((p) => dot(p, axis)));
  const [r0, r1] = extent(points.map((p) => length(reject(sub(p, surface.origin), axis))));
  const center = add(reject(surface.origin, axis), mul(axis, (h0 + h1) / 2));
  return { axis, center: round(mul(center, scale)), length: round((h1 - h0) * scale), radii: [r0 * scale, r1 * scale] };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byKindAndCenter = (a, b) => cmp(a.kind, b.kind) || cmp(a.center[0], b.center[0]) || cmp(a.center[1], b.center[1]) || cmp(a.center[2], b.center[2]);

function cylinderFeatures(faces, scale) {
  const keyOf = (f) => {
    const s = f.surface;
    if (s.kind !== "cylinder") return null;
    const axis = canonicalDirection(s.direction);
    return [round(s.radius, 5), round(axis), round(reject(s.origin, axis), 5), f.concave].join("|"); // 軸上で原点に最も近い点
  };
  return connectedGroups(faces, keyOf).map((members) => {
    const surface = members[0].surface;
    const sweep = Math.min(FULL_TURN_DEG, members.reduce((sum, f) => sum + Math.max(0, ...f.edges.map(sweepDeg)), 0));
    const { axis, center, length: len } = revolvedExtent(members, scale);
    const threads = members.flatMap((f) => f.threads);
    return {
      kind: CYLINDER_KIND[`${Boolean(members[0].concave)},${sweep > HALF_TURN_DEG + ANGLE_TOL_DEG}`],
      diameter: round(surface.radius * 2 * scale),
      radius: round(surface.radius * scale),
      axis,
      center,
      length: len,
      sweep_deg: round(sweep),
      face_ids: members.map((f) => f.index),
      thread: threads.length ? {
        designation: threads[0].designation,
        type: threads[0].type,
        class: threads[0].class,
        pitch: round(threads[0].pitch * scale),
        lengths: threads.map((t) => round(t.length * scale)),
      } : null,
    };
  }).sort(byKindAndCenter);
}

/** 円錐面（ドリルの先端・皿・面取りなど）。頂角と、両端の直径を示す。 */
function coneFeatures(faces, scale) {
  const keyOf = (f) => {
    const s = f.surface;
    if (s.kind !== "cone") return null;
    const apex = add(s.origin, mul(unit(s.direction), -s.radius / s.slope));
    return [round(Math.abs(s.slope), 9), round(canonicalDirection(s.direction)), round(apex, 5), f.concave].join("|");
  };
  return connectedGroups(faces, keyOf).map((members) => {
    const { axis, center, length: len, radii } = revolvedExtent(members, scale);
    return {
      kind: "cone",
      concave: Boolean(members[0].concave),
      angle_deg: round((2 * Math.atan(Math.abs(members[0].surface.slope)) * 180) / Math.PI),
      diameters: round(radii.map((r) => r * 2)),
      axis,
      center,
      length: len,
      face_ids: members.map((f) => f.index),
    };
  }).sort(byKindAndCenter);
}
