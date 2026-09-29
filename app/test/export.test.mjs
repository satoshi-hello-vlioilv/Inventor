// Inventor 用変換データの評価。
// 「元のメッシュの全頂点が、変換データから再構成した面の上にあるか」と「体積・表面積が厳密値と一致するか」で、
// 変換データが元の形状を正しく表していることを確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { cross, dot, length } from "../src/ipt/vec.js";
import { expectedProperties, featureOf, maxDeviation, meshProperties } from "../src/export/inventor.js";
import { loopCorners, loopIntegrals } from "../src/recognize/geometry2d.js";
import { recognizeSnapshot } from "../src/recognize/index.js";
import { pointAt } from "../src/recognize/mesh.js";
import { CORNER_ZONE } from "../src/recognize/prism.js";
import { BUILDER_FIXTURES, builderFixtures, fixtureText } from "./builder-fixtures.mjs";
import { readHtmlFixture } from "./helpers.mjs";

const FIXTURES = [
  "LS4_parts_viewer.spacer-t10", "LS4_parts_viewer.spacer-t50", "LS4_parts_viewer.rubber", "LS4_parts_viewer.finger", "LS4_parts_viewer.blade",
  "spool_reel_assembly_v2.steel", "spool_reel_assembly_v2.paper", "spool_reel_assembly_v2.rubber",
  "spool_reel_assembly_v2.reel", "spool_reel_assembly_v2.assy",
];
// 円を n 分割の多角形で描くと、面積・体積は (2π/n)²/6 だけ小さくなる。n ≥ 26 なら 1% 未満
const CHORD_TOL = 0.01;
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} ≠ ${b}`);
const specs = builderFixtures();

describe("変換データが元の形状を正しく表す", () => {
  for (const name of FIXTURES) {
    test(name, () => {
      const parts = recognizeSnapshot(readHtmlFixture(name)).parts;
      let checked = 0;
      for (const part of parts) {
        const feature = featureOf(part);
        if (!feature) continue;
        checked += 1;
        // 面取りの角付近は、認識が報告した差（cornerDeviation）まで許す。報告値が実際の差の上限になっていることの確認
        const bound = Math.max(1e-4, ...(part.chamfers ?? []).map((c) => c.cornerDeviation));
        assert.ok(maxDeviation(part, feature) <= bound, `部品 ${part.id}: 頂点が面から ${maxDeviation(part, feature)} mm 離れている`);
        const exact = expectedProperties(feature), mesh = meshProperties(part);
        assert.ok(Math.abs(exact.volume - mesh.volume) / exact.volume <= CHORD_TOL, `部品 ${part.id}: 体積 ${mesh.volume} vs ${exact.volume}`);
        assert.ok(Math.abs(exact.area - mesh.area) / exact.area <= CHORD_TOL, `部品 ${part.id}: 表面積 ${mesh.area} vs ${exact.area}`);
        const f = feature.frame;
        for (const v of [f.x, f.y, f.z]) near(length(v), 1, 1e-9, "軸の長さ");
        near(dot(cross(f.x, f.y), f.z), 1, 1e-9, "右手系");
      }
      assert.ok(checked > 0);
    });
  }
});

describe("丸刃（面取り付き押し出し）", () => {
  const [part] = recognizeSnapshot(readHtmlFixture("LS4_parts_viewer.blade")).parts;
  const feature = featureOf(part);
  test("面取りの角の範囲の外では、全頂点が再構成した面の上にある（1e-4 mm 以内）", () => {
    const f = feature.frame;
    const zones = feature.chamfers.flatMap((c) => loopCorners(feature.loops[c.loop]).map((p) => ({ p, r: CORNER_ZONE * c.distance })));
    const away = new Set([...new Set(part.tris)].filter((i) => {
      const d = pointAt(part.points, i).map((v, k) => v - f.origin[k]);
      const [x, y] = [dot(d, f.x), dot(d, f.y)];
      return zones.every(({ p, r }) => Math.hypot(x - p[0], y - p[1]) > r);
    }));
    assert.ok(away.size >= 0.98 * new Set(part.tris).size, "照合から外すのは角付近のわずかな頂点だけ（実測 88 / 8640）");
    assert.ok(maxDeviation(part, feature, away) <= 1e-4, `${maxDeviation(part, feature, away)} mm`);
  });
  test("体積は元のメッシュと 2e-5 以内で一致（メッシュの円は 0.25° 刻みの折れ線）", () => {
    const exact = expectedProperties(feature), mesh = meshProperties(part);
    assert.ok(Math.abs(exact.volume - mesh.volume) / exact.volume <= 2e-5, `${mesh.volume} vs ${exact.volume}`);
  });
  test("面取りを除いた押し出しより、両面の C1 の分（穴の縁の長さ × 1²/2 × 2 にほぼ等しい）だけ体積が小さい", () => {
    const removed = expectedProperties({ ...feature, chamfers: undefined }).volume - expectedProperties(feature).volume;
    const edge = loopIntegrals(feature.loops[1]).perimeter;
    assert.ok(Math.abs(removed - edge) / edge < 0.01, `削られる体積 ${removed} ≈ 縁の長さ ${edge} × 1`);
  });
});

describe("手計算した厳密値との一致", () => {
  test("スペーサー T10: 体積 = 2π × 21780（断面 20 × 10 から C1 の三角形 4 つを除いた 1 次モーメント）", () => {
    const [part] = recognizeSnapshot(readHtmlFixture("LS4_parts_viewer.spacer-t10")).parts;
    near(expectedProperties(featureOf(part)).volume, 2 * Math.PI * 21780, 1e-6, "体積");
  });
  test("穴あき板 21 × 7.5 × 2・Φ4.5 × 2: 体積と表面積", () => {
    const [p] = specs["plate-holes"].parts;
    const section = 21 * 7.5 - 2 * Math.PI * 2.25 ** 2;
    const perimeter = 2 * (21 + 7.5) + 2 * 2 * Math.PI * 2.25;
    near(p.expect.volume, section * 2, 1e-5, "体積");
    near(p.expect.area, 2 * section + perimeter * 2, 1e-5, "表面積");
    assert.deepEqual(p.sketch.loops.slice(1).map((l) => l.map((s) => [s.type, s.radius])), [[["circle", 2.25]], [["circle", 2.25]]]);
  });
  test("スペーサー T50: 逃がし溝の R2 は中心 (112, ±13)・半径 2 の円弧（溝底 φ228 − R2）", () => {
    const arcs = specs["spacer-t50"].parts[0].sketch.loops[0].filter((s) => s.type === "arc");
    assert.deepEqual(arcs.map((a) => a.center), [[112, 13], [112, -13]]);
    for (const a of arcs) near(Math.hypot(a.a[0] - a.center[0], a.a[1] - a.center[1]), 2, 1e-9, "半径");
  });
});

describe("変換データの構造", () => {
  test("リール: 459 部品を 25 種類の形状にまとめ、櫛歯は 1 種類 × 392 か所", () => {
    const { parts } = specs.reel;
    assert.equal(parts.length, 25);
    assert.equal(parts.reduce((s, p) => s + p.instances.length, 0), 459);
    assert.equal(Math.max(...parts.map((p) => p.instances.length)), 392);
  });
  test("全てのループが閉じている（各部分の終点が次の始点と一致）", () => {
    for (const spec of Object.values(specs)) {
      for (const part of spec.parts) {
        for (const loop of part.sketch.loops) {
          if (loop.length === 1 && loop[0].type === "circle") continue;
          loop.forEach((s, i) => assert.deepEqual(loop[(i + 1) % loop.length].a, s.b, `${part.name} の ${i} 番目`));
        }
      }
    }
  });
  test("ビルダーのテストに使う保存済みの変換データが、現在の出力と一致する", () => {
    for (const [name, spec] of Object.entries(specs)) {
      const stored = fs.readFileSync(path.join(BUILDER_FIXTURES, `${name}.inventor.json`), "utf8");
      assert.equal(stored, fixtureText(spec), `${name}: node app/test/builder-fixtures.mjs で更新してください`);
    }
  });
});
