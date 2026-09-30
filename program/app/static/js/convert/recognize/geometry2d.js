// 断面（直線・円弧・円の並び）の幾何量。変換データの期待値（体積・表面積）と、形状の検証に使う。
//
// 面積と回転体積は、ループに沿った線積分（グリーンの定理）で厳密に求める。
//   面積           A = ½∮(x dy − y dx)
//   y 軸まわりの 1 次モーメント  M = ∫∫ x dA = ∮ (x²/2) dy        → 回転体の体積 V = θ·|M|（パップス＝ギュルダン）
//   側面の母線積分  S = ∫ x ds                                     → 回転面の面積 = θ·S
//
// 面取りは、縁を材料側へずらしたループ（offsetIntoMaterial）で表す。
const TAU = 2 * Math.PI;

const angleOf = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** 円弧の開始角・符号付きの回転角（反時計回りが正）・半径。 */
export function arcAngles(s) {
  const [cx, cy] = s.center;
  const a0 = Math.atan2(s.a[1] - cy, s.a[0] - cx);
  const a1 = Math.atan2(s.b[1] - cy, s.b[0] - cx);
  let d = s.ccw ? a1 - a0 : a0 - a1;
  d = ((d % TAU) + TAU) % TAU;
  return { a0, sweep: s.ccw ? d : -d, radius: Math.hypot(s.a[0] - cx, s.a[1] - cy) };
}

/** 中心から見た角度 angle が円弧の範囲に入るか。 */
function withinArc(s, angle) {
  const { a0, sweep } = arcAngles(s);
  return (((sweep > 0 ? angle - a0 : a0 - angle) % TAU) + TAU) % TAU <= Math.abs(sweep);
}

/** 1 つのループの符号付き面積・1 次モーメント（ループの向きに従う）と、周長・母線積分（常に正）。 */
export function loopIntegrals(loop) {
  let area = 0, moment = 0, perimeter = 0, lateral = 0;
  for (const s of loop) {
    if (s.type === "line") {
      const [[x0, y0], [x1, y1]] = [s.a, s.b];
      const len = Math.hypot(x1 - x0, y1 - y0);
      area += (x0 * y1 - x1 * y0) / 2;
      moment += ((y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1)) / 6;
      perimeter += len;
      lateral += (len * (x0 + x1)) / 2;
    } else if (s.type === "arc") {
      const { a0, sweep, radius: R } = arcAngles(s);
      const [cx, cy] = s.center;
      const a1 = a0 + sweep;
      const A = (p) => (R * (cx * Math.sin(p) - cy * Math.cos(p) + R * p)) / 2;
      const M = (p) => (R / 2) * (cx * cx * Math.sin(p) + 2 * cx * R * (p / 2 + Math.sin(2 * p) / 4) + R * R * (Math.sin(p) - Math.sin(p) ** 3 / 3));
      area += A(a1) - A(a0);
      moment += M(a1) - M(a0);
      perimeter += R * Math.abs(sweep);
      lateral += Math.sign(sweep) * R * (cx * sweep + R * (Math.sin(a1) - Math.sin(a0)));
    } else if (s.type === "circle") {
      const [cx] = s.center, R = s.radius;
      area += Math.PI * R * R;
      moment += Math.PI * R * R * cx;
      perimeter += TAU * R;
      lateral += TAU * R * cx;
    }
  }
  return { area, moment, perimeter, lateral };
}

/** 点から断面の部分（直線・円弧・円）までの最短距離。 */
export function distanceToSegment(p, s) {
  if (s.type === "circle") return Math.abs(Math.hypot(p[0] - s.center[0], p[1] - s.center[1]) - s.radius);
  if (s.type === "arc") {
    const { radius } = arcAngles(s);
    if (withinArc(s, angleOf(p, s.center))) return Math.abs(Math.hypot(p[0] - s.center[0], p[1] - s.center[1]) - radius);
    return Math.min(Math.hypot(p[0] - s.a[0], p[1] - s.a[1]), Math.hypot(p[0] - s.b[0], p[1] - s.b[1]));
  }
  const [[x0, y0], [x1, y1]] = [s.a, s.b];
  const [dx, dy] = [x1 - x0, y1 - y0];
  const t = Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (x0 + t * dx), p[1] - (y0 + t * dy));
}

