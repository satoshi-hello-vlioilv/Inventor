// 2D で測るときに吸い付く点（viewer2d/scene.js の snaps と viewer2d/snap.js）の評価:
//   1. 見本の図面（A1_円筒_部品図.dxf）: 円の中心から P.C.D. φ40 の穴の中心まで 20 mm・45°（図面に書かれた寸法と突き合わせる）
//   2. 全ての線の両端・円の中心と四分点・円弧の両端と中点が吸い付く点になる（図形の値から独立に求めた点と合う）
//   3. 膨らみのある辺（半円）の中点と中心、交わる 2 本の線の交点、曲線を刻んだ線分の継ぎ目は交点にしない
//   4. 吸い付く点が無ければ線の上の一番近い点、何も無ければ null。値の壊れた図形の点は入れない
//   5. 選んだ図形の性質の表（長さ・面積・縮尺）と、隠した画層の図形は描いた図形に入らないこと
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { HitIndex } from "../../app/static/js/viewer2d/hit.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { itemDetails } from "../../app/static/js/viewer2d/describe.js";
import { SnapIndex, measure } from "../../app/static/js/viewer2d/snap.js";
import { ROOT } from "./helpers.mjs";

const SAMPLE = "A1_円筒_部品図.dxf";
const load = () => readDrawing(new Uint8Array(fs.readFileSync(path.join(ROOT, "samples/dwg", SAMPLE))), SAMPLE);
const index = (scene) => new SnapIndex(scene, new HitIndex(scene));
const near = (p, q, tol = 1e-9) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
const base = { layer: "0", color: { index: 7 }, linetype: "BYLAYER", lineweight: -1, ltscale: 1 };

test("見本の図面: 円の中心から P.C.D. φ40 の穴の中心まで 20 mm・45°（中心に吸い付く）", () => {
  const drawing = load();
  const scene = buildScene(drawing, drawing.layouts.find((l) => l.model));
  const snapper = index(scene);
  const center = snapper.find(140.3, -0.2, 1), hole = snapper.find(154.3, 14.0, 1);
  assert.deepEqual([center.kind, hole.kind], ["center", "center"]);
  const m = measure(center, hole);
  assert.ok(Math.abs(m.distance - 20) < 1e-9 && Math.abs(m.angle - 45) < 1e-9, JSON.stringify(m));
  assert.equal(measure(hole, center).angle, 225);
});

test("全ての線の両端・円の中心と四分点・円弧の両端と中点が、吸い付く点になる", () => {
  const drawing = load();
  const scene = buildScene(drawing, drawing.layouts.find((l) => l.model));
  const has = (kind, p) => scene.snaps.some((s) => s.kind === kind && near([s.x, s.y], p, 1e-9));
  let checked = 0;
  for (const { entity: e } of scene.items) {
    if (e.type === "LINE") {
      assert.ok(has("end", e.a) && has("end", e.b) && has("mid", [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]), `線 ${e.handle}`);
      checked++;
    } else if (e.type === "CIRCLE") {
      assert.ok(has("center", e.center), `円 ${e.handle}`);
      for (let k = 0; k < 4; k++) assert.ok(has("quad", [e.center[0] + e.radius * Math.cos((k * Math.PI) / 2), e.center[1] + e.radius * Math.sin((k * Math.PI) / 2)]));
      checked++;
    } else if (e.type === "ARC") {
      const at = (t) => [e.center[0] + e.radius * Math.cos(t), e.center[1] + e.radius * Math.sin(t)];
      let sweep = e.end - e.start;
      while (sweep <= 0) sweep += 2 * Math.PI;
      assert.ok(has("end", at(e.start)) && has("end", at(e.end)) && has("mid", at(e.start + sweep / 2)) && has("center", e.center), `円弧 ${e.handle}`);
      checked++;
    }
  }
  assert.ok(checked >= 10, `確かめた図形 ${checked}`);
  assert.ok(scene.snaps.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y)));
});

