// 回転体の判定: 軸を仮定し、全頂点が「高さ h・半径 r ごとの円（リング）」に並ぶかを調べる。
// 成り立てば、リングを隣接順に並べたものが断面形状（プロファイル）になる。
// 扇形に回した部分回転体（端面が平面）も扱う。

import { basis, cluster, cylindrical } from "./mesh.js";

export const MIN_RING = 12; // 円とみなす最少の分割数（6 角ボルトなどの多角柱を円柱と誤認しないため）
const FULL_GAP = (2 * Math.PI / MIN_RING) * 1.5; // リング上の角度の隙間がこれ以下なら全周
const ANGLE_TOL = 1e-4;

const fail = (reason) => ({ ok: false, reason });

/** リング上の角度から、全周か扇形か（開始角・角度幅）を求める。 */
function angularExtent(thetas) {
  const s = [...thetas].sort((a, b) => a - b);
  let gap = s[0] + 2 * Math.PI - s[s.length - 1], after = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] > gap) {
      gap = s[i] - s[i - 1];
      after = i;
    }
  }
  if (gap <= FULL_GAP) return { full: true };
  const start = s[after];
  const end = s[(after - 1 + s.length) % s.length];
  return { full: false, start, span: (end - start + 2 * Math.PI) % (2 * Math.PI) };
}

/** 半径 r の円周上の角度 thetas の点を順に結んだ多角形の面積 */
function polygonArea(thetas, r) {
  const s = [...thetas].sort((a, b) => a - b);
  return s.reduce((sum, a, i) => sum + (r * r * Math.sin(((i + 1 < s.length ? s[i + 1] : s[0] + 2 * Math.PI) - a))) / 2, 0);
}

/**
 * @param {Float64Array} points  統合済みの頂点（ワールド座標）
 * @param {Int32Array} tris      この部品の三角形
 * @returns {{ok: true, ...} | {ok: false, reason: string}}
 */
