// 評価用: アルミニウムコイル（samples/html/アルミニウムコイル_HOTコイル.html）と同じ式で作ったメッシュ（mm）。刻みは粗くできる。
// 元の HTML と同じく、面ごとに別々の刻みで分割する（外周の幅方向は端ほど細かく、持ち上がった所の面は等間隔、端面の渦巻きは
// 面ごとに別の角度の刻み、尻尾の切り口は板厚方向に細かい）ので、継ぎ目の頂点がそろわない（T 字の継ぎ目）。
// 見えない面（最後の巻きの内側など）は描かないが、立体としての面は全てそろっている。
import * as THREE from "three";

const TAU = Math.PI * 2, DEG = Math.PI / 180;
export const COIL = { id: 508, od: 1250, w: 1100, t: 8, lift: 159, liftDeg: 90, tailDeg: -93, cornerR: 150, edgeRound: 100 };

/** HTML の grid(): (nu + 1) × (nv + 1) の格子の面 */
function grid(nu, nv, fn) {
  const pos = [], idx = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) pos.push(...fn(i / nu, j / nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j, c = b + 1, d = a + 1;
    idx.push(a, b, d, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** コイルの寸法の式（HTML の build() と同じ） */
export function coilShape(P = COIL) {
  const ri = P.id / 2, t = P.t, W = P.w;
  const odR = Math.max(P.od / 2, ri + 4 * t);
  const n = Math.max(1, Math.round((odR - 2 * t - ri) / t));
  const Rc = ri + n * t, Ro = Rc + 2 * t;
  const phi = Math.min(P.liftDeg * DEG, TAU * 0.9), L = P.lift;
  const rb = (th) => Rc + (t * th) / TAU; // 最後の巻きの下の面
  const lift = (th) => (th > TAU - phi ? L * ((th - (TAU - phi)) / phi) ** 2 : 0);
  const ain = (th) => rb(th) + lift(th), aout = (th) => rb(th) + t + lift(th);
  const tailArc = 14 * DEG, Rref = Ro + L, rc = Math.min(P.cornerR, W / 2);
  const XV = (v) => 0.5 - 0.5 * Math.cos(Math.PI * v); // 幅方向は端ほど細かく
  const tailTheta = (v) => {
    const q = XV(v), d = Math.min(q, 1 - q) * W;
    let th = TAU - tailArc * (2 * q - 1) ** 2;
    if (rc > 0 && d < rc) th -= (rc - Math.sqrt(Math.max(0, rc * rc - (rc - d) ** 2))) / Rref;
    return th;
  };
  return { ri, t, W, Rc, Ro, phi, L, rb, lift, ain, aout, Rref, XV, tailTheta, XW: (v) => (XV(v) - 0.5) * W };
}

/** 設計の体積（mm³）: 巻いた本体（内径から rb まで）＋最後の巻き（ain から板厚 t。尻尾は幅方向に形が変わる）を数値積分 */
export function coilVolume(P = COIL) {
  const { ri, t, W, rb, ain, tailTheta } = coilShape(P);
  const N = 4000;
  let body = 0;
  for (let i = 0; i < N; i++) body += ((rb(((i + 0.5) / N) * TAU) ** 2 - ri ** 2) / 2) * (TAU / N);
  let lap = 0;
  for (let j = 0; j < 400; j++) {
    const v = Math.acos(1 - 2 * ((j + 0.5) / 400)) / Math.PI; // XV(v) = q（幅方向に等間隔）
    const T = tailTheta(v);
    for (let i = 0; i < 1000; i++) lap += (t * ain(((i + 0.5) / 1000) * T) + (t * t) / 2) * (T / 1000) * (W / 400);
  }
  return body * W + lap;
}

/** コイルの面（HTML と同じ 9 つのメッシュ。NT: 周の刻み、NX: 幅の刻み） */
export function coilGeometries({ NT = 480, NX = 64, P = COIL } = {}) {
  const { ri, t, W, phi, L, rb, ain, aout, Rref, XV, tailTheta, XW } = coilShape(P);
  const th0 = P.tailDeg * DEG;
  const P3 = (r, th, x) => { const a = th0 - th; return [x, r * Math.cos(a), r * Math.sin(a)]; };
  const thEdge = tailTheta(0);
  const out = [grid(NT, NX, (u, v) => { const th = u * tailTheta(v); return P3(aout(th), th, XW(v)); })]; // 最後の巻きの外周
  if (L > 0) {
    const t1 = TAU - phi, NL = Math.max(24, Math.round((NT * phi) / TAU));
    out.push(grid(NL, NX, (u, v) => { const th = t1 + u * Math.max(0, tailTheta(v) - t1); return P3(ain(th), th, XW(v)); })); // 持ち上がった巻きの裏
    out.push(grid(NL, NX, (u, v) => { const th = t1 + u * phi; return P3(rb(th), th, (v - 0.5) * W); })); // その下に見える面
  }
  const NB = 12, eR = ((t / 2) * P.edgeRound) / 100, h = 1e-3;
  out.push(grid(NB, NX, (u, v) => { // 尻尾の切り口（板厚方向に丸い）
    const th = tailTheta(v), a = u * Math.PI, rmid = ain(th) + t / 2;
    const v1 = Math.max(0, v - h), v2 = Math.min(1, v + h);
    const ds = (tailTheta(v2) - tailTheta(v1)) * Rref, dx = XW(v2) - XW(v1);
    const ns = Math.abs(dx) / (Math.hypot(ds, dx) || 1);
    const r = rmid - (t / 2) * Math.cos(a), dth = (eR * Math.sin(a) * ns) / rmid;
    return P3(r, th + dth, XW(v));
  }));
  out.push(grid(NT, NX, (u, v) => P3(ri, u * TAU, (v - 0.5) * W))); // 内径
  for (const x of [W / 2, -W / 2]) { // 両端面: 巻いた本体の円環と、最後の巻きの帯
    out.push(grid(NT, 1, (u, v) => { const th = u * TAU; return P3(ri + v * (rb(th) - ri), th, x); }));
    out.push(grid(NT, 1, (u, v) => { const th = u * thEdge; return P3(ain(th) + v * t, th, x); }));
  }
  return out;
}
