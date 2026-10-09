// 図面の中の 3D ソリッドなど（ACIS の図形）を、3D の表示に渡す形にまとめる（DOM に依存しない）。
//   solids3d(図面) → [] か [{ format: "ACIS", name, solids: [{ acis, matrix, color, layer, handle, solid, path }], unit }]
//     matrix … 図面の座標への置き方（行優先の 4×4。ブロック参照の入れ子を掛けたもの）、color … "#rrggbb"（画層・ブロックの色を解いたもの。
//     色番号 7（地に合わせて白か黒）は null = 3D の表示の既定の色）
//     path … モデル空間からの、ブロック参照の道筋 [{ block（ブロックの名前）, handle（参照のハンドル）, index（配列の何番目） }]（直下なら []）
//     unit … 図面の単位 → mm の倍率（3D の表示は mm）
// 集めるのはモデル空間（*Model_Space）から辿れるものだけ（紙のレイアウトの図形は 3D に出さない）。切った・凍結した画層の図形は除く。
// 3D の表示（formats/model3d.js）は、PDF の 3D と同じ「図面 ⇄ 3D」のタブで出す。

import { IDENTITY, multiply } from "../../core/matrix.js";
import { ACI, rgbHex } from "../../viewer2d/colors.js";
import { insertMatrices } from "./placement.js";

const MAX_DEPTH = 24; // ブロックの入れ子の上限（2D の表示と同じ）
const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };
const nameKey = (name) => String(name ?? "").toUpperCase();

export function solids3d(drawing) {
  const blocks = new Map([...drawing.blocks.values()].map((b) => [nameKey(b.name), b]));
  const layerOf = (name) => drawing.layers.get(name) ?? null;
  const hidden = (name) => { const l = layerOf(name); return Boolean(l?.off || l?.frozen); };
  const colorValue = (c) => (c?.rgb !== undefined && c.index !== 256 && c.index !== 0 ? rgbHex(c.rgb) : ACI[Math.abs(c?.index ?? 7)] ?? null);
  const colorOf = (c, layer, inherited) => {
    const index = c?.index ?? 256;
    if (index === 256) return colorValue(layerOf(layer)?.color);
    if (index === 0) return inherited ?? null;
    return colorValue(c);
  };

  const solids = [];
  const walk = (block, m, inherited, parentLayer, depth, path) => {
    if (!block || depth > MAX_DEPTH) return;
    for (const e of block.entities) {
      const layer = e.layer === "0" && parentLayer ? parentLayer : e.layer; // 画層 0 の図形は参照の画層を受け継ぐ
      if (e.invisible || hidden(layer)) continue;
      if (e.type === "ACIS" && e.acis) {
        solids.push({ acis: e.acis, matrix: m, color: colorOf(e.color, layer, inherited), layer, handle: e.handle, solid: e.solid, path });
      } else if (e.type === "INSERT") {
        const child = blocks.get(nameKey(e.block));
        insertMatrices(e, child).forEach((local, index) =>
          walk(child, multiply(m, local), colorOf(e.color, layer, inherited), layer, depth + 1, [...path, { block: child?.name ?? e.block, handle: e.handle, index }]));
      }
    }
  };
  const model = drawing.layouts.find((l) => l.model);
  walk(blocks.get(nameKey(model?.block ?? "*Model_Space")), IDENTITY, null, null, 0, []);
  if (!solids.length) return [];
  return [{ format: "ACIS", name: "モデル", solids, unit: UNIT_MM[drawing.units?.code] ?? 1 }];
}
