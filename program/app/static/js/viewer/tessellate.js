// シーン JSON の面を three.js の BufferGeometry に三角形分割する。
// 面の種類ごとに mesher を用意し、未対応の種類は null を返す（ビューアは稜線だけを描く）。
//
// どの面も境界ループ（隣の面と共有する稜線の点列）に沿って分割する。境界上に新しい点を足さないので、
// 面どうしは隙間なくつながる。円筒・円錐は展開図（角度 θ × 高さ h）の上で分割し、内側だけを細かくしてから曲面に戻す。
// 自由曲面（B スプライン）はパラメータ (u, v) の平面の上で同じように分割する。

import Constrainautor from "@kninnug/constrainautor";
import Delaunator from "delaunator";
import * as THREE from "three";
import { locateOnSurface, projectToSurface, surfaceDerivs, surfaceDomain } from "../model/nurbs.js";

const ARC_STEP = Math.PI / 32; // 曲面の分割の細かさ（稜線の円弧のサンプリングと同じ刻み）
const TUBE_STEP = Math.PI / 8; // トーラスの管のまわり（φ）の刻み。弦の誤差は管の半径の 1.9%（首下の R など小さい丸みが多い）
export const STEPS = { arc: ARC_STEP, tube: TUBE_STEP }; // 評価（弦の誤差の見積もり）用
const TAU = 2 * Math.PI;
const APEX_EPS = 1e-6; // 円錐の先端とみなす軸からの距離（mm）
const SAME_POINT = 1e-9; // 同じ点とみなす距離（mm）
const KEY = 2 ** 21; // 辺の番号 = 始点 × KEY + 終点（頂点の数は KEY 未満）
const REFINE_BUDGET = 200_000; // 1 面の細分で持てる点の数の上限（想定外の形で分割が止まらなくなるのを防ぐ安全弁）
const edgeKey = (i, j) => i * KEY + j;
const undirected = (i, j) => (i < j ? edgeKey(i, j) : edgeKey(j, i));
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const wrapAngle = (a) => a - TAU * Math.round(a / TAU); // (-π, π] 付近に戻す

/** 末尾が先頭と同じ点なら取り除き、開いた点列にする。 */
function openLoop(loop) {
  const points = loop.map(v3);
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < SAME_POINT) points.pop();
  return points;
}

/** 行って戻るだけの辺（円錐の継ぎ目の母線のように、面の内側を通る辺）と、続けて現れる同じ点を取り除く。 */
function withoutSpikes(points) {
  const out = [...points];
  for (let i = 0; out.length >= 3 && i < out.length; ) {
    const prev = out[(i + out.length - 1) % out.length], next = out[(i + 1) % out.length];
    if (out[i].distanceTo(next) < SAME_POINT || prev.distanceTo(next) < SAME_POINT) {
      out.splice(i, 1);
      i = Math.max(i - 1, 0); // 取り除いた点の前後が新たに隣り合うので、1 つ戻って見直す
    } else i++;
  }
  return out;
}

/**
 * 制約付き Delaunay 三角形分割（Delaunator + Constrainautor。判定は丸め誤差の無い robust-predicates）。
 * 輪（外周と穴）の辺を必ず三角形の辺にし、多角形の内側の三角形だけを、平面で反時計回りにして返す。
 * 内側かどうかは、外から輪の辺を何回越えるかの偶奇で決める（穴の中は 2 回で外側）。
 * 点が数千の細長い面（ねじ山・ローレットの B スプライン面など）でも、境界の点を省かず、面全体にまたがる細い三角形も作らない。
 * @param {THREE.Vector2[]} uv  全ての点（輪の点を連結した並びの後に、内部の点）
 * @param {number[]} sizes      輪ごとの点の数（先頭が外周）
 * @returns {number[][] | null}  分割できない（輪が交わるなど）ときは null
 */
