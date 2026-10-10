// DXF の書き出し（formats/cad2d/to-dxf.js）の評価: 図面を読み → DXF に書き → 読み直すと、書く前（書ける形に整えた写し）と
// 全ての図形・表・ブロック・レイアウトが一致する（R2013 と R2000）。整え方（名前・ハンドル・パス・書けない図形）と、Shift_JIS の書き方。
// 別の読み取り（ezdxf）での検査は開発の道具 program/tools/dxf_audit.py（docs/editing.md §5）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { encodeShiftJis } from "../../app/static/js/core/sjis.js";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { createDrawing } from "../../app/static/js/formats/cad2d/model.js";
import { drawingToDxf, dxfNotes, pathToEntities, prepareForDxf } from "../../app/static/js/formats/cad2d/to-dxf.js";
import { curvePoint } from "../../app/static/js/model/curves.js";
import { neutralSpline } from "../../app/static/js/formats/cad2d/curves.js";
import { roundTrip } from "../../tools/dxf-write-check.mjs";
import { ROOT } from "./helpers.mjs";

const DIRS = [path.join(ROOT, "samples/dwg"), path.join(ROOT, "tests/fixtures/drawings"), path.join(ROOT, "tests/fixtures/drawings/sxf")];
const DRAWINGS = DIRS.flatMap((dir) => fs.readdirSync(dir).filter((n) => /\.(dwg|dxf|jww|sfc|p21|pdf)$/i.test(n)).map((n) => path.join(dir, n)));
const read = (file) => readDrawing(new Uint8Array(fs.readFileSync(file)), file);
const entity = (type, extra = {}) => ({ type, handle: "", layer: "0", color: { index: 256 }, linetype: "BYLAYER", lineweight: -1, ltscale: 1, invisible: false, ...extra });
/** 図形を並べただけの図面（モデル空間に） */
function drawingOf(entities, more = {}) {
  const d = createDrawing({ format: "dxf", version: "R2018" });
  d.blocks.set("*Model_Space", { name: "*Model_Space", handle: "1F", base: [0, 0, 0], entities });
  d.layouts = [{ name: "Model", block: "*Model_Space", model: true, tabOrder: 0 }];
  return Object.assign(d, more);
}

test("サンプルと試験の図面の全て（DWG・DXF・Jw_cad・SXF・PDF）: DXF に書いて読み直すと、全ての図形・表・レイアウトが一致する（R2013・R2000）", () => {
  assert.ok(DRAWINGS.length >= 15, `図面 ${DRAWINGS.length}`);
  let total = 0;
  for (const file of DRAWINGS) {
    const drawing = read(file);
    for (const version of ["R2013", "R2000"]) {
      const r = roundTrip(drawing, { version });
      const name = `${path.basename(file)} ${version}`;
      assert.deepEqual([r.entities.onlyA, r.entities.onlyB], [[], []], name);
      assert.deepEqual(r.entities.diffs, [], name);
      assert.deepEqual(r.tables, [], name);
      assert.equal(r.again.version, version, name);
      total += r.entities.compared;
    }
  }
  assert.ok(total > 10000, `比べた図形 ${total}`);
});

