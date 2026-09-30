// 三角形の集まりを「殻」（稜線でつながった三角形の集まり）に分け、閉じた立体かを判定し、三角形の向きをそろえる。
// 開いた殻は、メッシュをまたいで縫い合わせ、平らな縁を塞ぎ、継ぎ目の刻みをそろえて、立体にできるかを試す（closeOpenShells）。
//
// - つながり: 三角形がちょうど 2 枚の稜線だけでつなぐ。3 枚以上が集まる稜線（1 つのジオメトリに重ねて描いた形どうしが
//   稜線で接する所）ではつながないので、重ねて描いた形はそれぞれ別の殻になる
// - 向き: 隣どうしが共有する稜線を逆向きに使うようにそろえ、閉じた殻は外向き（符号付き体積が正）にする。
//   裏返しに作られた面（内側から見せるための面など）も、立体の一部として扱える
// - 閉じた立体: 全ての稜線を、殻の中の 2 枚の三角形が逆向きに 1 回ずつ使う。厚みのない殻（床の表裏など）は立体としない

import * as THREE from "three";
import { cross, dot, length, sub } from "../../core/vec.js";
import { pointAt, weld } from "./mesh.js";

const edgeKey = (a, b, n) => (a < b ? a * n + b : b * n + a);

/** 三角形 t が有向の稜線 a→b を（元の向きのまま）持つか */
const hasDirected = (tris, t, a, b) => {
  for (let e = 0; e < 3; e++) if (tris[3 * t + e] === a && tris[3 * t + ((e + 1) % 3)] === b) return true;
  return false;
};

function signedVolume(points, tris) {
  let v = 0;
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]].map((i) => pointAt(points, i));
    v += dot(a, cross(b, c));
  }
  return v / 6;
}

function surfaceArea(points, tris) {
  let s = 0;
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]].map((i) => pointAt(points, i));
    s += length(cross(sub(b, a), sub(c, a))) / 2;
  }
  return s;
}

/**
 * 殻に分ける。
 * @param {Float64Array} points  頂点（統合済み）
 * @param {ArrayLike<number>} tris  三角形の頂点番号（3 つずつ）
 * @param {number} tol  長さの許容差（厚みのない殻を見分けるのに使う）
 * @returns {{ tris: Int32Array, source: Int32Array, closed: boolean, volume: number, area: number }[]}
 *   tris は向きをそろえた三角形、source は元の三角形の番号
 */
