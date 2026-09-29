// ipt ビューアの忠実度の評価。samples/ipt の全ての .ipt について、次の 2 つを確かめる。
//   形状 … 面ごとに三角形分割した結果をつなぎ合わせると、ソリッドとして閉じた（隙間・はみ出し・重なりのない）曲面になり、
//          曲面の三角形は解析曲面の上にあり、体積が「端面の面積 × 厚さ」（角柱状の部品）や寸法から求めた厳密値と一致する
//   仕様 … ファイル名と Inventor のサムネイルから読み取れる寸法・ねじが、要約（パネルに出す値）に現れる
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseIpt } from "../src/ipt/index.js";
import { describeBody } from "../src/viewer/describe.js";
import { readSample, sampleIpts } from "./helpers.mjs";
import { bodyMesh, DEVIATION_LIMIT, edgeDefects, FACE_TRIANGLE_LIMIT, signedVolume, surfaceDeviation, triangleArea } from "./mesh-check.mjs";

// 体積の差（外接箱の体積に対する比）。円を π/32 刻みの弦で近似すると、円の面積は最大 (π/32)²/6 ≈ 0.16% 変わる。
// 円の面積の合計は外接箱の断面積を超えないので、差は外接箱の体積の 0.16% 以内に収まる
// （側面の内側は曲面上の点で細分するので、端面（弦の多角形）× 厚さとも、厳密値とも、この範囲で異なる）
const VOLUME_TOL = 0.002;

