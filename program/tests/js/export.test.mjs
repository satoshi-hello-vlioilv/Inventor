// Inventor 用変換データの評価。
// 「元のメッシュの全頂点が、変換データから再構成した面の上にあるか」と「体積・表面積が厳密値と一致するか」で、
// 変換データが元の形状を正しく表していることを確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import * as THREE from "three";
import { cross, dot, length } from "../../app/static/js/core/vec.js";
import { buildInventorSpec, expectedProperties, featureOf, maxDeviation, meshProperties } from "../../app/static/js/convert/inventor.js";
import { loopCorners, loopIntegrals } from "../../app/static/js/convert/recognize/geometry2d.js";
import { recognizeMesh, recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
import { pointAt } from "../../app/static/js/convert/recognize/mesh.js";
import { CORNER_ZONE } from "../../app/static/js/convert/recognize/prism.js";
import { BUILDER_FIXTURES, builderFixtures, fixtureText } from "../../tools/builder-fixtures.mjs";
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
  test("全てのループが閉じている（各部分の終点が次の始点と一致）。円弧の両端は中心から等しい距離", () => {
    for (const spec of Object.values(specs)) {
      for (const part of spec.parts.filter((p) => p.sketch)) {
        for (const loop of part.sketch.loops) {
          if (loop.length === 1 && loop[0].type === "circle") continue;
          loop.forEach((s, i) => assert.deepEqual(loop[(i + 1) % loop.length].a, s.b, `${part.name} の ${i} 番目`));
          for (const s of loop.filter((s) => s.type === "arc")) {
            const r = (p) => Math.hypot(p[0] - s.center[0], p[1] - s.center[1]);
            assert.ok(Math.abs(r(s.a) - r(s.b)) <= 2e-6, `${part.name}: 円弧の半径 ${r(s.a)} / ${r(s.b)}`);
          }
        }
      }
    }
  });
  test("円弧の中心を格子に合わせても、両端から等しい距離のまま（端点に float32 の誤差が残る円弧。コイル転倒で 0.00007 mm 食い違った）", () => {
    // 設計値は中心 (0, 136.4)・半径 18.7。端点 a は float32 の誤差を持ち、中心と端点 b は格子（0.001 mm）に合う
    const arc = { type: "arc", a: [4.84, 118.337184], b: [18.700004, 136.400001], center: [0.00002, 136.40003], ccw: true };
    const part = { kind: "revolve", segments: [arc], sweepDeg: 360, fit: { axis: { origin: [0, 0, 0], dir: [0, 1, 0] }, frame: [[1, 0, 0], [0, 0, 1]] } };
    const [s] = featureOf(part).loops[0];
    const r = (p) => Math.hypot(p[0] - s.center[0], p[1] - s.center[1]);
    assert.ok(Math.abs(r(s.a) - r(s.b)) <= 1e-9, `円弧の半径 ${r(s.a)} / ${r(s.b)}`);
    near(r(s.b), 18.7, 1e-4, "半径");
  });
  test("たる形の回転体（断面の円弧の中心が軸の反対側）: STEP の厳密な面で書けないので、元の形の三角形を添える", () => {
    const R = Math.sqrt(1000), start = Math.asin(-10 / R), span = 2 * Math.asin(10 / R);
    const profile = [[0, -10], ...Array.from({ length: 33 }, (_, i) => [-20 + R * Math.cos(start + (span * i) / 32), R * Math.sin(start + (span * i) / 32)]), [0, 10]];
    const specOf = (g) => buildInventorSpec({ file: "t.html", revision: "180", capturedAt: "" },
      { parts: recognizeMesh({ positions: g.attributes.position.array, index: g.index?.array ?? null, matrix: new THREE.Matrix4().elements }) }).parts;
    const [part] = specOf(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 64));
    assert.equal(part.kind, "revolve");
    const [arc] = part.sketch.loops[0].filter((s) => s.type === "arc");
    near(arc.center[0], -20, 1e-3, "円弧の中心");
    assert.ok(part.mesh?.triangles.length > 0, "STEP 用の三角形");
    // 円が軸と交わらない普通のトーラスには添えない（厳密な面で書ける）
    const [ring] = specOf(new THREE.TorusGeometry(50, 5, 32, 96));
    assert.equal(ring.kind, "revolve");
    assert.equal(ring.mesh, undefined);
  });
  test("近似の部品（メッセンジャーワイヤーの管 12 本）: 三角形が閉じた外向きの立体で、体積・表面積の期待値は三角形の和", () => {
    const tubes = specs.wire.parts.filter((p) => p.kind === "mesh");
    assert.equal(tubes.length, 12);
    for (const part of tubes) {
      const { positions, triangles } = part.mesh;
      const directed = new Set();
      for (let k = 0; k < triangles.length; k += 3) for (let e = 0; e < 3; e++) directed.add(`${triangles[k + e]}>${triangles[k + (e + 1) % 3]}`);
      for (const key of directed) assert.ok(directed.has(key.split(">").reverse().join(">")), `${part.name}: 稜線 ${key} の相手が無い`);
      const exact = expectedProperties({ kind: "mesh", mesh: { positions, triangles } });
      assert.ok(exact.volume > 0);
      assert.deepEqual([part.expect.volume, part.expect.area], [exact.volume, exact.area].map((v) => Math.round(v * 1e6) / 1e6));
    }
  });
  test("ビルダーのテストに使う保存済みの変換データが、現在の出力と一致する", () => {
    for (const [name, spec] of Object.entries(specs)) {
      const stored = fs.readFileSync(path.join(BUILDER_FIXTURES, `${name}.inventor.json`), "utf8");
      assert.equal(stored, fixtureText(spec), `${name}: npm run fixtures:builder で更新してください`);
    }
  });
});
