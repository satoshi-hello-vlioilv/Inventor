// .ipt の表示用データ: 最終形状（PmBRepSegment）の面・稜線・要約を、three.js で描ける中立な JSON（mm 単位）にする。
//   faces   … 面ごとの曲面パラメータと境界ループ（model/scene.js）
//   edges   … 稜線の折れ線
//   summary … 外形・穴・R・ねじ・円錐の要約

import labels from "../../core/labels.json" with { type: "json" };
import { exportFace, mm } from "../../model/scene.js";
import { Topology, summarize } from "./brep.js";

export const BREP_SEGMENT = "PmBRepSegment";

/**
 * @param {string} fileName
 * @param {Array<{segment: object, doc: object}>} shapes  index.js の shapes() の結果
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
