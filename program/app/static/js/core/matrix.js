// 4×4 の同次変換行列（行優先の 16 要素の配列）。組立の配置・図面のブロック参照に使う。

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** a × b */
export function multiply(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

/** 剛体変換（回転 + 移動）の逆 */
export function invert(m) {
  const rt = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // 回転の転置
  const t = [m[3], m[7], m[11]];
  const it = [0, 1, 2].map((r) => -(rt[r * 3] * t[0] + rt[r * 3 + 1] * t[1] + rt[r * 3 + 2] * t[2]));
  return [rt[0], rt[1], rt[2], it[0], rt[3], rt[4], rt[5], it[1], rt[6], rt[7], rt[8], it[2], 0, 0, 0, 1];
}

/** 座標系（原点と 3 軸）→ その座標系から親への変換。移動は scale 倍（mm にする） */
export function placementMatrix({ origin, x, y, z }, scale = 1) {
  return [x[0], y[0], z[0], origin[0] * scale, x[1], y[1], z[1], origin[1] * scale, x[2], y[2], z[2], origin[2] * scale, 0, 0, 0, 1];
}

/** 点 p を変換する */
export const apply = (m, p) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);

/** 移動・Z 軸回りの回転（ラジアン）・拡大の行列（2D の図面のブロック参照など） */
export const translation = ([x, y, z = 0]) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
export function rotationZ(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
export const scaling = ([x, y, z = 1]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
