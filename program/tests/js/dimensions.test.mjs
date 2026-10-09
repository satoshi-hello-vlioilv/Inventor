// 変換データの寸法の直し（convert/dimensions.js）の評価:
//   1. 試験の変換データの全ての部品の全ての寸法を ±10% 変えてみる（tools/spec-edit-check.mjs と同じ確かめ。直せたものは、その値・作れる形・
//      閉じた三角形の体積と表面積が厳密な期待値と合う・元の値に戻せば元の形。直せないものは理由を添えて断る）
//   2. 直し方の意味: 平行な辺が一緒に伸びる・先の穴は一緒に動く・斜めの辺は角度を保てないので断る・角の丸み・回転体の直径・
//      相似の拡大・面取りの決まり（厚さの半分より小さく）・作れない形（交わる・軸をまたぐ）を断る
// Python のビルダーでの確かめ（直した 275 個の変換データの期待値の再計算・STEP の書き出しと読み戻し）は docs/editing.md に記録
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyDimension, checkPart, dimensionsOf } from "../../app/static/js/convert/dimensions.js";
import { expectedProperties, readSpec } from "../../app/static/js/convert/inventor.js";
import { checkPart as tryAll } from "../../tools/spec-edit-check.mjs";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/builder");
const load = (name) => readSpec(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const line = (a, b) => ({ type: "line", a, b });
const polygon = (...pts) => pts.map((p, i) => line(p, pts[(i + 1) % pts.length]));
const extrude = (loops, distance = 10, extra = {}) => ({ key: "p01", kind: "extrude", sketch: { plane: "XY", loops }, extrude: { direction: "Z", distance }, ...extra });
const dim = (part, id) => dimensionsOf(part).find((d) => d.id === id);
const volume = (part) => expectedProperties({ kind: part.kind, loops: part.sketch.loops, revolve: part.revolve, extrude: part.extrude, chamfers: part.chamfers }).volume;

test("全ての試験の変換データ: 全ての寸法を ±10% 変え、直せたものは正しく、直せないものは理由を添えて断る", () => {
  let tried = 0, done = 0;
  const failures = [];
  for (const name of fs.readdirSync(FIXTURES).filter((n) => n.endsWith(".json"))) {
    for (const part of load(name).parts) {
      const r = tryAll(part, { steps: 128, tol: 2e-3 });
      tried += r.tried;
      done += r.done;
      failures.push(...r.failures.map((f) => `${name} ${f}`));
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(done >= 275 && tried >= 388, `試した ${tried}・直せた ${done}`);
});

test("長さ: 辺を伸ばすと、辺の終点から先の点だけが辺の向きへ動く（平行な向かいの辺も伸び、先の穴は一緒に動き、手前の穴は動かない）", () => {
  // L 字の板: 下の辺（0〜20）を伸ばすと、x ≥ 20 の点（段・右の辺・その先の穴）が動き、上の辺（平行）が伸びる
  const plate = extrude([polygon([0, 0], [20, 0], [20, 10], [40, 10], [40, 20], [0, 20]),
    [{ type: "circle", center: [10, 10], radius: 3 }], [{ type: "circle", center: [30, 15], radius: 3 }]]);
  const bottom = dimensionsOf(plate).find((d) => d.kind === "length" && d.at.seg === 0);
  assert.deepEqual([bottom.label, bottom.value, bottom.editable], ["横の辺", 20, true]);
  const { part, changed } = applyDimension(plate, bottom.id, 30);
  assert.deepEqual(part.sketch.loops[0].map((s) => s.a), [[0, 0], [30, 0], [30, 10], [50, 10], [50, 20], [0, 20]]);
  assert.deepEqual([part.sketch.loops[1][0].center, part.sketch.loops[2][0].center], [[10, 10], [40, 15]]);
  assert.deepEqual(changed.map((c) => [c.id, c.after]), [["S", 50], ["L0.4", 50]]); // 外形の幅と、上の辺
  assert.ok(Math.abs(part.expect.volume - (30 * 10 + 50 * 10 - 2 * Math.PI * 9) * 10) < 1e-6);
  assert.equal(plate.sketch.loops[0][1].a[0], 20, "元の部品は変えない");
});

test("長さ: 斜めの辺は、隣の角度が変わるなら理由を添えて断る（平行四辺形は手前の側を動かせば角度が保てる）", () => {
  const trapezoid = extrude([polygon([0, 0], [40, 0], [30, 20], [10, 20])]);
  const slope = dim(trapezoid, "L0.1");
  assert.deepEqual([slope.label, slope.editable], ["斜めの辺", false]);
  assert.match(slope.reason, /斜めの辺の角度が変わる/);
  assert.throws(() => applyDimension(trapezoid, "L0.1", 30), /斜めの辺の角度が変わる/);
  const parallelogram = extrude([polygon([0, 0], [40, 0], [50, 20], [10, 20])]);
  const { part } = applyDimension(parallelogram, "L0.1", Math.hypot(10, 20) * 2);
  // 先の側（上の横の辺が斜めの辺と平行でない）は動かせないので、手前の側（両端が斜めの辺と平行な線）を逆向きへ動かす
  assert.deepEqual(part.sketch.loops[0].map((s) => s.a), [[-10, -20], [30, -20], [50, 20], [10, 20]]);
});

test("八角形: 辺を伸ばすと半分が動き、向かいの平行な辺も伸びる。相似の拡大は、全ての角度を保って大きさを変える", () => {
  const octagon = extrude([Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4 + Math.PI / 8) * 10, Math.sin((i * Math.PI) / 4 + Math.PI / 8) * 10])
    .map((p, i, all) => line(p, all[(i + 1) % 8]))]);
  assert.ok(dimensionsOf(octagon).filter((d) => d.kind === "length").every((d) => d.editable));
  const side = dim(octagon, "L0.1");
  const { changed } = applyDimension(octagon, side.id, side.value + 5);
  assert.ok(changed.some((c) => c.id === "L0.5" && Math.abs(c.after - side.value - 5) < 1e-6), "向かいの辺も伸びる");
  const before = volume(octagon);
  const { part } = applyDimension(octagon, "S", dim(octagon, "S").value * 2);
  assert.ok(Math.abs(volume(part) / before - 4) < 1e-6);
});

