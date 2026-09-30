// 三角形の集まりを「殻」（稜線でつながった三角形の集まり）に分け、閉じた立体かを判定し、三角形の向きをそろえる。
// 開いた殻は、メッシュをまたいで縫い合わせ、平らな縁を塞いで、立体にできるかを試す（closeOpenShells）。
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
    // 閉じているか: 殻の中で、全ての稜線がちょうど 1 回ずつ逆向きに使われる
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
        if (count !== 1 || directed.get(key ^ 1) !== 1) {
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

/**
 * 開いた殻（メッシュごとに別々の頂点を持つ）を 1 つの空間で縫い合わせ、閉じた立体になるものを返す。
 * 1. 頂点を統合して稜線をつなぐ（開いた円筒の内壁・外壁と、両端のリング → 筒）
 * 2. まだ開いている殻の平らな縁を塞ぐ（管の両端、端の開いた円筒など）。塞ぐ面積が元の面より大きいものは塞がない
 * @param {{ points: Float64Array, tris: ArrayLike<number>, tol: number }[]} pieces  開いた殻
 * @returns {{ solids: { points: Float64Array, tris: Int32Array, members: Map<number, number[]>, caps: number, volume: number, area: number }[], open: number[] }}
 *   members は「殻の番号 → 使った三角形の番号（殻の中での番号）」、caps は塞いだ三角形の数（tris の末尾）、
 *   open は立体にならなかった殻の番号
 */
export function closeOpenShells(pieces) {
  if (!pieces.length) return { solids: [], open: [] };
  const tol = Math.max(...pieces.map((p) => p.tol));
  const all = new Float64Array(pieces.reduce((s, p) => s + p.points.length, 0));
  const tris = [], fromPiece = [], fromTri = []; // 三角形ごとの元（殻の番号・殻の中の番号。塞いだ三角形は -1）
  let base = 0;
  pieces.forEach((p, i) => {
    all.set(p.points, base * 3);
    for (let k = 0; k < p.tris.length; k += 3) {
      tris.push(base + p.tris[k], base + p.tris[k + 1], base + p.tris[k + 2]);
      fromPiece.push(i);
      fromTri.push(k / 3);
    }
    base += p.points.length / 3;
  });
  const { points, map } = weld(all, tol);
  let rest = [];
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [map[tris[k]], map[tris[k + 1]], map[tris[k + 2]]];
    if (a !== b && b !== c && a !== c) rest.push({ tri: [a, b, c], piece: fromPiece[k / 3], local: fromTri[k / 3] });
  }
  const n = points.length / 3;

  // 1 回目: 縫い合わせだけで閉じるもの。2 回目: 残りの平らな縁を塞いでから
  const solids = [];
  for (const cap of [false, true]) {
    const own = Int32Array.from(rest.flatMap((r) => r.tri));
    const caps = cap ? capLoops(points, boundaryLoops(own, n), tol) : [];
    const combined = new Int32Array(own.length + caps.length);
    combined.set(own);
    combined.set(caps, own.length);
    const next = [];
    for (const shell of buildShells(points, combined, tol)) {
      const items = Array.from(shell.source, (t, i) => ({ tri: [shell.tris[3 * i], shell.tris[3 * i + 1], shell.tris[3 * i + 2]], ...(rest[t] ?? { piece: -1 }) }));
      if (!shell.closed) {
        for (const it of items) if (it.piece >= 0) next.push(it); // 立体にならなかった所の塞ぎは捨てる
        continue;
      }
      const own = items.filter((it) => it.piece >= 0), added = items.filter((it) => it.piece < 0);
      // 塞ぐ面積が元の面の面積を超えるなら、形の大半が推測になるので塞がない（表面に重ねた帯・短く太い輪など）。
      // 管の端（面積 πr² × 2 に対し元の面 2πrL）は塞ぐ
      if (added.length && triangleArea(points, added) > triangleArea(points, own)) {
        for (const it of own) next.push(it);
        continue;
      }
      const members = new Map();
      for (const it of own) {
        if (!members.has(it.piece)) members.set(it.piece, []);
        members.get(it.piece).push(it.local);
      }
      solids.push({ points, tris: Int32Array.from([...own, ...added].flatMap((it) => it.tri)), members, caps: added.length, volume: shell.volume, area: shell.area });
    }
    rest = next;
  }
  const open = [...new Set(rest.map((r) => r.piece))].sort((a, b) => a - b);
  return { solids, open };
}
