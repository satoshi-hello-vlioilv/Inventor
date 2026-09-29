// ファイルを読んでモデルにする入口（formats/open.js）の評価。画面はこのモデルだけを見て表示する。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ModelError, detectFormat, explainError, partOf, readModel } from "../src/formats/open.js";
import { ROOT, readSample, readSampleFile, sampleIams, sampleIpts, sampleSteps } from "./helpers.mjs";

const samplesIn = (dir) => fs.readdirSync(path.join(ROOT, "samples", dir)).filter((n) => !/\.(md|png)$/i.test(n));

test("形式を拡張子と中身から決める（全サンプル。拡張子が違っても HTML・STEP は中身で分かる）", () => {
  const expected = { ipt: "ipt", iam: "iam", stp: "step", html: "html" };
  for (const [dir, format] of Object.entries(expected)) {
    for (const name of samplesIn(dir)) assert.equal(detectFormat(name, readSampleFile(dir, name)), format, name);
  }
  assert.equal(detectFormat("a.txt", new TextEncoder().encode("ISO-10303-21;\nHEADER;")), "step");
  assert.equal(detectFormat("a.txt", new TextEncoder().encode("<!doctype html><script>")), "html");
});

test(".ipt は部品のモデル（形状・ファイル構造・材質・サムネイル・見出しの一行）", async () => {
  for (const name of sampleIpts()) {
    const model = await readModel(readSample(name), name);
    assert.equal(model.kind, "part", name);
    assert.equal(model.format, "ipt");
    assert.ok(model.scene.bodies.length && model.report.segments.length && model.thumbnail?.length, name);
    assert.equal(model.properties.material, "鋼、軟鋼", name);
    assert.match(model.meta, /^ASM /);
  }
});

test("STEP の組立は組立のモデル。組立の部品は部品のモデルとして開ける", async () => {
  const [name] = sampleSteps();
  const model = await readModel(readSampleFile("stp", name), name);
  assert.equal(model.kind, "assembly");
  assert.deepEqual([model.scene.parts.length, model.scene.instances.length, model.missing.length], [10, 39, 0]);
  const part = partOf(model, 0);
  assert.equal(part.kind, "part");
  assert.equal(part.assembly, name);
  assert.equal(part.properties.density_g_per_cm3, 7.85);
});

test(".iam は参照先の部品を findPart で探し、見つからない部品のファイル名を挙げる", async () => {
  const [name] = sampleIams();
  const available = new Set(sampleIpts());
  const asked = [];
  const findPart = async (ref) => {
    asked.push(ref.file);
    return available.has(ref.file) ? { name: ref.file, bytes: readSample(ref.file) } : null;
  };
  const model = await readModel(readSampleFile("iam", name), name, { findPart });
  assert.equal(model.kind, "assembly");
  assert.equal(asked.length, 10);
  assert.deepEqual(model.missing, ["JIS B 1176 - M4 x 8 - 0.7.ipt", "JIS B 1176 - M4 x 40 - 0.7.ipt"]);
  assert.equal(model.warning, null);
  assert.equal(partOf(model, model.scene.parts.findIndex((p) => p.missing)), null, "形状の無い部品は開けない");
});

test("読めないファイルは、利用者に見せる説明になる", async () => {
  const garbage = new TextEncoder().encode("not a cad file");
  await assert.rejects(() => readModel(garbage, "x.ipt"), (error) => /OLE2/.test(explainError(error)));
  await assert.rejects(() => readModel(new TextEncoder().encode("<html>"), "x.html"), ModelError);
  await assert.rejects(() => readModel(new TextEncoder().encode("ISO-10303-21;\nDATA;\nENDSEC;"), "x.stp"), (error) => explainError(error).length > 0);
});