export const distanceToLoop = (p, loop) => Math.min(...loop.map((s) => distanceToSegment(p, s)));

const CORNER_ANGLE = Math.PI / 180; // 継ぎ目で向きがこれ以上変わるなら角

/** ループの角（前後の部分の向きが変わる継ぎ目）の位置。 */
export function loopCorners(loop) {
  if (loop.length === 1 && loop[0].type === "circle") return [];
  const direction = (s, atEnd) => {
    if (s.type === "line") return Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
    return angleOf(atEnd ? s.b : s.a, s.center) + (s.ccw ? Math.PI / 2 : -Math.PI / 2);
  };
  return loop.filter((s, i) => {
    const turn = direction(loop[(i + 1) % loop.length], false) - direction(s, true);
    return Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > CORNER_ANGLE;
  }).map((s) => s.b);
}

/** 点が断面（外周の内側かつ穴の外側）に含まれるか。右向きの半直線と輪郭の交差数の偶奇で判定する。 */
export function insideSection(p, loops) {
  const y = p[1] + 1e-9 * Math.PI; // 半直線が頂点をちょうど通らないよう、わずかにずらす
  let count = 0;
  for (const loop of loops) for (const s of loop) count += crossings(p[0], y, s);
  return count % 2 === 1;
}

function crossings(x, y, s) {
  if (s.type === "line") {
    const [[x0, y0], [x1, y1]] = [s.a, s.b];
    if (y0 > y === y1 > y) return 0;
    return x0 + ((y - y0) * (x1 - x0)) / (y1 - y0) > x ? 1 : 0;
  }
  const [cx, cy] = s.center;
  const R = s.type === "circle" ? s.radius : arcAngles(s).radius;
  const dy = y - cy;
  if (Math.abs(dy) >= R) return 0;
  const dx = Math.sqrt(R * R - dy * dy);
  return [cx - dx, cx + dx].filter((px) => px > x && (s.type === "circle" || withinArc(s, angleOf([px, y], s.center)))).length;
}

// ---- 面取り: 縁を材料側へずらしたループ --------------------------------------------------
//
// 等距離 d の面取りをした端面の輪郭は、元の縁を材料側へ d だけずらした線になる。
// 直線は平行に、円弧は同心のまま半径を変えてずらし、隣どうしは延長・切り詰めて交点で継ぐ（角は尖ったまま＝留め継ぎ）。
// 接線がつながっている継ぎ目は、ずらした後もつながる。ずらす量が大きいと短い部分は長さ 0 になって消え、
// その先は両隣を直接継ぐ。消えた距離を「事象」として返す（面積はその前後で別の式になるため、積分の区切りに使う）。
// 前提: 面取りは形状の幅より十分小さい（離れた部分どうしがぶつかる場合は扱わない）。

const EPS = 1e-12;
const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;

/** 進行方向の単位ベクトル（atEnd なら終点、そうでなければ始点での向き）。 */
function tangent(s, atEnd) {
  if (s.type === "line") {
    const d = [s.b[0] - s.a[0], s.b[1] - s.a[1]], len = Math.hypot(d[0], d[1]);
    return [d[0] / len, d[1] / len];
  }
  const p = atEnd ? s.b : s.a;
  const r = [p[0] - s.center[0], p[1] - s.center[1]], len = Math.hypot(r[0], r[1]);
  return s.ccw ? [-r[1] / len, r[0] / len] : [r[1] / len, -r[0] / len];
}

/** 進行方向の左へ dist ずらした部分を含む直線・円。反時計回りの円弧の左は中心側。 */
function carrier(s, dist) {
  if (s.type === "line") {
    const t = tangent(s, false);
    return { type: "line", p: [s.a[0] - t[1] * dist, s.a[1] + t[0] * dist], t };
  }
  const R = arcAngles(s).radius;
  return { type: "circle", c: s.center, r: s.ccw ? R - dist : R + dist };
}

