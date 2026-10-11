// 注記（表・幾何公差・マルチ引出線）の評価: DWG・DXF の読み取り（寸法スタイルも）・描き方（AutoCAD が図形に添えた見本の描画 = 代理図形の値）・
// 部品に分ける（annotation.js）・DXF の書き出しと読み直し・動かす。開発の道具 program/tools/annotation-check.mjs が全ての試料で
// 代理図形と突き合わせる（docs/drawing2d.md §注記）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { annotationParts } from "../../app/static/js/formats/cad2d/annotation.js";
import { gdtRuns } from "../../app/static/js/formats/cad2d/gdt.js";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { createDrawing, dimVar, rawColor } from "../../app/static/js/formats/cad2d/model.js";
import { drawingToDxf } from "../../app/static/js/formats/cad2d/to-dxf.js";
import { EditError, similarity, transformEntity } from "../../app/static/js/formats/cad2d/transform.js";
import { toleranceText } from "../../app/static/js/viewer2d/describe.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { ROOT } from "./helpers.mjs";

const SAMPLE = path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg");
const read = (file) => readDrawing(new Uint8Array(fs.readFileSync(file)), file);
const all = (d) => [...d.blocks.values()].flatMap((b) => b.entities);
const byHandle = (d, h) => all(d).find((e) => e.handle === h);
const near = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** 図形 1 つだけの図面（寸法スタイルを足せる） */
function single(e, dimstyles = []) {
  const d = createDrawing({ format: "dxf", version: "R2018" });
  d.blocks.set("*Model_Space", { name: "*Model_Space", handle: "1F", base: [0, 0, 0], entities: [e] });
  d.layouts = [{ name: "Model", block: "*Model_Space", model: true, tabOrder: 0 }];
  for (const s of dimstyles) d.dimstyles.set(s.name, s);
  return d;
}
/** 場面の線（点の並び）と塗り */
const strokesOf = (scene) => scene.strokes.flatMap((s) => s.lines.map((l) => [...l.points]));

test("DWG（R2004）: 表 2・幾何公差 3・マルチ引出線 15 を読み、まだ描かない図形に数えない。寸法スタイルの値も読む", () => {
  const d = read(SAMPLE);
  const count = (t) => all(d).filter((e) => e.type === t).length;
  assert.deepEqual([count("ACAD_TABLE"), count("TOLERANCE"), count("MULTILEADER")], [2, 3, 15]);
  for (const t of ["ACAD_TABLE", "TOLERANCE", "MULTILEADER"]) assert.ok(!d.unsupported.has(t), t);
  assert.deepEqual([40, 41, 140, 147].map((c) => dimVar(d, "ISO-25", {}, c)), [1, 2.5, 2.5, 0.625]);
  assert.equal(dimVar(d, "custom_dim_style", {}, 178).index, 151);
  assert.equal(byHandle(d, "822").text, "{\\Fgdt;j}%%v{\\Fgdt;n}%%v%%v%%v%%v\n{\\Fgdt;d}%%v%%v%%v%%v%%v\n.5\n5");
  assert.equal(byHandle(d, "528").block.startsWith("*T"), true);
});

test("DWG の RGB の色（CMC）: 画層の色番号を 0（ブロックの色）にせず近い番号にし、画面は RGB で描く", () => {
  const d = read(SAMPLE);
  const layer = d.layers.get("Layer_true_color");
  assert.deepEqual(layer.color, { index: 150, rgb: 0x1192ee }); // AutoCAD が DXF に書く番号と同じ
  assert.equal(rawColor(0xc2123456 | 0).rgb, 0x123456);
  assert.deepEqual([rawColor(0xc0000000 | 0), rawColor(0xc1000000 | 0), rawColor(0xc3000005 | 0)], [{ index: 256 }, { index: 0 }, { index: 5 }]);
});

test("マルチ引出線: AutoCAD の代理図形と同じ線（矢印の分だけ短い引出線・折れ線）と、塗った矢印", () => {
  const d = read(SAMPLE);
  const e = byHandle(d, "7B8");
  const scene = buildScene(single(e), { block: "*Model_Space", model: true });
  const lines = strokesOf(scene);
  // AutoCAD の代理図形（sample_AC1027_ascii.dxf の 7B8 を ezdxf で読み解いた値）: 引出線と折れ線
  assert.ok(lines.some((p) => near(p, [1050.405, 8.25, 1083.321, 23.239])), JSON.stringify(lines));
  assert.ok(lines.some((p) => near(p, [1083.321, 23.239, 1083.681, 23.239])));
  assert.equal(scene.fills.length, 1); // 塗った矢印（開き 18.92°・長さ 0.18）
  const ring = [...scene.fills[0].rings[0]];
  assert.ok(near(ring.slice(0, 2), [1050.242, 8.176]));
  assert.deepEqual(scene.texts.map((t) => t.lines.join(" ")), ["MLeader text, hello!"]);
});

