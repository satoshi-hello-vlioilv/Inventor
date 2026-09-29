// 押し出し形状（角柱・任意断面の柱）の判定: 軸方向の高さがちょうど 2 段で、
// 上下の頂点が真上・真下に対応し、側面が全て軸と平行なら押し出し。底面の縁が断面（外周＋穴）になる。

import { dot, sub } from "../ipt/vec.js";
import { basis, cluster, pointAt } from "./mesh.js";

const fail = (reason) => ({ ok: false, reason });

/** 2 次元の多角形の符号付き面積（反時計回りが正）。 */
export const signedArea = (loop) => loop.reduce((s, p, i) => {
  const q = loop[(i + 1) % loop.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;

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
  if (levels.centers.length !== 2) {
    return { ...fail(`厚み方向の高さが ${levels.centers.length} 段ある（面取りや段付きの可能性）`), levels: levels.centers.length };
  }

  // 上下の頂点が 1 対 1 に対応すること
  const U = cluster(Float64Array.from(uv, (p) => p[0]), tol), V = cluster(Float64Array.from(uv, (p) => p[1]), tol);
  const footprint = [new Set(), new Set()];
  used.forEach((_, i) => footprint[levels.ids[i]].add(U.ids[i] * V.centers.length + V.ids[i]));
  if (footprint[0].size !== footprint[1].size || [...footprint[0]].some((k) => !footprint[1].has(k))) {
    return fail("上面と下面の形が一致しない");
  }

  // 側面は軸と平行（投影すると面積ゼロ）、上下面は 1 段に収まる
  const boundary = new Map(); // 下面の縁（1 枚の三角形だけが使う辺）
  const edgeKey = (a, b) => Math.min(a, b) * used.length + Math.max(a, b);
  for (let k = 0; k < tris.length; k += 3) {
    const ids = [local.get(tris[k]), local.get(tris[k + 1]), local.get(tris[k + 2])];
    const lv = ids.map((i) => levels.ids[i]);
    if (lv[0] === lv[1] && lv[1] === lv[2]) {
      if (lv[0] !== 0) continue;
      for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
        const key = edgeKey(a, b);
        if (boundary.has(key)) boundary.delete(key);
        else boundary.set(key, [a, b]);
      }
    } else {
      const [p, q, r] = ids.map((i) => uv[i]);
      const area = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
      const span = Math.max(Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(r[0] - p[0], r[1] - p[1]), 1);
      if (area > tol * span) return fail("軸に平行でない側面がある");
    }
  }
  if (!boundary.size) return fail("底面が見つからない");

  // 縁をつないでループにする
  const next = new Map();
  for (const [a, b] of boundary.values()) {
    if (next.has(a)) return fail("底面の縁が分岐している");
    next.set(a, b);
  }
  const loops = [];
  const seen = new Set();
  for (const first of next.keys()) {
    if (seen.has(first)) continue;
    const loop = [];
    for (let i = first; !seen.has(i); i = next.get(i)) {
      if (i === undefined) return fail("底面の縁が閉じていない");
      seen.add(i);
      loop.push(uv[i]);
    }
    loops.push(loop);
  }
  const byArea = loops.map((l) => ({ loop: l, area: signedArea(l) })).sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const orient = (l, ccw) => ((signedArea(l) > 0) === ccw ? l : [...l].reverse());

  const [h0, h1] = levels.centers;
  return {
    ok: true,
    kind: "prism",
    axis: { origin, dir },
    frame: [u, v],
    h0,
    h1,
    outer: orient(byArea[0].loop, true),
    holes: byArea.slice(1).map((x) => orient(x.loop, false)),
  };
}