function triangulate(uv, sizes) {
  const coords = new Float64Array(uv.length * 2);
  uv.forEach((p, i) => {
    coords[2 * i] = p.x;
    coords[2 * i + 1] = p.y;
  });
  let del;
  try {
    del = new Delaunator(coords);
  } catch {
    return null; // 全ての点が一直線に並ぶ
  }
  // 同じ座標の点は Delaunator が 1 つだけ使う。使われなかった点は、同じ座標の使われた点に置き換える
  const used = new Uint8Array(uv.length);
  for (const v of del.triangles) used[v] = 1;
  const byPlace = new Map();
  uv.forEach((p, i) => used[i] && byPlace.set(`${p.x},${p.y}`, i));
  const alias = (i) => (used[i] ? i : byPlace.get(`${uv[i].x},${uv[i].y}`) ?? -1);
  const edges = [];
  let base = 0;
  for (const n of sizes) {
    for (let i = 0; i < n; i++) {
      const [a, b] = [alias(base + i), alias(base + ((i + 1) % n))];
      if (a < 0 || b < 0) return null;
      if (a !== b) edges.push([a, b]);
    }
    base += n;
  }
  let con;
  try {
    con = new Constrainautor(del, edges);
  } catch {
    return null;
  }
  // 外（凸包の外）から、輪の辺を越えるたびに 1 増える深さ（0-1 BFS）。奇数が内側
  const { triangles, halfedges } = del;
  const count = triangles.length / 3;
  const depth = new Int32Array(count).fill(-1);
  const deque = [];
  const reach = (t, d, front) => {
    if (depth[t] >= 0 && depth[t] <= d) return;
    depth[t] = d;
    if (front) deque.unshift(t);
    else deque.push(t);
  };
  halfedges.forEach((adj, e) => adj < 0 && reach(Math.floor(e / 3), con.isConstrained(e) ? 1 : 0, !con.isConstrained(e)));
  while (deque.length) {
    const t = deque.shift();
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k, adj = halfedges[e];
      if (adj < 0) continue;
      const crossing = con.isConstrained(e) ? 1 : 0;
      reach(Math.floor(adj / 3), depth[t] + crossing, !crossing);
    }
  }
  const out = [];
  for (let t = 0; t < count; t++) {
    if (depth[t] % 2 !== 1) continue;
    const [a, b, c] = [triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2]];
    const orient = (uv[b].x - uv[a].x) * (uv[c].y - uv[a].y) - (uv[b].y - uv[a].y) * (uv[c].x - uv[a].x);
    out.push(orient < 0 ? [a, c, b] : [a, b, c]);
  }
  return out;
}