/** 直線・円どうしの交点。接する（判別式がわずかに負）場合は接点を返す。 */
function intersections(A, B) {
  if (A.type === "circle" && B.type === "line") return intersections(B, A);
  if (A.type === "line" && B.type === "line") {
    const den = A.t[0] * B.t[1] - A.t[1] * B.t[0];
    if (Math.abs(den) < EPS) return [];
    const u = ((B.p[0] - A.p[0]) * B.t[1] - (B.p[1] - A.p[1]) * B.t[0]) / den;
    return [[A.p[0] + u * A.t[0], A.p[1] + u * A.t[1]]];
  }
  if (A.type === "line") {
    const f = [A.p[0] - B.c[0], A.p[1] - B.c[1]];
    const b = f[0] * A.t[0] + f[1] * A.t[1];
    const disc = b * b - (f[0] * f[0] + f[1] * f[1] - B.r * B.r);
    if (disc < -1e-9 * B.r * B.r) return [];
    const q = Math.sqrt(Math.max(disc, 0));
    return [-b - q, -b + q].map((u) => [A.p[0] + u * A.t[0], A.p[1] + u * A.t[1]]);
  }
  const d = [B.c[0] - A.c[0], B.c[1] - A.c[1]], D = Math.hypot(d[0], d[1]);
  if (D < EPS) return [];
  const x = (D * D + A.r * A.r - B.r * B.r) / (2 * D), h2 = A.r * A.r - x * x;
  if (h2 < -1e-9 * A.r * A.r) return [];
  const h = Math.sqrt(Math.max(h2, 0)), e = [d[0] / D, d[1] / D], m = [A.c[0] + x * e[0], A.c[1] + x * e[1]];
  return [[m[0] - h * e[1], m[1] + h * e[0]], [m[0] + h * e[1], m[1] - h * e[0]]];
}

/**
 * 左へ dist ずらしたループ（材料が進行方向の左にある向きで渡す）。
 * @returns {{ loop: object[], events: number[] } | null}
 */
function offsetLeft(loop, dist) {
  const n = loop.length;
  // 部分 i の終わりと部分 k の始まりの継ぎ目（ずらした後）
  const junction = (i, k, at) => {
    const s = loop[i], t = loop[k];
    if (k === (i + 1) % n) {
      const ta = tangent(s, true), tb = tangent(t, false);
      if (Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) < 1e-9 && ta[0] * tb[0] + ta[1] * tb[1] > 0) return [s.b[0] - ta[1] * at, s.b[1] + ta[0] * at];
    }
    const A = carrier(s, at), B = carrier(t, at);
    if (A.r <= 0 || B.r <= 0) return null;
    const ref = [(s.b[0] + t.a[0]) / 2, (s.b[1] + t.a[1]) / 2];
    const candidates = intersections(A, B);
    return candidates.length ? candidates.reduce((best, p) => (dist2(p, ref) < dist2(best, ref) ? p : best)) : null;
  };
  // 継ぎ目 j0 → j1 の間に残る部分の長さ（向きが逆転していれば負）
  const extent = (i, j0, j1, at) => {
    const s = loop[i], C = carrier(s, at);
    if (s.type === "line") return (j1[0] - j0[0]) * C.t[0] + (j1[1] - j0[1]) * C.t[1];
    if (C.r <= 0) return -1;
    const { a0, sweep } = arcAngles(s);
    const d0 = wrapPi(angleOf(j0, s.center) - a0), d1 = wrapPi(angleOf(j1, s.center) - (a0 + sweep));
    return Math.sign(sweep) * (sweep + d1 - d0) * C.r;
  };
  const lengthAt = (alive, q, at) => {
    const m = alive.length, i = alive[q];
    const j0 = junction(alive[(q - 1 + m) % m], i, at), j1 = junction(i, alive[(q + 1) % m], at);
    return j0 && j1 ? extent(i, j0, j1, at) : -1;
  };

  let alive = loop.map((_, i) => i);
  const events = [];
  for (;;) {
    const m = alive.length;
    if (m < 2) return null;
    const joints = alive.map((i, q) => junction(i, alive[(q + 1) % m], dist));
    if (joints.some((p) => !p)) return null;
    const gone = alive.map((i, q) => q).filter((q) => extent(alive[q], joints[(q - 1 + m) % m], joints[q], dist) <= 0);
    if (!gone.length) {
      const out = alive.map((i, q) => {
        const s = loop[i], a = joints[(q - 1 + m) % m], b = joints[q];
        return s.type === "line" ? { type: "line", a, b } : { type: "arc", a, b, center: s.center, ccw: s.ccw };
      });
      return { loop: out, events };
    }
    // 最も早く消える部分を二分法で探して取り除く
    const from = events.at(-1) ?? 0;
    let first = null;
    for (const q of gone) {
      let lo = from, hi = dist;
      if (lengthAt(alive, q, lo) <= 0) hi = lo;
      else for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (lengthAt(alive, q, mid) > 0) lo = mid;
        else hi = mid;
      }
      if (!first || hi < first.at) first = { q, at: hi };
    }
    alive = alive.filter((_, q) => q !== first.q);
    events.push(first.at);
  }
}

