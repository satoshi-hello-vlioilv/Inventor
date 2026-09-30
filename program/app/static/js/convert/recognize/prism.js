// 押し出し形状（任意断面の柱。端面の縁に等距離の面取りがあってもよい）の判定。
//
// 三角形を「端面（最上段・最下段で平ら）」「側壁（軸と平行）」「斜面」に分ける。
//   側壁 … 平面に投影すると線になる。投影して重なる頂点（柱）を、側壁がつなぐ順にたどると断面の輪郭（外周＋穴）になる
//   斜面 … 端面の縁と側壁の端をつなぐ帯。側壁の端から端面までの高さ a と、端面の縁が輪郭から材料側へ入る距離が
//          等しければ等距離の面取り（C a）。斜面の各頂点が「輪郭を材料側へずらした線」の上にあるかで確かめる
// 面取りの角付近は、作り方（留め継ぎ・丸め・角度での再分割など）で形が変わる。変換後の形は CAD の留め継ぎになるので、
// 輪郭の角から 2a 以内（CORNER_ZONE）の縁の点は照合から外し、その範囲での縁の位置の差の最大値（cornerDeviation）を報告する。
// 斜面の途中の高さの点（丸い面取りの分割）は、角の範囲でも照合する（多角形の輪郭では丸い面取りの点が全て角の範囲にあるため）。

import { dot, sub } from "../../core/vec.js";
import { distanceToLoop, loopCorners, offsetIntoMaterial } from "./geometry2d.js";
import { basis, cluster, pointAt, weld } from "./mesh.js";
import { fitSegments } from "./segments.js";

const CAP = 0, WALL = 1, SLANT = 2;
export const CORNER_ZONE = 2; // 面取りの角の範囲（面取り量の倍数）

