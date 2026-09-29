// 三角形メッシュの下準備: ワールド座標への変換、重なった頂点の統合、閉じた立体かの判定、連結成分への分割。

import { cross, dot, length, sub } from "../../core/vec.js";

/** 4×4 行列（three.js の列優先 elements）で点列を変換する。 */
export function transformPoints(positions, m) {
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export const pointAt = (points, i) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];

/** 距離 tol 以内の頂点を 1 つにまとめる（格子ハッシュで近傍 27 セルを探す）。 */
export function weld(points, tol) {
  const n = points.length / 3;
  const cells = new Map();
  const unique = [];
  const map = new Int32Array(n);
  const cell = (v) => Math.floor(v / tol);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = pointAt(points, i);
    const [cx, cy, cz] = [cell(x), cell(y), cell(z)];
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const k = 3 * j;
            if (Math.abs(unique[k] - x) <= tol && Math.abs(unique[k + 1] - y) <= tol && Math.abs(unique[k + 2] - z) <= tol) {
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
      const key = `${cx},${cy},${cz}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(found);
    }
    map[i] = found;
  }
  return { points: Float64Array.from(unique), map };
}

/** 三角形の頂点番号列（index が無ければ 3 頂点ずつ順に並んだものとみなす）。 */
export function triangleIndices(index, vertexCount) {
  return index ?? Uint32Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
}

function triangleArea(points, a, b, c) {
  return length(cross(sub(pointAt(points, b), pointAt(points, a)), sub(pointAt(points, c), pointAt(points, a)))) / 2;
}

/**
 * 統合後の頂点・三角形（面積ゼロを除く）と、連結成分ごとの三角形の集合を返す。
 * closed は「全ての稜線をちょうど 2 枚の三角形が共有する」（厚みのある閉じた立体）かどうか。
 */
export function prepare(worldPoints, index, tol) {
  const { points, map } = weld(worldPoints, tol);
  const raw = triangleIndices(index, worldPoints.length / 3);
  const tris = [], source = []; // source: 元のメッシュでの三角形番号（表示で部品ごとに色分けするため）
  for (let k = 0; k + 2 < raw.length; k += 3) {
    const [a, b, c] = [map[raw[k]], map[raw[k + 1]], map[raw[k + 2]]];
    if (a === b || b === c || a === c || triangleArea(points, a, b, c) <= tol * tol) continue;
    tris.push(a, b, c);
    source.push(k / 3);
  }
  const n = points.length / 3;
  // 連結成分（union-find）
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let k = 0; k < tris.length; k += 3) {
    parent[find(tris[k + 1])] = find(tris[k]);
    parent[find(tris[k + 2])] = find(tris[k]);
  }
  const groups = new Map();
  for (let k = 0; k < tris.length; k += 3) {
    const root = find(tris[k]);
    if (!groups.has(root)) groups.set(root, { tris: [], source: [] });
    const g = groups.get(root);
    g.tris.push(tris[k], tris[k + 1], tris[k + 2]);
    g.source.push(source[k / 3]);
  }
  return {
    points,
    components: [...groups.values()].map((g) => ({
      tris: Int32Array.from(g.tris),
      sourceTriangles: Int32Array.from(g.source),
      closed: isClosed(g.tris, n),
    })),
  };
}

function isClosed(tris, n) {
  const count = new Map();
  for (let k = 0; k < tris.length; k += 3) {
    for (const [a, b] of [[tris[k], tris[k + 1]], [tris[k + 1], tris[k + 2]], [tris[k + 2], tris[k]]]) {
      const key = Math.min(a, b) * n + Math.max(a, b);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return count.size > 0 && [...count.values()].every((c) => c === 2);
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
