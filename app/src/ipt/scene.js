// 表示層: 最終形状を three.js で描ける中立な JSON（mm 単位）に変換する。
// 対応する Python 実装: ipt_inspect/scene.py
//   faces   … 面ごとの曲面パラメータ（平面: 法線と境界ループ / 円筒: 軸・半径・角度と高さの範囲）
//   edges   … 稜線の折れ線
//   summary … 外形・穴・R の要約

import labels from "../../../Inventor部品ビューア/アプリ本体/ipt_inspect/labels.json" with { type: "json" }; // Python 版と共用
import { Topology, round, summarize } from "./brep.js";
import { cross, dot, mul, reject, sub, unit } from "./vec.js";

export const BREP_SEGMENT = "PmBRepSegment";
const DIGITS = 5;
const ANGLE_DIGITS = 9;

const mm = (v, scale) => v.map((c) => round(c * scale, DIGITS));

function plane(face, scale) {
  const normal = unit(face.surface.direction);
  return {
    type: "plane",
    normal: mm(mul(normal, face.reversed ? -1 : 1), 1),
    loops: face.loops.map((loop) => loop.map((p) => mm(p, scale))),
  };
}

function cylinder(face, scale) {
  const s = face.surface;
  const axis = unit(s.direction);
  const points = face.loops.flat();
  const radials = points.map((p) => reject(sub(p, s.origin), axis));
  const full = face.edges.some((e) => e.curve.kind === "ellipse" && (Math.abs(e.t1 - e.t0) * 180) / Math.PI >= 360 - 1e-3);
  // 部分円筒は点群の平均方向（円弧の中央）を角度の基準にすると、角度が ±π を跨がない
  const mean = [0, 1, 2].map((k) => radials.reduce((sum, r) => sum + r[k], 0) / radials.length);
  const ref = unit(full ? radials[0] : mean);
  const side = cross(axis, ref);
  const angles = radials.map((r) => Math.atan2(dot(r, side), dot(r, ref)));
  const heights = points.map((p) => dot(sub(p, s.origin), axis));
  const min = (a) => a.reduce((m, v) => Math.min(m, v), Infinity);
  const max = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity);
  return {
    type: "cylinder",
    origin: mm(s.origin, scale),
    axis: mm(axis, 1),
    ref: mm(ref, 1),
    radius: round(s.radius * scale, DIGITS),
    theta: full ? [0, round(2 * Math.PI, ANGLE_DIGITS)] : [round(min(angles), ANGLE_DIGITS), round(max(angles), ANGLE_DIGITS)],
    height: [round(min(heights) * scale, DIGITS), round(max(heights) * scale, DIGITS)],
    outward: !face.concave, // 面の法線が軸から外へ向くか（凸面なら true）
  };
}

const FACE_EXPORTERS = { plane, cylinder };

function exportFace(face, scale) {
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