test("マルチ引出線の文字の枠: 引出線の側の辺はつなぐ点に、ほかの辺は文字の外形 ＋ 余白（AutoCAD の代理図形の値）", () => {
  const d = read(SAMPLE);
  const e = byHandle(d, "B1E"); // 右上揃えの 3 行・余白 2
  const frame = annotationParts(e, d).find((p) => p.type === "LWPOLYLINE" && p.closed);
  const xs = frame.points.map((p) => p[0]), ys = frame.points.map((p) => p[1]);
  assert.ok(near([Math.min(...xs), Math.max(...xs), Math.max(...ys)], [717.319, 759.957, -429.971]), JSON.stringify(frame.points));
  assert.ok(Math.abs(Math.min(...ys) - -451.459) < 0.2); // 下の辺は行の間隔の見積もりで、わずかに違う
});

test("幾何公差: 箱の高さ = 文字の高さの 2 倍、記号は形（線と円）で描く。寸法スタイルと図形の上書きの値を使う", () => {
  const e = { type: "TOLERANCE", handle: "A", layer: "0", color: { index: 256 }, linetype: "BYLAYER", lineweight: -1, p: [10, 20, 0], direction: [1, 0, 0],
    extrusion: [0, 0, 1], text: "{\\Fgdt;j}%%v{\\Fgdt;n}0.05{\\Fgdt;m}%%vA", dimstyle: "ISO", overrides: { 140: 3.5 } };
  const d = single(e, [{ name: "ISO", values: { 40: 1, 140: 2.5, 147: 0.625 }, textStyle: "Standard" }]);
  const parts = annotationParts(e, d);
  const boxes = parts.filter((p) => p.type === "LWPOLYLINE" && p.closed);
  assert.equal(boxes.length, 3);
  for (const b of boxes) {
    const ys = b.points.map((p) => p[1]);
    assert.ok(near([Math.min(...ys), Math.max(...ys)], [20 - 3.5, 20 + 3.5])); // 上書きの文字の高さ 3.5 × 2
  }
  assert.ok(near(boxes[0].points[0], [10, 16.5])); // 置く点 = 1 段目の左の真ん中
  assert.ok(parts.some((p) => p.type === "CIRCLE")); // 位置度・直径・最大実体の円
  assert.deepEqual(parts.filter((p) => p.type === "TEXT").map((t) => t.text), ["0.05", "M", "A"]);
  assert.equal(toleranceText(e.text), "位置度 | 直径 0.05 最大実体 | A");
  assert.deepEqual(gdtRuns("{\\Fgdt;r}%%c0.1"), [{ glyph: "r" }, { text: "⌀0.1" }]);
});

test("DXF に書いて読み直すと、描いたものが同じ（表 → ブロック参照・マルチ引出線 → 部品・幾何公差はそのまま、上書きも）", () => {
  const d = read(SAMPLE);
  const tol = byHandle(d, "822");
  tol.overrides = { 140: 0.3 };
  for (const b of d.blocks.values()) b.entities = b.entities.filter((e) => e.type !== "ACIS"); // 3D の立体は DXF に書かない（比べない）
  for (const version of ["R2013", "R2000"]) {
    const { bytes, notes } = drawingToDxf(d, { version });
    assert.deepEqual([notes.converted.get("ACAD_TABLE"), notes.converted.get("MULTILEADER")], [2, 15]);
    const back = readDrawing(bytes, "x.dxf");
    assert.deepEqual(byHandle(back, "822").overrides, { 140: 0.3 }, version);
    assert.equal(dimVar(back, "ISO-25", {}, 147), 0.625);
    const model = (x) => buildScene(x, x.layouts.find((l) => l.model));
    const [a, b] = [model(d), model(back)];
    const key = (p) => p.map((v) => v.toFixed(6)).join(",");
    const sa = new Set(strokesOf(a).map(key)), sb = new Set(strokesOf(b).map(key));
    const missing = [...sa].filter((k) => !sb.has(k));
    assert.deepEqual(missing, [], version);
    assert.deepEqual(b.texts.map((t) => t.lines.join("|")).sort(), a.texts.map((t) => t.lines.join("|")).sort(), version);
    assert.equal(b.fills.length, a.fills.length);
  }
});

test("動かす・回す: 注記の描いたものが同じだけ動く。幾何公差の拡大は理由を添えて断る", () => {
  const d = read(SAMPLE);
  // 図形 1 つだけを置いた図面（ブロック・寸法スタイルは元の図面のもの）
  const only = (e) => ({ ...d, blocks: new Map([...d.blocks, ["*Model_Space", { name: "*Model_Space", base: [0, 0, 0], entities: [e] }]]) });
  const scene = (e) => buildScene(only(e), { block: "*Model_Space", model: true });
  const key = (p) => p.map((v) => v.toFixed(6)).join(",");
  const m = similarity({ move: [5, -3] });
  for (const h of ["7B8", "B21", "822", "528"]) {
    const e = byHandle(d, h);
    const want = new Set(strokesOf(scene(e)).map((p) => key(p.map((v, i) => v + (i % 2 ? -3 : 5)))));
    const got = strokesOf(scene(transformEntity(e, m)));
    assert.ok(got.length > 0 && got.length === want.size, `${h}: ${got.length}/${want.size}`);
    for (const p of got) assert.ok(want.has(key(p)), h);
  }
  assert.throws(() => transformEntity(byHandle(d, "822"), similarity({ scale: 2 })), EditError);
  const table = transformEntity(byHandle(d, "528"), similarity({ angle: Math.PI / 2 }));
  assert.ok(near(table.direction, [0, 1, 0], 1e-9));
});
