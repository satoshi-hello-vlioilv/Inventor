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