/** ループを逆向きにする。 */
export const reverseLoop = (loop) =>
  [...loop].reverse().map((s) => (s.type === "circle" ? s : { ...s, a: s.b, b: s.a, ...(s.type === "arc" && { ccw: !s.ccw }) }));

/**
 * 断面のループを材料側へ dist だけずらす（面取り後の端面の輪郭）。外周なら内側、穴なら外側が材料。
 * @returns {{ loop: object[], events: number[] } | null} events は途中で消えた部分の距離（昇順）。形が崩れるなら null
 */
export function offsetIntoMaterial(loop, dist, isHole) {
  if (loop.length === 1 && loop[0].type === "circle") {
    const radius = loop[0].radius + (isHole ? dist : -dist);
    return radius > 0 ? { loop: [{ ...loop[0], radius }], events: [] } : null;
  }
  const ccw = loopIntegrals(loop).area > 0;
  return offsetLeft(ccw !== isHole ? loop : reverseLoop(loop), dist);
}

// 8 点のガウス＝ルジャンドル則（区間内で滑らかな関数なら、ほぼ丸め誤差の精度で積分できる）
const GAUSS8 = [
  [0.1834346424956498, 0.362683783378362], [0.525532409916329, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745], [0.9602898564975363, 0.1012285362903763],
];
function integrate(f, a, b) {
  const [mid, half] = [(a + b) / 2, (b - a) / 2];
  return half * GAUSS8.reduce((s, [x, w]) => s + w * (f(mid - half * x) + f(mid + half * x)), 0);
}

/**
 * 等距離 d の面取りで、ループの縁から削られる量。
 *   volume … 削られる体積 = ∫₀ᵈ (ずらし量 s で削られる端面の面積) ds
 *   face   … 端面から削られる面積（= 面取り面を端面に投影した面積。面取り面は 45° なので、その面積は √2 倍）
 *   loop   … 面取り後の端面の輪郭
 * 削られる面積は、部分が消える距離（事象）の間では滑らかなので、事象で区切って積分する。
 * @returns {{ volume: number, face: number, loop: object[] } | null}
 */
export function chamferIntegrals(loop, d, isHole) {
  const full = offsetIntoMaterial(loop, d, isHole);
  if (!full) return null;
  const area = (l) => Math.abs(loopIntegrals(l).area);
  const base = area(loop);
  const removed = (s) => {
    const shifted = area(offsetIntoMaterial(loop, s, isHole).loop);
    return isHole ? shifted - base : base - shifted;
  };
  const cuts = [0, ...full.events, d];
  let volume = 0;
  for (let i = 0; i + 1 < cuts.length; i++) volume += integrate(removed, cuts[i], cuts[i + 1]);
  return { volume, face: removed(d), loop: full.loop };
}

// ---- 断面の自己交差 --------------------------------------------------------------------

