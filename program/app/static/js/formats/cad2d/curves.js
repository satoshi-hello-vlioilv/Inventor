// 図面（DWG・DXF）に固有の曲線の計算。点の計算・折れ線へのサンプリングそのものは model/curves.js（3D と共用）が受け持つ。
//   通過点のスプライン: AutoCAD と同じノットと端の条件で、通過点から制御点を求める
//   膨らみ（bulge）: ポリラインの円弧の線分を点の列に
//   OCS → WCS: 図形ごとの座標系（押し出しの向きで決まる。任意軸アルゴリズム）

import { solveLinear } from "../../core/numbers.js";
import { cross, length, sub, unit } from "../../core/vec.js";
import { basisDerivatives } from "../../model/nurbs.js";

const xyz = (p) => [p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0];
const hasVector = (v) => Array.isArray(v) && v.some((x) => x);

// ---- 通過点のスプライン ------------------------------------------------------------------------------------------
/** 通過点の媒介変数（ノット）: 0 弦の長さ・1 弦の長さの平方根・2 等間隔（AutoCAD の knotParam） */
export function fitParameters(fit, method = 0) {
  const u = [0];
  for (let i = 1; i < fit.length; i++) {
    const d = length(sub(fit[i], fit[i - 1]));
    u.push(u[i - 1] + (method === 2 ? 1 : method === 1 ? Math.sqrt(d) : d));
  }
  return u;
}

/**
 * 通過点を通る 3 次の B スプライン（AutoCAD の「通過点で定義したスプライン」の制御点とノット）。
 * 端の条件: 接線があれば 1 階微分 = 接線（長さもそのまま。AutoCAD はふつう単位ベクトルで持ち、媒介変数が弦の長さのとき速さ 1。
 * 長さのある接線は R2013 の等間隔のノットの例で、AutoCAD の制御点 = 端 ± 接線 / 3 を確かめた）。無ければ 2 階微分 = 0（自然な端）。
 * 閉じたもの: 最初の点に戻り、つなぎ目で 1 階・2 階微分をそろえる。
 * AutoCAD の DXF の制御点・ノットと相対 1e-15 で一致する（許容差 0 のとき。cad2d-check.mjs）。許容差 > 0 のものは
 * AutoCAD が近似して通過点を外れるが、ここでは厳密に通す（差は許容差の内）。
 * @returns {{ degree: number, knots: number[], controls: number[][] } | null}
 */
export function interpolateFit({ fit, startTangent, endTangent, closed = false, knotParam = 0 }) {
  let points = fit.map(xyz).filter((p, i, a) => i === 0 || length(sub(p, a[i - 1])) > 0);
  if (closed && points.length > 2 && length(sub(points[0], points.at(-1))) > 0) points = [...points, points[0]];
  if (points.length < 2) return null;
  const degree = 3;
  const u = fitParameters(points, knotParam);
  const n = points.length - 1;
  const knots = [...new Array(degree + 1).fill(u[0]), ...u.slice(1, -1), ...new Array(degree + 1).fill(u[n])];
  const count = n + 3; // 制御点の数 = 通過点の数 + 端の条件 2 つ
  const row = (t, order) => {
    const { span, ders } = basisDerivatives(knots, degree, count, t, order);
    const r = new Array(count).fill(0);
    for (let j = 0; j <= degree; j++) r[span - degree + j] = ders[order][j];
    return r;
  };
  const A = points.map((_, k) => row(u[k], 0));
  const B = points.slice();
  if (closed) {
    for (const order of [1, 2]) {
      const a = row(u[0], order), b = row(u[n], order);
      A.push(a.map((v, i) => v - b[i]));
      B.push([0, 0, 0]);
    }
  } else {
    for (const [tangent, t] of [[startTangent, u[0]], [endTangent, u[n]]]) {
      const given = hasVector(tangent);
      A.push(row(t, given ? 1 : 2));
      B.push(given ? xyz(tangent) : [0, 0, 0]);
    }
  }
  const controls = solveLinear(A, B);
  return controls ? { degree, knots, controls } : null;
}

/** スプラインに制御点が無く通過点だけなら、制御点とノットを計算して足す（図形をそのまま直して返す） */
export function completeSpline(e) {
  if (e.controls?.length || !(e.fit?.length >= 2)) return e;
  const s = interpolateFit(e);
  if (s) Object.assign(e, { degree: s.degree, knots: s.knots, controls: s.controls, weights: [] });
  return e;
}

/** 図面のスプライン → model/curves.js の中立な曲線（sampleCurve・curvePoint にそのまま渡せる） */
export function neutralSpline(e) {
  return { kind: "spline", degree: e.degree, knots: e.knots, points: e.controls.map(xyz),
    weights: e.weights?.length === e.controls.length ? e.weights : e.controls.map(() => 1) };
}

// ---- 膨らみ ---------------------------------------------------------------------------------------------------------
/** 膨らみ（bulge = tan(中心角 / 4)。正 = 反時計回り）のある線分 a → b を点の列に（a を含めず b を含む）。step は刻みの角度 */
export function bulgePoints(a, b, bulge, step = Math.PI / 32) {
  const z = b[2] ?? a[2] ?? 0;
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!bulge || chord === 0) return [[b[0], b[1], z]];
  const theta = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // 中心: 弦の中点から、弦の左（反時計回りのとき）へ h。半円を越える弧は h が負になり、反対側へ
  const h = radius * Math.cos(theta / 2), sign = Math.sign(bulge);
  const dir = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
  const center = [(a[0] + b[0]) / 2 - sign * h * dir[1], (a[1] + b[1]) / 2 + sign * h * dir[0]];
  const start = Math.atan2(a[1] - center[1], a[0] - center[0]);
  const n = Math.max(1, Math.ceil(Math.abs(theta) / step));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = start + (theta * i) / n;
    out.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t), z]);
  }
  out.push([b[0], b[1], z]);
  return out;
}

// ---- 座標系 -----------------------------------------------------------------------------------------------------
/**
 * OCS → WCS の軸（任意軸アルゴリズム: 押し出しの向き N から OCS の x・y 軸を決める。DXF の説明書）。
 * 押し出しが +Z（ふつうの 2D の図形）なら null（変換しない）。
 */
export function ocsAxes(extrusion) {
  const N = unit(xyz(extrusion ?? [0, 0, 1]));
  if (Math.abs(N[0]) < 1e-12 && Math.abs(N[1]) < 1e-12 && N[2] > 0) return null;
  const ax = unit(Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? cross([0, 1, 0], N) : cross([0, 0, 1], N));
  return [ax, unit(cross(N, ax)), N];
}

/** OCS の点を WCS に（axes = ocsAxes の結果。null ならそのまま） */
export function toWcs(axes, p) {
  const [x, y, z] = xyz(p);
  if (!axes) return [x, y, z];
  return [0, 1, 2].map((k) => axes[0][k] * x + axes[1][k] * y + axes[2][k] * z);
}

/** WCS の点（向き）を OCS に（toWcs の逆。軸は直交なので転置） */
export function toOcs(axes, p) {
  const q = xyz(p);
  if (!axes) return q;
  return axes.map((axis) => axis[0] * q[0] + axis[1] * q[1] + axis[2] * q[2]);
}
