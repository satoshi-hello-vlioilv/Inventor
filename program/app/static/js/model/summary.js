// 面（形式によらない中立な形）の要約: 位相の数と種数、外接箱、曲面の種類ごとの数、円筒・円錐の形状要素（穴・外径・R・ねじ・円錐）。
// .ipt（SAB）と STEP で共用する。
//   面: { index, surface: {kind, origin, direction, major, radius, slope, normalOutward}, reversed, concave, edges, loops, threads }
//   稜線: { index, curve, t0, t1, points }

import { extent, round } from "../core/numbers.js";
import { add, canonicalDirection, dot, length, mul, reject, sub, unit } from "../core/vec.js";

const FULL_TURN_DEG = 360;
const HALF_TURN_DEG = 180;
const ANGLE_TOL_DEG = 1e-3;
const OVERLAP_TOL = 1e-7; // 軸方向の範囲の重なりとみなす長さ（モデル単位）。端で接するだけの面は重なりとしない
// 円筒の呼び名: 凹凸と周回角で決める。半周を超える円弧は直径（Φ）、半周以下は半径（R）で表す（JIS の寸法記入の規則）
const CYLINDER_KIND = { "true,true": "hole", "false,true": "boss", "false,false": "round", "true,false": "inner_round" };

const sweepDeg = (edge) => (edge.curve.kind === "ellipse" ? (Math.abs(edge.t1 - edge.t0) * 180) / Math.PI : 0);

/**
 * 面の円弧が囲む角度。同じ円（中心・向き・半径）の上の円弧は足し合わせ（STEP は 1 周の円を頂点で分けて持つことがある）、
 * 円ごとの最大を 360° で頭打ちにする。角の R の上下の縁のように別の円の円弧は足さない。
 */
function faceSweepDeg(face) {
  const circles = new Map();
  for (const edge of face.edges) {
    if (edge.curve.kind !== "ellipse") continue;
    const c = edge.curve;
    const key = [round(c.origin, 5), round(canonicalDirection(c.direction)), round(length(c.major), 5)].join("|");
    circles.set(key, (circles.get(key) ?? 0) + sweepDeg(edge));
  }
  return Math.min(FULL_TURN_DEG, Math.max(0, ...circles.values()));
}
/** 円筒・円錐面が凹（面の法線が軸を向く）か。穴と軸・角R と隅R の判別に使う。 */
export const isConcave = (face) => (face.surface.normalOutward === undefined ? null : face.surface.normalOutward === face.reversed);

/**
 * 位相の数と種数。V - E + F - (L - F) = 2(S - G)  →  G = S - (V - E + 2F - L) / 2
 * @param {{shells, faces, loops, edges, vertices}} counts
 */
export function topologySummary(counts, closed) {
  const euler = counts.vertices - counts.edges + 2 * counts.faces - counts.loops;
  const genus = closed && euler % 2 === 0 ? counts.shells - euler / 2 : null;
  return { closed, ...counts, genus };
}

/** 面から、外接箱・曲面の種類ごとの数・円筒と円錐の形状要素をまとめる。scale は 1 単位の mm。 */
export function summarizeFaces(faces, scale) {
  const points = faces.flatMap((f) => f.edges.flatMap((e) => e.points));
  const ranges = [0, 1, 2].map((k) => (points.length ? extent(points.map((p) => p[k] * scale)) : [0, 0]));
  const lo = ranges.map((r) => r[0]);
  const hi = ranges.map((r) => r[1]);
  const surfaces = {};
  for (const f of faces) surfaces[f.surface.kind] = (surfaces[f.surface.kind] ?? 0) + 1;
  return {
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
    const sweep = Math.min(FULL_TURN_DEG, members.reduce((sum, f) => sum + faceSweepDeg(f), 0));
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