test("角の丸み: 両側の直線に接したまま半径を変える（接点が直線の上を動く）", () => {
  const r = 5;
  const rounded = extrude([[line([0, 0], [40, 0]), line([40, 0], [40, 20 - r]),
    { type: "arc", a: [40, 20 - r], b: [40 - r, 20], center: [40 - r, 20 - r], ccw: true }, line([40 - r, 20], [0, 20]), line([0, 20], [0, 0])]]);
  assert.deepEqual([dim(rounded, "R0.2").value, dim(rounded, "R0.2").editable], [5, true]);
  const { part } = applyDimension(rounded, "R0.2", 8);
  const [, side, arc, top] = part.sketch.loops[0];
  assert.deepEqual([side.b, arc.a, arc.b, arc.center, top.a], [[40, 12], [40, 12], [32, 20], [32, 12], [32, 20]]);
  assert.throws(() => applyDimension(rounded, "R0.2", 25), /無くなる/); // 縦の辺（15 mm）より大きな丸み
});

test("回転体: 直径はその円筒だけを動かし、軸方向の長さは先を伸ばす。半径方向の長さは直径で直す（2 か所に出さない）", () => {
  const ring = { key: "p01", kind: "revolve", sketch: { plane: "XY", loops: [polygon([10, 0], [20, 0], [20, 30], [10, 30])] }, revolve: { axis: "Y", angle_deg: 360 } };
  const dims = dimensionsOf(ring);
  assert.deepEqual(dims.map((d) => `${d.id} ${d.label} ${d.value}`), ["a 回転の角度 360", "S 外径（形を保って拡大・縮小） 40", "D0.1 直径 40", "L0.1 軸方向の辺 30", "D0.3 直径 20", "L0.3 軸方向の辺 30"]);
  const { part } = applyDimension(ring, "D0.3", 16);
  assert.deepEqual(part.sketch.loops[0].map((s) => s.a), [[8, 0], [20, 0], [20, 30], [8, 30]]);
  assert.ok(Math.abs(part.expect.volume - Math.PI * (400 - 64) * 30) < 1e-6);
  assert.throws(() => applyDimension(ring, "D0.3", 44), /無くなる/); // 内径が外径を越える
  assert.throws(() => applyDimension(ring, "a", 361), /360°/);
});

test("面取り: 厚さの半分より小さく（ビルダーと同じ決まり）。直した面取りの部品は、STEP 用の三角形を作り直す", () => {
  const blade = load("blade.inventor.json").parts[0];
  const chamfer = dimensionsOf(blade).find((d) => d.kind === "chamfer");
  assert.match(chamfer.label, /面取り（穴 1の縁・(上面|下面)）/);
  assert.throws(() => applyDimension(blade, chamfer.id, 2.5), /厚さ 5 mm の半分より小さく/);
  const { part } = applyDimension(blade, chamfer.id, 1.5);
  assert.notDeepEqual(part.mesh, blade.mesh);
  assert.ok(part.expect.volume < blade.expect.volume);
  assert.throws(() => applyDimension(blade, "t", 1.8), /半分より小さく/); // 面取り 1 mm が入らないほど薄く
});

test("作れない形は断る: 穴が外周と交わる・回転体の断面が軸をまたぐ・0 以下の値", () => {
  const plate = extrude([polygon([0, 0], [40, 0], [40, 20], [0, 20]), [{ type: "circle", center: [10, 10], radius: 3 }]]);
  assert.throws(() => applyDimension(plate, "D1.0", 25), /外周と穴 1の線が交わります/);
  assert.throws(() => applyDimension(plate, "t", 0), /0 より大きい数/);
  assert.deepEqual(checkPart(plate), []);
  const disk = { key: "p01", kind: "revolve", sketch: { plane: "XY", loops: [polygon([0, 0], [20, 0], [20, 5], [0, 5])] }, revolve: { axis: "Y", angle_deg: 90 } };
  const bad = structuredClone(disk);
  bad.sketch.loops[0] = polygon([-1, 0], [20, 0], [20, 5], [-1, 5]);
  assert.match(checkPart(bad).join(), /軸をまたぎます/);
});
