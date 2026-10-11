// 図面の旧版と新版を比べる（formats/cad2d/compare.js）の評価:
//   ・決まった直し（動かす・回す・消す・写す・画層・文字）を当てた新版で、直した図形の見落とし 0・直していない図形への誤り 0
//     （ハンドルのまま・振り直した・無しの 3 通り × 乱数の種 3 つ。ハンドルのままなら分け方も正しい）: tools/drawing-compare-check.mjs
//   ・同じ図面どうし・既定の値の書き方だけが違う図面・DXF に書いて読み直した DXF・数に書き出しの丸めほどの差がある図面は、全て「同じ」
//   ・ブロックの中身を直すと、そのブロックの参照だけが「変わった」
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { compareDrawings } from "../../app/static/js/formats/cad2d/compare.js";
import { drawingToDxf } from "../../app/static/js/formats/cad2d/to-dxf.js";
import { MODES, checkCompare } from "../../tools/drawing-compare-check.mjs";
import { ROOT } from "./helpers.mjs";

const DRAWINGS = [
  ...fs.readdirSync(path.join(ROOT, "samples/dwg")).filter((f) => /\.(dwg|dxf|pdf|jww|sfc|p21)$/i.test(f)).map((f) => path.join(ROOT, "samples/dwg", f)),
  ...["sxf/all_features.sfc", "sxf/pair.p21"].map((f) => path.join(ROOT, "tests/fixtures/drawings", f)),
];
const bytesOf = (file) => new Uint8Array(fs.readFileSync(file));
const entities = (d) => d.blocks.get(d.layouts[0].block).entities;

for (const file of DRAWINGS) {
  test(`直した図形を見落とさず、直していない図形に印を付けない: ${path.basename(file)}`, async () => {
    for (const mode of MODES) {
      for (const seed of [1, 2, 3]) {
        const r = await checkCompare(bytesOf(file), path.basename(file), mode, seed);
        assert.ok(r.edited > 0, `${mode}・種 ${seed}: 直す図形が無い`);
        assert.deepEqual([r.misses, r.errors, r.wrongKind], [0, 0, 0], `${mode}・種 ${seed}: ${r.notes.slice(0, 5).join(" / ")}`);
      }
    }
  });
}

test("同じ図面どうしは、全て同じ", async () => {
  for (const file of DRAWINGS) {
    const [a, b] = [await readDrawing(bytesOf(file), path.basename(file)), await readDrawing(bytesOf(file), path.basename(file))];
    const r = compareDrawings(a, b);
    assert.equal(r.counts.same, entities(a).length, path.basename(file));
    assert.equal(r.counts.same, r.items.length, path.basename(file));
  }
});

test("既定の値の書き方の違い（無い・0・false）は同じ。値を変えれば変わった", async () => {
  const file = path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf");
  const a = await readDrawing(bytesOf(file), "a.dxf"), b = await readDrawing(bytesOf(file), "b.dxf");
  const lines = entities(b).filter((e) => e.type === "LINE");
  lines[0].thickness = 0;
  delete lines[1].extrusion;
  assert.equal(compareDrawings(a, b).counts.same, entities(a).length);
  lines[0].thickness = 2;
  const r = compareDrawings(a, b);
  assert.deepEqual(r.items.filter((x) => x.status !== "same").map((x) => [x.status, x.newer]), [["changed", lines[0]]]);
});

test("DXF の図面を DXF に書いて読み直すと、全て同じ（書き出しが寸法スタイルなどを落とさない）", async () => {
  for (const file of DRAWINGS.filter((f) => /\.dxf$/i.test(f))) {
    const a = await readDrawing(bytesOf(file), path.basename(file));
    const b = await readDrawing(drawingToDxf(await readDrawing(bytesOf(file), path.basename(file))).bytes, "again.dxf");
    const flagged = compareDrawings(a, b).items.filter((x) => x.status !== "same").map((x) => `${x.status} ${(x.older ?? x.newer).type}`);
    assert.deepEqual(flagged, [], path.basename(file));
  }
});

test("書き出しの丸めほどの数の差（1e-12 の割合）は、同じ", async () => {
  const file = path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf");
  const a = await readDrawing(bytesOf(file), "a.dxf"), b = await readDrawing(bytesOf(file), "b.dxf");
  const nudge = (v) => (typeof v === "number" ? v * (1 + 1e-12) : Array.isArray(v) ? v.map(nudge) : v);
  for (const e of entities(b)) for (const k of ["a", "b", "p", "center", "points"]) if (e[k]) e[k] = nudge(e[k]);
  assert.equal(compareDrawings(a, b).counts.same, entities(a).length);
});

