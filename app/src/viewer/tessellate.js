// シーン JSON の面を three.js の BufferGeometry に三角形分割する。
// 面の種類ごとに mesher を用意し、未対応の種類は null を返す（ビューアは稜線だけを描く）。
//
// どの面も境界ループ（隣の面と共有する稜線の点列）に沿って分割する。境界上に新しい点を足さないので、
// 面どうしは隙間なくつながる。円筒・円錐は展開図（角度 θ × 高さ h）の上で分割し、内側だけを細かくしてから曲面に戻す。

import * as THREE from "three";

const ARC_STEP = Math.PI / 32; // 曲面の分割の細かさ（稜線の円弧のサンプリングと同じ刻み）
const TAU = 2 * Math.PI;
const APEX_EPS = 1e-6; // 円錐の頂点とみなす軸からの距離（mm）
const KEY = 2 ** 21; // 辺の番号 = 始点 × KEY + 終点（頂点の数は KEY 未満）
const edgeKey = (i, j) => i * KEY + j;
const undirected = (i, j) => (i < j ? edgeKey(i, j) : edgeKey(j, i));
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const wrapAngle = (a) => a - TAU * Math.round(a / TAU); // (-π, π] 付近に戻す

/** 末尾が先頭と同じ点なら取り除き、開いた点列にする。 */
function openLoop(loop) {
  const points = loop.map(v3);
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < 1e-9) points.pop();
  return points;
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
  const triangles = THREE.ShapeUtils.triangulateShape(flat[outer], order.slice(1).map((i) => flat[i]));
  const points = order.flatMap((i) => loops[i]);
  return { points, normals: points.map(() => n), index: triangles.flat() };
}

// ---- 回転面（円筒・円錐）-------------------------------------------------------
/** 展開図の座標 (θ, h) と 3 次元の点・法線の対応。ρ(h) = radius + slope・h */
function revolvedFrame(face) {
  const origin = v3(face.origin), axis = v3(face.axis).normalize(), ref = v3(face.ref).normalize();
  const side = new THREE.Vector3().crossVectors(axis, ref);
  const slope = face.slope ?? 0;
  const direction = (t) => ref.clone().multiplyScalar(Math.cos(t)).addScaledVector(side, Math.sin(t));
  return {
    apex: slope ? -face.radius / slope : null, // 半径が 0 になる高さ
    toUV(p) {
      const d = p.clone().sub(origin);
      const x = d.dot(ref), y = d.dot(side);
      return { t: Math.atan2(y, x), h: d.dot(axis), rho: Math.hypot(x, y) };
    },
    point: (t, h) => origin.clone().addScaledVector(axis, h).addScaledVector(direction(t), face.radius + slope * h),
    // 曲面の法線は (半径方向 − slope・軸) の向き。凹面なら反転する
    normal: (t, h) => direction(t).addScaledVector(axis, -slope).normalize().multiplyScalar(face.outward ? 1 : -1),
  };
}

/**
 * ループを展開図の点列にする。θ は連続になるよう巻き戻さずにたどる。
 * winding … 軸のまわりを何周するか（0: 面の中で閉じたループ、±1: 軸を 1 周するループ）
 * 円錐の頂点は θ が定まらないので、前後の点の θ を持つ 2 点（どちらも頂点の位置）に置き換える。
 */