test("書けない図形は書かずに数え、DXF に無い図形は同じ形に直す（説明の行も）", () => {
  const acad = prepareForDxf(read(path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg"))).notes;
  assert.equal(acad.dropped.get("ACIS"), 3); // 3D の立体（ACIS）は、まだ書かない
  const pdf = prepareForDxf(read(path.join(ROOT, "samples/dwg/JPL_rover_top_front.pdf")));
  assert.equal(pdf.notes.dropped.get("IMAGE"), 1);
  assert.equal(pdf.notes.converted.get("PATH"), 3);
  assert.ok(pdf.notes.emptyModel);
  const lines = dxfNotes(pdf.notes);
  assert.ok(lines.some((l) => /画像/.test(l)) && lines.some((l) => /パス/.test(l)) && lines.some((l) => /紙のレイアウト/.test(l)), lines.join("\n"));
  // モデルの無い図面: 空のモデルを足し、紙のレイアウトは *Paper_Space に。開くとレイアウトが出る
  const text = new TextDecoder().decode(drawingToDxf(pdf.drawing).bytes);
  assert.match(text, /\$TILEMODE\r\n 70\r\n0\r\n/);
  assert.deepEqual(pdf.drawing.layouts.map((l) => [l.block, l.model]), [["*Model_Space", true], ["*Paper_Space", false]]);
  assert.deepEqual(dxfNotes(prepareForDxf(read(path.join(ROOT, "samples/dwg/JPL_rover_side_plate.dxf"))).notes), []);
});

test("名前: AutoCAD で使えない文字は _ に、大文字・小文字だけ違う名前は分け、参照も付け替える", () => {
  const d = drawingOf([
    entity("LINE", { handle: "A1", layer: "壁/外", a: [0, 0, 0], b: [1, 0, 0] }),
    entity("LINE", { handle: "A2", layer: "wall", a: [0, 0, 0], b: [0, 1, 0] }),
    entity("LINE", { handle: "A3", layer: "WALL", linetype: "点線?", a: [0, 0, 0], b: [1, 1, 0] }),
    entity("TEXT", { handle: "A4", layer: "*ADSK_SYSTEM", style: "明朝:太", p: [0, 0, 0], align: null, height: 2.5, rotation: 0, widthFactor: 1, oblique: 0,
      halign: 0, valign: 0, generation: 0, text: "A^B\n2 行目", extrusion: [0, 0, 1] }),
    entity("INSERT", { handle: "A5", block: "部品<1>", p: [5, 5, 0], scale: [1, 1, 1], rotation: 0, extrusion: [0, 0, 1], columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] }),
  ]);
  d.blocks.set("部品<1>", { name: "部品<1>", handle: "", base: [0, 0, 0], entities: [entity("CIRCLE", { handle: "B1", center: [0, 0, 0], radius: 1, extrusion: [0, 0, 1] })] });
  d.linetypes.set("点線?", { name: "点線?", description: "", dashes: [1, -0.5] });
  const r = roundTrip(d, { version: "R2013" });
  assert.deepEqual([r.entities.diffs, r.tables], [[], []]);
  const layers = [...r.again.layers.keys()];
  assert.ok(layers.includes("壁_外") && layers.includes("*ADSK_SYSTEM"), layers.join());
  assert.equal(new Set(layers.map((n) => n.toLowerCase())).size, layers.length); // wall と WALL は別の名前に
  const model = r.again.blocks.get("*Model_Space").entities;
  assert.equal(model.find((e) => e.handle === "A3").linetype, "点線_");
  assert.equal(model.find((e) => e.handle === "A4").style, "明朝_太");
  assert.equal(model.find((e) => e.handle === "A4").text, "A^B\n2 行目"); // ^ と改行は逃がして書き、戻る
  assert.equal(model.find((e) => e.handle === "A5").block, "部品_1_");
  assert.ok(r.again.blocks.get("部品_1_").entities.length === 1);
  assert.ok(dxfNotes(r.notes).some((l) => /画層の名前/.test(l)));
});

test("ハンドル: 無い・16 進でない・重なるものは新しい番号に（元の番号は残す）。$HANDSEED は全ての番号より大きい", () => {
  const d = drawingOf([
    entity("POINT", { handle: "1.A", p: [0, 0, 0] }), entity("POINT", { handle: "", p: [1, 0, 0] }),
    entity("POINT", { handle: "2B", p: [2, 0, 0] }), entity("POINT", { handle: "2B", p: [3, 0, 0] }),
  ]);
  const { bytes, drawing } = drawingToDxf(d);
  const handles = drawing.blocks.get("*Model_Space").entities.map((e) => e.handle);
  assert.equal(handles[2], "2B");
  assert.ok(handles.every((h) => /^[0-9A-F]+$/.test(h)) && new Set(handles).size === 4, handles.join());
  const text = new TextDecoder().decode(bytes).split("ENDSEC")[1]; // 見出しの後ろ（$HANDSEED の値は除く）
  const all = [...text.matchAll(/\r\n {2}5\r\n([0-9A-F]+)\r\n|\r\n105\r\n([0-9A-F]+)\r\n/g)].map((m) => parseInt(m[1] ?? m[2], 16));
  assert.equal(new Set(all).size, all.length); // ファイルの中で番号が重ならない
  const seed = parseInt(new TextDecoder().decode(bytes).match(/\$HANDSEED\r\n {2}5\r\n([0-9A-F]+)/)[1], 16);
  assert.ok(seed > Math.max(...all));
});

test("パス: 塗りはハッチング・直線だけの線はポリライン・曲線を含む線は同じ形のスプライン・破線は線種", () => {
  const sub = { points: [0, 0, 10, 0, 10, 10, 0, 10], curves: [[1, 15, 3, 15, 7]], closed: true };
  const line = pathToEntities({ ...entity("PATH", { handle: "P" }), subpaths: [sub], fill: null, width: 0.35, dashes: [2, 1], cap: 0, alpha: 1 }, (dashes) => `D${dashes}`);
  assert.equal(line.length, 1);
  const [spline] = line;
  assert.equal(spline.type, "SPLINE");
  assert.equal(spline.lineweight, 35);
  assert.equal(spline.linetype, "D2,-1");
  // ベジェ（10,0）→（15,3）（15,7）→（10,10）とスプラインが同じ曲線（区間 1 の媒介変数 1〜2）
  const controls = [[10, 0], [15, 3], [15, 7], [10, 10]];
  const bezier = (t) => [0, 1].map((k) => controls.reduce((s, p, i) => s + p[k] * [1, 3, 3, 1][i] * t ** i * (1 - t) ** (3 - i), 0));
  for (const t of [0, 0.25, 0.5, 0.9, 1]) {
    const p = curvePoint(neutralSpline(spline), 1 + t);
    const q = bezier(t);
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-12, `${t}: ${p} / ${q}`);
  }
  // 閉じた区切り: 最後の点から最初の点への直線もスプラインに入る（4 区間）
  assert.equal(spline.knots.at(-1), 4);
  const straight = pathToEntities({ ...entity("PATH"), subpaths: [{ points: [0, 0, 5, 0, 5, 5, 0, 0], closed: true }], fill: null, width: 0 }, () => "x");
  assert.deepEqual(straight.map((e) => [e.type, e.points.length, e.closed]), [["LWPOLYLINE", 3, true]]);
  const fill = pathToEntities({ ...entity("PATH"), subpaths: [sub, { points: [2, 2, 4, 2, 4, 4], closed: true }], fill: "evenodd", width: 0 }, () => "x");
  assert.deepEqual(fill.map((e) => [e.type, e.solid, e.loops.length]), [["HATCH", true, 2]]);
  assert.deepEqual(fill[0].loops.map((l) => (l.points ? "points" : l.edges.map((e) => e.kind).join())), ["line,spline,line,line", "points"]);
});