/** 2 次元の多角形の符号付き面積（反時計回りが正）。 */
export const signedArea = (loop) => loop.reduce((s, p, i) => {
  const q = loop[(i + 1) % loop.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;

const orient = (loop, ccw) => ((signedArea(loop) > 0) === ccw ? loop : [...loop].reverse());

/** 側壁の三角形がつなぐ柱のグラフを、順にたどってループ（柱の番号の列）にする。分岐していれば null。 */
function wallLoops(adjacency) {
  for (const next of adjacency.values()) if (next.size !== 2) return null;
  const seen = new Set(), loops = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let [prev, cur] = [start, [...adjacency.get(start)][0]];
    while (cur !== start) {
      loop.push(cur);
      seen.add(cur);
      const next = [...adjacency.get(cur)].find((c) => c !== prev);
      [prev, cur] = [cur, next];
    }
    loops.push(loop);
  }
  return loops;
}

export function detectPrism(points, tris, origin, dir, tol) {
  const used = [...new Set(tris)];
  const [u, v] = basis(dir);
  const local = new Map(used.map((g, i) => [g, i]));
  const h = new Float64Array(used.length), uv = [];
  used.forEach((g, i) => {
    const d = sub(pointAt(points, g), origin);
    h[i] = dot(d, dir);
    uv.push([dot(d, u), dot(d, v)]);
  });
  const levels = cluster(h, tol);
  const fail = (reason) => ({ ok: false, reason, levels: levels.centers.length });
  const top = levels.centers.length - 1;
  if (top < 1) return fail("軸方向の厚みがない");
  const level = (i) => levels.ids[i];

  // 三角形の分類（平らな段があれば、重い処理の前に打ち切る）
  const kinds = new Uint8Array(tris.length / 3);
  const idsOf = (k) => [local.get(tris[k]), local.get(tris[k + 1]), local.get(tris[k + 2])];
  for (let k = 0; k < tris.length; k += 3) {
    const ids = idsOf(k);
    const lv = ids.map(level);
    const [p, q, r] = ids.map((i) => uv[i]);
    const area = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
    const span = Math.max(Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(r[0] - p[0], r[1] - p[1]), 1);
    if (lv[0] === lv[1] && lv[1] === lv[2]) {
      if (lv[0] !== 0 && lv[0] !== top) return fail("途中の高さに平らな面がある（段付きの可能性）");
      kinds[k / 3] = CAP;
    } else kinds[k / 3] = area <= tol * span ? WALL : SLANT;
  }

  // 側壁がつなぐ柱のグラフ。側壁の三角形は投影すると一直線に並ぶので、線上の順に隣どうしをつなぐ
  const flat = new Float64Array(3 * used.length);
  uv.forEach((p, i) => { flat[3 * i] = p[0]; flat[3 * i + 1] = p[1]; });
  const column = weld(flat, tol).map;
  const adjacency = new Map();
  const link = (a, b) => {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!adjacency.has(x)) adjacency.set(x, new Set());
      adjacency.get(x).add(y);
    }
  };
  for (let k = 0; k < tris.length; k += 3) {
    if (kinds[k / 3] !== WALL) continue;
    const cols = [...new Map(idsOf(k).map((i) => [column[i], uv[i]]))];
    const [a, b] = [cols[0][1], cols.at(-1)[1]];
    const along = ([, w]) => (w[0] - a[0]) * (b[0] - a[0]) + (w[1] - a[1]) * (b[1] - a[1]);
    cols.sort((x, y) => along(x) - along(y));
    for (let j = 0; j + 1 < cols.length; j++) link(cols[j][0], cols[j + 1][0]);
  }
  if (!adjacency.size) return fail("軸に平行な側面がない");
  const loops = wallLoops(adjacency);
  if (!loops) return fail("側面の形が分岐している");

  // 柱ごとの側壁の上端・下端の段
  const columnPoint = new Map(), colTop = new Map(), colBottom = new Map();
  const slant = new Set();
  for (let k = 0; k < tris.length; k += 3) {
    for (let j = 0; j < 3; j++) {
      const i = local.get(tris[k + j]);
      if (kinds[k / 3] === SLANT) slant.add(i);
      if (kinds[k / 3] !== WALL) continue;
      const c = column[i];
      columnPoint.set(c, uv[i]);
      colTop.set(c, Math.max(colTop.get(c) ?? -1, level(i)));
      colBottom.set(c, Math.min(colBottom.get(c) ?? Infinity, level(i)));
    }
  }

  // 断面の輪郭（外周は反時計回り、穴は時計回り）と、輪郭ごとの面取り
  const polylines = loops.map((cols) => ({ cols, pts: cols.map((c) => columnPoint.get(c)) }))
    .map((l) => ({ ...l, area: Math.abs(signedArea(l.pts)) }))
    .sort((a, b) => b.area - a.area)
    .map((l, i) => ({ ...l, pts: orient(l.pts, i === 0) }));
  const sections = [];
  for (const [index, { cols, pts }] of polylines.entries()) {
    const ends = [new Set(cols.map((c) => colBottom.get(c))), new Set(cols.map((c) => colTop.get(c)))];
    if (ends.some((s) => s.size !== 1)) return fail("面取りや段が輪郭の一部だけにある");
    const [bottomEnd, topEnd] = ends.map((s) => [...s][0]);
    const depth = { [-1]: levels.centers[bottomEnd] - levels.centers[0], 1: levels.centers[top] - levels.centers[topEnd] };
    const segments = fitSegments(pts, true, tol);
    sections.push({ index, isHole: index > 0, pts, segments, depth, corners: loopCorners(segments) });
  }
  const [h0, h1] = [levels.centers[0], levels.centers[top]];
  const chamfered = sections.flatMap((s) => [-1, 1].filter((side) => s.depth[side] > tol).map((side) => ({ section: s, side })));
  if (chamfered.some(({ section, side }) => section.depth[side] >= (h1 - h0) / 2)) return fail("面取りが厚みの半分以上ある");

  // 斜面の頂点: 最も近い輪郭の面取りの上にあるか（端面からの深さ t の位置では、輪郭を a − t だけずらした線の上）
  const offsets = new Map();
  const shifted = (section, e) => {
    const key = `${section.index}:${e.toFixed(9)}`;
    if (!offsets.has(key)) offsets.set(key, e <= tol ? section.segments : offsetIntoMaterial(section.segments, e, section.isHole)?.loop ?? null);
    return offsets.get(key);
  };
  const deviation = new Map(chamfered.map((c) => [c, 0]));
  const capRing = new Map(chamfered.map((c) => [c, []]));
  for (const i of slant) {
    const p = uv[i];
    const side = h[i] >= (h0 + h1) / 2 ? 1 : -1;
    const gaps = sections.map((s) => distanceToLoop(p, s.segments));
    const section = sections[gaps.indexOf(Math.min(...gaps))];
    const target = chamfered.find((c) => c.section === section && c.side === side);
    if (!target) return fail("面取りのない縁に斜めの面がある");
    const a = section.depth[side], t = side > 0 ? h1 - h[i] : h[i] - h0;
    if (t > a + tol) return fail("斜面が側壁の途中まで入り込んでいる");
    const outline = shifted(section, Math.max(a - t, 0));
    if (!outline) return fail("面取り後の輪郭を作れない（面取りが形状に対して大きすぎる）");
    const residual = distanceToLoop(p, outline);
    if (t <= tol) capRing.get(target).push(gaps[section.index]);
    // 角の範囲で照合から外すのは、端面の縁（t = 0）と側壁の端（t = a）の点だけ。まっすぐな面取りの斜面は 2 つの縁を結ぶ帯なので
    // 途中の高さに点を持たない。途中の高さの点（丸い面取りの分割）は、角の範囲でも必ず照合する
    const between = t > tol && t < a - tol;
    const nearCorner = !between && section.corners.some((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= CORNER_ZONE * a);
    if (nearCorner) deviation.set(target, Math.max(deviation.get(target), residual));
    else if (residual > tol) {
      const ring = capRing.get(target).sort((x, y) => x - y);
      const r = ring.length ? ring[Math.floor(ring.length / 2)] : NaN;
      return fail(Math.abs(r - a) > tol ? `不等辺の面取り（端面側 ${r.toFixed(3)}・側面側 ${a.toFixed(3)}）には未対応` : "斜面が等距離の面取りの形になっていない");
    }
  }
  for (const [c, dev] of deviation) if (dev > c.section.depth[c.side]) return fail("面取りの角の形が大きく異なる");

  return {
    ok: true,
    kind: "prism",
    axis: { origin, dir },
    frame: [u, v],
    h0,
    h1,
    outer: sections[0].pts,
    holes: sections.slice(1).map((s) => s.pts),
    segments: { outer: sections[0].segments, holes: sections.slice(1).map((s) => s.segments) },
    chamfers: chamfered.map((c) => ({ loop: c.section.index, side: c.side, distance: c.section.depth[c.side], cornerDeviation: deviation.get(c) })),
  };
}
