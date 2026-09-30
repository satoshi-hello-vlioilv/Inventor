// 閉じた三角形の自己交差（元の形が自分と交わる所）を見つける。three.js の丸い面取り（bevel）がへこんだ角で面を交差させる、
// 重なった帯を 1 つのメッシュで描いている、など。そのような形は CAD の立体として正しくない（STEP を読んだ CAD で修復が要る）ので、
// 近似の部品について調べて知らせる。頂点を共有する三角形どうし（隣どうし）は調べない。

import { pointAt } from "./mesh.js";

/** 元の形が自分と交わる近似の部品の注意（部品の説明と、変換データの notes に書く） */
export const selfIntersectionNote = (n) =>
  `元の形が自分と交わる所がある（三角形の交わり ${n >= 100 ? "100 以上" : n}。急に曲がる管・丸い面取りなど）。CAD で修復が要ることがある`;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 線分 p–q が三角形 (a, b, c) の内側を横切るか（端や辺にかすめるだけは数えない） */
function segmentHitsTriangle(p, q, a, b, c, eps) {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(...n);
  if (len < eps) return false;
  const dp = dot(n, sub(p, a)) / len, dq = dot(n, sub(q, a)) / len;
  if ((dp > eps && dq > eps) || (dp < -eps && dq < -eps) || Math.abs(dp - dq) < eps) return false;
  const t = dp / (dp - dq);
  if (t <= 1e-9 || t >= 1 - 1e-9) return false;
  const x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  // 三角形の内側（辺から eps 以上内側）
  for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    if (dot(cross(sub(v, u), sub(x, u)), n) / len / Math.hypot(...sub(v, u)) <= eps) return false;
  }
  return true;
}

/**
 * 自己交差している三角形の組の数（多い場合は limit で打ち切る）。
 * @param {Float64Array} points  頂点
 * @param {ArrayLike<number>} tris  三角形
 * @param {number} tol  長さの許容差（これより浅い交わりは数えない）
 */
export function selfIntersections(points, tris, tol, limit = 100) {
  const m = tris.length / 3;
  const corner = (t, k) => pointAt(points, tris[3 * t + k]);
  const boxes = [];
  let size = 0;
  for (let t = 0; t < m; t++) {
    const p = [corner(t, 0), corner(t, 1), corner(t, 2)];
    const lo = [0, 1, 2].map((k) => Math.min(p[0][k], p[1][k], p[2][k]) - tol);
    const hi = [0, 1, 2].map((k) => Math.max(p[0][k], p[1][k], p[2][k]) + tol);
    boxes.push({ lo, hi, p });
    size += Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  }
  const cell = Math.max((2 * size) / Math.max(m, 1), tol);
  const grid = new Map();
  boxes.forEach((b, t) => {
    const [l, h] = [b.lo.map((v) => Math.floor(v / cell)), b.hi.map((v) => Math.floor(v / cell))];
    for (let x = l[0]; x <= h[0]; x++) for (let y = l[1]; y <= h[1]; y++) for (let z = l[2]; z <= h[2]; z++) {
      const key = `${x},${y},${z}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(t);
    }
  });
  let count = 0;
  for (const [key, list] of grid) {
    const here = key.split(",").map(Number);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i], t = list[j];
        const A = boxes[s], B = boxes[t];
        if ([0, 1, 2].some((k) => A.lo[k] > B.hi[k] || B.lo[k] > A.hi[k])) continue;
        // 同じ組を 2 度調べない: 2 つの箱の重なりの最小の角がある升目でだけ調べる
        if ([0, 1, 2].some((k) => Math.floor(Math.max(A.lo[k], B.lo[k]) / cell) !== here[k])) continue;
        const shared = [0, 1, 2].some((a) => [0, 1, 2].some((b) => tris[3 * s + a] === tris[3 * t + b]));
        if (shared) continue;
        const hit = [[0, 1], [1, 2], [2, 0]].some(([u, v]) => segmentHitsTriangle(A.p[u], A.p[v], ...B.p, tol)) ||
          [[0, 1], [1, 2], [2, 0]].some(([u, v]) => segmentHitsTriangle(B.p[u], B.p[v], ...A.p, tol));
        if (hit && ++count >= limit) return count;
      }
    }
  }
  return count;
}
