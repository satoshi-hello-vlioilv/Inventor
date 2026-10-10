// 2D の図形を動かす・回す・拡大する（formats/cad2d/transform.js）の評価: 動かした図形を描いたもの（viewer2d/scene.js）と、
// 元の描画を同じ変換で動かしたものが一致する（tools/edit2d-check.mjs）。サンプルの図面の全ての図形と、サンプルに無い向きの図形
// （押し出しが −Z の円・円弧・ポリライン・文字・ブロック参照・ハッチング・塗り。時計回りの円弧の辺のハッチング）で確かめる。
// 後半は直す命令（edit/drawing.js）: 取り消し・やり直しで図面がぴったり戻る・直した図面も DXF に書いて戻る・直せないときは何も変えない。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { createDrawing } from "../../app/static/js/formats/cad2d/model.js";
import { EditError, compose, editableReason, similarity, transformEntity } from "../../app/static/js/formats/cad2d/transform.js";
import { DrawingEdits } from "../../app/static/js/edit/drawing.js";
import { roundTrip } from "../../tools/dxf-write-check.mjs";
import { checkDrawing } from "../../tools/edit2d-check.mjs";
import { ROOT } from "./helpers.mjs";

const DIRS = [path.join(ROOT, "samples/dwg"), path.join(ROOT, "tests/fixtures/drawings/sxf")];
const base = (type, extra) => ({ type, handle: "", layer: "0", color: { index: 256 }, linetype: "BYLAYER", lineweight: -1, ltscale: 1, invisible: false, ...extra });
const DOWN = [0, 0, -1];

/** サンプルに無い向きの図形を並べた図面（押し出し −Z・時計回りの円弧の辺） */
export function unusualDrawing() {
  const d = createDrawing({ format: "dxf", version: "R2018" });
  d.layers.set("0", { name: "0", color: { index: 7 }, off: false, frozen: false, locked: false, plot: true, linetype: "Continuous", lineweight: -3 });
  d.blocks.set("部品", { name: "部品", handle: "", base: [1, 2, 0], entities: [
    base("LINE", { a: [0, 0, 0], b: [10, 0, 0] }), base("ARC", { center: [5, 0, 0], radius: 5, start: 0.3, end: 2.5, extrusion: [0, 0, 1] }),
    base("TEXT", { p: [0, 1, 0], align: null, height: 2, rotation: 0.4, widthFactor: 1, oblique: 0, halign: 0, valign: 0, generation: 0, text: "A1", style: "Standard", extrusion: [0, 0, 1] }),
  ] });
  const text = { align: null, height: 3, rotation: 0.5, widthFactor: 1, oblique: 0, halign: 0, valign: 0, generation: 0, text: "−Z の文字", style: "Standard" };
  const arcEdge = (ccw) => ({ kind: "arc", center: [30, 30], radius: 10, start: ccw ? 0 : -Math.PI, end: ccw ? Math.PI : 0, ccw });
  const entities = [
    base("CIRCLE", { center: [20, 5, 0], radius: 4, extrusion: DOWN }),
    base("ARC", { center: [20, 5, 0], radius: 7, start: 0.2, end: 2, extrusion: DOWN }),
    base("LWPOLYLINE", { points: [[0, 0], [10, 0], [10, 6], [0, 6]], bulges: [0, 0.5, 0, 0], widths: [[0, 0], [0, 0], [0, 0], [0, 0]], constWidth: 0, closed: true, elevation: 0, extrusion: DOWN }),
    base("POLYLINE", { kind: "2d", closed: false, elevation: 0, extrusion: DOWN, vertices: [{ p: [0, 0, 0], bulge: 0.3 }, { p: [8, 2, 0], bulge: 0 }, { p: [12, -3, 0], bulge: 0 }] }),
    base("TEXT", { ...text, p: [5, 20, 0], extrusion: DOWN }),
    base("TEXT", { ...text, p: [5, 25, 0], align: [15, 25, 0], halign: 1, extrusion: DOWN }),
    base("INSERT", { block: "部品", p: [40, 10, 0], scale: [1, 1, 1], rotation: 0.6, extrusion: DOWN, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] }),
    base("SOLID", { points: [[0, 40, 0], [6, 40, 0], [0, 46, 0], [6, 46, 0]], extrusion: DOWN }),
    // 時計回りの円弧の辺（DXF の約束で角度は補角）と、−Z のハッチング
    base("HATCH", { loops: [{ flags: 1, edges: [{ kind: "line", a: [20, 30], b: [40, 30] }, arcEdge(false)] }], solid: true, pattern: "SOLID", angle: 0, scale: 1,
      lines: [], elevation: 0, extrusion: [0, 0, 1], style: 0, gradient: false }),
    base("HATCH", { loops: [{ flags: 1, edges: [{ kind: "line", a: [40, 30], b: [20, 30] }, arcEdge(true)] }], solid: false, pattern: "ANSI31", angle: 0.785, scale: 1,
      lines: [{ angle: 0.785, base: [0, 0], offset: [-2.2, 2.2], dashes: [] }], elevation: 0, extrusion: DOWN, style: 0, gradient: false }),
    base("HATCH", { loops: [{ flags: 1, edges: [{ kind: "ellipse", center: [60, 30], major: [8, 2], ratio: 0.5, start: -Math.PI, end: 0, ccw: false },
      { kind: "line", a: [60 - 8, 30 - 2], b: [68, 32] }] }], solid: true, pattern: "SOLID", angle: 0, scale: 1, lines: [], elevation: 0, extrusion: [0, 0, 1], style: 0, gradient: false }),
  ];
  d.blocks.set("*Model_Space", { name: "*Model_Space", handle: "", base: [0, 0, 0], entities });
  d.layouts = [{ name: "Model", block: "*Model_Space", model: true, tabOrder: 0 }];
  return d;
}

