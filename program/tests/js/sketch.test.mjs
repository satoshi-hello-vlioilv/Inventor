// 寸法を直す欄の断面図（ui/sketch.js）と置き場所（convert/dimensions.js の placeOf）の評価:
//   1. 全ての試験の変換データの、場所のある全ての直せる寸法で: 光る区間の数が合う（辺は 1 本・ループはその本数）・札が図の枠に収まる
//   2. 円弧の向き: 反時計回りと時計回りの円弧で、SVG の large-arc・sweep の旗が、円弧の通る点と合う
//   3. 置き場所: 全体（厚さ・外形の幅）・外周・穴 n・回転体は断面
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dimensionsOf, placeOf } from "../../app/static/js/convert/dimensions.js";
import { readSpec } from "../../app/static/js/convert/inventor.js";
import { sketchMarkup } from "../../app/static/js/ui/sketch.js";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/builder");
const parts = fs.readdirSync(FIXTURES).filter((n) => n.endsWith(".json"))
  .flatMap((name) => readSpec(fs.readFileSync(path.join(FIXTURES, name), "utf8")).parts.map((part) => ({ name, part })))
  .filter(({ part }) => part.kind !== "mesh");
const W = 400, H = 200;
const count = (svg, pattern) => (svg.match(pattern) ?? []).length;

test("全ての試験の変換データ: 光る区間の数が寸法の場所と合い、札が図の枠に収まる", () => {
  let checked = 0;
  for (const { name, part } of parts) {
    for (const dim of dimensionsOf(part).filter((d) => d.editable && d.at)) {
      const focus = dim.at.seg === undefined ? { loop: dim.at.loop } : { loop: dim.at.loop, seg: dim.at.seg };
      const svg = sketchMarkup(part.sketch.loops, { width: W, height: H, focus, label: `${dim.label} ${dim.value}` });
      const expected = dim.at.seg === undefined ? part.sketch.loops[dim.at.loop].length : 1;
      assert.equal(count(svg, /class="sk-line is-focus"/g), expected, `${name} ${dim.id}`);
      assert.equal(count(svg, /class="sk-line/g), part.sketch.loops.flat().length, `${name} ${dim.id} 全ての区間を描く`);
      const [x, y, w, h] = svg.match(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/).slice(1).map(Number);
      assert.ok(x >= 0 && y >= 0 && x + w <= W && y + h <= H, `${name} ${dim.id} の札 ${[x, y, w, h]}`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `確かめた寸法 ${checked}`);
});

test("円弧の向き: 旗（large-arc・sweep）が円弧の通る点と合う（図は y が下向き）", () => {
  // 中心 (0,0)・半径 10。(10,0) → (0,10) の反時計回りは 90°（小さい弧）、時計回りは 270°（大きい弧）
  const arc = (ccw) => sketchMarkup([[{ type: "arc", a: [10, 0], b: [0, 10], center: [0, 0], ccw }, { type: "line", a: [0, 10], b: [10, 0] }]], { width: W, height: H });
  const flags = (svg) => svg.match(/A[\d.]+ [\d.]+ 0 (\d) (\d)/).slice(1).map(Number);
  assert.deepEqual(flags(arc(true)), [0, 0]); // 小さい弧・見た目の反時計回り
  assert.deepEqual(flags(arc(false)), [1, 1]); // 大きい弧・見た目の時計回り
  // 光らせた円弧も、円弧の道（A）で描く
  const svg = sketchMarkup([[{ type: "arc", a: [10, 0], b: [0, 10], center: [0, 0], ccw: true }, { type: "line", a: [0, 10], b: [10, 0] }]],
    { width: W, height: H, focus: { loop: 0, seg: 0 }, label: "R 10" });
  assert.match(svg, /class="sk-line is-focus" d="M[\d.]+ [\d.]+A/);
});

test("置き場所: 全体・外周・穴 n・回転体は断面", () => {
  const blade = parts.find(({ name }) => name === "blade.inventor.json").part;
  const places = new Map(dimensionsOf(blade).map((d) => [d.id, placeOf(d, blade)]));
  assert.deepEqual([places.get("t"), places.get("S"), places.get("D0.0"), places.get("C0")], ["全体", "全体", "外周", "穴 1"]);
  const revolve = parts.find(({ part }) => part.kind === "revolve").part;
  assert.deepEqual([...new Set(dimensionsOf(revolve).map((d) => placeOf(d, revolve)))], ["全体", "断面"]);
});
