// シーン JSON の面を three.js の BufferGeometry に三角形分割する。
// 面の種類ごとに mesher を用意し、未対応の種類は null を返す（ビューアは稜線だけを描く）。
//
// どの面も境界ループ（隣の面と共有する稜線の点列）に沿って分割する。境界上に新しい点を足さないので、
// 面どうしは隙間なくつながる。円筒・円錐は展開図（角度 θ × 高さ h）の上で分割し、内側だけを細かくしてから曲面に戻す。

import * as THREE from "three";

const ARC_STEP = Math.PI / 32; // 曲面の分割の細かさ（稜線の円弧のサンプリングと同じ刻み）
const TUBE_STEP = Math.PI / 8; // トーラスの管のまわり（φ）の刻み。弦の誤差は管の半径の 1.9%（首下の R など小さい丸みが多い）
export const STEPS = { arc: ARC_STEP, tube: TUBE_STEP }; // 評価（弦の誤差の見積もり）用
const TAU = 2 * Math.PI;
const APEX_EPS = 1e-6; // 円錐の先端とみなす軸からの距離（mm）
const SAME_POINT = 1e-9; // 同じ点とみなす距離（mm）
const KEY = 2 ** 21; // 辺の番号 = 始点 × KEY + 終点（頂点の数は KEY 未満）
const REFINE_BUDGET = 200_000; // 1 面の細分で持てる点の数の上限（想定外の形で分割が止まらなくなるのを防ぐ安全弁）
const edgeKey = (i, j) => i * KEY + j;
const undirected = (i, j) => (i < j ? edgeKey(i, j) : edgeKey(j, i));
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const wrapAngle = (a) => a - TAU * Math.round(a / TAU); // (-π, π] 付近に戻す

/** 末尾が先頭と同じ点なら取り除き、開いた点列にする。 */
function openLoop(loop) {
  const points = loop.map(v3);
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < SAME_POINT) points.pop();
  return points;
}

/** 行って戻るだけの辺（円錐の継ぎ目の母線のように、面の内側を通る辺）と、続けて現れる同じ点を取り除く。 */
function withoutSpikes(points) {
  const out = [...points];
  for (let i = 0; out.length >= 3 && i < out.length; ) {
    const prev = out[(i + out.length - 1) % out.length], next = out[(i + 1) % out.length];
    if (out[i].distanceTo(next) < SAME_POINT || prev.distanceTo(next) < SAME_POINT) {
      out.splice(i, 1);
      i = Math.max(i - 1, 0); // 取り除いた点の前後が新たに隣り合うので、1 つ戻って見直す
    } else i++;
  }
  return out;
}

/**
 * earcut（THREE.ShapeUtils.triangulateShape）で多角形を三角形に分ける。earcut は耳（切り取れる角）が見つからなくなると
 * 一直線に並ぶ境界の点を省いてやり直す（内部の点（点 1 つの穴）を加えたときに起きる）。省かれた点は、
 * その点を通る境界の辺を持つ三角形に扇形に分け入れて戻す
 * （戻さないと、隣の面と共有する稜線の点が抜けて隙間になり、細分では面積 0 の三角形が分け続けられる）。
 * @param {THREE.Vector2[][]} rings  外周と穴（点 1 つの穴は内部の点）。返す番号はこれらを連結した並び
 * @returns {number[][]}
 */
function triangulate(rings) {
  const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
  const used = new Set(triangles.flat());
  /** 境界の辺 a → b の途中に run の点を戻す */
  const restore = (a, b, run) => {
    const t = triangles.findIndex((tri) => tri.includes(a) && tri.includes(b));
    if (t < 0) return;
    const tri = triangles[t], c = tri.find((v) => v !== a && v !== b);
    const forward = tri[(tri.indexOf(a) + 1) % 3] === b; // 元の三角形の向き（a → b → c）を保つ
    const chain = [a, ...run, b];
    const fan = chain.slice(1).map((v, i) => (forward ? [chain[i], v, c] : [v, chain[i], c]));
    triangles.splice(t, 1, ...fan);
  };
  let base = 0;
  for (const ring of rings) {
    const n = ring.length;
    const first = ring.findIndex((_, i) => used.has(base + i));
    if (first >= 0) {
      let a = first, run = [];
      for (let s = 1; s <= n; s++) {
        const i = (first + s) % n;
        if (!used.has(base + i)) {
          if (ring[i].distanceTo(ring[a]) > 0) run.push(base + i); // 重なる点は戻さない（面積 0 の三角形になる）
          continue;
        }
        if (run.length) restore(base + a, base + i, run);
        [a, run] = [i, []];
      }
    }
    base += n;
  }
  return triangles;
}