function plane(face) {
  const n = v3(face.normal).normalize();
  const helper = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const loops = face.loops.map(openLoop).filter((l) => l.length >= 3);
  if (!loops.length) return null;
  const flat = loops.map((l) => l.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
  // 面積が最大のループを外周、それ以外を穴として扱う
  const area = (l) => Math.abs(THREE.ShapeUtils.area(l));
  const outer = flat.reduce((best, l, i) => (area(l) > area(flat[best]) ? i : best), 0);
  const order = [outer, ...flat.keys()].filter((i, k) => k === 0 || i !== outer);
  const triangles = triangulate(order.flatMap((i) => flat[i]), order.map((i) => flat[i].length));
  if (!triangles) return null;
  const points = order.flatMap((i) => loops[i]);
  return { points, normals: points.map(() => n), index: triangles.flat() };
}

// ---- 回転面（円筒・円錐・トーラス）---------------------------------------------
// 展開図の座標は (θ, h)。θ は軸まわりの角度。h は円筒・円錐では軸方向の高さ、トーラスでは管のまわりの角度 φ。
//   periodicH … h も角度で、2π ごとに同じ点になる（トーラス）
//   hStep     … h の向きの細分の刻み。円筒・円錐は母線が直線なので細分しない（Infinity）。トーラスは TUBE_STEP

/** 軸まわりの座標系（軸・角度の基準・その直交方向）と、角度 θ の半径方向 */
function axisFrame(face) {
  const origin = v3(face.origin), axis = v3(face.axis).normalize(), ref = v3(face.ref).normalize();
  const side = new THREE.Vector3().crossVectors(axis, ref);
  const direction = (t) => ref.clone().multiplyScalar(Math.cos(t)).addScaledVector(side, Math.sin(t));
  const polar = (p) => {
    const d = p.clone().sub(origin);
    const x = d.dot(ref), y = d.dot(side);
    return { t: Math.atan2(y, x), z: d.dot(axis), rho: Math.hypot(x, y) };
  };
  return { origin, axis, direction, polar, sign: face.outward ? 1 : -1 };
}

/** 円筒・円錐: ρ(h) = radius + slope・h */
function revolvedFrame(face) {
  const { origin, axis, direction, polar, sign } = axisFrame(face);
  const slope = face.slope ?? 0;
  const point = (t, h) => origin.clone().addScaledVector(axis, h).addScaledVector(direction(t), face.radius + slope * h);
  return {
    apex: slope ? -face.radius / slope : null, // 半径が 0 になる高さ（円錐の先端）
    toUV(p) {
      const { t, z, rho } = polar(p);
      return { t, h: z, rho };
    },
    point,
    // 曲面の法線は (半径方向 − slope・軸) の向き。凹面なら反転する
    normal: (t, h) => direction(t).addScaledVector(axis, -slope).normalize().multiplyScalar(sign),
    // 先端の法線は θ で決まらないので、θ について平均した向き（軸方向の成分だけ）にする
    tipNormal: axis.clone().multiplyScalar(-Math.sign(slope) * sign),
    // 軸に垂直な平面への正射影 (x, y) = ρ(cos θ, sin θ) から曲面の点に戻す（円錐の先端を含む面の分割に使う）
    lift(x, y) {
      const rho = Math.hypot(x, y), t = Math.atan2(y, x), h = (rho - face.radius) / slope;
      return { p: point(t, h), t, h, x, y, rho };
    },
  };
}

/** トーラス: 点 = origin + (radius + minor・cos φ)・半径方向(θ) + minor・sin φ・軸 */
function torusFrame(face) {
  const { origin, axis, direction, polar, sign } = axisFrame(face);
  const [R, r] = [face.radius, face.minor];
  return {
    apex: null,
    periodicH: true,
    hStep: TUBE_STEP,
    toUV(p) {
      const { t, z, rho } = polar(p);
      return { t, h: Math.atan2(z, rho - R), rho };
    },
    point: (t, h) => origin.clone().addScaledVector(direction(t), R + r * Math.cos(h)).addScaledVector(axis, r * Math.sin(h)),
    normal: (t, h) => direction(t).multiplyScalar(Math.cos(h)).addScaledVector(axis, Math.sin(h)).normalize().multiplyScalar(sign),
    arc: [R, r], // 展開図の尺度（θ・φ → 弧長）
  };
}

/**
 * ループを展開図の点列にする。θ は連続になるよう巻き戻さずにたどる。
 * winding … 軸のまわりを何周するか（0: 面の中で閉じたループ、±1: 軸を 1 周するループ）
 * throughApex … 円錐の先端を通る（先端は θ が定まらないので点列から除き、面は apexCone で分割する）
 */
function unwrapLoop(loop, frame) {
  const raw = openLoop(loop).map((p) => ({ p, ...frame.toUV(p) }));
  const verts = raw.filter((v) => v.rho >= APEX_EPS);
  if (verts.length < 2) return null;
  let t = verts[0].t;
  for (const v of verts) v.t = t += wrapAngle(v.t - t);
  if (frame.periodicH) {
    let h = verts[0].h;
    for (const v of verts) v.h = h += wrapAngle(v.h - h);
  }
  const turn = verts.at(-1).t - verts[0].t + wrapAngle(verts[0].t - verts.at(-1).t);
  return { verts, winding: Math.round(turn / TAU), throughApex: verts.length < raw.length };
}

const shifted = (verts, dt) => verts.map((v) => ({ ...v, t: v.t + dt }));
const meanT = (verts) => verts.reduce((s, v) => s + v.t, 0) / verts.length;

/** 軸を 1 周するループを、start 番目の点から 1 周分（θ が増える向き、末尾は先頭と同じ位置で θ + 2π）に並べ直す。 */
function openAround({ verts, winding }, start) {
  const n = verts.length;
  let seq = Array.from({ length: n + 1 }, (_, j) => {
    const v = verts[(start + j) % n];
    return { ...v, t: v.t + (start + j >= n ? TAU * winding : 0) };
  });
  if (winding < 0) seq = shifted(seq.reverse(), TAU);
  return seq;
}

/**
 * 継ぎ目を置く角度。穴（面の中で閉じたループ）の角度の範囲と、軸を 1 周するループのうち母線に沿う辺（θ が一定の辺）を避け、
 * 最も広い隙間の中央に置く（母線に沿う辺に重ねると、切り開いた多角形がその辺を往復して潰れる）。
 */
function seamAngle(around, holes, fallback) {
  const ranges = holes.map(({ verts }) => verts.map((v) => v.t));
  for (const { verts } of around) {
    verts.forEach((v, i) => {
      const w = verts[(i + 1) % verts.length];
      if (Math.abs(wrapAngle(w.t - v.t)) < 1e-9 && w.p.distanceTo(v.p) > 0) ranges.push([v.t - 1e-6, v.t + 1e-6]);
    });
  }
  const spans = ranges.map((ts) => {
    const lo = Math.min(...ts), hi = Math.max(...ts);
    const start = ((lo % TAU) + TAU) % TAU;
    return [start, start + (hi - lo)];
  }).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return fallback;
  const wrapped = Math.max(...spans.map((s) => s[1])) - TAU; // 2π を越えて先頭側まで覆う分
  let best = { size: -1, at: fallback };
  spans.forEach(([, end], i) => {
    const next = i + 1 < spans.length ? spans[i + 1][0] : spans[0][0] + TAU;
    const reach = Math.max(end, wrapped, ...spans.slice(0, i).map((s) => s[1])); // 手前の区間がさらに先まで覆う場合
    if (next - reach > best.size) best = { size: next - reach, at: (reach + next) / 2 };
  });
  return best.at;
}

/** θ が target に最も近い点の番号（2π の差は同一視）。 */
const nearest = (verts, target) => verts.reduce((best, v, i) => (Math.abs(wrapAngle(v.t - target)) < Math.abs(wrapAngle(verts[best].t - target)) ? i : best), 0);

/**
 * 展開図の上で、外周（1 本の閉じた多角形）と穴に整理する。
 * 軸を 1 周するループが 2 本（筒状の面）なら継ぎ目で切り開いて 1 本の多角形にする
 * （1 本だけなのは円錐の先端を含む面で、apexCone が扱う）。
 * @returns {{ outer: object[], holes: object[][], cuts: number[] } | null}  cuts … 外周のうち稜線ではない辺（i → i + 1）
 */
function layout(loops, frame) {
  const around = loops.filter((l) => l.winding !== 0);
  const inside = loops.filter((l) => l.winding === 0);
  if (!around.length) {
    // 面の中で閉じたループだけ（部分円筒など）。展開図の面積が最大のものが外周
    const area = (l) => Math.abs(THREE.ShapeUtils.area(l.verts.map((v) => new THREE.Vector2(v.t, v.h))));
    const outer = inside.reduce((a, b) => (area(b) > area(a) ? b : a));
    // 穴は、外周の θ の範囲の中央から ±π の中へ移す。範囲は 2π 以下なので、中の穴は必ずそこに入る。
    // 点の平均を中央にすると、点の密な側（B スプラインの交線など）に寄り、範囲の端の穴が 1 周外へ出る
    const ts = outer.verts.map((v) => v.t);
    const center = (Math.min(...ts) + Math.max(...ts)) / 2;
    const holes = inside.filter((l) => l !== outer).map((l) => shifted(l.verts, TAU * Math.round((center - meanT(l.verts)) / TAU)));
    return { outer: outer.verts, holes, cuts: [] };
  }
  if (around.length !== 2) return null;
  const seam = seamAngle(around, inside, around[0].verts[0].t);
  const first = openAround(around[0], nearest(around[0].verts, seam));
  const start = shifted(first, TAU * Math.round((seam - first[0].t) / TAU)); // 継ぎ目の近くから 1 周（θ0 → θ0 + 2π）
  const t0 = start[0].t;
  const second = openAround(around[1], nearest(around[1].verts, t0));
  const back = shifted(second, TAU * Math.round((t0 - second[0].t) / TAU)).reverse(); // θ0 + 2π → θ0 の向きに戻る
  const holes = inside.map((l) => shifted(l.verts, TAU * Math.ceil((t0 - meanT(l.verts)) / TAU))); // θ0 〜 θ0 + 2π の中へ
  // 継ぎ目（外周の 1 周目の末尾 → 戻りの先頭、戻りの末尾 → 先頭）は稜線ではない。分割してよい
  return { outer: [...start, ...back], holes, cuts: [start.length - 1, start.length + back.length - 1] };
}

/**
 * 三角形の辺を、チャートの幅（chart.width、1 が細分の刻み）が 1 以下になるまで二等分する。
 * 境界の辺（稜線）は分けない（隣の面と点をそろえるため）。
 * 境界の辺がそれより広い三角形は、残りの 2 辺の目安を「境界の辺の幅の 3/4」に緩める
 * （三角形の不等式から、残りの 2 辺の幅の和は境界の辺以上なので、目安を下げないと分割が終わらない）。
 * 目安は辺ごとに記録し、辺の両側の三角形で同じ目安を使う（片側だけ厳しいと、その側が分けた辺を
 * もう片側が分け直すたびに境界の辺を含む三角形が生まれ直し、分割が終わらない）。
 * 分けた辺（中点のある辺）は、反対側の三角形も同じ中点で分ける（分けないと辺の途中に点が浮き、隙間になる）。
 * 先に出力した三角形も、後から中点ができれば分け直す。
 * 分けるべき辺（中点のある辺・目安を超える辺）を持つ三角形は、境界の辺以外で最も幅の広い辺で分ける（最長辺の二等分）。
 * 分けるべき辺そのものを分けると、長い辺を残したまま、3 つ目の点が同じ位置に近づき続けて終わらないことがある。
 * 点の数が REFINE_BUDGET に達したら、中点のある辺だけを分ける。これは新しい中点を作らないので、
 * そこで必ず終わり、隙間も残らない。
 */
function refine(verts, triangles, fixedEdge, chart) {
  const width = (i, j) => chart.width(verts[i], verts[j]);
  const edges = (tri) => [0, 1, 2].map((e) => [tri[e], tri[(e + 1) % 3]]);
  const relaxed = new Map(); // 辺 → 緩めた目安
  const register = (tri) => {
    const limit = Math.max(0, ...edges(tri).filter(([i, j]) => fixedEdge(i, j)).map(([i, j]) => 0.75 * width(i, j)));
    if (limit <= 1) return;
    for (const [i, j] of edges(tri)) {
      const key = undirected(i, j);
      if (!fixedEdge(i, j)) relaxed.set(key, Math.max(relaxed.get(key) ?? 0, limit));
    }
  };
  const excess = (i, j) => (fixedEdge(i, j) ? 0 : width(i, j) / Math.max(1, relaxed.get(undirected(i, j)) ?? 0));
  const midpoints = new Map();
  const midpoint = (i, j) => {
    const key = undirected(i, j);
    if (!midpoints.has(key)) midpoints.set(key, verts.push(chart.midpoint(verts[i], verts[j])) - 1);
    return midpoints.get(key);
  };
  const hasMidpoint = (tri) => edges(tri).some(([i, j]) => midpoints.has(undirected(i, j)));
  triangles.forEach(register);
  let out = [], stack = [...triangles];
  while (stack.length) {
    while (stack.length) {
      const tri = stack.pop();
      const open = verts.length < REFINE_BUDGET;
      const due = ([i, j]) => midpoints.has(undirected(i, j)) || (open && excess(i, j) > 1);
      let split = -1, widest = -1;
      if (edges(tri).some(due)) {
        edges(tri).forEach(([i, j], e) => {
          if (fixedEdge(i, j) || !(open || midpoints.has(undirected(i, j)))) return;
          const w = width(i, j);
          if (w > widest) [split, widest] = [e, w];
        });
      }
      if (split < 0) {
        out.push(tri);
        continue;
      }
      const [i, j, k] = [tri[split], tri[(split + 1) % 3], tri[(split + 2) % 3]];
      const m = midpoint(i, j);
      const halves = [[i, m, k], [m, j, k]];
      halves.forEach(register);
      stack.push(...halves);
    }
    stack = out.filter(hasMidpoint);
    if (stack.length) out = out.filter((tri) => !hasMidpoint(tri));
  }
  return out;
}

/**
 * 平面に写した多角形（外周 + 穴）を三角形分割し、曲面に沿うまで細分する（回転面の分割の共通部分）。
 * @param {object[][]} rings  点の列（先頭が外周）
 * @param {number[]} cuts     外周のうち稜線ではない辺（i → i + 1）。細分してよい
 * @param {object[]} inner    内部に加える点（円錐の先端）
 * @param {{ uv(v): THREE.Vector2, width(a, b): number, midpoint(a, b): object }} chart
 *   uv … 分割する平面の座標、width … 辺の幅（細分の刻みを 1 とする）、midpoint … 辺の中点（曲面の上の点）
 */
function meshChart(rings, cuts, inner, chart) {
  const verts = [...rings.flat(), ...inner];
  const fixed = new Set();
  let base = 0;
  rings.forEach((ring, r) => {
    ring.forEach((_, i) => {
      if (r === 0 && cuts.includes(i)) return;
      fixed.add(undirected(base + i, base + ((i + 1) % ring.length)));
    });
    base += ring.length;
  });
  const isFixed = (i, j) => fixed.has(undirected(i, j));
  const triangles = triangulate(verts.map(chart.uv), rings.map((ring) => ring.length));
  return triangles && { verts, triangles: refine(verts, triangles, isFixed, chart) };
}

function revolved(face) {
  const frame = face.type === "torus" ? torusFrame(face) : revolvedFrame(face);
  const loops = face.loops.map((l) => unwrapLoop(l, frame)).filter(Boolean);
  if (!loops.length) return null;
  if (frame.apex !== null && (loops.some((l) => l.throughApex) || loops.filter((l) => l.winding !== 0).length === 1)) return apexCone(face, frame);
  if (frame.periodicH) {
    // h も角度のときは、全てのループを最初のループと同じ 1 周の範囲にそろえる
    const meanH = (l) => l.verts.reduce((s, v) => s + v.h, 0) / l.verts.length;
    const h0 = meanH(loops[0]);
    for (const l of loops) {
      const dh = TAU * Math.round((h0 - meanH(l)) / TAU);
      if (dh) l.verts = l.verts.map((v) => ({ ...v, h: v.h + dh }));
    }
  }
  const plan = layout(loops, frame);
  if (!plan) return null;
  const rings = [plan.outer, ...plan.holes];
  // 展開図の尺度。円筒・円錐は母線（h の向き）に沿って真っすぐなので、誤差は θ の幅だけで決まる。
  // h を縮めて（面の高さ全体を 1 刻み分の弧長にして）から Delaunay 分割すると、θ の幅の小さい辺が選ばれ、
  // 上下の境界をジグザグに結ぶ細分のいらない分割になる（拡大縮小では三角形の表裏は変わらない）
  const all = rings.flat();
  const radius = all.reduce((s, v) => s + v.rho, 0) / all.length || 1;
  const hs = all.map((v) => v.h);
  // トーラスは h（φ）の向きにも曲がっているので、縮めずに弧長でそろえる
  const squash = frame.arc ? frame.arc[1] : Math.min(1, (ARC_STEP * radius) / Math.max(Math.max(...hs) - Math.min(...hs), 1e-9));
  const hStep = frame.hStep ?? Infinity;
  const { verts, triangles } = meshChart(rings, plan.cuts, [], {
    uv: (v) => new THREE.Vector2(v.t * radius, v.h * squash),
    width: (a, b) => Math.max(Math.abs(a.t - b.t) / ARC_STEP, Math.abs(a.h - b.h) / hStep),
    midpoint(a, b) {
      const t = (a.t + b.t) / 2, h = (a.h + b.h) / 2;
      return { p: frame.point(t, h), t, h };
    },
  }) ?? {};
  if (!triangles) return null;
  return { points: verts.map((v) => v.p), normals: verts.map((v) => frame.normal(v.t, v.h)), index: triangles.flat() };
}

/**
 * 円錐の先端を含む面。展開図は先端で特異（先端の高さの直線全体が 3D の 1 点に潰れる）で、
 * 先端のまわりの細い三角形が 3D で裏返ったり重なったりする。そこで軸に垂直な平面への正射影
 * (x, y) = ρ(cos θ, sin θ) の上で分割する。正射影は線形で、円錐の法線は軸方向の成分を持つので、
 * 平面で向きがそろい重ならない三角形分割は、3D でも向きがそろい重ならない。先端は平面の原点で、内部の点として加える。
 * 継ぎ目の母線（先端と縁を往復する辺）は面の内側を通るので、ループから取り除く。
 */
function apexCone(face, frame) {
  const rings = face.loops
    .map((loop) => withoutSpikes(openLoop(loop)))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((p) => {
      const { t, h, rho } = frame.toUV(p);
      return { p, t, h, rho, x: rho * Math.cos(t), y: rho * Math.sin(t) };
    }));
  if (!rings.length) return null;
  const uv = (v) => new THREE.Vector2(v.x, v.y);
  const area = (ring) => Math.abs(THREE.ShapeUtils.area(ring.map(uv)));
  rings.sort((a, b) => area(b) - area(a)); // 面積が最大のループが外周
  const isTip = (v) => v.rho < APEX_EPS;
  const tip = { p: frame.point(0, frame.apex), t: 0, h: frame.apex, rho: 0, x: 0, y: 0 };
  const { verts, triangles } = meshChart(rings, [], rings.some((ring) => ring.some(isTip)) ? [] : [tip], {
    uv,
    // 先端を通る辺は母線（曲面の上の直線）なので分けない。それ以外は先端から見た角度の幅で分ける
    width: (a, b) => (isTip(a) || isTip(b) ? 0 : Math.abs(wrapAngle(b.t - a.t)) / ARC_STEP),
    midpoint: (a, b) => frame.lift((a.x + b.x) / 2, (a.y + b.y) / 2),
  }) ?? {};
  if (!triangles) return null;
  return { points: verts.map((v) => v.p), normals: verts.map((v) => (isTip(v) ? frame.tipNormal : frame.normal(v.t, v.h))), index: triangles.flat() };
}