test("文字: R2013 は UTF-8、R2000 は Shift_JIS（無い文字は \\U+XXXX）。長い複数行の文字は 250 バイトずつに分けて書き、戻る", () => {
  const long = "設計の注記。".repeat(60) + "\\P2 行目 é ①";
  const mtext = entity("MTEXT", { handle: "M1", p: [0, 0, 0], direction: [1, 0, 0], extrusion: [0, 0, 1], height: 3.5, width: 100, attach: 1, drawing: 1,
    text: long, style: "Standard", lineSpacing: 1 });
  for (const version of ["R2013", "R2000"]) {
    const r = roundTrip(drawingOf([mtext]), { version });
    assert.deepEqual(r.entities.diffs, [], version);
    const raw = r.bytes;
    if (version === "R2013") assert.match(new TextDecoder().decode(raw), /\r\n {2}3\r\n設計の注記/);
    else {
      assert.match(new TextDecoder("shift_jis").decode(raw), /ANSI_932[\s\S]*設計の注記/);
      assert.ok(new TextDecoder("latin1").decode(raw).includes("\\U+00E9")); // é は Shift_JIS に無い。① は CP932 にある
      assert.deepEqual([r.notes.escaped, r.notes.replaced], [1, 0]);
    }
  }
  // R2000 で表せない文字（4 桁に収まらない 𠮷）は ? にして数える
  const lost = drawingToDxf(drawingOf([{ ...mtext, text: "𠮷野" }]), { version: "R2000" });
  assert.equal(readDrawing(lost.bytes, "x.dxf").blocks.get("*Model_Space").entities[0].text, "?野");
  assert.ok(dxfNotes(lost.notes).some((l) => /\? にした/.test(l)));
  const { bytes, unmapped } = encodeShiftJis("ｱｲｳ 寸法 ①Ⅱ ~ é", () => "?");
  assert.equal(new TextDecoder("shift_jis").decode(bytes), "ｱｲｳ 寸法 ①Ⅱ ~ ?");
  assert.equal(unmapped, 1);
});

test("読めない版は書かない。書いた DXF の先頭は版と文字コードの見出し", () => {
  assert.throws(() => drawingToDxf(drawingOf([]), { version: "R12" }), /R12/);
  const text = new TextDecoder().decode(drawingToDxf(drawingOf([])).bytes);
  assert.match(text, /^ {2}0\r\nSECTION\r\n {2}2\r\nHEADER\r\n {2}9\r\n\$ACADVER\r\n {2}1\r\nAC1027\r\n/);
  assert.match(text, /EOF\r\n$/);
});
