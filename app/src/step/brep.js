// STEP の B-rep を、Inventor の B-rep（app/src/ipt/brep.js）と同じ「中立な面」の形にする。
// 面の要約（外接箱・穴・円錐）と表示（三角形分割）は ipt と共通の処理を使う。
//   面: { index, surface, reversed, concave, edges, loops, threads }
//   曲面: plane / cylinder / cone / torus（それ以外は型名のまま。表示は稜線だけ）
//   稜線: 直線・円・楕円・B スプライン（有理を含む）。曲面上の曲線（SURFACE_CURVE など）は 3 次元の曲線を使う

import { curvePoint, isConcave, sampleCurve, summarizeFaces, topologySummary } from "../ipt/brep.js";
import { cross, dot, length, mul, reject, sub, unit } from "../ipt/vec.js";
import { argsOf, isType } from "./p21.js";

const TAU = 2 * Math.PI;
const CLOSE_TOL = 1e-9; // 始点と終点が同じ頂点とみなす距離（モデル単位）の比

const isTrue = (v) => v?.enum === "T";

/** 単位（長さ → mm、平面角 → ラジアン）。表現の文脈（GLOBAL_UNIT_ASSIGNED_CONTEXT）から読む。 */
export function unitsOf(step, context) {
  const units = argsOf(step.get(context), "GLOBAL_UNIT_ASSIGNED_CONTEXT")?.[0] ?? [];
  const out = { mm: 1, radian: 1 };
  for (const ref of units) {
    const u = step.get(ref);
    if (isType(u, "LENGTH_UNIT")) out.mm = factorOf(step, u, "METRE", 1000);
    else if (isType(u, "PLANE_ANGLE_UNIT")) out.radian = factorOf(step, u, "RADIAN", 1);
  }
  return out;
}

const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };

/** SI 単位（接頭辞つき）または換算単位（CONVERSION_BASED_UNIT）の大きさを、基準（METRE → mm なら 1000 倍）で返す */
function factorOf(step, unit, base, perBase) {
  const si = argsOf(unit, "SI_UNIT");
  if (si && si[1]?.enum === base) return (PREFIX[si[0]?.enum] ?? 1) * perBase;
  const conv = argsOf(unit, "CONVERSION_BASED_UNIT");
  if (conv) {
    const measure = step.get(conv[1]);
    const args = measure?.args ?? argsOf(measure, measure?.parts?.[0]?.type);
    const value = typeof args?.[0] === "number" ? args[0] : args?.[0]?.args?.[0];
    const baseUnit = step.get(args?.[1]);
    if (typeof value === "number" && baseUnit) return value * factorOf(step, baseUnit, base, perBase);
  }
  return perBase;
}

/** 形状の読み取り（座標はモデル単位のまま持ち、要約・表示で mm にする）。角度は units.radian でラジアンにする */
export class StepGeometry {
  constructor(step, units = { mm: 1, radian: 1 }) {
    this.step = step;
    this.radian = units.radian;
  }

  point(ref) {
    const e = this.step.get(ref);
    if (e?.type === "VERTEX_POINT") return this.point(e.args[1]);
    const c = e?.args?.[1] ?? [0, 0, 0];
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  }

  direction(ref, fallback) {
    const e = this.step.get(ref);
    if (!e) return fallback;
    const c = e.args[1];
    return unit([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]);
  }