/** 2 本の線分の交点（端点を除く内側で交わるときだけ） */
function crossPoint(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < EPS) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : null;
}

export const KINK_SPAN = 4; // 取り除く小さな輪: 交わる 2 本の直線の間にある部分の数の上限

/**
 * 断面の小さな自己交差（2〜4 本先の直線どうしが交わってできる蝶ネクタイ形の輪。元のメッシュの折れ）を取り除く。
 * 交わる 2 本を交点で継ぎ、間の部分を捨てる。
 * @returns {{ loop: object[], removed: number, deviation: number }}  deviation: 捨てた頂点と、継いだ 2 本との距離の最大（元の形との差）
 */
export function untangleLoop(loop) {
  let out = loop, removed = 0, deviation = 0;
  for (let changed = true; changed;) {
    changed = false;
    search: for (let i = 0; i < out.length; i++) {
      if (out[i].type !== "line") continue;
      for (let k = 2; k <= KINK_SPAN && k < out.length - 1; k++) {
        const j = (i + k) % out.length;
        if (out[j].type !== "line") continue;
        const x = crossPoint(out[i].a, out[i].b, out[j].a, out[j].b);
        if (!x) continue;
        const rotated = [...out.slice(i), ...out.slice(0, i)]; // i を先頭に
        const kept = [{ type: "line", a: rotated[0].a, b: x }, { type: "line", a: x, b: rotated[k].b }];
        for (const s of rotated.slice(1, k)) for (const p of [s.a, s.b]) deviation = Math.max(deviation, Math.min(...kept.map((t) => distanceToSegment(p, t))));
        out = [...kept, ...rotated.slice(k + 1)];
        removed += 1;
        changed = true;
        break search;
      }
    }
  }
  return { loop: out, removed, deviation };
}

/** 断面（複数のループ）が自分と交わるか（円弧は折れ線にして調べる）。交わる所の数 */
export function selfCrossings(loops) {
  const edges = [];
  loops.forEach((loop, li) => loop.forEach((s, si) => {
    const pts = s.type === "line" ? [s.a, s.b] : sampleSegment(s, 16);
    for (let k = 0; k + 1 < pts.length; k++) edges.push({ a: pts[k], b: pts[k + 1], li, si, n: loop.length });
  }));
  // 格子（辺の長さの中央値の 2 倍）で近い辺だけを調べる
  const lengths = edges.map((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])).sort((x, y) => x - y);
  const size = Math.max(2 * lengths[lengths.length >> 1], 1e-9);
  const cells = new Map();
  edges.forEach((e, idx) => {
    for (let x = Math.floor(Math.min(e.a[0], e.b[0]) / size); x <= Math.floor(Math.max(e.a[0], e.b[0]) / size); x++) {
      for (let y = Math.floor(Math.min(e.a[1], e.b[1]) / size); y <= Math.floor(Math.max(e.a[1], e.b[1]) / size); y++) {
        const key = `${x},${y}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(idx);
      }
    }
  });
  const seen = new Set();
  for (const list of cells.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const [A, B] = [edges[list[p]], edges[list[q]]];
        const near = A.li === B.li && [0, 1, A.n - 1].includes((((A.si - B.si) % A.n) + A.n) % A.n); // 同じ部分・隣の部分は継ぎ目で接するだけ
        if (near) continue;
        const x = crossPoint(A.a, A.b, B.a, B.b);
        if (x) seen.add(x.map((v) => v.toFixed(6)).join(","));
      }
    }
  }
  return seen.size;
}

/** 円・円弧を n 等分した点（端を含む） */
function sampleSegment(s, n) {
  if (s.type === "circle") return Array.from({ length: n + 1 }, (_, k) => [s.center[0] + s.radius * Math.cos((TAU * k) / n), s.center[1] + s.radius * Math.sin((TAU * k) / n)]);
  const { a0, sweep, radius } = arcAngles(s);
  return Array.from({ length: n + 1 }, (_, k) => [s.center[0] + radius * Math.cos(a0 + (sweep * k) / n), s.center[1] + radius * Math.sin(a0 + (sweep * k) / n)]);
}
