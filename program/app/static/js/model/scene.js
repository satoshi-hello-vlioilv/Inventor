// 中立な面（.ipt・STEP 共通）を、three.js ビューアに渡すシーン JSON の面（mm 単位）にする。
//   平面: 法線 / 円筒・円錐（回転面）: 軸上の原点・軸・角度の基準方向・半径・半径の傾き / トーラス: 大小の半径
//   自由曲面（B スプライン）: 次数・ノット・制御点（mm）・重み・法線を裏返すか（∂S/∂u × ∂S/∂v が面の外向きでなければ true）
//   三角形分割はビューアが境界ループに沿って行う（ループは隣の面と同じ点列なので、面どうしが隙間なくつながる）

import { round } from "../core/numbers.js";
import { mul, reject, unit } from "../core/vec.js";

const DIGITS = 5;
const SLOPE_DIGITS = 9;

export const mm = (v, scale) => v.map((c) => round(c * scale, DIGITS));
const loopsOf = (face, scale) => face.loops.map((loop) => loop.map((p) => mm(p, scale)));

function plane(face, scale) {
  const normal = unit(face.surface.direction);
  return { type: "plane", normal: mm(mul(normal, face.reversed ? -1 : 1), 1), loops: loopsOf(face, scale) };
}

/** 円筒・円錐: 点 = origin + h・axis + ρ(h)・(cos θ・ref + sin θ・(axis × ref))、ρ(h) = radius + slope・h */
function revolved(face, scale) {
  const s = face.surface;
  const axis = unit(s.direction);
  return {
    type: s.kind,
    origin: mm(s.origin, scale),
    axis: mm(axis, 1),
    ref: mm(unit(reject(s.major, axis)), 1),
    radius: round(s.radius * scale, DIGITS),
    slope: round(s.slope, SLOPE_DIGITS),
    outward: !face.concave, // 面の法線が軸から外へ向くか（凸面なら true）
    loops: loopsOf(face, scale),
  };
}

/** トーラス: 点 = origin + (radius + minor・cos φ)・(cos θ・ref + sin θ・(axis × ref)) + minor・sin φ・axis（STEP から） */
function torus(face, scale) {
  const s = face.surface;
  const axis = unit(s.direction);
  return {
    type: "torus",
    origin: mm(s.origin, scale),
    axis: mm(axis, 1),
    ref: mm(unit(reject(s.major, axis)), 1),
    radius: round(s.radius * scale, DIGITS),
    minor: round(s.minor * scale, DIGITS),
    outward: !face.concave, // 面の法線が管の中心から外へ向くか
    loops: loopsOf(face, scale),
  };
}

/** 自由曲面（B スプライン）。ノットはパラメータなので単位を変えない */
function bspline(face, scale) {
  const s = face.surface;
  return {
    type: "bspline",
    degree: s.degree,
    knots: s.knots,
    points: s.points.map((row) => row.map((p) => mm(p, scale))),
    weights: s.weights,
    flip: face.reversed,
    loops: loopsOf(face, scale),
  };
}

const FACE_EXPORTERS = { plane, cylinder: revolved, cone: revolved, torus, bspline };

/** 中立な面（ipt・STEP 共通）→ シーン JSON の面 */
export function exportFace(face, scale) {
  const exporter = FACE_EXPORTERS[face.surface.kind];
  // 未対応の曲面は種類だけを渡す（ビューアは稜線のみ描く）
  return { id: face.index, ...(exporter ? exporter(face, scale) : { type: face.surface.kind }) };
}
