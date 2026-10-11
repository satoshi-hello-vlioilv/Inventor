// SXF（SFC）の書き出し（formats/cad2d/to-sxf.js）の評価: 図面の各レイアウトを SFC に書いて読み直すと、書く前に画面に描いたもの
// （用紙の座標に写し、ビューポートの枠で切ったもの）と線・塗り・文字・点が一致する（tools/sxf-write-check.mjs と共用）。
// 用紙と尺度の選び方・破線のピッチ・文字の逃がしと符号・SXF の同じ図形での書き方・並び（塗りの境界を先に）・図面の属性・単位。
// 別の読み取り（ezsxf の to_dxf）での突き合わせは開発の道具（sxf-write-check.mjs --ezsxf。docs/editing.md §7）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { createDrawing, unitsOf } from "../../app/static/js/formats/cad2d/model.js";
import { drawingToSfc, pitchOf, sfcNotes, sfcString, sheetPlan } from "../../app/static/js/formats/cad2d/to-sxf.js";
import { readSxf } from "../../app/static/js/formats/sxf/index.js";
import { roundTrip } from "../../tools/sxf-write-check.mjs";
import { ROOT } from "./helpers.mjs";

const DIRS = [path.join(ROOT, "samples/dwg"), path.join(ROOT, "tests/fixtures/drawings"), path.join(ROOT, "tests/fixtures/drawings/sxf")];
const DRAWINGS = DIRS.flatMap((dir) => fs.readdirSync(dir).filter((n) => /\.(dwg|dxf|jww|sfc|p21|pdf)$/i.test(n)).map((n) => path.join(dir, n)));
const read = (file) => readDrawing(new Uint8Array(fs.readFileSync(file)), file);
const entity = (type, extra = {}) => ({ type, handle: "", layer: "0", color: { index: 256 }, linetype: "BYLAYER", lineweight: -1, ltscale: 1, invisible: false, ...extra });
/** 図形を並べただけの図面（モデル空間に） */
function drawingOf(entities, more = {}) {
  const d = createDrawing({ format: "dxf", version: "R2018" });
  d.layers.set("0", { name: "0", color: { index: 7 }, off: false, frozen: false, locked: false, plot: true, linetype: "Continuous", lineweight: -3 });
  d.blocks.set("*Model_Space", { name: "*Model_Space", handle: "1F", base: [0, 0, 0], entities });
  d.layouts = [{ name: "Model", block: "*Model_Space", model: true, tabOrder: 0 }];
  return Object.assign(d, more);
}
const sfcText = (bytes) => new TextDecoder("shift_jis").decode(bytes);
const features = (bytes) => readSxf(bytes).features;

test("サンプルと試験の図面の全てのレイアウト（DWG・DXF・Jw_cad・SXF・PDF）: SFC に書いて読み直すと、描いたものが一致する", () => {
  assert.ok(DRAWINGS.length >= 15, `図面 ${DRAWINGS.length}`);
  let layouts = 0, samples = 0, texts = 0;
  for (const file of DRAWINGS) {
    const drawing = read(file);
    for (const layout of drawing.layouts) {
      const r = roundTrip(drawing, layout);
      const name = `${path.basename(file)} [${layout.name}]`;
      assert.ok(r.precision >= 0.999 && r.recall >= 0.999, `${name}: ${r.precision} / ${r.recall}\n${r.failures.join("\n")}`);
      assert.equal(r.texts[0], r.texts[1], `${name} 文字\n${r.failures.join("\n")}`);
      assert.equal(r.points[0], r.points[1], `${name} 点`);
      layouts++;
      samples += r.samples[0];
      texts += r.texts[1];
    }
  }
  assert.ok(layouts >= 25 && samples > 1e5 && texts > 2000, `レイアウト ${layouts}・点 ${samples}・文字 ${texts}`);
});

