// JS 版の解析結果が、Python 版で作った正解データ（tests/fixtures/ipt）と一致することを確かめる。
// samples/ipt に置いた全ての .ipt が対象（正解データは python -m tests.golden で作る）。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseIpt } from "../src/ipt/index.js";
import { diff, readGolden, readSample, sampleIpts } from "./helpers.mjs";

for (const name of sampleIpts()) {
  describe(name, () => {
    const golden = readGolden(name);
    test("正解データがある", () => assert.ok(golden, "python -m tests.golden で作ってください"));
    if (!golden) return;
    const result = parseIpt(readSample(name), name);
    test("レポート（構造・セグメント・形状要約）が Python 版と一致する", () => {
      assert.deepEqual(diff(result.report, golden.report), []);
    });
    test("シーン（面・稜線・要約）が Python 版と一致する", () => {
      assert.deepEqual(diff(result.scene, golden.scene), []);
    });
  });
}

test("差分検出器そのものが差を見逃さない", () => {
  assert.equal(diff({ a: [1, 2] }, { a: [1, 2.001] }).length, 1);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }).length, 1);
  assert.equal(diff([1], [1, 2]).length, 1);
});