// ---- 自由曲面（B スプライン）------------------------------------------------------
// 境界の点をパラメータ (u, v) に写し（最近点）、その平面で分割してから、辺に沿って面の法線が回る角度が
// 円弧の刻み ARC_STEP 以下になるまで細分する（円筒・円錐と同じ細かさ）。
// 境界の点は元の座標のまま使う（隣の面と同じ点）。u・v の向きに閉じた曲面は、継ぎ目の上の点を前の点と同じ側に置く。

const ON_SURFACE = 1e-6; // 最近点が境界の点とこの比（面の大きさに対する）以内なら、曲面の上とみなす

/** 閉じた向き（最初と最後の制御点の列が一致する向き）: [u が閉じている, v が閉じている] */
function closedDirections(s) {
  const same = (a, b) => a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2]) < SAME_POINT);
  const columns = (j) => s.points.map((row) => row[j]);
  return [same(s.points[0], s.points.at(-1)), same(columns(0), columns(s.points[0].length - 1))];
}

/** ループの点をパラメータに写す。閉じた曲面を継ぎ目なしに 1 周するループ（継ぎ目の稜線の無い筒の縁など）は扱わない（null） */
function surfaceLoop(face, loop, domain, closed, size) {
  const points = openLoop(loop).filter((p, i, all) => i === 0 || p.distanceTo(all[i - 1]) >= SAME_POINT);
  const out = [];
  for (const p of points) {
    const q = p.toArray();
    const prev = out.at(-1);
    let hit = prev ? projectToSurface(face, q, [prev.u, prev.v], domain) : null;
    if (!hit || hit.distance > ON_SURFACE * size) hit = locateOnSurface(face, q, domain);
    const uv = [hit.u, hit.v];
    // 継ぎ目の上の点（範囲の端）は、前の点に近い側の端にする
    for (const k of [0, 1]) {
      const [lo, hi] = domain[k], span = hi - lo, at = uv[k];
      if (!closed[k] || !prev) continue;
      const before = k ? prev.v : prev.u;
      if (Math.abs(at - lo) < 1e-9 * span && before - lo > span / 2) uv[k] = hi;
      else if (Math.abs(at - hi) < 1e-9 * span && hi - before > span / 2) uv[k] = lo;
    }
    out.push({ p, u: uv[0], v: uv[1] });
  }
  if (out.length < 3) return null;
  // 閉じた向きに半周を超えて跳ぶ区間があれば、継ぎ目をまたいで 1 周している
  const around = out.some((a, i) => {
    const b = out[(i + 1) % out.length];
    return [a.u - b.u, a.v - b.v].some((d, k) => closed[k] && Math.abs(d) > (domain[k][1] - domain[k][0]) / 2);
  });
  return around ? null : out;
}

