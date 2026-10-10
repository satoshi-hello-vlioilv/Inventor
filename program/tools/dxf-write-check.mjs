// DXF の書き出しの評価関数（開発用）: 図面を読み → DXF に書き → 書いた DXF を読み直し、書く前（書ける形に整えた写し）と突き合わせる。
//
//   node program/tools/dxf-write-check.mjs フォルダか図面 … [--version R2013|R2000] [--out 置き場] [--verbose]
//
// 図面は DWG・DXF・Jw_cad・SXF・PDF のどれでも（読み取りは formats/cad2d/index.js）。比べ方は cad2d-compare.mjs（試験と共用）:
// 図形はハンドルで全ての値を、表（画層・線種・文字スタイル）・ブロック・レイアウト・単位・線種の尺度は名前で。
// 書けなかったもの・変えたもの（to-dxf.js の dxfNotes）も出す。--out に書いた DXF は、別の読み取り（ezdxf）で dxf_audit.py が確かめる。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { drawingToDxf, dxfNotes } from "../app/static/js/formats/cad2d/to-dxf.js";
import { compareDrawings, compareTables } from "./cad2d-compare.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const version = option("--version", "R2013");
const out = option("--out", null);
const verbose = args.includes("--verbose");
const skip = new Set([option("--version"), option("--out")]);
const files = args.filter((a, i) => !a.startsWith("--") && !(skip.has(a) && args[i - 1]?.startsWith("--")))
  .flatMap((a) => (fs.statSync(a).isDirectory() ? walk(a) : [a]))
  .filter((f) => /\.(dwg|dxf|jww|sfc|p21|pdf)$/i.test(f));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

/** 1 つの図面を書いて読み直す（試験と共用できるよう、結果を値で返す） */
export function roundTrip(drawing, options) {
  const { bytes, notes, drawing: written } = drawingToDxf(drawing, options);
  const again = readDrawing(bytes, "x.dxf");
  return { bytes, notes, written, again, entities: compareDrawings(written, again), tables: compareTables(written, again) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (out) fs.mkdirSync(out, { recursive: true });
  const total = { files: 0, unread: 0, compared: 0, equal: 0, missing: 0, tables: 0 };
  for (const file of files) {
    const name = path.relative(process.cwd(), file);
    let drawing;
    try {
      drawing = readDrawing(new Uint8Array(fs.readFileSync(file)), file);
    } catch (error) {
      console.log(`${name}  読めない（書き出しの評価の外）: ${error.message}`);
      total.unread++;
      continue;
    }
    const r = roundTrip(drawing, { version });
    total.files++;
    total.compared += r.entities.compared;
    total.equal += r.entities.equal;
    total.missing += r.entities.onlyA.length + r.entities.onlyB.length;
    total.tables += r.tables.length;
    const lost = r.entities.onlyA.length ? `  書いたのに読めない ${r.entities.onlyA.length}` : "";
    const extra = r.entities.onlyB.length ? `  余分 ${r.entities.onlyB.length}` : "";
    console.log(`${name}  ${drawing.format.toUpperCase()} → DXF ${version}  図形 ${r.entities.equal}/${r.entities.compared}${lost}${extra}` +
      (r.tables.length ? `  表などの食い違い ${r.tables.length}` : "") + `  ${(r.bytes.length / 1024).toFixed(0)} KB`);
    for (const line of dxfNotes(r.notes)) console.log(`  · ${line}`);
    if (verbose || r.entities.diffs.length || r.tables.length) {
      for (const [h, type, at, x, y] of r.entities.diffs.slice(0, verbose ? Infinity : 8)) console.log(`  ${type} #${h} ${at}: 書く前 ${JSON.stringify(x)} / 読み直し ${JSON.stringify(y)}`);
      for (const [at, x, y] of r.tables.slice(0, verbose ? Infinity : 8)) console.log(`  ${at}: 書く前 ${JSON.stringify(x)} / 読み直し ${JSON.stringify(y)}`);
    }
    if (out) fs.writeFileSync(path.join(out, `${path.basename(file).replace(/\.[^.]+$/, "")}.${path.extname(file).slice(1).toLowerCase()}.dxf`), r.bytes);
  }
  console.log(`\n合計: 図面 ${total.files}（読めない ${total.unread}）・図形 ${total.equal}/${total.compared} が一致・片方だけ ${total.missing}・表などの食い違い ${total.tables}`);
}
