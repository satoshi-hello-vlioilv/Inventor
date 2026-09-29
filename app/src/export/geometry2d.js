// 断面（直線・円弧・円の並び）の幾何量。変換データの期待値（体積・表面積）と、形状の検証に使う。
//
// 面積と回転体積は、ループに沿った線積分（グリーンの定理）で厳密に求める。
//   面積           A = ½∮(x dy − y dx)
//   y 軸まわりの 1 次モーメント  M = ∫∫ x dA = ∮ (x²/2) dy        → 回転体の体積 V = θ·|M|（パップス＝ギュルダン）
//   側面の母線積分  S = ∫ x ds                                     → 回転面の面積 = θ·S

const TAU = 2 * Math.PI;

/** 円弧の開始角・符号付きの回転角（反時計回りが正）・半径。 */
export function arcAngles(s) {
  const [cx, cy] = s.center;
  const a0 = Math.atan2(s.a[1] - cy, s.a[0] - cx);
  const a1 = Math.atan2(s.b[1] - cy, s.b[0] - cx);
  let d = s.ccw ? a1 - a0 : a0 - a1;
  d = ((d % TAU) + TAU) % TAU;
  return { a0, sweep: s.ccw ? d : -d, radius: Math.hypot(s.a[0] - cx, s.a[1] - cy) };
}

/** 1 つのループの符号付き面積・1 次モーメント（ループの向きに従う）と、周長・母線積分（常に正）。 */
export function loopIntegrals(loop) {
  let area = 0, moment = 0, perimeter = 0, lateral = 0;
  for (const s of loop) {
    if (s.type === "line") {
      const [[x0, y0], [x1, y1]] = [s.a, s.b];
      const len = Math.hypot(x1 - x0, y1 - y0);
      area += (x0 * y1 - x1 * y0) / 2;
      moment += ((y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1)) / 6;
      perimeter += len;
      lateral += (len * (x0 + x1)) / 2;
    } else if (s.type === "arc") {
      const { a0, sweep, radius: R } = arcAngles(s);
      const [cx, cy] = s.center;
      const a1 = a0 + sweep;
      const A = (p) => (R * (cx * Math.sin(p) - cy * Math.cos(p) + R * p)) / 2;
      const M = (p) => (R / 2) * (cx * cx * Math.sin(p) + 2 * cx * R * (p / 2 + Math.sin(2 * p) / 4) + R * R * (Math.sin(p) - Math.sin(p) ** 3 / 3));
      area += A(a1) - A(a0);
      moment += M(a1) - M(a0);
      perimeter += R * Math.abs(sweep);
      lateral += Math.sign(sweep) * R * (cx * sweep + R * (Math.sin(a1) - Math.sin(a0)));
    } else if (s.type === "circle") {
      const [cx] = s.center, R = s.radius;
      area += Math.PI * R * R;
      moment += Math.PI * R * R * cx;
      perimeter += TAU * R;
      lateral += TAU * R * cx;
    }
  }
  return { area, moment, perimeter, lateral };
}

/** 点から断面の部分（直線・円弧・円）までの最短距離。 */
export function distanceToSegment(p, s) {
  if (s.type === "circle") return Math.abs(Math.hypot(p[0] - s.center[0], p[1] - s.center[1]) - s.radius);
  if (s.type === "arc") {
    const { a0, sweep, radius } = arcAngles(s);
    const angle = Math.atan2(p[1] - s.center[1], p[0] - s.center[0]);
    const within = (((sweep > 0 ? angle - a0 : a0 - angle) % TAU) + TAU) % TAU <= Math.abs(sweep);
    if (within) return Math.abs(Math.hypot(p[0] - s.center[0], p[1] - s.center[1]) - radius);
    return Math.min(Math.hypot(p[0] - s.a[0], p[1] - s.a[1]), Math.hypot(p[0] - s.b[0], p[1] - s.b[1]));
  }
  const [[x0, y0], [x1, y1]] = [s.a, s.b];
  const [dx, dy] = [x1 - x0, y1 - y0];
  const t = Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (x0 + t * dx), p[1] - (y0 + t * dy));
}

export const distanceToLoop = (p, loop) => Math.min(...loop.map((s) => distanceToSegment(p, s)));
