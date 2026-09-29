// 曲線（形式によらない中立な形）の点の計算と、表示・寸法用の折れ線へのサンプリング。.ipt（SAB）と STEP で共用する。
//   line    … { kind: "line", origin, direction }                 点 = origin + t・direction
//   ellipse … { kind: "ellipse", origin, direction, major, ratio } 点 = origin + cos t・major + sin t・ratio・(direction × major)
//   spline  … { kind: "spline", degree, knots, points, weights, period, reversed }（有理 B スプライン。knots は標準の形）

import { divide, extent } from "../core/numbers.js";
import { add, cross, mul, unit } from "../core/vec.js";

const ARC_STEP = Math.PI / 32; // 円弧のサンプリング刻み（外接箱・表示用の折れ線）
const SPLINE_STEPS = 4; // B スプラインの 1 区間（ノット間）の分割数

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
    return breaks.slice(1).flatMap((b, i) => divide(breaks[i], b, SPLINE_STEPS).slice(i ? 1 : 0)).map((t) => curvePoint(c, t));
  }
  return [];
}