export function buildShells(points, tris, tol) {
  const m = tris.length / 3, n = points.length / 3;
  const edges = new Map();
  for (let t = 0; t < m; t++) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)], n);
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  const shellOf = new Int32Array(m).fill(-1);
  const flip = new Uint8Array(m);
  const shells = [];
  for (let seed = 0; seed < m; seed++) {
    if (shellOf[seed] >= 0) continue;
    const id = shells.length;
    const members = [seed];
    let orientable = true;
    shellOf[seed] = id;
    for (let q = 0; q < members.length; q++) {
      const u = members[q];
      for (let e = 0; e < 3; e++) {
        const a = tris[3 * u + e], b = tris[3 * u + ((e + 1) % 3)];
        const list = edges.get(edgeKey(a, b, n));
        if (list.length !== 2) continue;
        const v = list[0] === u ? list[1] : list[0];
        // 同じ向きに稜線を使っていれば、どちらかを裏返す必要がある
        const want = flip[u] ^ (hasDirected(tris, v, a, b) ? 1 : 0);
        if (shellOf[v] < 0) {
          shellOf[v] = id;
          flip[v] = want;
          members.push(v);
        } else if (shellOf[v] === id && flip[v] !== want) {
          orientable = false; // メビウスの帯のように、向きをそろえられない
        }
      }
    }
    shells.push({ members, orientable });
  }

  return shells.map(({ members, orientable }) => {
    const out = new Int32Array(members.length * 3);
    members.forEach((t, i) => {
      const [a, b, c] = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
      out.set(flip[t] ? [a, c, b] : [a, b, c], 3 * i);
    });
    // 閉じているか: 殻の中で、全ての稜線がちょうど 1 回ずつ逆向きに使われる。
    // 鍵は稜線の番号 × 2 ＋ 向き（頂点が約 4.6 万を超えると 2^31 を超えるので、ビット演算は使わない）
    const directed = new Map();
    for (let k = 0; k < out.length; k += 3) {
      for (let e = 0; e < 3; e++) {
        const a = out[k + e], b = out[k + ((e + 1) % 3)];
        const key = edgeKey(a, b, n) * 2 + (a < b ? 0 : 1);
        directed.set(key, (directed.get(key) ?? 0) + 1);
      }
    }
    let closed = orientable && directed.size > 0;
    if (closed) {
      for (const [key, count] of directed) {
        if (count !== 1 || directed.get(key % 2 ? key - 1 : key + 1) !== 1) {
          closed = false;
          break;
        }
      }
    }
    let volume = signedVolume(points, out);
    const area = surfaceArea(points, out);
    if (closed && volume < 0) {
      for (let k = 0; k < out.length; k += 3) [out[k + 1], out[k + 2]] = [out[k + 2], out[k + 1]];
      volume = -volume;
    }
    // 厚みのない殻（平均の厚み = 体積 / 表面積 × 2 が許容差以下）は立体としない
    if (closed && volume * 2 <= area * tol) closed = false;
    return { tris: out, source: Int32Array.from(members), closed, volume: closed ? volume : 0, area };
  });
}

// ---- 開いた殻を立体にする ----------------------------------------------------------

const triangleArea = (points, items) => items.reduce((sum, { tri }) => {
  const [a, b, c] = tri.map((i) => pointAt(points, i));
  return sum + length(cross(sub(b, a), sub(c, a))) / 2;
}, 0);