function bspline(face) {
  const domain = surfaceDomain(face);
  const closed = closedDirections(face);
  const box = new THREE.Box3().setFromPoints(face.points.flat().map(v3));
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const rings = face.loops.map((loop) => surfaceLoop(face, loop, domain, closed, size));
  if (!rings.length || rings.some((r) => !r)) return null;
  // パラメータの平面の縦横の尺度を、曲面の上の長さにそろえる（∂S/∂u・∂S/∂v の長さの平均）。Delaunay 分割の形をよくするため
  const grid = [0.1, 0.3, 0.5, 0.7, 0.9];
  const mean = (k) => grid.reduce((sum, a) => sum + grid.reduce((t, b) => {
    const { du, dv } = surfaceDerivs(face, domain[0][0] + a * (domain[0][1] - domain[0][0]), domain[1][0] + b * (domain[1][1] - domain[1][0]));
    return t + Math.hypot(...(k ? dv : du));
  }, 0), 0) / grid.length ** 2 || 1;
  const scale = [mean(0), mean(1)];
  // 片方の向きだけが直線（次数 1。線織面）なら、円筒の高さと同じく、その向きの範囲全体を境界の点の間隔ほどに縮める。
  // Delaunay 分割が直線の向きに沿う（もう一方のパラメータの差が小さい）辺を選び、細分のいらない分割になる
  const straight = face.degree.map((d) => d === 1);
  if (straight[0] !== straight[1]) {
    const k = straight[0] ? 0 : 1, other = 1 - k, key = ["u", "v"];
    const gaps = rings.flatMap((ring) => ring.map((a, i) => Math.abs(ring[(i + 1) % ring.length][key[other]] - a[key[other]]) * scale[other])).filter((g) => g > 0).sort((a, b) => a - b);
    const range = domain[k][1] - domain[k][0];
    if (gaps.length) scale[k] = Math.min(scale[k], gaps[gaps.length >> 1] / range);
  }
  const uv = (v) => new THREE.Vector2(v.u * scale[0], v.v * scale[1]);
  const area = (ring) => Math.abs(THREE.ShapeUtils.area(ring.map(uv)));
  rings.sort((a, b) => area(b) - area(a)); // 面積が最大のループが外周
  const at = (u, v) => v3(surfaceDerivs(face, u, v).p);
  // 辺がまたぐノット区間の数（曲面の曲がりはノット区間ごとに変わりうるので、垂れは区間ごとに 4 点以上で調べる）
  const knots = face.knots.map((k) => [...new Set(k)]);
  const below = (list, t) => { // t より小さいノットの数
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const crossed = (k, a, b) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return Math.max(0, below(knots[k], hi) - below(knots[k], lo) - (knots[k].includes(lo) ? 1 : 0)) + 1;
  };
  // 辺の幅 = 辺に沿って面の法線が回る角度の和 / ARC_STEP（円筒の |Δθ| / ARC_STEP と同じ尺度）。
  // 波打つ面も、波ごとの曲がりを足すので平らな三角形 1 枚で覆わない
  const normalAt = (u, v) => {
    const { du, dv } = surfaceDerivs(face, u, v);
    return new THREE.Vector3(...du).cross(new THREE.Vector3(...dv)).normalize();
  };
  const turning = (a, b) => {
    if (a.p.distanceTo(b.p) < SAME_POINT) return 0;
    const n = 4 * (crossed(0, a.u, b.u) + crossed(1, a.v, b.v) - 1);
    let sum = 0, prev = normalAt(a.u, a.v);
    for (let i = 1; i <= n; i++) {
      const f = i / n, next = normalAt(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f);
      sum += prev.angleTo(next) || 0;
      prev = next;
    }
    return sum / ARC_STEP;
  };
  const cache = new Map(); // 点 → (点 → 幅)。細分は同じ辺の幅を何度も尋ねる
  const { verts, triangles } = meshChart(rings, [], [], {
    uv,
    width(a, b) {
      if (!cache.has(a)) cache.set(a, new Map());
      if (!cache.get(a).has(b)) {
        const w = turning(a, b);
        cache.get(a).set(b, w);
        if (!cache.has(b)) cache.set(b, new Map());
        cache.get(b).set(a, w);
      }
      return cache.get(a).get(b);
    },
    midpoint(a, b) {
      const u = (a.u + b.u) / 2, v = (a.v + b.v) / 2;
      return { p: at(u, v), u, v };
    },
  }) ?? {};
  if (!triangles) return null;
  // 法線 = ∂S/∂u × ∂S/∂v（面の向きが逆なら裏返す）。特異点（極）では範囲の中央へ少し寄せた点の法線を使う
  const center = domain.map(([lo, hi]) => (lo + hi) / 2);
  const normal = ({ u, v }) => {
    for (const f of [0, 1e-6, 1e-3]) {
      const { du, dv } = surfaceDerivs(face, u + (center[0] - u) * f, v + (center[1] - v) * f);
      const n = new THREE.Vector3(...du).cross(new THREE.Vector3(...dv));
      if (n.lengthSq() > 0) return n.normalize().multiplyScalar(face.flip ? -1 : 1);
    }
    return new THREE.Vector3();
  };
  // 三角形は展開図（u・v とも正の尺度）で反時計回りなので、3D では ∂S/∂u × ∂S/∂v の向きを向く。
  // 向きは法線との比較では決めない（ねじれた線織面の細長い三角形は、垂れが小さくても面の傾きが定まらない）
  const index = triangles.flatMap(([a, b, c]) => (face.flip ? [a, c, b] : [a, b, c]));
  return { points: verts.map((v) => v.p), normals: verts.map(normal), index, oriented: true };
}

