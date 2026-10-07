// 同じ図面の 2 つの図面のモデル（DWG と DXF など）を、図形のハンドルで突き合わせる（cad2d-check.mjs と試験で共用。開発用）。
//   compareDrawings(a, b) → { compared, equal, onlyA: [ハンドル], onlyB, diffs: [[ハンドル, 種類, 経路, a の値, b の値]] }
// 比べる値: 図形の種類・共通の値（画層・色・線種・線の太さ）・形の値（モデルの値をすべて。数は相対 1e-6、角度は 2π の違いを同じとみる）。
// ブロックの参照は名前でなくブロックの記録のハンドルで比べる（DWG の無名のブロックの番号は、読み取りが振るので AutoCAD と違う）。
// 通過点のスプラインで許容差 > 0 のものは、AutoCAD が近似するので、制御点でなく曲線どうしの距離が許容差の内かで比べる。

import { neutralSpline } from "../app/static/js/formats/cad2d/curves.js";
import { curvePoint } from "../app/static/js/model/curves.js";

// 比べない値（読み方の都合で形が違うだけのもの・DXF に無いもの）
const SKIP = new Set(["paper", "handle", "thickness", "widths", "mtext", "dimstyle", "flags", "extents", "limits", "fitTolerance", "knotParam"]);
const ANGLES = new Set(["start", "end", "rotation", "oblique", "angle", "twist"]);
// 名前（AutoCAD は大文字・小文字を区別しない: R14 の "STANDARD" と後の版の "Standard" は同じ）
const NAMES = new Set(["layer", "linetype", "style", "block"]);
const TAU = 2 * Math.PI;

const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const closeAngle = (a, b) => {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d) <= 1e-6;
};

/** 2 つの値の食い違い（[経路, DWG の値, DXF の値]）を集める。片方が undefined の値は比べない */
function diff(a, b, at, out, key = "") {
  if (a === undefined || b === undefined || a === null || b === null) return;
  if (typeof a === "number" && typeof b === "number") {
    if (!(ANGLES.has(key) ? closeAngle(a, b) : close(a, b))) out.push([at, a, b]);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push([`${at}.length`, a.length, b.length]);
    else a.forEach((v, i) => diff(v, b[i], `${at}[]`, out, key));
  } else if (typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(a)) if (!SKIP.has(k)) diff(a[k], b[k], at ? `${at}.${k}` : k, out, k);
  } else if (NAMES.has(key) ? String(a).toLowerCase() !== String(b).toLowerCase() : String(a) !== String(b)) out.push([at, a, b]);
}

/** 図面の図形をハンドルで引く（ブロックの中・属性も）。ブロックの参照は、ブロックの記録のハンドルに置き換える */
function byHandle(drawing) {
  const map = new Map();
  const block = (name) => (name === undefined ? name : drawing.blocks.get(name)?.handle ?? name);
  for (const b of drawing.blocks.values()) {
    for (const e of b.entities) {
      map.set(e.handle, e.block === undefined ? e : { ...e, block: block(e.block) });
      for (const a of e.attribs ?? []) map.set(a.handle, a);
    }
  }
  return map;
}

/** 許容差のある通過点のスプライン: 曲線どうしの距離（正規化した媒介変数で 200 点）が許容差の内なら、制御点・ノットは比べない */
function approximateSpline(e, f, out) {
  const tolerance = Math.max(e.fitTolerance ?? 0, f.fitTolerance ?? 0);
  if (e.type !== "SPLINE" || !(tolerance > 1e-9) || !e.fit?.length || !e.controls?.length || !f.controls?.length) return false;
  const range = (s) => [s.knots[s.degree], s.knots[s.controls.length]];
  const [a0, a1] = range(e), [b0, b1] = range(f);
  const [ce, cf] = [neutralSpline(e), neutralSpline(f)];
  let distance = 0;
  for (let i = 0; i <= 200; i++) {
    const p = curvePoint(ce, a0 + ((a1 - a0) * i) / 200), q = curvePoint(cf, b0 + ((b1 - b0) * i) / 200);
    distance = Math.max(distance, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  if (distance > tolerance) out.push(["curve", `${distance}`, `許容差 ${tolerance}`]);
  return true;
}

export function compareDrawings(first, second) {
  const a = byHandle(first), b = byHandle(second);
  const result = { compared: 0, equal: 0, onlyA: [...a.keys()].filter((h) => !b.has(h)), onlyB: [...b.keys()].filter((h) => !a.has(h)), diffs: [] };
  for (const [handle, e] of a) {
    const f = b.get(handle);
    if (!f) continue;
    result.compared++;
    const out = [];
    if (e.type !== f.type) out.push(["type", e.type, f.type]);
    else if (approximateSpline(e, f, out)) diff({ ...e, knots: undefined, controls: undefined, weights: undefined }, f, "", out);
    else diff(e, f, "", out);
    if (!out.length) result.equal++;
    for (const [at, x, y] of out) result.diffs.push([handle, e.type, at, x, y]);
  }
  return result;
}

/** 図形のハンドル → 図形（突き合わせの片方にしか無いものを調べるとき） */
export const entitiesByHandle = (drawing) => byHandle(drawing);