test("ブロックの中身を直すと、そのブロックの参照だけが変わった", async () => {
  const file = path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg");
  const a = await readDrawing(bytesOf(file), "a.dwg"), b = await readDrawing(bytesOf(file), "b.dwg");
  const insert = entities(b).find((e) => e.type === "INSERT" && b.blocks.get(e.block)?.entities.some((x) => x.type === "LINE"));
  assert.ok(insert, "線を含むブロックの参照がある");
  const line = b.blocks.get(insert.block).entities.find((x) => x.type === "LINE");
  line.b = [line.b[0] + 1, line.b[1], line.b[2] ?? 0];
  const r = compareDrawings(a, b);
  const changed = r.items.filter((x) => x.status !== "same");
  const users = entities(b).filter((e) => e.type === "INSERT" && e.block === insert.block);
  assert.equal(changed.length, users.length);
  for (const item of changed) {
    assert.equal(item.status, "changed");
    assert.equal(item.newer.block, insert.block);
    assert.deepEqual(item.changes, ["shape"]);
  }
});

test("重ねた描くもの: 新版は全て、旧版は消した図形と前の形だけ。色は比べた結果ごと", async () => {
  const { buildScene } = await import("../../app/static/js/viewer2d/scene.js");
  const { compareScene } = await import("../../app/static/js/viewer2d/compare-scene.js");
  const { applyEdits } = await import("../../tools/drawing-compare-check.mjs");
  const file = path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf");
  const a = await readDrawing(bytesOf(file), "a.dxf"), b = await readDrawing(bytesOf(file), "b.dxf");
  applyEdits(a, b, 1);
  const result = compareDrawings(a, b);
  const palette = { same: "#999999", added: "#00aa00", changed: "#cc8800", removed: "#cc0000", before: "#ee9999" };
  const [sa, sb] = [buildScene(a, a.layouts[0]), buildScene(b, b.layouts[0])];
  const scene = compareScene(sa, sb, result, palette);
  const older = scene.sides.filter((s) => s?.side === "older");
  assert.equal(scene.sides.filter((s) => s?.side === "newer").length, sb.items.length);
  assert.equal(older.length, result.counts.removed + result.counts.changed);
  // 線の色は比べた結果の色（新版の線は、その図形の結果の色）
  for (const s of scene.strokes) {
    for (const line of s.lines) {
      const side = scene.sides[line.item];
      const want = side.side === "older" ? (side.status === "changed" ? palette.before : palette.removed) : palette[side.status];
      assert.equal(s.color, want);
    }
  }
  assert.ok(scene.strokes.some((s) => s.color === palette.removed), "消した図形の線がある");
  assert.ok(scene.strokes.some((s) => s.color === palette.added), "足した図形の線がある");
});

test("画面の試料（A1 の旧版 → 新版）: 変わった 3（穴の径・寸法の位置・注記）・消した 1・足した 2。試料は道具で作り直せる", async () => {
  const { olderA1 } = await import("../../tools/make-compare-fixture.mjs");
  const fixture = path.join(ROOT, "tests/fixtures/drawings/compare/A1_円筒_部品図_旧版.dxf");
  assert.deepEqual(drawingToDxf(await olderA1()).bytes, bytesOf(fixture), "試料が道具の出力と同じ（作り直すと同じバイト列）");
  const older = await readDrawing(bytesOf(fixture), "old.dxf");
  const newer = await readDrawing(bytesOf(path.join(ROOT, "samples/dwg/A1_円筒_部品図.dxf")), "new.dxf");
  const r = compareDrawings(older, newer);
  assert.ok(r.byHandle);
  assert.deepEqual(r.counts, { same: 34, changed: 3, removed: 1, added: 2 });
  const changed = r.items.filter((x) => x.status === "changed").map((x) => [x.newer.handle, x.changes.join()]).sort();
  assert.deepEqual(changed, [["104", "text"], ["9D", "shape"], ["CE", "shape"]]);
  assert.deepEqual(r.items.filter((x) => x.status === "added").map((x) => x.newer.handle).sort(), ["DC", "DD"]);
});

test("違いのまとまり: 近い違いは 1 つ、離れた違いは別。番号は上の行から。改訂雲は外形を囲んで閉じる", async () => {
  const { differenceRegions, cloudOutline } = await import("../../app/static/js/viewer2d/compare-scene.js");
  const boxes = { 0: [[0, 0], [1, 1]], 1: [[1.2, 0], [2, 1]], 2: [[10, 10], [11, 11]], 3: [[50, 0], [51, 1]] };
  const scene = { sides: [{ status: "changed" }, { status: "added" }, { status: "removed" }, { status: "changed" }, { status: "same" }] };
  const boundsOf = ([i]) => (boxes[i] ? { min: boxes[i][0], max: boxes[i][1] } : null);
  const regions = differenceRegions(scene, boundsOf, 0.5);
  assert.deepEqual(regions.map((r) => [r.number, r.items.sort()]), [[1, [2]], [2, [0, 1]], [3, [3]]]);
  assert.deepEqual([...regions[1].statuses].sort(), ["added", "changed"]);
  const pts = cloudOutline({ min: [0, 0], max: [10, 4] }, 2);
  assert.deepEqual(pts.slice(0, 2), pts.slice(-2), "閉じている");
  for (let i = 0; i < pts.length; i += 2) assert.ok(pts[i] <= 0 || pts[i] >= 10 || pts[i + 1] <= 0 || pts[i + 1] >= 4, "外形の外側を通る");
});
