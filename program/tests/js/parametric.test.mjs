// Inventor で直せる部品の計画（convert/parametric.js。B）の評価（program/tools/parametric-check.mjs と共用）:
//   1. 試験の変換データの全ての部品: 完全拘束・今の値で解いても形が動かない・名前が Inventor で使える・式の名前がある
//   2. 名前つきの値を ±10% 変えて拘束を解いた形と、寸法の欄の直し方（applyDimension）の形: 解けない値は無く、
//      同じ形になる数が基準より減らない（平行な辺が 3 組以上の形・段のある回転体は、どの寸法を参照にしても全ては合わない。docs/editing.md §4）
//   3. 例: 穴の板の名前つきの値・向かいの辺は参照寸法・押し出し / 回転 / 面取りの値の式
//   4. 変換データ: 版 4 で計画を添える・古い版を読むと計画を作る・寸法を直すと計画を作り直す（直した形に合う）
//   5. 寸法の欄の Inventor での呼び名: 直せる寸法は全て、名前つきの値・参照寸法・対応なしのどれかになり、名前は計画の値にある
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyDimension, dimensionsOf } from "../../app/static/js/convert/dimensions.js";
import { VERSION, readSpec } from "../../app/static/js/convert/inventor.js";
import { inventorNames, parametricPlan, solveSketch } from "../../app/static/js/convert/parametric.js";
import { checkPlan, checkSpec, shapeDifference } from "../../tools/parametric-check.mjs";
import { ROOT } from "./helpers.mjs";

const DIR = path.join(ROOT, "tests/fixtures/builder");
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith(".inventor.json"));
const load = (name) => readSpec(fs.readFileSync(path.join(DIR, name), "utf8"));
const part = (name, key = "p01") => load(name).parts.find((p) => p.key === key);

test("試験の変換データの全ての部品: 完全拘束・形が動かない・名前が使える。直したときに解けない値は無い", () => {
  const total = { same: 0, differ: 0, refused: 0, unsolved: 0 };
  for (const file of FILES) {
    const r = checkSpec(load(file));
    assert.deepEqual(r.problems, [], file);
    for (const k of Object.keys(total)) total[k] += r.edits[k];
  }
  assert.equal(total.unsolved, 0);
  assert.ok(total.same >= 49, `寸法の欄と同じ形になる数 ${total.same}（基準 49）`);
  assert.ok(total.same + total.differ >= 58);
});

test("穴の板: 名前つきの値（穴の直径・辺の長さ・穴の位置・厚さ）、向かいの辺は参照寸法、外周の角は原点", () => {
  const plan = part("plate-holes.inventor.json").parametric;
  assert.deepEqual(plan.params.map((p) => `${p.name}=${p.value}${p.unit}`), ["D1_0=4.5mm", "D2_0=4.5mm", "L0_0=21mm", "L0_1=7.5mm",
    "P1X=4mm", "P1Y=3.75mm", "P2X=17mm", "P2Y=3.75mm", "t=2mm"]);
  assert.equal(plan.params[0].comment, "穴 1の直径");
  assert.deepEqual(plan.constraints.map((c) => c.type), ["horizontal", "vertical", "horizontal", "vertical", "onAxis", "onAxis"]);
  assert.deepEqual(plan.dimensions.filter((d) => d.driven).map((d) => d.seg), [[0, 2], [0, 3]], "向かいの辺の長さは参照寸法");
  assert.deepEqual(plan.features, { chamfers: [], distance: "t" });
  assert.equal(plan.free, 0);
});

test("フィーチャの値の式: 部分回転は角度 a、一周は無し、面取りは面取りごとに C0・C1", () => {
  const reel = load("reel.inventor.json").parts;
  const partial = reel.find((p) => p.kind === "revolve" && p.revolve.angle_deg < 360);
  const full = reel.find((p) => p.kind === "revolve" && p.revolve.angle_deg === 360);
  assert.equal(partial.parametric.features.angle, "a");
  assert.equal(partial.parametric.params.find((p) => p.name === "a").unit, "deg");
  assert.equal(full.parametric.features.angle, undefined);
  assert.deepEqual(part("blade.inventor.json").parametric.features, { chamfers: ["C0", "C1"], distance: "t" });
  assert.equal(load("wire.inventor.json").parts.filter((p) => p.kind === "mesh" && p.parametric).length, 0, "近似の部品には計画が無い");
});

test("角の丸み: 接線の拘束と半径の名前つきの値。半径を変えて解いた形は、寸法の欄の直し方（角の位置を保つ）と同じ", () => {
  const spacer = part("spacer-t50.inventor.json");
  const plan = spacer.parametric;
  assert.equal(plan.constraints.filter((c) => c.type === "tangent").length, 4);
  assert.deepEqual(plan.params.filter((p) => p.name.startsWith("R")).map((p) => p.name), ["R0_8", "R0_10"]);
  const solved = solveSketch(spacer, plan, { R0_8: 2.5 });
  const expected = applyDimension(spacer, "R0.8", 2.5).part;
  assert.ok(shapeDifference("revolve", expected.sketch.loops, solved.loops) < 1e-6);
});

test("変換データ: 版 4 で計画を添える。古い版を読むと計画を作り、寸法を直すと直した形に合う計画に作り直す", () => {
  assert.equal(VERSION, 4);
  const text = fs.readFileSync(path.join(DIR, "plate-holes.inventor.json"), "utf8");
  const old = JSON.parse(text);
  old.version = 3;
  delete old.parts[0].parametric;
  const read = readSpec(JSON.stringify(old));
  assert.equal(read.version, 4);
  assert.deepEqual(read.parts[0].parametric, JSON.parse(text).parts[0].parametric);

  const edited = applyDimension(read.parts[0], "L0.0", 25).part;
  assert.equal(edited.parametric.params.find((p) => p.name === "L0_0").value, 25);
  assert.deepEqual(checkPlan(edited).problems, []);
  assert.deepEqual(parametricPlan(edited), edited.parametric);
});

test("寸法の欄の Inventor での呼び名: 名前つきの値・参照寸法（向かいの辺）・対応なし（形を保って拡大・縮小・一周の角度）", () => {
  const plate = part("plate-holes.inventor.json");
  const names = inventorNames(plate);
  const of = (id) => names.get(id);
  assert.deepEqual([of("t"), of("D1.0"), of("L0.0")].map((n) => n.name), ["t", "D1_0", "L0_0"]);
  assert.deepEqual([of("L0.2").kind, of("L0.3").kind, of("S").kind], ["driven", "driven", "none"]);
  const reel = load("reel.inventor.json").parts.find((p) => p.kind === "revolve" && p.revolve.angle_deg === 360);
  assert.equal(inventorNames(reel).get("a").kind, "none", "一周の回転には角度の値が無い");
  // 全ての試験の部品: 直せる寸法は呼び名を持ち、名前つきの値の名前は計画の値の名前にある
  for (const file of FILES) {
    for (const p of load(file).parts.filter((x) => x.parametric)) {
      const map = inventorNames(p);
      const params = new Set(p.parametric.params.map((x) => x.name));
      for (const d of dimensionsOf(p).filter((x) => x.editable)) {
        const n = map.get(d.id);
        assert.ok(n, `${file} ${p.key} ${d.id}`);
        if (n.kind === "param") assert.ok(params.has(n.name), `${file} ${p.key} ${n.name}`);
      }
    }
  }
  assert.equal(inventorNames({ kind: "mesh" }).size, 0, "近似の部品には呼び名が無い");
});
