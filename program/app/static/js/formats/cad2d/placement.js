// ブロック参照（INSERT・MINSERT）の置き方の行列（2D の表示と 3D の表示で共用）。
//   insertMatrices(参照, ブロック) → 行列の列（行優先の 4×4。配列の升目ごとに 1 つ。親の行列に掛ける）
// 行列 = OCS（押し出しの向き）× 移動（挿入点）× Z 軸回りの回転 × 升目のずれ × 拡大 × ブロックの基点を原点へ

import { IDENTITY, multiply, rotationZ, scaling, translation } from "../../core/matrix.js";
import { ocsAxes } from "./curves.js";

export function insertMatrices(e, block) {
  const axes = ocsAxes(e.extrusion);
  const ocs = axes
    ? [axes[0][0], axes[1][0], axes[2][0], 0, axes[0][1], axes[1][1], axes[2][1], 0, axes[0][2], axes[1][2], axes[2][2], 0, 0, 0, 0, 1]
    : IDENTITY;
  const base = block?.base ?? [0, 0, 0];
  const [sx, sy, sz] = e.scale ?? [1, 1, 1];
  const out = [];
  for (let r = 0; r < Math.max(1, e.rows ?? 1); r++) {
    for (let c = 0; c < Math.max(1, e.columns ?? 1); c++) {
      const cell = [(e.columnSpacing ?? 0) * c, (e.rowSpacing ?? 0) * r, 0];
      const local = multiply(multiply(multiply(multiply(translation(e.p ?? [0, 0, 0]), rotationZ(e.rotation ?? 0)), translation(cell)),
        scaling([sx || 1, sy || 1, sz || 1])), translation(base.map((v) => -v)));
      out.push(multiply(ocs, local));
    }
  }
  return out;
}
