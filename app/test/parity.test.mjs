// JS 版の解析結果が、Python 版で作った正解データ（tests/fixtures）と一致することを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIpt } from "../src/ipt/index.js";
import { SAMPLE_NAME, diff, readGolden, readSample } from "./helpers.mjs";

const golden = readGolden();
const result = parseIpt(readSample(), SAMPLE_NAME);

test("レポート（構造・セグメント・形状要約）が Python 版と一致する", () => {
  assert.deepEqual(diff(result.report, golden.report), []);
});

test("シーン（面・稜線・要約）が Python 版と一致する", () => {
  assert.deepEqual(diff(result.scene, golden.scene), []);
});

test("差分検出器そのものが差を見逃さない", () => {
  assert.equal(diff({ a: [1, 2] }, { a: [1, 2.001] }).length, 1);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }).length, 1);
  assert.equal(diff([1], [1, 2]).length, 1);
});
