// 有理 B スプライン（NURBS）の基底関数と、曲面の点・偏微分・最近点。曲線（curves.js）と曲面（STEP の自由曲面）で共用する。
//   曲面 … { kind: "bspline", degree: [p, q], knots: [U, V], points: 行（u の向き）× 列（v の向き）の点, weights: 同じ並びの重み }
//   knots は標準の形（端の多重度を含む全てのノット）。u は行の番号、v は列の番号に対応する

import { cross, dot, length, mul, sub } from "../core/vec.js";

/** t を含むノット区間の番号 k（knots[k] ≤ t < knots[k + 1]。右端は最後の区間）。n … 制御点の数 */
function spanOf(knots, degree, n, t) {
  if (t >= knots[n]) return n - 1;
  if (t <= knots[degree]) return degree;
  let lo = degree, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t < knots[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * B スプラインの基底関数と 1 階微分（Cox–de Boor）。区間 k で 0 でない p + 1 個: N[j] = N_{k−p+j}(t)
 * @returns {{ span: number, N: number[], dN: number[] }}
 */
export function basis(knots, degree, n, t) {
  const k = spanOf(knots, degree, n, t);
  // 次数を 1 つずつ上げて求める。微分は次数 p − 1 の基底（lower）から求める
  const left = [], right = [];
  let N = [1], lower = [1];
  for (let j = 1; j <= degree; j++) {
    left[j] = t - knots[k + 1 - j];
    right[j] = knots[k + j] - t;
    const next = [];
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : N[r] / denom;
      next[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    next[j] = saved;
    if (j === degree) lower = N;
    N = next;
  }
  const dN = N.map((_, j) => {
    if (degree === 0) return 0;
    const i = k - degree + j; // 全体の番号
    const a = j > 0 ? lower[j - 1] / (knots[i + degree] - knots[i] || Infinity) : 0;
    const b = j < degree ? lower[j] / (knots[i + degree + 1] - knots[i + 1] || Infinity) : 0;
    return degree * (a - b);
  });
  return { span: k, N, dN };
}

/** 曲面のパラメータの範囲 [[u0, u1], [v0, v1]] */
export function surfaceDomain(s) {
  const [p, q] = s.degree, [U, V] = s.knots;
  return [[U[p], U[s.points.length]], [V[q], V[s.points[0].length]]];
}

/** 曲面の点と偏微分 { p, du, dv }（有理なら商の微分） */
export function surfaceDerivs(s, u, v) {
  const [p, q] = s.degree, [U, V] = s.knots;
  const bu = basis(U, p, s.points.length, u), bv = basis(V, q, s.points[0].length, v);
  const acc = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // 同次座標 (x·w, y·w, z·w, w) の値・u 微分・v 微分
  for (let i = 0; i <= p; i++) {
    const row = s.points[bu.span - p + i], wrow = s.weights?.[bu.span - p + i];
    for (let j = 0; j <= q; j++) {
      const P = row[bv.span - q + j], w = wrow ? wrow[bv.span - q + j] : 1;
      const f = [bu.N[i] * bv.N[j], bu.dN[i] * bv.N[j], bu.N[i] * bv.dN[j]];
      for (let m = 0; m < 3; m++) {
        acc[m][0] += f[m] * w * P[0];
        acc[m][1] += f[m] * w * P[1];
        acc[m][2] += f[m] * w * P[2];
        acc[m][3] += f[m] * w;
      }
    }
  }
  const [A, Au, Av] = acc, w = A[3];
  const pt = [A[0] / w, A[1] / w, A[2] / w];
  const d = (D) => [0, 1, 2].map((m) => (D[m] - D[3] * pt[m]) / w);
  return { p: pt, du: d(Au), dv: d(Av) };
}

export const surfacePoint = (s, u, v) => surfaceDerivs(s, u, v).p;

/** 面の法線の向き（∂S/∂u × ∂S/∂v、長さ 1）。特異点（極）では 0 ベクトル */
export function surfaceNormal(s, u, v) {
  const { du, dv } = surfaceDerivs(s, u, v);
  const n = cross(du, dv), l = length(n);
  return l > 0 ? mul(n, 1 / l) : [0, 0, 0];
}

const clamp = (x, [a, b]) => Math.min(b, Math.max(a, x));

/**
 * 点 q に最も近い曲面の上の点のパラメータ（Newton 法。guess から始め、範囲の外へは出さない）。
 * @returns {{ u: number, v: number, distance: number }}
 */
export function projectToSurface(s, q, guess, domain = surfaceDomain(s)) {
  let [u, v] = guess;
  let best = { u, v, distance: Infinity };
  for (let it = 0; it < 30; it++) {
    const { p, du, dv } = surfaceDerivs(s, u, v);
    const r = sub(p, q), distance = length(r);
    if (distance < best.distance) best = { u, v, distance };
    // (J^T J) Δ = −J^T r（Gauss–Newton）
    const a = dot(du, du), b = dot(du, dv), c = dot(dv, dv);
    const g = [dot(r, du), dot(r, dv)];
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-300)) break;
    const step = [(-c * g[0] + b * g[1]) / det, (b * g[0] - a * g[1]) / det];
    const [nu, nv] = [clamp(u + step[0], domain[0]), clamp(v + step[1], domain[1])];
    if (Math.abs(nu - u) + Math.abs(nv - v) <= 1e-14 * (1 + Math.abs(u) + Math.abs(v))) break;
    [u, v] = [nu, nv];
  }
  return best;
}

/**
 * 曲面を粗い格子で調べて、点 q に近いパラメータを初期値にしてから projectToSurface する（初期値が無いとき用）。
 * 格子はノット区間ごとに 4 等分（曲がりはノットの細かさに表れている）。
 */
export function locateOnSurface(s, q, domain = surfaceDomain(s)) {
  const samples = (knots, [lo, hi]) => {
    const unique = [...new Set(knots)].filter((k) => k >= lo && k <= hi);
    return unique.slice(1).flatMap((k, i) => [0, 1, 2, 3].map((m) => unique[i] + ((k - unique[i]) * m) / 4)).concat(hi);
  };
  const us = samples(s.knots[0], domain[0]), vs = samples(s.knots[1], domain[1]);
  let guess = [us[0], vs[0]], best = Infinity;
  for (const u of us) {
    for (const v of vs) {
      const d = length(sub(surfacePoint(s, u, v), q));
      if (d < best) [guess, best] = [[u, v], d];
    }
  }
  return projectToSurface(s, q, guess, domain);
}