/** 殻の縁（1 枚の三角形だけが使う稜線）を、つながった輪にまとめる。 */
function boundaryLoops(tris, n) {
  const count = new Map();
  for (let k = 0; k < tris.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(tris[k + e], tris[k + ((e + 1) % 3)], n);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const next = new Map(); // 縁の有向稜線 a→b（三角形の向きのまま）
  for (let k = 0; k < tris.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[k + e], b = tris[k + ((e + 1) % 3)];
      if (count.get(edgeKey(a, b, n)) !== 1) continue;
      if (!next.has(a)) next.set(a, []);
      next.get(a).push(b);
    }
  }
  const loops = [];
  for (const start of next.keys()) {
    while (next.get(start)?.length) {
      const loop = [start];
      let at = next.get(start).pop();
      while (at !== start && next.get(at)?.length && loop.length <= next.size + 1) {
        loop.push(at);
        at = next.get(at).pop();
      }
      if (at === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** 輪が平らなら、その平面（法線・原点・面内の基底）と 2 次元の点列を返す。 */
function planarLoop(points, loop, tol) {
  const p = loop.map((i) => pointAt(points, i));
  const normal = [0, 0, 0];
  const c = [0, 0, 0];
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
    for (let k = 0; k < 3; k++) c[k] += a[k] / p.length;
  });
  const len = length(normal);
  if (len < tol * tol) return null;
  const nn = normal.map((v) => v / len);
  if (p.some((a) => Math.abs(dot(sub(a, c), nn)) > tol)) return null;
  // 同じ平面の輪を見分けるため、法線の向きを正規化する（最初の 0 でない成分を正に）
  const sign = (Math.abs(nn[0]) > 1e-9 ? nn[0] : Math.abs(nn[1]) > 1e-9 ? nn[1] : nn[2]) < 0 ? -1 : 1;
  const nz = nn.map((v) => v * sign);
  const helper = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0 = cross(helper, nz), u = u0.map((v) => v / length(u0)), v = cross(nz, u);
  return { normal: nz, offset: dot(c, nz), flat: p.map((a) => [dot(a, u), dot(a, v)]) };
}

function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * 平らな縁の輪を塞ぐ三角形。同じ平面にある輪は、入れ子（外周と穴）にしてまとめて塞ぐ（管の端の輪、筒の端の外周と内周など）。
 * 向きはそろえない（あとで buildShells がそろえる）。
 */
function capLoops(points, loops, tol) {
  const planes = [];
  for (const loop of loops) {
    const plane = planarLoop(points, loop, tol);
    if (!plane) continue;
    const same = planes.find((g) => dot(g.normal, plane.normal) > 1 - 1e-9 && Math.abs(g.offset - plane.offset) <= tol);
    if (same) same.loops.push({ loop, flat: plane.flat });
    else planes.push({ normal: plane.normal, offset: plane.offset, loops: [{ loop, flat: plane.flat }] });
  }
  const caps = [];
  for (const { loops: group } of planes) {
    // 入れ子の深さ: 偶数 = 外周、奇数 = 穴
    const depth = group.map((g, i) => group.filter((h, j) => j !== i && inside(g.flat[0], h.flat)).length);
    group.forEach((outer, i) => {
      if (depth[i] % 2) return;
      const holes = group.filter((h, j) => depth[j] === depth[i] + 1 && inside(h.flat[0], outer.flat));
      const ring = [outer, ...holes];
      const faces = THREE.ShapeUtils.triangulateShape(outer.flat.map(([x, y]) => new THREE.Vector2(x, y)), holes.map((h) => h.flat.map(([x, y]) => new THREE.Vector2(x, y))));
      const ids = ring.flatMap((r) => r.loop);
      for (const [a, b, c] of faces) caps.push(ids[a], ids[b], ids[c]);
    });
  }
  return caps;
}

// ---- 継ぎ目の刻みをそろえる --------------------------------------------------------
// 隣り合う面が、同じ線を別々の刻みで分割していると（片方は等間隔・片方は端ほど細かい、曲線を面ごとに別の角度の刻みで分けたなど）、
// 縁の頂点が相手の縁の稜線の途中に乗る（T 字の継ぎ目）。その稜線を頂点で分けると、両側の縁が同じ頂点の列になり、稜線でつながる。
// 曲線の継ぎ目では、頂点は相手の弦から「弦のたわみ」だけ外側（曲がりの外）に離れる。たわみは、弦の側の曲がり（弦の長さ × 端での
// 曲がりの角度 / 8）か、頂点の側の曲がり（弦の長さ² × 頂点での曲がりの角度 / (8 × 頂点の縁の長さ)）で見積もれるので、その 2 倍まで、
// 曲がりの外側だけを許す。平行に並んだ別の縁（薄い板の表と裏など）は、まっすぐなら許容差を超え、曲がっていれば内側にあるので分けない。

const SEAM_ALIGN = Math.cos(Math.PI / 6); // 同じ線に沿う稜線とみなす向きの差（30°）

/** 開いた殻の縁（1 枚の三角形だけが使う稜線。[始点, 終点, 三角形の残りの頂点]）と、縁の頂点ごとの隣の縁の頂点 */
function boundaryEdges(items, n) {
  const count = new Map();
  for (const { tri } of items) for (let e = 0; e < 3; e++) {
    const key = edgeKey(tri[e], tri[(e + 1) % 3], n);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const edges = [], neighbors = new Map();
  const link = (a, b) => {
    if (!neighbors.has(a)) neighbors.set(a, []);
    neighbors.get(a).push(b);
  };
  for (const { tri } of items) for (let e = 0; e < 3; e++) {
    const a = tri[e], b = tri[(e + 1) % 3];
    if (count.get(edgeKey(a, b, n)) !== 1) continue;
    edges.push([a, b, tri[(e + 2) % 3]]);
    link(a, b);
    link(b, a);
  }
  return { edges, neighbors };
}

const unitOf = (v) => {
  const l = length(v);
  return l > 0 ? v.map((c) => c / l) : v;
};

/**
 * 縁の稜線ごとに、途中に乗っている縁の頂点（T 字の継ぎ目）を探す。
 * @returns {Map<number, { from: number, vertices: number[] }>}  稜線の鍵 → from から見た順の頂点
 */
function seamInserts(points, items, tols) {
  const n = points.length / 3;
  const { edges, neighbors } = boundaryEdges(items, n);
  const inserts = new Map();
  if (!edges.length) return inserts;
  const at = (i) => pointAt(points, i);
  const lengths = edges.map(([a, b]) => length(sub(at(b), at(a)))).sort((x, y) => x - y);
  const cell = edges.reduce((m, [a]) => Math.max(m, tols[a]), lengths[lengths.length >> 1]); // 大きな配列を引数に展開しない
  const grid = new Map();
  const key = (p) => p.map((v) => Math.floor(v / cell)).join(",");
  for (const v of neighbors.keys()) {
    const k = key(at(v));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(v);
  }
  /** 線分 A–B から reach 以内にありうる縁の頂点（線分に沿って升目をたどる。長さに比例する手間） */
  function* nearSegment(A, B, reach) {
    const steps = Math.max(1, Math.ceil(length(sub(B, A)) / cell));
    const r = reach + cell / 2;
    const cells = new Set();
    for (let i = 0; i <= steps; i++) {
      const P = A.map((v, k) => v + ((B[k] - v) * i) / steps);
      const lo = P.map((v) => Math.floor((v - r) / cell)), hi = P.map((v) => Math.floor((v + r) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) cells.add(`${x},${y},${z}`);
    }
    for (const k of cells) yield* grid.get(k) ?? [];
  }
  // 頂点 v で dir に沿って続く縁（前と後ろ）。曲がり k（向きの変化のベクトル。曲がりの中心の側を向き、長さはほぼ角度）と縁の長さ
  const bendAt = (v, dir) => {
    let back = null, ahead = null, cb = SEAM_ALIGN, ca = SEAM_ALIGN;
    for (const w of neighbors.get(v)) {
      const e = sub(at(w), at(v)), c = dot(unitOf(e), dir);
      if (c >= ca) [ca, ahead] = [c, e];
      if (-c >= cb) [cb, back] = [-c, e];
    }
    return { back, ahead };
  };
  const turn = (inward, outward) => sub(unitOf(outward), unitOf(inward)); // 入る向き → 出る向きの変化
  const ZERO = [0, 0, 0];
  for (const [a, b, c] of edges) {
    const A = at(a), B = at(b), d = sub(B, A), len = length(d);
    const tol = Math.max(tols[a], tols[b]); // この稜線の許容差（元のメッシュの float32 の精度）
    if (len <= tol) continue;
    const dir = d.map((c) => c / len);
    // 弦の側の曲がり: a の手前・b の先に続く縁との向きの変化（30° 以内）
    const before = bendAt(a, dir).back, after = bendAt(b, dir).ahead;
    const ka = before ? turn(before.map((c) => -c), d) : ZERO, kb = after ? turn(d, after) : ZERO;
    const chord = { k: [ka[0] + kb[0], ka[1] + kb[1], ka[2] + kb[2]], limit: (len * Math.max(length(ka), length(kb))) / 4 };
    // 探す範囲: 弦が曲線の 60° にかかるときのたわみの 2 倍（長さ × π/12）まで、ただし格子の 1 升まで
    const reach = Math.max(tol, Math.min(cell, (len * Math.PI) / 12));
    const found = [], seen = new Set();
    for (const v of nearSegment(A, B, reach)) {
      if (v === a || v === b || v === c || seen.has(v)) continue; // 細い三角形では、向かいの頂点が稜線の近くにある
      seen.add(v);
      const P = at(v), t = dot(sub(P, A), dir);
      if (t <= tol || t >= len - tol) continue;
      const off = sub(P, [A[0] + dir[0] * t, A[1] + dir[1] * t, A[2] + dir[2] * t]);
      const dist = length(off);
      if (dist > reach) continue;
      // 頂点の縁が、この稜線と同じ線に沿っている（前か後ろに続く）
      const { back, ahead } = bendAt(v, dir);
      if (!back && !ahead) continue;
      // 頂点の側の曲がり: 前後に続く縁の向きの変化 τ と長さ l から。弦がその曲線の 60° 以内にかかる（len τ / l ≤ π/3）ときだけ
      let side = null;
      if (back && ahead) {
        const k = turn(back.map((c) => -c), ahead), span = (length(back) + length(ahead)) / 2;
        if ((len * length(k)) / span <= Math.PI / 3) side = { k, limit: (len * len * length(k)) / (4 * span) };
      }
      // 曲がりの外側で、たわみの見積もりの 2 倍以内（曲がりの内側にあるものは、平行に並んだ別の縁）
      const fits = (bend) => bend && dist <= bend.limit && dot(off, bend.k) <= 0;
      if (dist > tol && !fits(chord) && !fits(side)) continue;
      found.push({ t, v });
    }
    if (found.length) inserts.set(edgeKey(a, b, n), { from: a, vertices: found.sort((p, q) => p.t - q.t).map((f) => f.v) });
  }
  return inserts;
}

/** 三角形を、稜線の途中に入れる頂点で分ける（入れる稜線の向かいの頂点から扇形に。分けた三角形の残りの稜線も続けて分ける） */
function splitTriangle(tri, inserts, n, out) {
  for (let e = 0; e < 3; e++) {
    const a = tri[e], b = tri[(e + 1) % 3], c = tri[(e + 2) % 3];
    const found = inserts.get(edgeKey(a, b, n));
    if (!found) continue;
    const path = [a, ...(found.from === a ? found.vertices : [...found.vertices].reverse()), b];
    for (let i = 0; i + 1 < path.length; i++) splitTriangle([path[i], path[i + 1], c], inserts, n, out);
    return;
  }
  out.push(tri);
}

/**
 * 継ぎ目の刻みをそろえた三角形（元の items の番号 from を持つ）。分けるものが無くなるまで繰り返す。
 * @param {Float64Array} tols  頂点ごとの長さの許容差
 */
export function conformSeams(points, items, tols) {
  const n = points.length / 3;
  let current = items.map((it, from) => ({ ...it, from }));
  for (let round = 0; round < 3; round++) {
    const inserts = seamInserts(points, current, tols);
    if (!inserts.size) break;
    current = current.flatMap((it) => {
      const out = [];
      splitTriangle(it.tri, inserts, n, out);
      // 潰れた三角形（同じ頂点を 2 度持つ）は作らない。できたら、その所は閉じないので元に戻る
      return out.filter(([x, y, z]) => x !== y && y !== z && x !== z).map((tri) => ({ ...it, tri }));
    });
  }
  return current;
}

/**
 * 開いた殻（メッシュごとに別々の頂点を持つ）を 1 つの空間で縫い合わせ、閉じた立体になるものを返す。段ごとに、閉じた殻を立体にし、
 * 閉じなかった所は元の三角形に戻して次の段へ:
 * 1. 頂点を統合して稜線をつなぐ（開いた円筒の内壁・外壁と、両端のリング → 筒）
 * 2. まだ開いている殻の平らな縁を塞ぐ（管の両端、端の開いた円筒など）。塞ぐ面積が元の面より大きいものは塞がない
 * 3. 継ぎ目の刻みをそろえる（同じ線を面ごとに別の刻みで分けた形。アルミコイルの端面と外周など）。続けて平らな縁も塞ぐ
 * @param {{ points: Float64Array, tris: ArrayLike<number>, tol: number }[]} pieces  開いた殻
 * @returns {{ solids: { points: Float64Array, tris: Int32Array, members: Map<number, number[]>, caps: number, seams: boolean, volume: number, area: number }[], open: number[] }}
 *   members は「殻の番号 → 使った三角形の番号（殻の中での番号）」、caps は塞いだ三角形の数（tris の末尾）、
 *   seams は継ぎ目の刻みをそろえたか、open は立体にならなかった殻の番号
 */
export function closeOpenShells(pieces) {
  if (!pieces.length) return { solids: [], open: [] };
  const tol = Math.max(...pieces.map((p) => p.tol));
  const all = new Float64Array(pieces.reduce((s, p) => s + p.points.length, 0));
  const pointTol = new Float64Array(all.length / 3); // 頂点ごとの許容差（元の殻の許容差）
  const tris = [], fromPiece = [], fromTri = []; // 三角形ごとの元（殻の番号・殻の中の番号。塞いだ三角形は -1）
  let base = 0;
  pieces.forEach((p, i) => {
    all.set(p.points, base * 3);
    pointTol.fill(p.tol, base, base + p.points.length / 3);
    for (let k = 0; k < p.tris.length; k += 3) {
      tris.push(base + p.tris[k], base + p.tris[k + 1], base + p.tris[k + 2]);
      fromPiece.push(i);
      fromTri.push(k / 3);
    }
    base += p.points.length / 3;
  });
  const { points, map, tols } = weld(all, tol, pointTol);
  let rest = [];
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [map[tris[k]], map[tris[k + 1]], map[tris[k + 2]]];
    if (a !== b && b !== c && a !== c) rest.push({ tri: [a, b, c], piece: fromPiece[k / 3], local: fromTri[k / 3] });
  }
  const n = points.length / 3;

  const solids = [];
  for (const { cap, seams } of [{ cap: false, seams: false }, { cap: true, seams: false }, { cap: false, seams: true }, { cap: true, seams: true }]) {
    if (!rest.length) break;
    const tried = seams ? conformSeams(points, rest, tols) : rest.map((it, from) => ({ ...it, from }));
    const own = Int32Array.from(tried.flatMap((r) => r.tri));
    const caps = cap ? capLoops(points, boundaryLoops(own, n), tol) : [];
    const combined = new Int32Array(own.length + caps.length);
    combined.set(own);
    combined.set(caps, own.length);
    const next = new Set(); // 次の段へ回す元の三角形（rest の番号。立体にならなかった所の塞ぎ・分割は捨てる）
    for (const shell of buildShells(points, combined, tol)) {
      // 三角形は向きをそろえたもの（元の情報の tri で上書きしない）
      const items = Array.from(shell.source, (t, i) => ({ ...(tried[t] ?? { piece: -1 }), tri: [shell.tris[3 * i], shell.tris[3 * i + 1], shell.tris[3 * i + 2]] }));
      const own = items.filter((it) => it.piece >= 0), added = items.filter((it) => it.piece < 0);
      // 塞ぐ面積が元の面の面積を超えるなら、形の大半が推測になるので塞がない（表面に重ねた帯・短く太い輪など）。
      // 管の端（面積 πr² × 2 に対し元の面 2πrL）は塞ぐ
      if (!shell.closed || (added.length && triangleArea(points, added) > triangleArea(points, own))) {
        for (const it of own) next.add(it.from);
        continue;
      }
      const members = new Map();
      for (const it of own) {
        if (!members.has(it.piece)) members.set(it.piece, new Set());
        members.get(it.piece).add(it.local);
      }
      solids.push({
        points, tris: Int32Array.from([...own, ...added].flatMap((it) => it.tri)), caps: added.length, seams,
        members: new Map([...members].map(([piece, local]) => [piece, [...local]])), volume: shell.volume, area: shell.area,
      });
    }
    rest = [...next].sort((a, b) => a - b).map((i) => rest[i]);
  }
  const open = [...new Set(rest.map((r) => r.piece))].sort((a, b) => a - b);
  return { solids, open };
}
