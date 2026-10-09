// R2007（AC1021）の DWG のファイルの組み立て（formats/dwg/rs2007.js）の試験: リード・ソロモン符号の並びを解く・R2007 の LZ77 の圧縮を解く・
// 見出しと節のページを読む。素材は ACadSharp（MIT）の見本の DWG から抜いたバイト列（tests/fixtures/drawings/dwg2007/README.md）。
// 見本の DWG そのもの（約 1 MB）での確かめは、環境変数 ACADSHARP_SAMPLES に ACadSharp の samples/ の場所があるときだけ行う
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { DwgError, R2007 } from "../../app/static/js/formats/dwg/bits.js";
import { readDwgFile } from "../../app/static/js/formats/dwg/file.js";
import { readHeader } from "../../app/static/js/formats/dwg/header.js";
import { readDwgObjects } from "../../app/static/js/formats/dwg/index.js";
import { decompress2007, deinterleave } from "../../app/static/js/formats/dwg/rs2007.js";
import { compareDrawings } from "../../tools/cad2d-compare.mjs";
import { ROOT } from "./helpers.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/drawings/dwg2007/acadsharp.json"), "utf8"));
const base64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
const u64 = (b, i) => b[i] + b[i + 1] * 2 ** 8 + b[i + 2] * 2 ** 16 + b[i + 3] * 2 ** 24 + (b[i + 4] + b[i + 5] * 2 ** 8 + b[i + 6] * 2 ** 16 + b[i + 7] * 2 ** 24) * 2 ** 32;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const SAMPLES = process.env.ACADSHARP_SAMPLES;
const sample = (name) => SAMPLES && path.join(SAMPLES, name);
const hasSample = SAMPLES && fs.existsSync(sample("sample_AC1021.dwg")) && fs.existsSync(sample("sample_AC1021_ascii.dxf"));

/** 見出しの変数を DXF の値と比べる */
function assertHeader(header) {
  for (const [name, want] of Object.entries(FIXTURE.dxf)) {
    const ok = Array.isArray(want) ? want.every((v, i) => close(header[name][i], v)) : close(header[name], want);
    assert.ok(ok, `${name}: ${JSON.stringify(header[name])}（DXF は ${JSON.stringify(want)}）`);
  }
}

test("R2007: リード・ソロモン符号の並びを解く（符号語 i の j バイトめは j × 符号語の数 + i。誤りを直す部分は捨てる）", () => {
  // 3 つの符号語（各 255 バイト）。データの部分を 4 バイトとして、頭の 10 バイトを取り出す
  const encoded = new Uint8Array(3 * 255);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 255; j++) encoded[j * 3 + i] = (i + 1) * 16 + (j < 4 ? j : 0x0f);
  assert.deepEqual([...deinterleave(encoded, 0, 3, 4, 10)], [0x10, 0x11, 0x12, 0x13, 0x20, 0x21, 0x22, 0x23, 0x30, 0x31]);
  assert.throws(() => deinterleave(encoded, 1, 3, 4, 10), DwgError); // 3 つめの符号語の終わりがファイルの外
});

test("R2007: LZ77 の圧縮を解く（文字の並べ替え・後ろからのコピー・命令の下 3 ビットの文字の数）", () => {
  // 文字 8 個（命令 0x00 → 8 個。8 バイトはそのままの順）→ 命令 0x30（3 バイトを 1 つ後ろから）→ 続くバイトの下 3 ビットの 2 → 文字 2 個（逆の順）
  const src = [0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0x30, 0x02, 0xaa, 0xbb];
  assert.deepEqual([...decompress2007(new Uint8Array(src), 0, src.length, 13)], [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 0xbb, 0xaa]);
  // 文字 32 個（命令 0x0F → 0x17 + 続くバイト 9）: 8 バイトの組の順が逆に書いてある
  const block = Array.from({ length: 32 }, (_, i) => i);
  const out = decompress2007(new Uint8Array([0x0f, 0x09, ...block]), 0, 34, 32);
  assert.deepEqual([...out], [...block.slice(24), ...block.slice(16, 24), ...block.slice(8, 16), ...block.slice(0, 8)]);
  // 途中で切れたもの・範囲の外を指す参照は、はっきり知らせる
  assert.throws(() => decompress2007(new Uint8Array(src), 0, 10, 13), DwgError);
  assert.throws(() => decompress2007(new Uint8Array([0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0x30, 0x48, 0]), 0, 12, 13), DwgError);
});

test("R2007: 見本の DWG の見出し（0x80〜）を解くと、ファイルの大きさ・決まった値（0x70・0xF800・0x60100 など）が読める", () => {
  const head = deinterleave(base64(FIXTURE.fileHeader), 0, 3, 239, 3 * 239);
  const length = head[0x18] | (head[0x19] << 8) | (head[0x1a] << 16) | (head[0x1b] << 24);
  const meta = decompress2007(head, 0x20, length, 0x110);
  const m = (at) => u64(meta, at);
  assert.equal(m(0x00), 0x70); // 見出しの大きさ
  assert.equal(m(0x08), FIXTURE.fileSize);
  assert.deepEqual([m(0x70), m(0x78), m(0x88), m(0x90), m(0x98), m(0xe8)], [0x20, 0x40, 0xf800, 4, 1, 0x60100]);
});

test("R2007: 見本の見出しの変数の節（符号 4 語・圧縮 757 → 848 バイト）を解いて読んだ値が、同じ図面の DXF と合う", () => {
  const { compressed, size, data } = FIXTURE.headerPage;
  const factor = Math.ceil(Math.ceil(compressed / 8) * 8 / 251);
  assert.equal(factor, 4);
  const page = decompress2007(deinterleave(base64(data), 0, factor, 251, factor * 251), 0, compressed, size);
  assertHeader(readHeader(page, { version: R2007, maintenance: FIXTURE.maintenance }));
});

test("R2007: 壊れた・途中で切れたファイルは、理由つきの DwgError で知らせる", () => {
  const tag = [..."AC1021"].map((c) => c.charCodeAt(0));
  const empty = new Uint8Array(0x800);
  empty.set(tag);
  assert.throws(() => readDwgFile(empty), DwgError); // 見出しが全て 0
  const short = new Uint8Array(0x100);
  short.set(tag);
  assert.throws(() => readDwgFile(short), DwgError);
});

test("R2007: 見本の DWG を全て読み、同じ図面の DXF と図形ごとに突き合わせる（R2004 と同じ 308/310）", { skip: !hasSample && "ACADSHARP_SAMPLES が無い" }, () => {
  const bytes = new Uint8Array(fs.readFileSync(sample("sample_AC1021.dwg")));
  const { version, objects, failures, header } = readDwgObjects(bytes);
  assert.equal(version, R2007);
  assert.deepEqual(failures, []);
  assert.ok(objects.size > 900, `${objects.size}`);
  assertHeader(header);
  const dwg = readDrawing(bytes, "sample_AC1021.dwg");
  const dxf = readDrawing(new Uint8Array(fs.readFileSync(sample("sample_AC1021_ascii.dxf"))), "sample_AC1021_ascii.dxf");
  assert.deepEqual(dwg.failures, []);
  const r = compareDrawings(dwg, dxf);
  // 残りの 2 つは、AutoCAD が保存のたびに作り直す注釈の無名のブロックと、引出線のフック線（R2004 以降の全ての版で同じ）
  assert.deepEqual([r.equal, r.compared], [308, 310]);
});