test("サンプルの図面の全ての図形: 動かす・回す・拡大して描いたものが、元の描画を同じだけ動かしたものと一致する", () => {
  let tried = 0;
  for (const dir of DIRS) {
    for (const name of fs.readdirSync(dir).filter((n) => /\.(dwg|dxf|jww|sfc|p21)$/i.test(n))) {
      const r = checkDrawing(readDrawing(new Uint8Array(fs.readFileSync(path.join(dir, name))), name));
      assert.deepEqual(r.failures, [], name);
      tried += r.tried;
    }
  }
  assert.ok(tried > 1000, `試した数 ${tried}`);
});

test("サンプルに無い向きの図形（押し出し −Z・時計回りの円弧の辺のハッチング）も一致する", () => {
  const r = checkDrawing(unusualDrawing());
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, 11 * 3);
});

test("直せない図形は理由を返す（ビューポート・3D の立体・図面の面に平行でない図形・鏡に映す変換）", () => {
  assert.match(editableReason(base("VIEWPORT", {})), /ビューポート/);
  assert.match(editableReason(base("ACIS", {})), /3D/);
  assert.equal(editableReason(base("LINE", {})), null);
  const tilted = base("CIRCLE", { center: [0, 0, 0], radius: 1, extrusion: [0, 1, 1] });
  assert.throws(() => transformEntity(tilted, similarity({ move: [1, 0] })), (e) => e instanceof EditError && /3D の向き/.test(e.message));
  const mirror = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  assert.throws(() => transformEntity(base("LINE", { a: [0, 0, 0], b: [1, 0, 0] }), mirror), /鏡/);
});

test("変換: 合成・中心のまわりの回転・元の図形を変えない", () => {
  const m = similarity({ angle: Math.PI / 2, center: [1, 1] });
  const line = base("LINE", { a: [2, 1, 5], b: [1, 1, 0] });
  const moved = transformEntity(line, m);
  assert.deepEqual(moved.a.map((v) => Number(v.toFixed(12)) + 0), [1, 2, 5]); // Z はそのまま
  assert.deepEqual(line.a, [2, 1, 5]);
  const back = compose(similarity({ angle: -Math.PI / 2, center: [1, 1] }), m);
  assert.ok(Math.abs(back.a - 1) < 1e-12 && Math.abs(back.e) < 1e-12 && Math.abs(back.f) < 1e-12);
});

