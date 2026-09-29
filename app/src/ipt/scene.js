// 表示層: 最終形状を three.js で描ける中立な JSON（mm 単位）に変換する。
// 対応する Python 実装: ipt_inspect/scene.py
//   faces   … 面ごとの曲面パラメータと境界ループ
//               平面: 法線 / 円筒・円錐（回転面）: 軸上の原点・軸・角度の基準方向・半径・半径の傾き
//             三角形分割はビューアが境界ループに沿って行う（ループは隣の面と同じ点列なので、面どうしが隙間なくつながる）
//   edges   … 稜線の折れ線
//   summary … 外形・穴・R・ねじ・円錐の要約

import labels from "../../../Inventor部品ビューア/アプリ本体/ipt_inspect/labels.json" with { type: "json" }; // Python 版と共用
import { Topology, round, summarize } from "./brep.js";
import { mul, reject, unit } from "./vec.js";

export const BREP_SEGMENT = "PmBRepSegment";
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

const FACE_EXPORTERS = { plane, cylinder: revolved, cone: revolved, torus };

/** 中立な面（ipt・STEP 共通）→ シーン JSON の面 */
export function exportFace(face, scale) {
  const exporter = FACE_EXPORTERS[face.surface.kind];
  // 未対応の曲面は種類だけを渡す（ビューアは稜線のみ描く）
  return { id: face.index, ...(exporter ? exporter(face, scale) : { type: face.surface.kind }) };
}

/**
 * @param {string} fileName
 * @param {Array<{segment: object, doc: object}>} shapes  report.js の shapes() の結果
 */
export function buildScene(fileName, shapes) {
  const bodies = [];
  let source = null;
  for (const { segment, doc } of shapes) {
    if (segment.name !== BREP_SEGMENT) continue;
    const topo = new Topology(doc);
    const summaries = summarize(doc);
    topo.bodies().forEach((body, i) => {
      const faces = topo.faces(body).map((f) => topo.face(f));
      const edges = new Map(faces.flatMap((f) => f.edges.map((e) => [e.index, e])));
      bodies.push({
        faces: faces.map((f) => exportFace(f, doc.mmPerUnit)),
        edges: [...edges.values()].map((e) => e.points.map((p) => mm(p, doc.mmPerUnit))),
        summary: summaries[i],
      });
    });
    source = { kernel: doc.kernel, saved_at: doc.savedAt };
  }
  return { file: fileName, units: "mm", source, labels, bodies };
}