export function detectRevolve(points, tris, origin, dir, tol) {
  const used = [...new Set(tris)];
  const frame = basis(dir);
  const all = cylindrical(points, origin, dir, frame);
  const pick = (a) => Float64Array.from(used, (i) => a[i]);
  const [h, r, t] = [pick(all.h), pick(all.r), pick(all.t)];
  const local = new Map(used.map((g, i) => [g, i]));

  // (h, r) が同じ頂点を 1 つのリングにまとめる
  const H = cluster(h, tol), R = cluster(r, tol);
  const keyOf = (i) => H.ids[i] * R.centers.length + R.ids[i];
  const groups = new Map();
  used.forEach((_, i) => {
    const key = keyOf(i);
    if (!groups.has(key)) groups.set(key, { h: H.centers[H.ids[i]], r: R.centers[R.ids[i]], members: [] });
    groups.get(key).members.push(i);
  });
  const rings = [...groups.values()];
  rings.forEach((g, id) => (g.id = id));
  const ringOf = new Int32Array(used.length);
  for (const g of rings) for (const i of g.members) ringOf[i] = g.id;
  const onAxis = (g) => g.r <= tol;

  let minRing = Infinity;
  for (const g of rings) {
    if (onAxis(g)) continue;
    if (g.members.length < MIN_RING) return fail(`半径 ${g.r.toFixed(3)} の円周上の点が ${g.members.length} 個（${MIN_RING} 個未満）`);
    minRing = Math.min(minRing, g.members.length);
  }
  if (!Number.isFinite(minRing)) return fail("軸から離れた点がない");

  // 全周か扇形か（全てのリングで一致すること）
  let extent = null;
  for (const g of rings) {
    if (onAxis(g)) continue;
    const e = angularExtent(g.members.map((i) => t[i]));
    if (!extent) extent = e;
    else if (e.full !== extent.full || (!e.full && (Math.abs(e.start - extent.start) > ANGLE_TOL || Math.abs(e.span - extent.span) > ANGLE_TOL))) {
      return fail("リングごとに回転角の範囲が異なる");
    }
  }

  // 断面の稜線: 異なるリング同士を結ぶ三角形の辺のうち、十分な本数があるもの（帯状の面）
  const pairCount = new Map();
  const pairKey = (a, b) => Math.min(a, b) * rings.length + Math.max(a, b);
  for (let k = 0; k < tris.length; k += 3) {
    const g = [ringOf[local.get(tris[k])], ringOf[local.get(tris[k + 1])], ringOf[local.get(tris[k + 2])]];
    for (const [a, b] of [[g[0], g[1]], [g[1], g[2]], [g[2], g[0]]]) {
      if (a !== b) pairCount.set(pairKey(a, b), (pairCount.get(pairKey(a, b)) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(minRing / 2));
  const adjacent = rings.map(() => new Set());
  const isAdjacent = (a, b) => adjacent[a].has(b);
  for (const [key, count] of pairCount) {
    if (count < threshold) continue;
    const [a, b] = [Math.floor(key / rings.length), key % rings.length];
    adjacent[a].add(b);
    adjacent[b].add(a);
  }
  // 中心の頂点が無い円板の端面（円周上の点だけで三角形に分けたもの。縁を塞いだ管・円筒など）は、
  // 同じ高さの軸上の点とつながる端面とみなす（CylinderGeometry の端面と同じ断面になる）。
  // 円周の点だけの三角形が、円周の多角形をちょうど覆うときに限る（外周だけの三角形を含む輪の端面は、覆う面積が足りない）
  if (extent.full) {
    const selfArea = new Float64Array(rings.length);
    for (let k = 0; k < tris.length; k += 3) {
      const ids = [local.get(tris[k]), local.get(tris[k + 1]), local.get(tris[k + 2])];
      if (ringOf[ids[0]] !== ringOf[ids[1]] || ringOf[ids[1]] !== ringOf[ids[2]]) continue;
      const [a, b, c] = ids.map((i) => [r[i] * Math.cos(t[i]), r[i] * Math.sin(t[i])]);
      selfArea[ringOf[ids[0]]] += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    for (const g of [...rings]) {
      if (onAxis(g) || selfArea[g.id] < polygonArea(g.members.map((i) => t[i]), g.r) * (1 - 1e-6)) continue;
      const center = { h: g.h, r: 0, members: [], id: rings.length };
      rings.push(center);
      adjacent.push(new Set([g.id]));
      adjacent[g.id].add(center.id);
    }
  }
  for (const g of rings) {
    const degree = adjacent[g.id].size;
    if (!(degree === 2 || (degree === 1 && onAxis(g)))) return fail("断面の輪郭が 1 本の線につながらない");
  }

  // 断面の輪郭を順にたどる（軸上の点から始まる開いた輪郭か、閉じた輪郭）
  const start = rings.find((g) => adjacent[g.id].size === 1) ?? rings[0];
  const order = [start.id];
  for (let prev = -1, cur = start.id; ;) {
    const next = [...adjacent[cur]].find((x) => x !== prev);
    if (next === undefined || next === start.id) break;
    order.push(next);
    [prev, cur] = [cur, next];
  }
  if (order.length !== rings.length) return fail("断面の輪郭が複数に分かれている");

  // 全ての三角形が「隣り合うリングの帯」か「扇形の端面」に載っていること
  const atAngle = (i, angle) => Math.abs(Math.atan2(Math.sin(t[i] - angle), Math.cos(t[i] - angle))) <= ANGLE_TOL * 10;
  for (let k = 0; k < tris.length; k += 3) {
    const ids = [local.get(tris[k]), local.get(tris[k + 1]), local.get(tris[k + 2])];
    const g = ids.map((i) => ringOf[i]);
    const banded = [[0, 1], [1, 2], [2, 0]].every(([a, b]) => g[a] === g[b] || isAdjacent(g[a], g[b]));
    if (banded) continue;
    if (!extent.full && [extent.start, extent.start + extent.span].some((angle) => ids.every((i) => atAngle(i, angle) || onAxis(rings[ringOf[i]])))) continue;
    return fail("回転方向に一様でない面がある");
  }

  return {
    ok: true,
    kind: "revolve",
    axis: { origin, dir },
    frame,
    profile: order.map((id) => [rings[id].r, rings[id].h]),
    closed: !order.some((id) => onAxis(rings[id])),
    sector: extent.full ? null : { start: extent.start, span: extent.span },
    rings: rings.length,
  };
}
