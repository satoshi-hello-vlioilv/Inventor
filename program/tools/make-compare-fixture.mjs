// 図面を比べる画面の試料（開発用）: サンプルの A1 の図面（新版）から、ありそうな違いのある旧版を作って DXF に書く。
//
//   node --import ./program/tests/js/importmap.mjs program/tools/make-compare-fixture.mjs
//   → program/tests/fixtures/drawings/compare/A1_円筒_部品図_旧版.dxf（撮影の道具 ui-harness.mjs の状態 compare が使う）
//
// 旧版 → 新版で変わったこと（新版から見て）: 穴の径 φ6.0 → φ6.6・注記に「調質」を足した・ねじ穴を 1 か所足した（円と円弧）・
// 面取りの線を 1 本消した・寸法の位置を動かした。ハンドルはそのまま（AutoCAD で直した図面と同じ）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { drawingToDxf } from "../app/static/js/formats/cad2d/to-dxf.js";
import { DrawingEdits } from "../app/static/js/edit/drawing.js";

const PROGRAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(PROGRAM, "samples/dwg/A1_円筒_部品図.dxf");
const OUT = path.join(PROGRAM, "tests/fixtures/drawings/compare/A1_円筒_部品図_旧版.dxf");

export async function olderA1() {
  const drawing = await readDrawing(new Uint8Array(fs.readFileSync(SOURCE)), path.basename(SOURCE));
  const entities = drawing.blocks.get(drawing.layouts[0].block).entities;
  const byHandle = (h) => entities.find((e) => e.handle === h);
  const edits = new DrawingEdits();
  edits.open(drawing);
  byHandle("9D").radius = 3.0; // 穴の径（新版は 3.3）
  edits.setText(byHandle("104"), byHandle("104").text.replace("S45C 調質", "S45C")); // 注記（新版は「調質」を足した）
  edits.remove([byHandle("DC"), byHandle("DD")]); // ねじ穴（新版で足した）
  edits.copy([byHandle("A0")], [-6, 0]); // 面取りの線（新版で消した）
  edits.move([byHandle("CE")], [0, 6]); // 寸法の位置（新版で動かした）
  return drawing;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { bytes } = drawingToDxf(await olderA1());
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`${path.relative(process.cwd(), OUT)}（${bytes.length} バイト）`);
}