function plane(face) {
  const n = v3(face.normal).normalize();
  const helper = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const loops = face.loops.map(openLoop).filter((l) => l.length >= 3);
  if (!loops.length) return null;
  const flat = loops.map((l) => l.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
  // 面積が最大のループを外周、それ以外を穴として扱う
  const area = (l) => Math.abs(THREE.ShapeUtils.area(l));
  const outer = flat.reduce((best, l, i) => (area(l) > area(flat[best]) ? i : best), 0);
  const order = [outer, ...flat.keys()].filter((i, k) => k === 0 || i !== outer);
  const triangles = triangulate(order.map((i) => flat[i]));
  const points = order.flatMap((i) => loops[i]);
  return { points, normals: points.map(() => n), index: triangles.flat() };
}

// ---- 回転面（円筒・円錐・トーラス）---------------------------------------------
// 展開図の座標は (θ, h)。θ は軸まわりの角度。h は円筒・円錐では軸方向の高さ、トーラスでは管のまわりの角度 φ。
//   periodicH … h も角度で、2π ごとに同じ点になる（トーラス）
//   hStep     … h の向きの細分の刻み。円筒・円錐は母線が直線なので細分しない（Infinity）。トーラスは TUBE_STEP

/** 軸まわりの座標系（軸・角度の基準・その直交方向）と、角度 θ の半径方向 */
function axisFrame(face) {
  const origin = v3(face.origin), axis = v3(face.axis).normalize(), ref = v3(face.ref).normalize();
  const side = new THREE.Vector3().crossVectors(axis, ref);
  const direction = (t) => ref.clone().multiplyScalar(Math.cos(t)).addScaledVector(side, Math.sin(t));
  const polar = (p) => {
    const d = p.clone().sub(origin);
    const x = d.dot(ref), y = d.dot(side);
    return { t: Math.atan2(y, x), z: d.dot(axis), rho: Math.hypot(x, y) };
  };
  return { origin, axis, direction, polar, sign: face.outward ? 1 : -1 };
}

/** 円筒・円錐: ρ(h) = radius + slope・h */
function revolvedFrame(face) {
  const { origin, axis, direction, polar, sign } = axisFrame(face);
  const slope = face.slope ?? 0;
  const point = (t, h) => origin.clone().addScaledVector(axis, h).addScaledVector(direction(t), face.radius + slope * h);
  return {
    apex: slope ? -face.radius / slope : null, // 半径が 0 になる高さ（円錐の先端）
    toUV(p) {
      const { t, z, rho } = polar(p);
      return { t, h: z, rho };
    },
    point,
    // 曲面の法線は (半径方向 − slope・軸) の向き。凹面なら反転する
    normal: (t, h) => direction(t).addScaledVector(axis, -slope).normalize().multiplyScalar(sign),
    // 先端の法線は θ で決まらないので、θ について平均した向き（軸方向の成分だけ）にする
    tipNormal: axis.clone().multiplyScalar(-Math.sign(slope) * sign),
    // 軸に垂直な平面への正射影 (x, y) = ρ(cos θ, sin θ) から曲面の点に戻す（円錐の先端を含む面の分割に使う）
    lift(x, y) {
      const rho = Math.hypot(x, y), t = Math.atan2(y, x), h = (rho - face.radius) / slope;
      return { p: point(t, h), t, h, x, y, rho };
    },
  };
}

/** トーラス: 点 = origin + (radius + minor・cos φ)・半径方向(θ) + minor・sin φ・軸 */
function torusFrame(face) {
  const { origin, axis, direction, polar, sign } = axisFrame(face);
  const [R, r] = [face.radius, face.minor];
  return {
    apex: null,
    periodicH: true,
    hStep: TUBE_STEP,
    toUV(p) {
      const { t, z, rho } = polar(p);
      return { t, h: Math.atan2(z, rho - R), rho };
    },
    point: (t, h) => origin.clone().addScaledVector(direction(t), R + r * Math.cos(h)).addScaledVector(axis, r * Math.sin(h)),
    normal: (t, h) => direction(t).multiplyScalar(Math.cos(h)).addScaledVector(axis, Math.sin(h)).normalize().multiplyScalar(sign),
    arc: [R, r], // 展開図の尺度（θ・φ → 弧長）
  };
}

/**
 * ループを展開図の点列にする。θ は連続になるよう巻き戻さずにたどる。
 * winding … 軸のまわりを何周するか（0: 面の中で閉じたループ、±1: 軸を 1 周するループ）
 * throughApex … 円錐の先端を通る（先端は θ が定まらないので点列から除き、面は apexCone で分割する）
 */
function unwrapLoop(loop, frame) {
  const raw = openLoop(loop).map((p) => ({ p, ...frame.toUV(p) }));
  const verts = raw.filter((v) => v.rho >= APEX_EPS);
  if (verts.length < 2) return null;
  let t = verts[0].t;
  for (const v of verts) v.t = t += wrapAngle(v.t - t);
  if (frame.periodicH) {
    let h = verts[0].h;
    for (const v of verts) v.h = h += wrapAngle(v.h - h);
  }
  const turn = verts.at(-1).t - verts[0].t + wrapAngle(verts[0].t - verts.at(-1).t);
  return { verts, winding: Math.round(turn / TAU), throughApex: verts.length < raw.length };
}

const shifted = (verts, dt) => verts.map((v) => ({ ...v, t: v.t + dt }));
const meanT = (verts) => verts.reduce((s, v) => s + v.t, 0) / verts.length;

/** 軸を 1 周するループを、start 番目の点から 1 周分（θ が増える向き、末尾は先頭と同じ位置で θ + 2π）に並べ直す。 */
function openAround({ verts, winding }, start) {
  const n = verts.length;
  let seq = Array.from({ length: n + 1 }, (_, j) => {
    const v = verts[(start + j) % n];
    return { ...v, t: v.t + (start + j >= n ? TAU * winding : 0) };
  });
  if (winding < 0) seq = shifted(seq.reverse(), TAU);
  return seq;
}

/**
 * 継ぎ目を置く角度。穴（面の中で閉じたループ）の角度の範囲と、軸を 1 周するループのうち母線に沿う辺（θ が一定の辺）を避け、
 * 最も広い隙間の中央に置く（母線に沿う辺に重ねると、切り開いた多角形がその辺を往復して潰れる）。
 */
function seamAngle(around, holes, fallback) {
  const ranges = holes.map(({ verts }) => verts.map((v) => v.t));
  for (const { verts } of around) {
    verts.forEach((v, i) => {
      const w = verts[(i + 1) % verts.length];
      if (Math.abs(wrapAngle(w.t - v.t)) < 1e-9 && w.p.distanceTo(v.p) > 0) ranges.push([v.t - 1e-6, v.t + 1e-6]);
    });
  }
  const spans = ranges.map((ts) => {
    const lo = Math.min(...ts), hi = Math.max(...ts);
    const start = ((lo % TAU) + TAU) % TAU;
    return [start, start + (hi - lo)];
  }).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return fallback;
  const wrapped = Math.max(...spans.map((s) => s[1])) - TAU; // 2π を越えて先頭側まで覆う分
  let best = { size: -1, at: fallback };
  spans.forEach(([, end], i) => {
    const next = i + 1 < spans.length ? spans[i + 1][0] : spans[0][0] + TAU;
    const reach = Math.max(end, wrapped, ...spans.slice(0, i).map((s) => s[1])); // 手前の区間がさらに先まで覆う場合
    if (next - reach > best.size) best = { size: next - reach, at: (reach + next) / 2 };
  });
  return best.at;
}

/** θ が target に最も近い点の番号（2π の差は同一視）。 */
const nearest = (verts, target) => verts.reduce((best, v, i) => (Math.abs(wrapAngle(v.t - target)) < Math.abs(wrapAngle(verts[best].t - target)) ? i : best), 0);

/**
 * 展開図の上で、外周（1 本の閉じた多角形）と穴に整理する。
 * 軸を 1 周するループが 2 本（筒状の面）なら継ぎ目で切り開いて 1 本の多角形にする
 * （1 本だけなのは円錐の先端を含む面で、apexCone が扱う）。
 * @returns {{ outer: object[], holes: object[][], cuts: number[] } | null}  cuts … 外周のうち稜線ではない辺（i → i + 1）
 */
function layout(loops, frame) {
  const around = loops.filter((l) => l.winding !== 0);
  const inside = loops.filter((l) => l.winding === 0);
  if (!around.length) {
    // 面の中で閉じたループだけ（部分円筒など）。展開図の面積が最大のものが外周
    const area = (l) => Math.abs(THREE.ShapeUtils.area(l.verts.map((v) => new THREE.Vector2(v.t, v.h))));
    const outer = inside.reduce((a, b) => (area(b) > area(a) ? b : a));
    const center = meanT(outer.verts);
    const holes = inside.filter((l) => l !== outer).map((l) => shifted(l.verts, TAU * Math.round((center - meanT(l.verts)) / TAU)));
    return { outer: outer.verts, holes, cuts: [] };
  }
  if (around.length !== 2) return null;
  const seam = seamAngle(around, inside, around[0].verts[0].t);
  const first = openAround(around[0], nearest(around[0].verts, seam));
  const start = shifted(first, TAU * Math.round((seam - first[0].t) / TAU)); // 継ぎ目の近くから 1 周（θ0 → θ0 + 2π）
  const t0 = start[0].t;
  const second = openAround(around[1], nearest(around[1].verts, t0));
  const back = shifted(second, TAU * Math.round((t0 - second[0].t) / TAU)).reverse(); // θ0 + 2π → θ0 の向きに戻る
  const holes = inside.map((l) => shifted(l.verts, TAU * Math.ceil((t0 - meanT(l.verts)) / TAU))); // θ0 〜 θ0 + 2π の中へ
  // 継ぎ目（外周の 1 周目の末尾 → 戻りの先頭、戻りの末尾 → 先頭）は稜線ではない。分割してよい
  return { outer: [...start, ...back], holes, cuts: [start.length - 1, start.length + back.length - 1] };
}

/**
 * earcut の結果（面積は正しいが、細長い三角形や面積 0 の三角形を含む）を、境界の辺を保ったまま
 * 辺の入れ替え（Lawson の方法）で制約付き Delaunay 三角形分割にする。
 * 円は展開図で一直線に並ぶので、そのままだと一直線上の点どうしを結ぶ三角形ができ、細分の結果が乱れる。
 * @param {THREE.Vector2[]} uv  展開図の座標（縦横の尺度をそろえたもの）
 */
function delaunay(uv, triangles, fixedEdge) {
  const orient = (a, b, c) => (uv[b].x - uv[a].x) * (uv[c].y - uv[a].y) - (uv[b].y - uv[a].y) * (uv[c].x - uv[a].x);
  const size2 = (a, b) => uv[a].distanceToSquared(uv[b]);
  const flat = (a, b, c) => Math.abs(orient(a, b, c)) <= 1e-12 * Math.max(size2(a, b), size2(b, c), size2(c, a));
  /** d が反時計回りの三角形 abc の外接円の内側にあれば正 */
  const inCircle = (a, b, c, d) => {
    const [ax, ay, bx, by, cx, cy] = [a, b, c].flatMap((v) => [uv[v].x - uv[d].x, uv[v].y - uv[d].y]);
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
    const scale = Math.max(size2(a, d), size2(b, d), size2(c, d));
    return det > 1e-9 * scale * scale;
  };
  const tris = triangles.map(([a, b, c]) => (orient(a, b, c) < 0 ? [a, c, b] : [a, b, c]));
  const owner = new Map(); // 向きのある辺 → その辺を持つ三角形
  const own = (t) => {
    const [a, b, c] = tris[t];
    owner.set(edgeKey(a, b), t).set(edgeKey(b, c), t).set(edgeKey(c, a), t);
  };
  tris.forEach((_, t) => own(t));
  const stack = [...owner.keys()];
  for (let guard = 4 * tris.length * tris.length + 1000; stack.length && guard > 0; guard--) { // 収束までの入れ替えは最悪で三角形数の 2 乗
    const key = stack.pop();
    const t1 = owner.get(key);
    const i = Math.floor(key / KEY), j = key % KEY;
    const t2 = owner.get(edgeKey(j, i));
    if (t1 === undefined || t2 === undefined || fixedEdge(i, j)) continue;
    const k = tris[t1].find((v) => v !== i && v !== j), l = tris[t2].find((v) => v !== i && v !== j);
    // 四角形 i, l, j, k の対角線を i–j から k–l に替える。替えた後の 2 つの三角形が裏返らないことが条件
    if (orient(i, l, k) <= 0 || orient(l, j, k) <= 0 || flat(i, l, k) || flat(l, j, k)) continue;
    if (!(flat(i, j, k) || flat(j, i, l) || inCircle(i, j, k, l))) continue;
    owner.delete(key);
    owner.delete(edgeKey(j, i));
    tris[t1] = [i, l, k];
    tris[t2] = [l, j, k];
    own(t1);
    own(t2);
    stack.push(edgeKey(i, l), edgeKey(l, j), edgeKey(j, k), edgeKey(k, i));
  }
  return tris;
}

/**
 * 三角形の辺を、チャートの幅（chart.width、1 が細分の刻み）が 1 以下になるまで二等分する。
 * 境界の辺（稜線）は分けない（隣の面と点をそろえるため）。
 * 境界の辺がそれより広い三角形は、残りの 2 辺の目安を「境界の辺の幅の 3/4」に緩める
 * （三角形の不等式から、残りの 2 辺の幅の和は境界の辺以上なので、目安を下げないと分割が終わらない）。
 * 目安は辺ごとに記録し、辺の両側の三角形で同じ目安を使う（片側だけ厳しいと、その側が分けた辺を
 * もう片側が分け直すたびに境界の辺を含む三角形が生まれ直し、分割が終わらない）。
 * 分けた辺（中点のある辺）は、反対側の三角形も同じ中点で分ける（分けないと辺の途中に点が浮き、隙間になる）。
 * 先に出力した三角形も、後から中点ができれば分け直す。
 * 分けるべき辺（中点のある辺・目安を超える辺）を持つ三角形は、境界の辺以外で最も幅の広い辺で分ける（最長辺の二等分）。
 * 分けるべき辺そのものを分けると、長い辺を残したまま、3 つ目の点が同じ位置に近づき続けて終わらないことがある。
 * 点の数が REFINE_BUDGET に達したら、中点のある辺だけを分ける。これは新しい中点を作らないので、
 * そこで必ず終わり、隙間も残らない。
 */
function refine(verts, triangles, fixedEdge, chart) {
  const width = (i, j) => chart.width(verts[i], verts[j]);
  const edges = (tri) => [0, 1, 2].map((e) => [tri[e], tri[(e + 1) % 3]]);
  const relaxed = new Map(); // 辺 → 緩めた目安
  const register = (tri) => {
    const limit = Math.max(0, ...edges(tri).filter(([i, j]) => fixedEdge(i, j)).map(([i, j]) => 0.75 * width(i, j)));
    if (limit <= 1) return;
    for (const [i, j] of edges(tri)) {
      const key = undirected(i, j);
      if (!fixedEdge(i, j)) relaxed.set(key, Math.max(relaxed.get(key) ?? 0, limit));
    }
  };
  const excess = (i, j) => (fixedEdge(i, j) ? 0 : width(i, j) / Math.max(1, relaxed.get(undirected(i, j)) ?? 0));
  const midpoints = new Map();
  const midpoint = (i, j) => {
    const key = undirected(i, j);
    if (!midpoints.has(key)) midpoints.set(key, verts.push(chart.midpoint(verts[i], verts[j])) - 1);
    return midpoints.get(key);
  };
  const hasMidpoint = (tri) => edges(tri).some(([i, j]) => midpoints.has(undirected(i, j)));
  triangles.forEach(register);
  let out = [], stack = [...triangles];
  while (stack.length) {
    while (stack.length) {
      const tri = stack.pop();
      const open = verts.length < REFINE_BUDGET;
      const due = ([i, j]) => midpoints.has(undirected(i, j)) || (open && excess(i, j) > 1);
      let split = -1, widest = -1;
      if (edges(tri).some(due)) {
        edges(tri).forEach(([i, j], e) => {
          if (fixedEdge(i, j) || !(open || midpoints.has(undirected(i, j)))) return;
          const w = width(i, j);
          if (w > widest) [split, widest] = [e, w];
        });
      }
      if (split < 0) {
        out.push(tri);
        continue;
      }
      const [i, j, k] = [tri[split], tri[(split + 1) % 3], tri[(split + 2) % 3]];
      const m = midpoint(i, j);
      const halves = [[i, m, k], [m, j, k]];
      halves.forEach(register);
      stack.push(...halves);
    }
    stack = out.filter(hasMidpoint);
    if (stack.length) out = out.filter((tri) => !hasMidpoint(tri));
  }
  return out;
}

/**
 * 平面に写した多角形（外周 + 穴）を三角形分割し、曲面に沿うまで細分する（回転面の分割の共通部分）。
 * @param {object[][]} rings  点の列（先頭が外周）
 * @param {number[]} cuts     外周のうち稜線ではない辺（i → i + 1）。細分してよい
 * @param {object[]} inner    内部に加える点（円錐の先端）
 * @param {{ uv(v): THREE.Vector2, width(a, b): number, midpoint(a, b): object }} chart
 *   uv … 分割する平面の座標、width … 辺の幅（細分の刻みを 1 とする）、midpoint … 辺の中点（曲面の上の点）
 */
function meshChart(rings, cuts, inner, chart) {
  const verts = [...rings.flat(), ...inner];
  const fixed = new Set();
  let base = 0;
  rings.forEach((ring, r) => {
    ring.forEach((_, i) => {
      if (r === 0 && cuts.includes(i)) return;
      fixed.add(undirected(base + i, base + ((i + 1) % ring.length)));
    });
    base += ring.length;
  });
  const isFixed = (i, j) => fixed.has(undirected(i, j));
  // 点 1 つの穴は earcut で内部の点（Steiner 点）になる。番号は verts と同じ並び
  const shape = triangulate([...rings, ...inner.map((v) => [v])].map((ring) => ring.map(chart.uv)));
  const triangles = delaunay(verts.map(chart.uv), shape, isFixed);
  return { verts, triangles: refine(verts, triangles, isFixed, chart) };
}

function revolved(face) {
  const frame = face.type === "torus" ? torusFrame(face) : revolvedFrame(face);
  const loops = face.loops.map((l) => unwrapLoop(l, frame)).filter(Boolean);
  if (!loops.length) return null;
  if (frame.apex !== null && (loops.some((l) => l.throughApex) || loops.filter((l) => l.winding !== 0).length === 1)) return apexCone(face, frame);
  if (frame.periodicH) {
    // h も角度のときは、全てのループを最初のループと同じ 1 周の範囲にそろえる
    const meanH = (l) => l.verts.reduce((s, v) => s + v.h, 0) / l.verts.length;
    const h0 = meanH(loops[0]);
    for (const l of loops) {
      const dh = TAU * Math.round((h0 - meanH(l)) / TAU);
      if (dh) l.verts = l.verts.map((v) => ({ ...v, h: v.h + dh }));
    }
  }
  const plan = layout(loops, frame);
  if (!plan) return null;
  const rings = [plan.outer, ...plan.holes];
  // 展開図の尺度。円筒・円錐は母線（h の向き）に沿って真っすぐなので、誤差は θ の幅だけで決まる。
  // h を縮めて（面の高さ全体を 1 刻み分の弧長にして）から Delaunay 分割すると、θ の幅の小さい辺が選ばれ、
  // 上下の境界をジグザグに結ぶ細分のいらない分割になる（拡大縮小では三角形の表裏は変わらない）
  const all = rings.flat();
  const radius = all.reduce((s, v) => s + v.rho, 0) / all.length || 1;
  const hs = all.map((v) => v.h);
  // トーラスは h（φ）の向きにも曲がっているので、縮めずに弧長でそろえる
  const squash = frame.arc ? frame.arc[1] : Math.min(1, (ARC_STEP * radius) / Math.max(Math.max(...hs) - Math.min(...hs), 1e-9));
  const hStep = frame.hStep ?? Infinity;
  const { verts, triangles } = meshChart(rings, plan.cuts, [], {
    uv: (v) => new THREE.Vector2(v.t * radius, v.h * squash),
    width: (a, b) => Math.max(Math.abs(a.t - b.t) / ARC_STEP, Math.abs(a.h - b.h) / hStep),
    midpoint(a, b) {
      const t = (a.t + b.t) / 2, h = (a.h + b.h) / 2;
      return { p: frame.point(t, h), t, h };
    },
  });
  return { points: verts.map((v) => v.p), normals: verts.map((v) => frame.normal(v.t, v.h)), index: triangles.flat() };
}

/**
 * 円錐の先端を含む面。展開図は先端で特異（先端の高さの直線全体が 3D の 1 点に潰れる）で、
 * 先端のまわりの細い三角形が 3D で裏返ったり重なったりする。そこで軸に垂直な平面への正射影
 * (x, y) = ρ(cos θ, sin θ) の上で分割する。正射影は線形で、円錐の法線は軸方向の成分を持つので、
 * 平面で向きがそろい重ならない三角形分割は、3D でも向きがそろい重ならない。先端は平面の原点で、内部の点として加える。
 * 継ぎ目の母線（先端と縁を往復する辺）は面の内側を通るので、ループから取り除く。
 */
function apexCone(face, frame) {
  const rings = face.loops
    .map((loop) => withoutSpikes(openLoop(loop)))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((p) => {
      const { t, h, rho } = frame.toUV(p);
      return { p, t, h, rho, x: rho * Math.cos(t), y: rho * Math.sin(t) };
    }));
  if (!rings.length) return null;
  const uv = (v) => new THREE.Vector2(v.x, v.y);
  const area = (ring) => Math.abs(THREE.ShapeUtils.area(ring.map(uv)));
  rings.sort((a, b) => area(b) - area(a)); // 面積が最大のループが外周
  const isTip = (v) => v.rho < APEX_EPS;
  const tip = { p: frame.point(0, frame.apex), t: 0, h: frame.apex, rho: 0, x: 0, y: 0 };
  const { verts, triangles } = meshChart(rings, [], rings.some((ring) => ring.some(isTip)) ? [] : [tip], {
    uv,
    // 先端を通る辺は母線（曲面の上の直線）なので分けない。それ以外は先端から見た角度の幅で分ける
    width: (a, b) => (isTip(a) || isTip(b) ? 0 : Math.abs(wrapAngle(b.t - a.t)) / ARC_STEP),
    midpoint: (a, b) => frame.lift((a.x + b.x) / 2, (a.y + b.y) / 2),
  });
  return { points: verts.map((v) => v.p), normals: verts.map((v) => (isTip(v) ? frame.tipNormal : frame.normal(v.t, v.h))), index: triangles.flat() };
}

