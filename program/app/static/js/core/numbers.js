// 数値の小道具（形式によらない）。

/** 小数第 d 位に丸める（-0 は 0 に揃える）。配列は要素ごと。 */
export const round = (v, d = 6) => (Array.isArray(v) ? v.map((x) => round(x, d)) : Number(v.toFixed(d)) + 0);

/** 最小値と最大値（大きな配列でも引数展開の上限に当たらないようループで求める）。 */
export function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** 等分点 a → b（両端を含む n + 1 点）。 */
export const divide = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

/** 連立一次方程式 A X = B を解く（部分ピボットのガウスの消去法。B は右辺の列が複数: 点の x・y・z など）。解けなければ null */
export function solveLinear(A, B) {
  const n = A.length, m = B[0].length;
  const a = A.map((r) => Float64Array.from(r)), b = B.map((r) => Float64Array.from(r));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > 1e-300)) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      for (let k = 0; k < m; k++) b[r][k] -= f * b[c][k];
    }
  }
  const x = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < m; k++) {
      let s = b[r][k];
      for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c][k];
      x[r][k] = s / a[r][r];
    }
  }
  return x;
}
