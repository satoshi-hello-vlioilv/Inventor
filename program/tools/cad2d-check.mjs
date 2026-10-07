// 2D 図面の読み取りの評価関数（開発用）: 同じ図面の DWG と DXF を、それぞれの読み取りで図面のモデルにし、図形をハンドルで突き合わせる。
//
//   node program/tools/cad2d-check.mjs フォルダか .dwg … [--verbose]
//
// .dwg の隣に同じ名前の .dxf があれば対にする（AutoCAD が同じ図面を 2 つの形式で書いたもの。ハンドルが同じ）。
// 2 つの読み取りは独立（DWG はビット列、DXF は文字の群）なので、値が合えば両方が正しい見込みが高く、合わなければどちらかの誤り。
// 比べ方は cad2d-compare.mjs（試験と共用）。
// 出力: 対ごとの 合った図形／比べた図形・片方にしか無い図形・合わなかった値（種類.値 ごとの数）。最後に全体の合計。

import fs from "node:fs";
import path from "node:path";
import { drawingFromDwg } from "../app/static/js/formats/cad2d/from-dwg.js";
import { drawingFromDxf } from "../app/static/js/formats/cad2d/from-dxf.js";
import { compareDrawings, entitiesByHandle } from "./cad2d-compare.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const pairs = args.filter((a) => !a.startsWith("--"))
  .flatMap((a) => (fs.statSync(a).isDirectory() ? walk(a) : [a]))
  .filter((f) => /\.dwg$/i.test(f) && fs.existsSync(f.replace(/\.dwg$/i, ".dxf")));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

const total = { pairs: 0, failed: 0, compared: 0, equal: 0, onlyDwg: 0, onlyDxf: 0 };
const kinds = new Map();
for (const file of pairs) {
  const name = path.relative(process.cwd(), file);
  let dwg, dxf;
  try {
    dwg = drawingFromDwg(new Uint8Array(fs.readFileSync(file)));
    dxf = drawingFromDxf(new Uint8Array(fs.readFileSync(file.replace(/\.dwg$/i, ".dxf"))));
  } catch (error) {
    console.log(`${name}  読めない: ${error.message}`);
    total.pairs++;
    total.failed++;
    continue;
  }
  const r = compareDrawings(dwg, dxf);
  for (const [, type, at] of r.diffs) kinds.set(`${type}.${at}`, (kinds.get(`${type}.${at}`) ?? 0) + 1);
  const layers = [...dwg.layers.keys()].sort().join() === [...dxf.layers.keys()].sort().join();
  const layouts = dwg.layouts.map((l) => l.name).join() === dxf.layouts.map((l) => l.name).join();
  console.log(`${name}  ${dwg.version}/${dxf.version}  図形 ${r.equal}/${r.compared}` +
    (r.onlyA.length ? `  DWG だけ ${r.onlyA.length}` : "") + (r.onlyB.length ? `  DXF だけ ${r.onlyB.length}` : "") +
    (layers ? "" : "  画層が違う") + (layouts ? "" : `  レイアウトが違う（${dwg.layouts.map((l) => l.name)} / ${dxf.layouts.map((l) => l.name)}）`));
  if (verbose) {
    for (const [handle, type, at, x, y] of r.diffs) console.log(`  ${type} #${handle} ${at}: DWG ${JSON.stringify(x)} / DXF ${JSON.stringify(y)}`);
    const [a, b] = [entitiesByHandle(dwg), entitiesByHandle(dxf)];
    for (const h of r.onlyA) console.log(`  DWG だけ ${a.get(h).type} #${h}`);
    for (const h of r.onlyB) console.log(`  DXF だけ ${b.get(h).type} #${h}`);
  }
  total.pairs++;
  total.compared += r.compared;
  total.equal += r.equal;
  total.onlyDwg += r.onlyA.length;
  total.onlyDxf += r.onlyB.length;
}
console.log(`\n合計: 対 ${total.pairs}（読めない ${total.failed}）・図形 ${total.equal}/${total.compared} が一致・DWG だけ ${total.onlyDwg}・DXF だけ ${total.onlyDxf}`);
if (kinds.size) {
  console.log("合わなかった値（種類.値: 数）:");
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1])) console.log(`  ${k}: ${n}`);
}