// ---- 仕様（ファイル名とサムネイルから読み取れること）----------------------------
// threads: ねじの呼び → か所数、holes: ねじのない穴の径 → 数、outer: 外径、thickness: 厚さ（Z）、cones: 円錐の頂角、
// volume: 寸法から求めた厳密な体積（mm³）
const SPEC = {
  A1: { threads: { "M4x0.7": 4, "M6x1": 2, "M8x1.25": 2 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  A2: { threads: { "M4x0.7": 4, "M6x1": 2, "M8x1.25": 4 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  A3: { threads: { "M4x0.7": 6, "M8x1.25": 2 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  B: { threads: { "M4x0.7": 4, "M6x1": 2 }, holes: {}, outer: 54.5, cones: [] },
  C1: { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 3, cones: [] },
  "C1-2": { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 2, cones: [] },
  "C1-3": { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 1, cones: [] },
  C2: { threads: {}, holes: { 4.5: 2 }, outer: 54.5, thickness: 3, cones: [] },
  // Φ54.5 × 3、穴 Φ4.5 × 2、角窓 35 × 35（サムネイルの角窓。寸法は直線の稜線の頂点から読んだ値）
  D: { threads: {}, holes: { 4.5: 2 }, outer: 54.5, thickness: 3, cones: [], volume: 3 * (Math.PI * (27.25 ** 2 - 2 * 2.25 ** 2) - 35 * 35) },
  // 21 × 7.5 × 2、角 R3.5 × 4、穴 Φ4.5 × 2
  // ファイル名は「100㎜」だが、形状の長さは 97 mm（組立では C1（厚さ 3）と並ぶ）
  F: { threads: { "M4x0.7": 4, "M6x1": 2, "M8x1.25": 2 }, holes: {}, outer: 54.5, cones: [118, 118] },
  E: { threads: {}, holes: { 4.5: 2 }, cones: [], volume: 2 * (21 * 7.5 - 4 * (3.5 ** 2 - (Math.PI * 3.5 ** 2) / 4) - 2 * Math.PI * 2.25 ** 2) },
};
const tally = (items, keyOf) => items.reduce((m, x) => ({ ...m, [keyOf(x)]: (m[keyOf(x)] ?? 0) + 1 }), {});

for (const name of sampleIpts()) {
  describe(name, () => {
    const { scene } = parseIpt(readSample(name), name);
    const body = scene.bodies[0];
    const s = body.summary;
    const { triangles, missing, largest } = bodyMesh([body]);
    const envelope = s.size[0] * s.size[1] * s.size[2];
    const nearVolume = (actual, expected) => assert.ok(Math.abs(actual - expected) <= VOLUME_TOL * envelope, `${actual} vs ${expected}`);

    test("全ての面を三角形分割できる（稜線だけの面がない）", () => assert.deepEqual(missing, []));

    test("細分が自然に終わる（1 面の三角形が上限以下）", () => assert.ok(largest <= FACE_TRIANGLE_LIMIT, `${largest}`));

    test("稜線は全て 2 点以上の折れ線で、閉じた稜線は円周をたどる", () => {
      const short = body.edges.filter((line) => new Set(line.map((p) => p.join())).size < 2);
      assert.equal(short.length, 0, `点の足りない稜線 ${short.length} 本`);
    });

    test("面をつなぐと閉じたソリッドになる（隙間・はみ出し・重なりがない）", () => {
      assert.ok(s.closed);
      assert.deepEqual(edgeDefects(triangles), { open: 0, duplicated: 0 });
    });

    test("体積が正（面の表裏が外向きに揃っている）", () => assert.ok(signedVolume(triangles) > 0));

    test("円筒・円錐の三角形は解析曲面の上にある（弦で近似する分の誤差の範囲で）", () => {
      const worst = surfaceDeviation(triangles);
      assert.ok(worst <= DEVIATION_LIMIT, `設計上の弦の誤差の ${worst.toFixed(2)} 倍`);
    });

    const spec = SPEC[name.split("_")[0]];
    if (!spec) return;

    if (spec.thickness !== undefined) {
      test(`角柱の体積 = 端面の面積 × 厚さ ${spec.thickness}`, () => {
        assert.ok(Math.abs(s.size[2] - spec.thickness) < 1e-6, `厚さ ${s.size[2]}`);
        const cap = triangles.filter(({ face }) => face.type === "plane" && face.normal[2] === 1).reduce((a, t) => a + triangleArea(t.p), 0);
        nearVolume(signedVolume(triangles), cap * spec.thickness);
      });
    }

    if (spec.volume !== undefined) {
      test(`体積が寸法から求めた厳密値 ${spec.volume.toFixed(3)} mm³ と一致する`, () => {
        nearVolume(signedVolume(triangles), spec.volume);
      });
    }

    test("ねじ（呼びと数）", () => {
      const threads = s.cylinders.filter((c) => c.thread);
      assert.deepEqual(tally(threads, (c) => c.thread.designation), spec.threads);
      for (const c of threads) {
        assert.equal(c.kind, "hole", "ねじは全てめねじ（穴）");
        assert.ok(c.thread.lengths.every((l) => l > 0 && l <= c.length + 1e-6), `ねじ長さ ${c.thread.lengths} ≤ 穴の長さ ${c.length}`);
      }
    });

    test("ねじのない穴（径と数）", () => {
      assert.deepEqual(tally(s.cylinders.filter((c) => c.kind === "hole" && !c.thread), (c) => c.diameter), spec.holes);
    });

    if (spec.outer) {
      test(`外径 Φ${spec.outer}（角R ではなく外径として示す）`, () => {
        const outer = s.cylinders.filter((c) => c.diameter === spec.outer);
        assert.ok(outer.length > 0 && outer.every((c) => c.kind === "boss"), JSON.stringify(outer.map((c) => c.kind)));
      });
    }

    test("円錐（頂角）", () => {
      assert.deepEqual(s.cones.map((c) => Math.round(c.angle_deg)), spec.cones);
    });

    test("全ての円筒・円錐の面に説明がある（カーソルを合わせると寸法が出る）", () => {
      const { faceInfo } = describeBody(body, scene.labels);
      const curved = body.faces.filter((f) => f.type === "cylinder" || f.type === "cone");
      assert.deepEqual(curved.filter((f) => !faceInfo.get(f.id)?.group).map((f) => f.id), []);
    });
  });
}