test("用紙: 読んだ用紙の大きさ（SXF・PDF）・DXF の範囲（描いたものが収まるとき）、ほかは収まる尺度と A 判の部分図", () => {
  const sxf = read(path.join(ROOT, "samples/dwg/SXF_A1_円筒_部品図.sfc"));
  assert.deepEqual(sheetPlan(sxf, sxf.layouts[0], null).sheet, { type: 3, orientation: 1, width: 420, height: 297, name: "部品図" });
  const dxf = read(path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf"));
  const paper = dxf.layouts.find((l) => !l.model);
  const p = sheetPlan(dxf, paper, { min: [10, 7], max: [422, 287] }); // 範囲 0〜420 × 0〜297 に収まる → A3 に直に
  assert.equal(p.figure, null);
  assert.deepEqual([p.sheet.type, p.sheet.orientation, p.k, p.origin.map((v) => v + 0)], [3, 1, 1, [0, 0]]);
  assert.ok(sheetPlan(dxf, paper, { min: [0, 0], max: [900, 600] }).figure, "範囲からはみ出せば部分図");
  // モデル: 1:1 で収まる最も小さい用紙 → 大きければ尺度を下げる（用紙は A4 から A0 まで）
  const model = dxf.layouts.find((l) => l.model);
  const plan = (w, h) => {
    const r = sheetPlan(dxf, model, { min: [100, 50], max: [100 + w, 50 + h] });
    return `${r.sheet.type === 9 ? "自由" : `A${r.sheet.type}`}${r.sheet.orientation ? "横" : "縦"} 1:${Math.round(1 / r.figure.ratio)}`;
  };
  assert.equal(plan(200, 100), "A4横 1:1");
  assert.equal(plan(100, 250), "A4縦 1:1");
  assert.equal(plan(300, 250), "A3横 1:1");
  assert.equal(plan(1100, 700), "A0横 1:1");
  assert.equal(plan(5000, 3000), "A0横 1:5");
  assert.equal(plan(5e9, 1), "自由横 1:100000");
  // 図の外形の中心が用紙の中心に来る
  const r = sheetPlan(dxf, model, { min: [100, 50], max: [300, 150] });
  assert.deepEqual([200 * r.figure.ratio + r.figure.at[0], 100 * r.figure.ratio + r.figure.at[1]], [r.sheet.width / 2, r.sheet.height / 2]);
  // 単位: インチの図面は mm に直す（図の中の長さ = 図面の長さ × 25.4）
  const inch = drawingOf([entity("LINE", { a: [0, 0, 0], b: [10, 0, 0] })], { units: unitsOf(1) });
  const { bytes, notes, plan: ip } = drawingToSfc(inch, inch.layouts[0]);
  assert.equal(ip.k, 25.4);
  assert.ok(features(bytes).some((f) => f.name === "line" && Number(f.params[6]) === 254), "線の終わりは 254 mm");
  assert.ok(sfcNotes(notes).some((l) => /inch から mm/.test(l)));
});

test("破線のピッチ: 線から始め、同じ種類は足し、長さ 0 の点は 0.25 mm。既定の 15 種と同じなら、その名前で書く", () => {
  assert.deepEqual(pitchOf([6, -1.5], 1), [6, 1.5]);
  assert.deepEqual(pitchOf([-1, 3, -2], 1), [3, 3]); // すき間で始まる → 末尾へ回し、続くすき間を足す
  assert.deepEqual(pitchOf([2, 0, -1, 0, -1], 2), [4.25, 2, 0.25, 2]); // 0（点）は用紙の 0.25 mm（尺度を掛けない）
  assert.deepEqual(pitchOf([1, -1, 2], 1), [3, 1]); // 線で終わる → 先頭の線に足す
  assert.equal(pitchOf([3, 2], 1), null); // すき間の無い線種は実線
  assert.equal(pitchOf(null, 1), null);
  const d = drawingOf([entity("LINE", { a: [0, 0, 0], b: [100, 0, 0], linetype: "DASHED" }), entity("LINE", { a: [0, 10, 0], b: [100, 10, 0], linetype: "ODD" })]);
  d.linetypes.set("DASHED", { name: "DASHED", dashes: [6, -1.5] });
  d.linetypes.set("ODD", { name: "ODD", dashes: [5, -2, 0, -2] });
  const list = features(drawingToSfc(d, d.layouts[0]).bytes);
  assert.ok(list.some((f) => f.name === "pre_defined_font" && f.params[0] === "dashed"), "既定の dashed");
  const user = list.find((f) => f.name === "user_defined_font");
  assert.deepEqual([user.params[1], user.params[2]], ["4", "(5,2,0.25,2)"]);
});

test("文字: 1 行ずつ揃えの基線に。' は ’・\\ はそのまま・*/ は分け・⌀ は φ・Shift_JIS に無い文字は ?（知らせる）。符号は Shift_JIS・改行は CRLF", () => {
  const text = "a'b\\c */ ⌀10 😀 漢字";
  const d = drawingOf([entity("TEXT", { p: [10, 20, 0], height: 3.5, rotation: 0, text, widthFactor: 1, halign: 0, valign: 0 }),
    entity("MTEXT", { p: [10, 50, 0], height: 2.5, direction: [1, 0, 0], text: "上の行\\P下の行", attach: 1, width: 0, lineSpacing: 1 })]);
  const { bytes, notes } = drawingToSfc(d, d.layouts[0], { fileName: "名前'.sfc", now: new Date("2026-10-10T01:02:03Z") });
  const raw = sfcText(bytes);
  assert.match(raw, /^ISO-10303-21;\r\nHEADER;\r\nFILE_DESCRIPTION\(\('SCADEC level2 feature_mode'\),'2;1'\);\r\nFILE_NAME\('名前''\.sfc','2026-10-10T01:02:03'/);
  assert.ok(!/[^\r]\n/.test(raw), "改行は全て CRLF");
  assert.ok(raw.endsWith("ENDSEC;\r\nEND-ISO-10303-21;\r\n"));
  assert.equal(sfcString(text), "a’b\\c * / φ10 ? 漢字"); // 書いて読み直したときの文字と同じ
  const back = readDrawing(bytes, "x.sfc");
  const strings = [...back.blocks.values()].flatMap((b) => b.entities).filter((e) => e.type === "TEXT").map((e) => e.text);
  assert.deepEqual(strings.sort(), ["a’b\\c * / φ10 ? 漢字", "上の行", "下の行"].sort());
  assert.deepEqual([notes.quotes, notes.diameters, notes.unmapped], [1, 1, 1]);
  const lines = sfcNotes(notes);
  assert.ok(lines.some((l) => /’/.test(l)) && lines.some((l) => /φ/.test(l)) && lines.some((l) => /\?/.test(l)), lines.join("\n"));
  // MTEXT の 2 行は、行の間隔（高さの 5/3）だけ下へ
  const rows = features(bytes).filter((f) => f.name === "text_string" && /行/.test(f.params[3])).map((f) => Number(f.params[5]));
  assert.ok(Math.abs(rows[0] - rows[1] - (2.5 * 5) / 3) < 1e-5, rows.join(", "));
});

test("線・円・円弧・楕円・ポリライン（膨らみつき）は SXF の同じ図形で書く。塗りの境界（複合曲線）は図形より先に", () => {
  const d = drawingOf([
    entity("LINE", { a: [0, 0, 0], b: [10, 0, 0] }),
    entity("CIRCLE", { center: [5, 5, 0], radius: 2 }),
    entity("ARC", { center: [5, 5, 0], radius: 3, start: 0, end: Math.PI / 2 }),
    entity("ELLIPSE", { center: [20, 5, 0], major: [4, 0, 0], ratio: 0.5, start: 0, end: 2 * Math.PI }),
    entity("ELLIPSE", { center: [20, 15, 0], major: [0, 4, 0], ratio: 0.5, start: 0, end: Math.PI }),
    entity("LWPOLYLINE", { points: [[0, 20], [10, 20], [10, 30]], bulges: [0, 1], widths: [], constWidth: 0, closed: false, elevation: 0 }),
    entity("CIRCLE", { center: [40, 5, 0], radius: 2, extrusion: [0, 0, -1] }), // −Z は描いた点の列
    entity("SOLID", { points: [[50, 0, 0], [60, 0, 0], [50, 10, 0], [60, 10, 0]] }),
  ]);
  const list = features(drawingToSfc(d, d.layouts[0]).bytes);
  const names = list.map((f) => f.name);
  const count = (n) => names.filter((x) => x === n).length;
  assert.equal(count("circle"), 1);
  assert.equal(count("arc"), 2); // 円弧と、ポリラインの膨らみ
  assert.equal(count("ellipse"), 1);
  assert.equal(count("ellipse_arc"), 1);
  const arc = list.find((f) => f.name === "arc" && f.params[6] === "3");
  assert.deepEqual(arc.params.slice(7), ["0", "0", "90"]);
  const bulge = list.find((f) => f.name === "arc" && f.params[6] === "5"); // (10,20)→(10,30) の半円（反時計回り = 右へ膨らむ）
  assert.deepEqual(bulge.params.slice(4, 10), ["10", "25", "5", "0", "270", "90"]);
  const ea = list.find((f) => f.name === "ellipse_arc");
  assert.deepEqual(ea.params.slice(6, 12), ["4", "2", "0", "90", "0", "180"]);
  // 塗り（SOLID）: 境界の折れ線と複合曲線が、どの図形よりも先。塗りは複合曲線の番号 1 を指す
  const first = names.findIndex((n) => !["layer", "pre_defined_colour", "pre_defined_font", "width", "text_font"].includes(n));
  assert.deepEqual(names.slice(first, first + 2), ["polyline", "composite_curve_org"]);
  const fill = list.find((f) => f.name === "fill_area_style_colour");
  assert.deepEqual(fill.params.slice(2), ["1", "0", "()"]);
  // 部分図にして置き、用紙で閉じる
  assert.deepEqual(names.slice(-3), ["sfig_org", "sfig_locate", "drawing_sheet"]);
});

test("塗りの穴: 内側の輪は穴（含まれる深さで外側と穴を分ける）。幅のある線は区間ごとの四角", () => {
  const ring = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map((p) => [...p, 0]);
  const d = drawingOf([
    entity("HATCH", { solid: true, pattern: "SOLID", loops: [{ points: ring(0, 0, 10), closed: true }, { points: ring(3, 3, 4), closed: true }], lines: [], angle: 0, scale: 1, elevation: 0, extrusion: [0, 0, 1] }),
    entity("LWPOLYLINE", { points: [[20, 0], [30, 0], [30, 10]], bulges: [], widths: [], constWidth: 1, closed: false, elevation: 0 }),
  ]);
  const list = features(drawingToSfc(d, d.layouts[0]).bytes);
  const fills = list.filter((f) => f.name === "fill_area_style_colour");
  assert.deepEqual(fills[0].params.slice(2), ["1", "1", "(2)"]); // 外側 1・穴 1 つ（2）
  assert.equal(fills.length, 3); // ハッチング 1 と、幅のある線の 2 区間
  assert.equal(list.filter((f) => f.name === "composite_curve_org").length, 4);
});

test("SXF を読んで書くと、図面の属性（表題）と用紙が戻る", () => {
  const sxf = read(path.join(ROOT, "samples/dwg/SXF_A1_円筒_部品図.sfc"));
  const back = readDrawing(drawingToSfc(sxf, sxf.layouts[0]).bytes, "x.sfc");
  assert.deepEqual(back.titleBlock, sxf.titleBlock);
  assert.deepEqual(back.sheet, sxf.sheet);
  for (const name of back.layers.keys()) assert.ok(sxf.layers.has(name), `画層 ${name}`);
});

test("画層の名前: Shift_JIS にして重なる名前は番号を足して分ける（別の画層のまま）", () => {
  const d = drawingOf([entity("LINE", { a: [0, 0, 0], b: [1, 0, 0], layer: "😀" }), entity("LINE", { a: [0, 1, 0], b: [1, 1, 0], layer: "🍣" })]);
  for (const name of ["😀", "🍣"]) d.layers.set(name, { ...d.layers.get("0"), name });
  const layers = features(drawingToSfc(d, d.layouts[0]).bytes).filter((f) => f.name === "layer").map((f) => f.params[0]);
  assert.deepEqual(layers, ["?", "?_2"]);
});
