// DWG の見出しの変数（formats/dwg/header.js）の評価: 版ごと（R2000〜R2018）の見出しの節を読んだ値が、同じ図面を AutoCAD が書いた DXF の値と合うか。
// 範囲・日時のような既定でない値も比べるので、変数の並び（LAYOUT）が 1 つでもずれれば落ちる。
// 素材は ACadSharp（MIT）の見本の見出しの節（tests/fixtures/drawings/dwg-header/README.md）と、A1 の DWG（R2000・R2004）とその DXF
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { DwgError } from "../../app/static/js/formats/dwg/bits.js";
import { VERSION_NAME } from "../../app/static/js/formats/dwg/file.js";
import { readHeader } from "../../app/static/js/formats/dwg/header.js";
import { readDwgObjects } from "../../app/static/js/formats/dwg/index.js";
import { readModel } from "../../app/static/js/formats/open.js";
import { ROOT } from "./helpers.mjs";

const DRAWINGS = path.join(ROOT, "tests/fixtures/drawings");
const HEADERS = JSON.parse(fs.readFileSync(path.join(DRAWINGS, "dwg-header/acadsharp.json"), "utf8"));
const VERSION = Object.fromEntries(Object.entries(VERSION_NAME).map(([code, name]) => [name, Number(code)]));
const bytes = (file) => new Uint8Array(fs.readFileSync(file));
const DAY = 86400000; // ミリ秒
// 日時（日の小数）と、DXF との差（ミリ秒）。見本の DXF は DWG の 1 秒後に保存してあり（5 版とも）、直した日と編集した時間だけが 1 秒進んでいる
const DATES = { tducreate: 0, tduupdate: -1000, tdindwg: -1000 };
/** 日時は 1 ミリ秒まで（DWG はミリ秒で持つ。値の大きさに比べた幅だと、ユリウス日では日をまたぐずれまで通してしまう）、ほかは 1e-9 の比で比べる */
const close = (name, a, b) => (name in DATES ? Math.abs((a - b) * DAY - DATES[name]) <= 1 : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

/** 読んだ値を DXF の書き方に（日時: [ユリウス日, ミリ秒] → 日の小数） */
const asDxf = (header) => ({ ...header, psltscale: Number(header.psltscale),
  ...Object.fromEntries(Object.keys(DATES).map((name) => [name, header[name][0] + header[name][1] / DAY])) });

test("見出しの変数: R2000〜R2018 の見出しの節を読んだ値が、同じ図面の DXF の 12 個の変数（日時は世界時の $TDUCREATE など）と全て合う", () => {
  assert.deepEqual(HEADERS.map((h) => h.version), ["R2000", "R2004", "R2010", "R2013", "R2018"]);
  for (const { version, maintenance, header, dxf } of HEADERS) {
    const got = asDxf(readHeader(new Uint8Array(Buffer.from(header, "base64")), { version: VERSION[version], maintenance }));
    assert.equal(Object.keys(dxf).length, 12, version);
    for (const [name, want] of Object.entries(dxf)) {
      const ok = Array.isArray(want) ? want.every((v, i) => close(name, got[name][i], v)) : close(name, got[name], want);
      assert.ok(ok, `${version} ${name}: ${JSON.stringify(got[name])}（DXF は ${JSON.stringify(want)}）`);
    }
  }
});

test("見出しの変数: 節の頭が違えば読まない（並びの途中で止まらず、はっきり知らせる）", () => {
  const { version, maintenance, header } = HEADERS[0];
  const broken = new Uint8Array(Buffer.from(header, "base64"));
  broken[0] ^= 0xff;
  assert.throws(() => readHeader(broken, { version: VERSION[version], maintenance }), DwgError);
  assert.throws(() => readHeader(null, { version: VERSION[version], maintenance }), DwgError);
});

test("見出しの変数: DWG の図面の単位と線種の尺度が、同じ図面の DXF と同じになる（A1 は mm、ACadSharp の見本は inch）", () => {
  const dxf = readDrawing(bytes(path.join(DRAWINGS, "A1_R2000_sjis.dxf")), "A1_R2000_sjis.dxf");
  for (const name of ["A1_R2000.dwg", "A1_R2004.dwg"]) {
    const file = bytes(path.join(DRAWINGS, name));
    const { header, failures } = readDwgObjects(file);
    assert.ok(header, name);
    assert.deepEqual(failures, [], name);
    assert.equal(header.insunits, 4, name);
    assert.equal(header.textsize, 2.5, name);
    const drawing = readDrawing(file, name);
    assert.deepEqual([drawing.units, drawing.ltscale], [dxf.units, dxf.ltscale], name);
    assert.equal(drawing.units.name, "mm", name);
  }
  const sample = readDrawing(bytes(path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg")), "ACadSharp_sample_R2004.dwg");
  assert.deepEqual([sample.units.name, sample.ltscale], ["inch", 1]);
});

test("見出しの変数: 読めなければ、図形は描き、線種の尺度 1・単位なしで描いていると見出しバーで知らせる（図形の失敗とは数えない）", async () => {
  const name = "A1_R2000.dwg";
  const file = bytes(path.join(DRAWINGS, name));
  const at = file.findIndex((_, i) => file[i] === 0xcf && file[i + 1] === 0x7b && file[i + 2] === 0x1f && file[i + 3] === 0x23); // 見出しの節の頭
  assert.ok(at > 0);
  file[at] ^= 0xff;
  const { header, headerError, failures } = readDwgObjects(file);
  assert.equal(header, null);
  assert.match(headerError, /見出しの変数の節/);
  assert.deepEqual(failures, []);
  const model = await readModel(file, name);
  assert.deepEqual([model.drawing.units.name, model.drawing.ltscale], ["", 1]);
  assert.match(model.warning, /見出しの変数（線種の尺度・単位）を読めなかった/);
  assert.doesNotMatch(model.warning, /オブジェクト/);
  assert.ok(model.drawing.blocks.get("*Model_Space").entities.length > 0);
});
