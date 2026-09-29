// 折れ線を直線と円弧に分解する。three.js の円は細かい折れ線で描かれているので、
// 「曲がり角が小さく同じ向きに続く区間」を円弧の候補にし、円に当てはまるか確かめる。

const ARC_TURN_MAX = (15 * Math.PI) / 180; // 1 頂点あたりの曲がりがこれ以下なら円弧の候補（円を 24 分割以上で描いたもの）
const CHORD_RATIO_MAX = 1.5; // 円弧は等間隔に分割されている。前後の弦の長さがこれ以上違えば円弧の切れ目
const MIN_ARC_SEGMENTS = 3;

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const turnAt = (p, q, r) => {
  const [a, b] = [sub2(q, p), sub2(r, q)];
  return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
};

/** 3 点を通る円（一直線上なら null）。 */
function circleThrough(p, q, r) {
  const d = 2 * (p[0] * (q[1] - r[1]) + q[0] * (r[1] - p[1]) + r[0] * (p[1] - q[1]));
  if (Math.abs(d) < 1e-12) return null;
  const s = (a) => a[0] * a[0] + a[1] * a[1];
  const cx = (s(p) * (q[1] - r[1]) + s(q) * (r[1] - p[1]) + s(r) * (p[1] - q[1])) / d;
  const cy = (s(p) * (r[0] - q[0]) + s(q) * (p[0] - r[0]) + s(r) * (q[0] - p[0])) / d;
  return { center: [cx, cy], radius: Math.hypot(p[0] - cx, p[1] - cy) };
}

const fitsCircle = (pts, c, tol) => pts.every((p) => Math.abs(Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) - c.radius) <= tol);

/** 連続する重複点と、一直線上の中間点を取り除く。 */
function simplify(points, closed, tol) {
  let pts = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > tol);
  if (closed && pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) <= tol) pts = pts.slice(0, -1);
  return pts;
}

/**
 * @param {number[][]} points  2 次元の点列
 * @param {boolean} closed     閉じたループか
 * @returns {Array<{type: "line"|"arc"|"circle", ...}>}
 */
export function fitSegments(points, closed, tol) {
  let pts = simplify(points, closed, tol);
  const n = pts.length;
  if (n < 2) return [];
  const turn = (i) => (closed || (i > 0 && i < n - 1) ? turnAt(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]) : NaN);
  const smooth = (i) => {
    const a = turn(i);
    return Number.isFinite(a) && Math.abs(a) > 1e-6 && Math.abs(a) <= ARC_TURN_MAX;
  };
  const chord = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

  // 全周が滑らかに曲がる閉ループは円
  if (closed && n >= 2 * MIN_ARC_SEGMENTS && pts.every((_, i) => smooth(i) && Math.sign(turn(i)) === Math.sign(turn(0)))) {
    const c = circleThrough(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)]);
    if (c && fitsCircle(pts, c, tol)) return [{ type: "circle", center: c.center, radius: c.radius }];
  }
  // 閉ループは角（滑らかでない頂点）から始める
  if (closed) {
    const corner = pts.findIndex((_, i) => !smooth(i));
    if (corner > 0) pts = [...pts.slice(corner), ...pts.slice(0, corner)];
  }
  const m = pts.length;
  const seq = closed ? [...pts, pts[0]] : pts;
  const segments = [];
  let i = 0;
  while (i < seq.length - 1) {
    // 円弧: i の次から同じ向きの小さな曲がりが続く区間
    let j = i + 1;
    const sign = Math.sign(turn(j % m));
    const step = chord(seq[i], seq[i + 1]);
    const even = (k) => {
      const c = chord(seq[k], seq[k + 1]);
      return c <= step * CHORD_RATIO_MAX && c >= step / CHORD_RATIO_MAX;
    };
    while (j < seq.length - 1 && smooth(j % m) && Math.sign(turn(j % m)) === sign && even(j)) j += 1;
    if (j - i >= MIN_ARC_SEGMENTS) {
      const run = seq.slice(i, j + 1);
      const c = circleThrough(run[0], run[Math.floor(run.length / 2)], run.at(-1));
      if (c && fitsCircle(run, c, tol)) {
        segments.push({ type: "arc", a: run[0], b: run.at(-1), center: c.center, radius: c.radius, ccw: sign > 0 });
        i = j;
        continue;
      }
    }
    // 直線: 一直線上に続く限り延ばす
    let k = i + 1;
    const a = seq[i];
    while (k < seq.length - 1) {
      const b = seq[k + 1], d = sub2(b, a), len = Math.hypot(d[0], d[1]);
      const off = seq.slice(i + 1, k + 1).some((p) => Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / len > tol);
      if (off) break;
      k += 1;
    }
    segments.push({ type: "line", a, b: seq[k] });
    i = k;
  }
  return segments;
}

/** 部分の一覧を「直線 6・円弧 2」のように数える。 */
export function describeSegments(segments) {
  const names = { line: "直線", arc: "円弧", circle: "円" };
  const counts = {};
  for (const s of segments) counts[s.type] = (counts[s.type] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${names[k]} ${v}`).join("・");
}