export const MESHERS = { plane, cylinder: revolved, cone: revolved, torus: revolved };
export const isRenderable = (face) => face.type in MESHERS;

/** 三角形の向きを頂点法線に揃えてから BufferGeometry にする（表裏の判定と陰影を正しくするため）。 */
function toGeometry({ points, normals, index }) {
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [index[k], index[k + 1], index[k + 2]];
    e1.subVectors(points[b], points[a]);
    e2.subVectors(points[c], points[a]);
    if (e1.cross(e2).dot(normals[a]) < 0) [index[k + 1], index[k + 2]] = [c, b];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals.flatMap((p) => p.toArray()), 3));
  geometry.setIndex(index);
  return geometry;
}

/** @returns {THREE.BufferGeometry | null} */
export function faceGeometry(face) {
  const raw = MESHERS[face.type]?.(face);
  return raw && raw.index.length ? toGeometry(raw) : null;
}

/**
 * 部品（ボディの集まり）の面を 1 つの BufferGeometry にまとめる（組立で同じ部品を何か所にも置くときに使い回す）。
 * @returns {{ geometry: THREE.BufferGeometry, volume: number, unsupported: number }}  volume は mm³（面の向きがそろった閉じた形のとき正しい）
 */
export function partGeometry(bodies) {
  const positions = [], normals = [], index = [];
  let unsupported = 0;
  for (const body of bodies) {
    for (const face of body.faces) {
      const g = faceGeometry(face);
      if (!g) {
        unsupported += 1;
        continue;
      }
      const base = positions.length / 3;
      positions.push(...g.getAttribute("position").array);
      normals.push(...g.getAttribute("normal").array);
      for (const i of g.index.array) index.push(base + i);
      g.dispose();
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return { geometry, volume: meshVolume(geometry), unsupported };
}

/** 閉じた三角形メッシュの体積（発散定理: Σ a・(b × c) / 6）。面の向きが外向きなら正 */
export function meshVolume(geometry) {
  const pos = geometry.getAttribute("position").array, idx = geometry.index?.array;
  if (!idx) return 0;
  let v = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

/** 稜線の折れ線群を LineSegments 用の座標列にする。 */
export function edgeSegments(edges) {
  return edges.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
}
