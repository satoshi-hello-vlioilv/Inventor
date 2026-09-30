// 三角形メッシュの下準備: ワールド座標（mm）への変換、重なった頂点の統合、座標の精度に見合う許容差。
// 殻（つながり・閉じた立体か・向き）は shells.js。

import { cross, dot, length, sub } from "../../core/vec.js";

/** 4×4 行列（three.js の列優先 elements）で点列を変換し、scale 倍する（シーンの単位 → mm）。 */
export function transformPoints(positions, m, scale = 1) {
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
    out[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
    out[i + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
    out[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
  }
  return out;
}

const FLOAT32_EPSILON = 2 ** -23;

/**
 * 長さの許容差（mm）。three.js の頂点は float32 なので、座標が大きいほど丸めの誤差が大きい。
 * 最小 base（設計上の寸法差より十分小さい値）と、座標の大きさに見合う float32 の丸め幅の 8 倍の大きい方。
 */
export function tolerance(positions, m, scale, base) {
  let max = 0;
  for (let i = 0; i < positions.length; i++) max = Math.max(max, Math.abs(positions[i]));
  const stretch = Math.max(...[0, 4, 8].map((k) => Math.hypot(m[k], m[k + 1], m[k + 2])));
  return Math.max(base, 8 * FLOAT32_EPSILON * max * stretch * scale);
}

export const pointAt = (points, i) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];

/**
 * 距離 tol 以内の頂点を 1 つにまとめる（格子ハッシュで近傍 27 セルを探す）。
 * 頂点ごとの許容差 tols（元のメッシュごとの float32 の精度）を渡すと、2 点は大きい方の許容差でまとめる（tol はその最大）。
 * 座標の大きな遠くの板（床など）の粗い許容差で、細かい形の近い頂点をまとめてしまわないように。
 * @returns {{ points: Float64Array, map: Int32Array, tols: Float64Array|null }}  tols はまとめた頂点ごとの許容差
 */
export function weld(points, tol, tols = null) {
  const n = points.length / 3;
  const cells = new Map();
  const unique = [], uniqueTol = [];
  const map = new Int32Array(n);
  const cell = (v) => Math.floor(v / tol);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = pointAt(points, i);
    const [cx, cy, cz] = [cell(x), cell(y), cell(z)];
    const own = tols ? tols[i] : tol;
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const k = 3 * j, limit = Math.max(own, uniqueTol[j]);
            if (Math.abs(unique[k] - x) <= limit && Math.abs(unique[k + 1] - y) <= limit && Math.abs(unique[k + 2] - z) <= limit) {
              found = j;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = unique.length / 3;
      unique.push(x, y, z);
      uniqueTol.push(own);
      const key = `${cx},${cy},${cz}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(found);
    } else {
      uniqueTol[found] = Math.max(uniqueTol[found], own);
    }
    map[i] = found;
  }
  return { points: Float64Array.from(unique), map, tols: tols ? Float64Array.from(uniqueTol) : null };
}

/** 三角形の頂点番号列（index が無ければ 3 頂点ずつ順に並んだものとみなす）。 */
export function triangleIndices(index, vertexCount) {
  return index ?? Uint32Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
}

function triangleArea(points, a, b, c) {
  return length(cross(sub(pointAt(points, b), pointAt(points, a)), sub(pointAt(points, c), pointAt(points, a)))) / 2;
}

/**
 * 頂点を統合し、面積の無い三角形を除く。
 * @returns {{ points: Float64Array, tris: Int32Array, source: Int32Array }}  source は元のメッシュでの三角形の番号（表示の色分けに使う）
 */
export function weldTriangles(worldPoints, index, tol) {
  const { points, map } = weld(worldPoints, tol);
  const raw = triangleIndices(index, worldPoints.length / 3);
  const tris = [], source = [];
  for (let k = 0; k + 2 < raw.length; k += 3) {
    const [a, b, c] = [map[raw[k]], map[raw[k + 1]], map[raw[k + 2]]];
    if (a === b || b === c || a === c || triangleArea(points, a, b, c) <= tol * tol) continue;
    tris.push(a, b, c);
    source.push(k / 3);
  }
  return { points, tris: Int32Array.from(tris), source: Int32Array.from(source) };
}

/** 1 次元の値を、隣との差が tol を超えるところで区切ってまとめる。 */
export function cluster(values, tol) {
  const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
  const ids = new Int32Array(values.length);
  const centers = [];
  let id = -1, last = -Infinity, sum = 0, count = 0;
  for (const i of order) {
    if (values[i] - last > tol) {
      if (count) centers.push(sum / count);
      id += 1;
      sum = 0;
      count = 0;
    }
    ids[i] = id;
    sum += values[i];
    count += 1;
    last = values[i];
  }
  if (count) centers.push(sum / count);
  return { ids, centers };
}

/** dir に垂直な正規直交基底 [u, v]。 */
export function basis(dir) {
  const helper = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(helper, dir);
  const lu = length(u);
  const un = [u[0] / lu, u[1] / lu, u[2] / lu];
  return [un, cross(dir, un)];
}

/** 点を軸まわりの円柱座標 (h: 軸方向, r: 軸からの距離, t: 角度) に変換する。 */
export function cylindrical(points, origin, dir, [u, v]) {
  const n = points.length / 3;
  const h = new Float64Array(n), r = new Float64Array(n), t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = sub(pointAt(points, i), origin);
    const hh = dot(d, dir);
    const radial = [d[0] - dir[0] * hh, d[1] - dir[1] * hh, d[2] - dir[2] * hh];
    h[i] = hh;
    r[i] = length(radial);
    t[i] = Math.atan2(dot(radial, v), dot(radial, u));
  }
  return { h, r, t };
}