function unwrapLoop(loop, frame) {
  const raw = openLoop(loop).map((p) => ({ p, ...frame.toUV(p) }));
  const valid = raw.filter((v) => v.rho >= APEX_EPS);
  if (valid.length < 2) return null;
  let t = valid[0].t;
  for (const v of valid) v.t = t += wrapAngle(v.t - t);
  const winding = Math.round((t + wrapAngle(valid[0].t - t) - valid[0].t) / TAU);
  const verts = [];
  raw.forEach((v, i) => {
    if (v.rho >= APEX_EPS) return verts.push(v);
    const before = [...raw.slice(0, i)].reverse().find((w) => w.rho >= APEX_EPS) ?? valid.at(-1);
    const after = raw.slice(i + 1).find((w) => w.rho >= APEX_EPS) ?? valid[0];
    verts.push({ ...v, t: before.t }, { ...v, t: after.t });
  });
  return { verts, winding };
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
 * 軸を 1 周するループが 2 本（筒状の面）なら継ぎ目で切り開いて 1 本の多角形にし、
 * 1 本（円錐の先端を含む面）なら頂点の高さの直線で閉じる。
 * @returns {{ outer: object[], holes: object[][], cuts: number[] } | null}  cuts … 外周のうち稜線ではない辺（i → i + 1）
 */
function layout(loops, frame) {
  const around = loops.filter((l) => l.winding !== 0);
  const inside = loops.filter((l) => l.winding === 0);
  if (!around.length) {
    // 面の中で閉じたループだけ（部分円筒など）。展開図の面積が最大のものが外周
    const area = (l) => Math.abs(THREE.ShapeUtils.area(l.verts.map((v) => new THREE.Vector2(v.t, v.h))));
    const outer = inside.reduce((a, b) => (area(b) > area(a) ? b : a));
    const center = meanT(outer.verts);
    const holes = inside.filter((l) => l !== outer).map((l) => shifted(l.verts, TAU * Math.round((center - meanT(l.verts)) / TAU)));
    return { outer: outer.verts, holes, cuts: [] };
  }
  if (around.length > 2 || (around.length === 1 && frame.apex === null)) return null;
  const seam = seamAngle(around, inside, around[0].verts[0].t);
  const first = openAround(around[0], nearest(around[0].verts, seam));
  const start = shifted(first, TAU * Math.round((seam - first[0].t) / TAU)); // 継ぎ目の近くから 1 周（θ0 → θ0 + 2π）
  const t0 = start[0].t;
  let back;
  if (around.length === 2) {
    const second = openAround(around[1], nearest(around[1].verts, t0));
    back = shifted(second, TAU * Math.round((t0 - second[0].t) / TAU)).reverse(); // θ0 + 2π → θ0 の向きに戻る
  } else {
    const tip = frame.point(0, frame.apex);
    back = [{ p: tip, t: t0 + TAU, h: frame.apex }, { p: tip, t: t0, h: frame.apex }];
  }
  const holes = inside.map((l) => shifted(l.verts, TAU * Math.ceil((t0 - meanT(l.verts)) / TAU))); // θ0 〜 θ0 + 2π の中へ
  // 継ぎ目（外周の 1 周目の末尾 → 戻りの先頭、戻りの末尾 → 先頭）と頂点の直線は稜線ではない。分割してよい
  return { outer: [...start, ...back], holes, cuts: [start.length - 1, start.length + back.length - 1, ...(around.length === 1 ? [start.length] : [])] };
}

/**
 * earcut の結果（面積は正しいが、細長い三角形や面積 0 の三角形を含む）を、境界の辺を保ったまま
 * 辺の入れ替え（Lawson の方法）で制約付き Delaunay 三角形分割にする。
 * 円は展開図で一直線に並ぶので、そのままだと一直線上の点どうしを結ぶ三角形ができ、細分の結果が乱れる。
 * @param {THREE.Vector2[]} uv  展開図の座標（縦横の尺度をそろえたもの）
 */
function delaunay(uv, triangles, fixedEdge) {
  const orient = (a, b, c) => (uv[b].x - uv[a].x) * (uv[c].y - uv[a].y) - (uv[b].y - uv[a].y) * (uv[c].x - uv[a].x);
  const size2 = (a, b) => uv[a].distanceToSquared(uv[b]);
  const flat = (a, b, c) => Math.abs(orient(a, b, c)) <= 1e-12 * Math.max(size2(a, b), size2(b, c), size2(c, a));
  /** d が反時計回りの三角形 abc の外接円の内側にあれば正 */
  const inCircle = (a, b, c, d) => {
    const [ax, ay, bx, by, cx, cy] = [a, b, c].flatMap((v) => [uv[v].x - uv[d].x, uv[v].y - uv[d].y]);
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
    const scale = Math.max(size2(a, d), size2(b, d), size2(c, d));
    return det > 1e-9 * scale * scale;
  };
  const tris = triangles.map(([a, b, c]) => (orient(a, b, c) < 0 ? [a, c, b] : [a, b, c]));
  const owner = new Map(); // 向きのある辺 → その辺を持つ三角形
  const own = (t) => {
    const [a, b, c] = tris[t];
    owner.set(edgeKey(a, b), t).set(edgeKey(b, c), t).set(edgeKey(c, a), t);
  };
  tris.forEach((_, t) => own(t));
  const stack = [...owner.keys()];
  for (let guard = 4 * tris.length * tris.length + 1000; stack.length && guard > 0; guard--) { // 収束までの入れ替えは最悪で三角形数の 2 乗
    const key = stack.pop();
    const t1 = owner.get(key);
    const i = Math.floor(key / KEY), j = key % KEY;
    const t2 = owner.get(edgeKey(j, i));
    if (t1 === undefined || t2 === undefined || fixedEdge(i, j)) continue;
    const k = tris[t1].find((v) => v !== i && v !== j), l = tris[t2].find((v) => v !== i && v !== j);
    // 四角形 i, l, j, k の対角線を i–j から k–l に替える。替えた後の 2 つの三角形が裏返らないことが条件
    if (orient(i, l, k) <= 0 || orient(l, j, k) <= 0 || flat(i, l, k) || flat(l, j, k)) continue;
    if (!(flat(i, j, k) || flat(j, i, l) || inCircle(i, j, k, l))) continue;
    owner.delete(key);
    owner.delete(edgeKey(j, i));
    tris[t1] = [i, l, k];
    tris[t2] = [l, j, k];
    own(t1);
    own(t2);
    stack.push(edgeKey(i, l), edgeKey(l, j), edgeKey(j, k), edgeKey(k, i));
  }
  return tris;
}

/**
 * 三角形の辺を、θ の幅が ARC_STEP 以下になるまで二等分する。境界の辺（稜線）は分けない（隣の面と点をそろえるため）。
 * 同じ辺の中点は 1 つにまとめるので、隣り合う三角形の間に隙間はできない。
 */
function refine(verts, triangles, fixedEdge, frame) {
  const midpoints = new Map();
  const midpoint = (i, j) => {
    const key = undirected(i, j);
    if (!midpoints.has(key)) {
      const t = (verts[i].t + verts[j].t) / 2, h = (verts[i].h + verts[j].h) / 2;
      midpoints.set(key, verts.push({ p: frame.point(t, h), t, h }) - 1);
    }
    return midpoints.get(key);
  };
  const out = [], stack = [...triangles];
  while (stack.length) {
    const tri = stack.pop();
    let split = -1, widest = ARC_STEP;
    for (let e = 0; e < 3; e++) {
      const [i, j] = [tri[e], tri[(e + 1) % 3]];
      const width = Math.abs(verts[i].t - verts[j].t);
      if (width > widest && !fixedEdge(i, j)) [split, widest] = [e, width];
    }
    if (split < 0) {
      out.push(tri);
      continue;
    }
    const [i, j, k] = [tri[split], tri[(split + 1) % 3], tri[(split + 2) % 3]];
    const m = midpoint(i, j);
    stack.push([i, m, k], [m, j, k]);
  }
  return out;
}

function revolved(face) {
  const frame = revolvedFrame(face);
  const loops = face.loops.map((l) => unwrapLoop(l, frame)).filter(Boolean);
  if (!loops.length) return null;
  const plan = layout(loops, frame);
  if (!plan) return null;
  const rings = [plan.outer, ...plan.holes];
  const verts = rings.flat();
  // 境界の辺 = 各ループで隣り合う点（外周の継ぎ目・頂点の直線を除く）
  const fixed = new Set();
  let base = 0;
  rings.forEach((ring, r) => {
    ring.forEach((_, i) => {
      if (r === 0 && plan.cuts.includes(i)) return;
      fixed.add(undirected(base + i, base + ((i + 1) % ring.length)));
    });
    base += ring.length;
  });
  // 展開図の尺度。円筒・円錐は母線（h の向き）に沿って真っすぐなので、誤差は θ の幅だけで決まる。
  // h を縮めて（面の高さ全体を 1 刻み分の弧長にして）から Delaunay 分割すると、θ の幅の小さい辺が選ばれ、
  // 上下の境界をジグザグに結ぶ細分のいらない分割になる（拡大縮小では三角形の表裏は変わらない）
  const radius = verts.reduce((s, v) => s + frame.toUV(v.p).rho, 0) / verts.length || 1;
  const hs = verts.map((v) => v.h);
  const squash = Math.min(1, (ARC_STEP * radius) / Math.max(Math.max(...hs) - Math.min(...hs), 1e-9));
  const flat = (ring) => ring.map((v) => new THREE.Vector2(v.t * radius, v.h * squash));
  const uv = rings.flatMap(flat); // 番号は verts と同じ（triangulateShape の返す番号もこの並び）
  const isFixed = (i, j) => fixed.has(undirected(i, j));
  const triangles = delaunay(uv, THREE.ShapeUtils.triangulateShape(flat(rings[0]), rings.slice(1).map(flat)), isFixed);
  const all = refine(verts, triangles, isFixed, frame);
  return { points: verts.map((v) => v.p), normals: verts.map((v) => frame.normal(v.t, v.h)), index: all.flat() };
}

export const MESHERS = { plane, cylinder: revolved, cone: revolved };
export const isRenderable = (face) => face.type in MESHERS;

/** 三角形の向きを頂点法線に揃えてから BufferGeometry にする（表裏の判定と陰影を正しくするため）。 */
function toGeometry({ points, normals, index }) {
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let k = 0; k < index.length; k += 3) {
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

/** 稜線の折れ線群を LineSegments 用の座標列にする。 */
export function edgeSegments(edges) {
  return edges.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
}