export const MESHERS = { plane, cylinder: revolved, cone: revolved, torus: revolved, bspline };
export const isRenderable = (face) => face.type in MESHERS;

/**
 * 三角形の向きを頂点法線に揃えてから BufferGeometry にする（表裏の判定と陰影を正しくするため）。
 * oriented … 分割が向きをそろえて返した（展開図の向きから決まる）ので、揃え直さない
 */
function toGeometry({ points, normals, index, oriented = false }) {
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let k = 0; !oriented && k < index.length; k += 3) {
    const [a, b, c] = [index[k], index[k + 1], index[k + 2]];
    e1.subVectors(points[b], points[a]);
    e2.subVectors(points[c], points[a]);
    if (e1.cross(e2).dot(normals[a]) < 0) [index[k + 1], index[k + 2]] = [c, b];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals.flatMap((p) => p.toArray()), 3));
  geometry.setIndex(index);
  return geometry;
}

/** @returns {THREE.BufferGeometry | null} */
export function faceGeometry(face) {
  const raw = MESHERS[face.type]?.(face);
  return raw && raw.index.length ? toGeometry(raw) : null;
}

/**
 * 部品（ボディの集まり）の面を 1 つの BufferGeometry にまとめる（組立で同じ部品を何か所にも置くときに使い回す）。
 * @returns {{ geometry: THREE.BufferGeometry, volume: number, unsupported: number }}  volume は mm³（面の向きがそろった閉じた形のとき正しい）
 */
export function partGeometry(bodies) {
  const positions = [], normals = [], index = [];
  let unsupported = 0;
  for (const body of bodies) {
    for (const face of body.faces) {
      const g = faceGeometry(face);
      if (!g) {
        unsupported += 1;
        continue;
      }
      const base = positions.length / 3;
      positions.push(...g.getAttribute("position").array);
      normals.push(...g.getAttribute("normal").array);
      for (const i of g.index.array) index.push(base + i);
      g.dispose();
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return { geometry, volume: meshVolume(geometry), unsupported };
}

/** 閉じた三角形メッシュの体積（発散定理: Σ a・(b × c) / 6）。面の向きが外向きなら正 */
export function meshVolume(geometry) {
  const pos = geometry.getAttribute("position").array, idx = geometry.index?.array;
  if (!idx) return 0;
  let v = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

/** 稜線の折れ線群を LineSegments 用の座標列にする。 */
export function edgeSegments(edges) {
  return edges.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
}