test("膨らみのある辺（半円）の中点と中心・交わる 2 本の線の交点。曲線を刻んだ継ぎ目は交点にしない", () => {
  const drawing = load();
  const model = drawing.blocks.get("*Model_Space").entities;
  model.length = 0;
  // 半円の辺（(0,0) → (10,0)、膨らみ 1 = 反時計回りの半円: 中心 (5,0)・中点 (5,-5)）と、その上で交わる 2 本の線
  model.push({ ...base, type: "LWPOLYLINE", handle: "B1", points: [[0, 0], [10, 0]], bulges: [1, 0], closed: false });
  model.push({ ...base, type: "LINE", handle: "L1", a: [20, 0, 0], b: [30, 10, 0] });
  model.push({ ...base, type: "LINE", handle: "L2", a: [20, 10, 0], b: [30, 0, 0] });
  model.push({ ...base, type: "CIRCLE", handle: "C1", center: [50, 0, 0], radius: 5 });
  const scene = buildScene(drawing, drawing.layouts.find((l) => l.model));
  const snapper = index(scene);
  const arcMid = snapper.find(5.1, -4.9, 0.5), arcCenter = snapper.find(5.1, 0.1, 0.5);
  assert.deepEqual([arcMid.kind, arcCenter.kind], ["mid", "center"]);
  assert.ok(near([arcMid.x, arcMid.y], [5, -5], 1e-9) && near([arcCenter.x, arcCenter.y], [5, 0], 1e-9));
  const cross = snapper.find(25.2, 4.9, 0.5);
  assert.equal(cross.kind, "int");
  assert.ok(near([cross.x, cross.y], [25, 5], 1e-9));
  // 円は細かい線分で描くが、その継ぎ目は交点にしない（円の上の、四分点から離れた所では線の上の点になる）
  const onCircle = snapper.find(50 + 5 * Math.cos(1), 5 * Math.sin(1), 0.2);
  assert.equal(onCircle.kind, "near");
});

test("吸い付く点が無ければ線の上の一番近い点、何も無ければ null。値の壊れた図形の点は入れない", () => {
  const drawing = load();
  const model = drawing.blocks.get("*Model_Space").entities;
  model.length = 0;
  model.push({ ...base, type: "LINE", handle: "L1", a: [0, 0, 0], b: [100, 0, 0] });
  model.push({ ...base, type: "CIRCLE", handle: "BAD", center: [0, 0, 0], radius: Number.NaN });
  const scene = buildScene(drawing, drawing.layouts.find((l) => l.model));
  assert.equal(scene.snaps.length, 3, "線の両端と中点だけ（壊れた円の点は入れない）");
  const snapper = index(scene);
  const onLine = snapper.find(30, 0.4, 1);
  assert.deepEqual([onLine.kind, onLine.x, onLine.y], ["near", 30, 0]);
  assert.equal(snapper.find(30, 20, 1), null);
});

test("選んだ図形の性質の表（itemDetails）: 図形の値から独立に求めた長さ・面積と合う。隠した画層の図形は描いた図形に入らない", () => {
  const drawing = load();
  const model = drawing.blocks.get("*Model_Space").entities;
  model.length = 0;
  model.push({ ...base, type: "CIRCLE", handle: "C1", center: [140, 0, 0], radius: 26.25 });
  model.push({ ...base, type: "ARC", handle: "A1", center: [0, 0, 0], radius: 10, start: 0, end: Math.PI / 2 });
  // 1 辺 10 の正方形の上の辺を半円に膨らませた閉じた形（面積 100 ＋ 半円 π·5²/2、長さ 30 ＋ π·5）
  model.push({ ...base, type: "LWPOLYLINE", handle: "P1", points: [[0, 0], [10, 0], [10, 10], [0, 10]], bulges: [0, 0, 1, 0], closed: true });
  model.push({ ...base, layer: "隠す", type: "LINE", handle: "L1", a: [0, 0, 0], b: [3, 4, 0] });
  const scene = buildScene(drawing, drawing.layouts.find((l) => l.model), { hidden: new Set(["隠す"]) });
  const details = (handle, scale) => Object.fromEntries(itemDetails(scene.items.find((i) => i.handle === handle), "mm", scale));
  assert.deepEqual(details("C1"), { 種類: "円", 中心: "140, 0", 直径: "52.5 mm", 半径: "26.25 mm", 周長: `${Number((52.5 * Math.PI).toFixed(3))} mm`,
    面積: `${Number((Math.PI * 26.25 ** 2).toFixed(3))} mm²`, 画層: "0" });
  assert.deepEqual([details("A1").中心角, details("A1").弧長], ["90°", `${Number((5 * Math.PI).toFixed(3))} mm`]);
  const p = details("P1");
  assert.deepEqual([p.長さ, p.面積], [`${Number((30 + 5 * Math.PI).toFixed(3))} mm`, `${Number((100 + (Math.PI * 25) / 2).toFixed(3))} mm²`]);
  assert.deepEqual([details("L1", 2).長さ, details("L1", 2).縮尺], ["10 mm", "1:2"], "画層の縮尺 1:2 なら実寸は 2 倍");
  const hit = new HitIndex(scene);
  assert.deepEqual(scene.items.map((item, i) => hit.has(i)), [true, true, true, false], "隠した画層の線は描いた図形に入らない（選んでいても外す）");
});