  /** AXIS2_PLACEMENT_3D → 原点と直交する 3 軸 */
  placement(ref) {
    const a = this.step.get(ref)?.args ?? [];
    const origin = this.point(a[1]);
    const z = this.direction(a[2], [0, 0, 1]);
    let x = reject(this.direction(a[3], [1, 0, 0]), z);
    if (length(x) < 1e-12) x = reject(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], z);
    x = unit(x);
    return { origin, z, x, y: cross(z, x) };
  }

  /** 曲線 → brep.js の曲線（line / ellipse / spline）。読めないものは { kind: 型名 } */
  curve(ref) {
    const e = this.step.get(ref);
    if (!e) return { kind: "none" };
    switch (e.type) {
      case "LINE": {
        const vec = this.step.get(e.args[2]);
        return { kind: "line", origin: this.point(e.args[1]), direction: mul(this.direction(vec?.args[1], [1, 0, 0]), vec?.args[2] ?? 1) };
      }
      case "CIRCLE": {
        const p = this.placement(e.args[1]);
        return { kind: "ellipse", origin: p.origin, direction: p.z, major: mul(p.x, e.args[2]), ratio: 1, frame: p };
      }
      case "ELLIPSE": {
        const p = this.placement(e.args[1]);
        return { kind: "ellipse", origin: p.origin, direction: p.z, major: mul(p.x, e.args[2]), ratio: e.args[3] / e.args[2], frame: p };
      }
      case "SURFACE_CURVE": case "SEAM_CURVE": case "INTERSECTION_CURVE":
        return this.curve(e.args[1]);
      case "TRIMMED_CURVE":
        return this.curve(e.args[1]); // 範囲は稜線の頂点で決まる
      case "POLYLINE":
        return { kind: "polyline", points: e.args[1].map((r) => this.point(r)) };
      default:
        return this.spline(e) ?? { kind: e.type || e.parts.map((p) => p.type).join("+") };
    }
  }

  /** B_SPLINE_CURVE_WITH_KNOTS（単純・複合・有理） */
  spline(e) {
    const simple = e.type === "B_SPLINE_CURVE_WITH_KNOTS" ? e.args : null;
    const base = simple ? simple.slice(1, 6) : argsOf(e, "B_SPLINE_CURVE");
    const knotArgs = simple ? simple.slice(6, 9) : argsOf(e, "B_SPLINE_CURVE_WITH_KNOTS");
    if (!base || !knotArgs) return null;
    const [degree, pointRefs] = base;
    const [mults, values] = knotArgs;
    const knots = values.flatMap((k, i) => Array(mults[i]).fill(k));
    const points = pointRefs.map((r) => this.point(r));
    const weights = argsOf(e, "RATIONAL_B_SPLINE_CURVE")?.[0] ?? points.map(() => 1);
    if (knots.length !== points.length + degree + 1) return null;
    return { kind: "spline", degree, knots, points, weights, period: 0, reversed: false };
  }

  /** 曲面 → brep.js の曲面 */
  surface(ref) {
    const e = this.step.get(ref);
    if (!e) return { kind: "none" };
    const a = e.args;
    const revolved = (kind, radius, slope, extra = {}) => {
      const p = this.placement(a[1]);
      return { kind, origin: p.origin, direction: p.z, major: mul(p.x, radius), radius, slope, normalOutward: true, ...extra };
    };
    switch (e.type) {
      case "PLANE": {
        const p = this.placement(a[1]);
        return { kind: "plane", origin: p.origin, direction: p.z };
      }
      case "CYLINDRICAL_SURFACE": return revolved("cylinder", a[2], 0);
      case "CONICAL_SURFACE": return revolved("cone", a[2], Math.tan(a[3] * this.radian));
      case "TOROIDAL_SURFACE": return revolved("torus", a[2], 0, { minor: a[3] });
      case "SPHERICAL_SURFACE": return revolved("sphere", a[2], 0);
      default: return { kind: (e.type || e.parts.map((p) => p.type).join("+")).toLowerCase() };
    }
  }

  /** 稜線（EDGE_CURVE）→ { index, curve, t0, t1, points }。点列は始点の頂点 → 終点の頂点の向き */
  edge(ref) {
    const e = this.step.get(ref);
    const [, v1, v2, curveRef, sameSense] = e.args;
    const start = this.point(v1), end = this.point(v2);
    const closed = v1.ref === v2.ref || length(sub(start, end)) <= CLOSE_TOL * Math.max(1, length(start));
    const forward = isTrue(sameSense);
    const curve = this.curve(curveRef);
    let t0 = 0, t1 = 0, points;
    if (curve.kind === "ellipse") {
      const angle = (p) => {
        const d = sub(p, curve.frame.origin);
        return Math.atan2(dot(d, curve.frame.y) / curve.ratio, dot(d, curve.frame.x));
      };
      t0 = angle(start);
      const raw = closed ? t0 : angle(end);
      // 曲線の向きに沿うなら角度が増える向き、逆なら減る向きにたどる
      const span = closed ? TAU : forward ? ((raw - t0) % TAU + TAU) % TAU : ((t0 - raw) % TAU + TAU) % TAU;
      t1 = forward ? t0 + span : t0 - span;
      points = sampleCurve(curve, t0, t1);
    } else if (curve.kind === "spline") {
      const u = curve.knots, p = curve.degree;
      const [lo, hi] = [u[p], u[u.length - p - 1]];
      let [a, b] = forward ? [lo, hi] : [hi, lo];
      if (!closed) {
        // 稜線の頂点が B スプラインの端でなければ、頂点に最も近いパラメータで切る
        a = this.nearestParam(curve, start, lo, hi, a);
        b = this.nearestParam(curve, end, lo, hi, b);
      }
      [t0, t1] = [a, b];
      points = sampleCurve(curve, a, b);
    } else if (curve.kind === "polyline") {
      points = forward ? curve.points : [...curve.points].reverse();
    } else {
      points = [start, end];
    }
    points = [...points];
    points[0] = start;
    points[points.length - 1] = end;
    return { index: e.id, curve, t0, t1, points };
  }

  /** B スプライン上で点 q に最も近いパラメータ（端の点に近ければ端をそのまま使う） */
  nearestParam(curve, q, lo, hi, preferred) {
    const at = (t) => curvePoint(curve, t);
    if (length(sub(at(preferred), q)) < 1e-9 * Math.max(1, length(q))) return preferred;
    const n = 64 * Math.max(1, new Set(curve.knots).size);
    let best = lo, bestD = Infinity;
    for (let i = 0; i <= n; i++) {
      const t = lo + ((hi - lo) * i) / n;
      const d = length(sub(at(t), q));
      if (d < bestD) [best, bestD] = [t, d];
    }
    let step = (hi - lo) / n;
    for (let k = 0; k < 40; k++, step /= 2) { // 近くを二分して詰める
      for (const t of [best - step, best + step]) {
        if (t < lo || t > hi) continue;
        const d = length(sub(at(t), q));
        if (d < bestD) [best, bestD] = [t, d];
      }
    }
    return best;
  }

  /** ループ（EDGE_LOOP・VERTEX_LOOP・POLY_LOOP）→ 閉じた折れ線と、使った稜線 */
  loop(ref, orientation) {
    const e = this.step.get(ref);
    let points = [], edges = [];
    if (e.type === "EDGE_LOOP") {
      for (const oeRef of e.args[1]) {
        const oe = this.step.get(oeRef);
        const edge = this.edge(oe.args[3]);
        edges.push(edge);
        const run = isTrue(oe.args[4]) ? edge.points : [...edge.points].reverse();
        points.push(...(points.length ? run.slice(1) : run));
      }
    } else if (e.type === "VERTEX_LOOP") points = [this.point(e.args[1])];
    else if (e.type === "POLY_LOOP") points = [...e.args[1].map((r) => this.point(r)), this.point(e.args[1][0])];
    if (!orientation) points.reverse();
    return { points, edges };
  }

  /** ADVANCED_FACE（FACE_SURFACE）→ 中立な面 */
  face(ref) {
    const e = this.step.get(ref);
    const [, bounds, surfaceRef, sameSense] = e.args;
    const loops = [], edges = new Map(), uses = new Map();
    for (const b of bounds) {
      const bound = this.step.get(b);
      const { points, edges: used } = this.loop(bound.args[1], isTrue(bound.args[2]));
      loops.push(points);
      for (const edge of used) {
        edges.set(edge.index, edge);
        uses.set(edge.index, (uses.get(edge.index) ?? 0) + 1);
      }
    }
    // 同じ面が 2 回使う稜線は継ぎ目（閉じた曲面の角度の切れ目）で、面と面の境界ではない。稜線としては描かない
    for (const [index, n] of uses) if (n > 1) edges.get(index).seam = true;
    const face = { index: e.id, surface: this.surface(surfaceRef), reversed: !isTrue(sameSense), edges: [...edges.values()], loops, threads: [] };
    face.concave = isConcave(face);
    return face;
  }

  /** MANIFOLD_SOLID_BREP・BREP_WITH_VOIDS・SHELL_BASED_SURFACE_MODEL → 面と位相の数 */
  solid(ref) {
    const e = this.step.get(ref);
    const shells = [];
    if (e.type === "MANIFOLD_SOLID_BREP") shells.push(e.args[1]);
    else if (e.type === "BREP_WITH_VOIDS") shells.push(e.args[1], ...e.args[2]);
    else if (e.type === "SHELL_BASED_SURFACE_MODEL") shells.push(...e.args[1]);
    const faceRefs = shells.flatMap((s) => this.step.get(s).args[1]);
    const faces = faceRefs.map((f) => this.face(f));
    // 位相の数（稜線・頂点は EDGE_CURVE・VERTEX_POINT の番号で数える）。閉じているか = 全ての稜線がちょうど 2 回使われる
    const uses = new Map(), vertices = new Set();
    let loops = 0;
    for (const f of faceRefs) {
      for (const b of this.step.get(f).args[1]) {
        loops += 1;
        const loop = this.step.get(this.step.get(b).args[1]);
        if (loop.type !== "EDGE_LOOP") continue;
        for (const oe of loop.args[1]) {
          const edgeRef = this.step.get(oe).args[3].ref;
          uses.set(edgeRef, (uses.get(edgeRef) ?? 0) + 1);
          const edge = this.step.get(edgeRef);
          vertices.add(edge.args[1].ref).add(edge.args[2].ref);
        }
      }
    }
    const closed = e.type !== "SHELL_BASED_SURFACE_MODEL" && [...uses.values()].every((n) => n === 2);
    const counts = { shells: shells.length, faces: faces.length, loops, edges: uses.size, vertices: vertices.size };
    return { index: e.id, faces, counts, closed };
  }
}

/** 形状（ソリッド）1 つの要約。ipt の要約と同じ形 */
export function summarizeSolid(solid, scale) {
  return { index: solid.index, ...topologySummary(solid.counts, solid.closed), ...summarizeFaces(solid.faces, scale) };
}

