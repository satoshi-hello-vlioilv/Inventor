// 3 次元ベクトル（配列 [x, y, z]）の最小限の演算。対応する Python 実装: ipt_inspect/vec.py

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.sqrt(dot(a, a));
export const unit = (a) => {
  const n = length(a);
  return n ? mul(a, 1 / n) : a;
};
/** a から単位ベクトル axis 方向の成分を除いたもの（軸に垂直な成分）。 */
export const reject = (a, axis) => sub(a, mul(axis, dot(a, axis)));
