// 曲線（形式によらない中立な形）の点の計算と、表示・寸法用の折れ線へのサンプリング。.ipt（SAB）と STEP で共用する。
//   line    … { kind: "line", origin, direction }                 点 = origin + t・direction
//   ellipse … { kind: "ellipse", origin, direction, major, ratio } 点 = origin + cos t・major + sin t・ratio・(direction × major)
//   spline  … { kind: "spline", degree, knots, points, weights, period, reversed }（有理 B スプライン。knots は標準の形）

import { divide, extent } from "../core/numbers.js";
import { add, cross, mul, sub, unit } from "../core/vec.js";
import { basis } from "./nurbs.js";

const ARC_STEP = Math.PI / 32; // 円弧のサンプリング刻み（外接箱・表示用の折れ線）
const SPLINE_STEPS = 4; // B スプラインの 1 区間（ノット間）の最初の分割数
const SPLINE_DEPTH = 6; // 曲がりが刻みを超える区間を二等分する回数の上限（1 区間あたり最大 4 × 2⁶ 点）

/** B スプライン上の点（基底関数は曲面と共用。有理なら同次座標で計算する）。周期的なら t を 1 周期の範囲に戻す。 */
function splinePoint(c, t) {
  const { degree: p, knots: u, points, weights } = c;
  if (c.period) {
    let r = (t - u[0]) % c.period;
    if (r < 0) r += c.period;
    t = u[0] + r;
  }
  const { span, N } = basis(u, p, points.length, t);
  const sum = [0, 0, 0, 0];
  N.forEach((n, j) => {
    const [x, y, z] = points[span - p + j], w = n * weights[span - p + j];
    sum[0] += x * w;
    sum[1] += y * w;
    sum[2] += z * w;
    sum[3] += w;
  });
  return [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
}

export function curvePoint(c, t) {
  if (c.kind === "line") return add(c.origin, mul(c.direction, t));
  if (c.kind === "spline") return splinePoint(c, c.reversed ? -t : t);
  const minor = mul(cross(unit(c.direction), c.major), c.ratio);
  return add(c.origin, add(mul(c.major, Math.cos(t)), mul(minor, Math.sin(t))));
}

export function sampleCurve(c, t0, t1) {
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
    const ts = breaks.slice(1).flatMap((b, i) => divide(breaks[i], b, SPLINE_STEPS).slice(i ? 1 : 0));
    // 急に曲がる所（ねじ山・ローレットの角を丸めた部分など）は、円弧と同じく曲がりが ARC_STEP 以下になるまで二等分する
    const out = [[ts[0], curvePoint(c, ts[0])]];
    ts.slice(1).forEach((t, i) => out.push(...refineSpan(c, out.at(-1), [t, curvePoint(c, t)], SPLINE_DEPTH)));
    return out.map(([, p]) => p);
  }
  return [];
}

const angleBetween = (a, b) => {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  return la && lb ? Math.acos(Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)))) : 0;
};

/** 区間 a → b（[t, 点]）を、前半と後半の弦の向きの差（曲がりの半分）が ARC_STEP / 2 以下になるまで二等分した点列（a を除く） */
function refineSpan(c, a, b, depth) {
  const tm = (a[0] + b[0]) / 2, m = [tm, curvePoint(c, tm)];
  const bend = angleBetween(sub(m[1], a[1]), sub(b[1], m[1]));
  if (depth <= 0 || bend <= ARC_STEP / 2) return [b];
  return [...refineSpan(c, a, m, depth - 1), ...refineSpan(c, m, b, depth - 1)];
}