// ---- 直す命令と取り消し（edit/drawing.js）------------------------------------------------------------------------------
const snapshot = (d) => JSON.stringify([...d.blocks].map(([k, b]) => [k, b.base, b.entities]));
const sampleDrawing = () => readDrawing(new Uint8Array(fs.readFileSync(path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf"))), "a.dxf");

test("命令: 動かす・回す・写す・消す・画層・文字。取り消すと元に、やり直すと直した後に、ぴったり戻る", () => {
  const drawing = sampleDrawing();
  let changes = 0;
  const edits = new DrawingEdits({ onChange: () => changes++ });
  edits.open(drawing);
  const model = drawing.blocks.get("*Model_Space");
  const all = model.entities.filter((e) => !edits.reason([e]));
  const dims = all.filter((e) => e.type === "DIMENSION");
  assert.ok(all.length > 30 && dims.length > 0, `${all.length}`);
  const original = snapshot(drawing);
  const steps = [
    ["動かす", () => edits.move(all, [12.5, -3])],
    ["回す", () => edits.rotate(all.slice(0, 20), [100, 50], Math.PI / 5)],
    ["写す", () => edits.copy(dims.concat(all.slice(0, 5)), [0, 80])],
    ["消す", () => edits.remove(all.filter((_, i) => i % 3 === 0))],
    ["画層", () => edits.setLayer(all.filter((_, i) => i % 3 !== 0).slice(0, 4), "中心線")],
    ["文字", () => edits.setText(all.find((e, i) => /TEXT/.test(e.type) && i % 3 !== 0), "直した文字")],
  ];
  const states = [original];
  for (const [name, run] of steps) {
    run();
    states.push(snapshot(drawing));
    assert.notEqual(states.at(-1), states.at(-2), name);
  }
  assert.equal(changes, steps.length + 1); // open の clear も知らせる
  assert.ok(edits.history.dirty);
  for (let i = steps.length; i > 0; i--) {
    assert.ok(edits.history.undo());
    assert.equal(snapshot(drawing), states[i - 1], `${steps[i - 1][0]} を取り消す`);
  }
  assert.ok(!edits.history.dirty);
  for (let i = 1; i <= steps.length; i++) {
    assert.ok(edits.history.redo());
    assert.equal(snapshot(drawing), states[i], `${steps[i - 1][0]} をやり直す`);
  }
});

test("命令: 動かした図形は transformEntity と同じ値・寸法は見た目のブロックも動く・写した寸法は自分のブロックを持つ。直した図面も DXF に書いて戻る", () => {
  const drawing = sampleDrawing();
  const edits = new DrawingEdits();
  edits.open(drawing);
  const model = drawing.blocks.get("*Model_Space");
  const dim = model.entities.find((e) => e.type === "DIMENSION");
  const line = model.entities.find((e) => e.type === "LINE");
  const [dimBefore, lineBefore, blockBefore] = [{ ...dim }, { ...line }, drawing.blocks.get(dim.block).entities];
  edits.move([dim, line], [10, 20]);
  const m = similarity({ move: [10, 20] });
  assert.deepEqual(line, transformEntity(lineBefore, m));
  assert.deepEqual(dim, transformEntity(dimBefore, m));
  assert.deepEqual(drawing.blocks.get(dim.block).entities, blockBefore.map((e) => transformEntity(e, m)));
  const [copy] = edits.copy([dim], [0, 50]);
  assert.notEqual(copy.block, dim.block);
  assert.ok(/^\*D\d+$/.test(copy.block) && drawing.blocks.get(copy.block).entities.length === blockBefore.length);
  assert.equal(copy.handle, "");
  edits.rotate([copy], [0, 0], 0.3);
  edits.setText(model.entities.find((e) => e.type === "MTEXT"), "注記\\P直した 2 行目");
  const r = roundTrip(drawing, { version: "R2013" });
  assert.deepEqual([r.entities.diffs, r.entities.onlyA, r.entities.onlyB, r.tables], [[], [], [], []]);
  assert.equal(r.again.blocks.get("*Model_Space").entities.length, model.entities.length);
  edits.history.undo(); // 文字
  edits.history.undo(); // 回す
  edits.history.undo(); // 写す: 写したブロックも消える
  assert.ok(!drawing.blocks.has(copy.block));
});

test("命令: 直せないときは理由を出し、何も変えない（ロックした画層・無い画層・ブロックの中・ビューポート・文字でない図形）", () => {
  const drawing = sampleDrawing();
  const edits = new DrawingEdits();
  edits.open(drawing);
  const model = drawing.blocks.get("*Model_Space");
  const line = model.entities.find((e) => e.type === "LINE");
  const before = snapshot(drawing);
  assert.throws(() => edits.setLayer([line], "無い画層"), (e) => e instanceof EditError && /無い画層/.test(e.message));
  assert.throws(() => edits.setText(line, "x"), /文字の図形/);
  const inBlock = [...drawing.blocks.values()].find((b) => !/^\*/.test(b.name) && b.entities.length).entities[0];
  assert.match(edits.reason([inBlock]), /ブロックの中/);
  const viewport = [...drawing.blocks.values()].flatMap((b) => b.entities).find((e) => e.type === "VIEWPORT");
  assert.match(edits.reason([viewport]), /ビューポート/);
  drawing.layers.get(line.layer).locked = true;
  assert.match(edits.reason([line]), /ロック/);
  assert.throws(() => edits.move([model.entities.find((e) => e !== line && e.layer !== line.layer && !edits.reason([e])), line], [1, 1]), /ロック/);
  assert.equal(snapshot(drawing), before);
  assert.ok(!edits.history.canUndo);
  assert.equal(edits.reason([]), "直す図形を選んでください");
});
