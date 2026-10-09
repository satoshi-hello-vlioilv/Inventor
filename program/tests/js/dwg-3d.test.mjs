// DWG の 3D ソリッド（ACIS）の評価: 形の取り出し（オブジェクトの中の SAB・R2013+ の AcDs の節）・B-rep の読み・三角形の閉じ方と体積・
// 2D の稜線・3D の表示に渡す形（models3d）。
// 同じ図面を AutoCAD が R2004・R2013・R2018 で保存したもの（ACadSharp（MIT）の見本）が、どの版でも同じ形・体積になることを確かめる
// （版ごとに置き場と書き方が違う: R2004 はオブジェクトの中の "ACIS BinaryFile"、R2013+ は AcDs の節、R2018 は "ASM BinaryFile4"）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { acisMesh, acisShape } from "../../app/static/js/formats/acis/index.js";
import { readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { readAcDs } from "../../app/static/js/formats/dwg/acds.js";
import { readDwgObjects } from "../../app/static/js/formats/dwg/index.js";
import { read3d } from "../../app/static/js/formats/model3d.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { closure } from "../../tools/acis-check.mjs";
import { ROOT } from "./helpers.mjs";

const SAMPLE = path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg");
const ACDS = path.join(ROOT, "tests/fixtures/drawings/acds");
// 箱（5 × 5 × 5）・リージョン（平らな 1 面。閉じた立体ではない）・もう 1 つの 3D ソリッド
const EXPECTED = new Map([[3429, { faces: 6, volume: 125, closed: true }], [3433, { faces: 1, closed: false }], [3434, { faces: 7, volume: 47.539392, closed: true }]]);

/** ACIS のデータ → 面の数・閉じているか・体積 */
function facts(acis) {
  const shape = acisShape(acis);
  assert.equal(shape.error, undefined, shape.error);
  const mesh = acisMesh(shape);
  const { open, volume } = closure(mesh, 1e-6);
  return { faces: mesh.faces, drawn: mesh.drawn, closed: open === 0, volume };
}

function check(byHandle, label) {
  assert.deepEqual([...byHandle.keys()].sort(), [...EXPECTED.keys()], label);
  for (const [handle, want] of EXPECTED) {
    const got = facts(byHandle.get(handle));
    assert.equal(got.faces, want.faces, `${label} ${handle}: 面の数`);
    assert.equal(got.drawn, got.faces, `${label} ${handle}: 描けない面がある`);
    assert.equal(got.closed, want.closed, `${label} ${handle}: 閉じ方`);
    if (want.volume) assert.ok(Math.abs(got.volume - want.volume) < 1e-6, `${label} ${handle}: 体積 ${got.volume}`);
  }
}

test("R2004: オブジェクトの中の ACIS（SAB）を読み、箱の体積が 125・ほかも閉じた立体になる（ボディの置き方を反映）", () => {
  const { objects } = readDwgObjects(new Uint8Array(fs.readFileSync(SAMPLE)));
  check(new Map([...objects.values()].filter((o) => o.acis !== undefined).map((o) => [o.handle, o.acis])), "R2004");
});

test("R2013・R2018: AcDs の節からハンドルで形を取り出し、R2004 と同じ形・体積になる", () => {
  for (const name of ["R2013", "R2018"]) {
    const store = readAcDs(new Uint8Array(gunzipSync(fs.readFileSync(path.join(ACDS, `${name}.acds.gz`)))));
    check(store, name);
  }
  assert.equal(readAcDs(new Uint8Array(10)).size, 0, "短すぎる節は空");
});

test("図面: 2D では 3D ソリッドの稜線を描き、3D の表示には全てのソリッドを置き方と色つきで渡す（mm に直す）", async () => {
  const bytes = new Uint8Array(fs.readFileSync(SAMPLE));
  const drawing = readDrawing(bytes, "ACadSharp_sample_R2004.dwg");
  assert.equal(drawing.unsupported.get("3DSOLID"), undefined, "3D ソリッドは「まだ描かない図形」に数えない");
  const model = drawing.layouts.find((l) => l.model);
  const scene = buildScene(drawing, model, { shown: new Set(drawing.layers.keys()) });
  const solidItems = new Set(scene.items.flatMap((it, i) => (it.type === "ACIS" ? [i] : []))); // 線の item は items の番号
  assert.equal(solidItems.size, 3);
  const strokes = scene.strokes.flatMap((s) => s.lines).filter((l) => solidItems.has(l.item));
  assert.ok(strokes.length >= 12 + 3, `稜線 ${strokes.length} 本（箱だけで 12 本）`);
  const [entry] = drawing.models3d;
  assert.equal(entry.format, "ACIS");
  assert.equal(entry.unit, 25.4, "inch → mm");
  const shown = read3d(entry);
  assert.equal(shown.meshes.length, 3);
  assert.deepEqual(shown.warnings, []);
  assert.equal(shown.units, "mm");
  for (const m of shown.meshes) {
    assert.ok(m.positions instanceof Float32Array && m.index instanceof Uint32Array);
    assert.ok(m.groups[0].color === null || /^#[0-9a-f]{6}$/.test(m.groups[0].color), m.groups[0].color); // 色番号 7 は表示の既定の色
  }
  assert.ok(shown.view.direction && shown.view.up, "既定の視点（南東の等角図）");
});
