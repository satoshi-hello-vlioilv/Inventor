// Jw_cad の図面（.jww）の評価: 形式の判定・読み取り（見出し・画層グループ・色・線種・図形）・図面のモデルへの変換・
// Jw_cad 自身が書き出した DXF との突き合わせ（tools/jww-check.mjs と同じ比べ方）・画面の色（Jw_cad の画面の絵で測った値）。
// 試験の素材は ezjww（MIT）の、Jw_cad 10.02 で保存し直した JWW と Jw_cad が書き出した DXF の組（tests/fixtures/drawings/jww/README.md）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isDrawing, readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { layerScales } from "../../app/static/js/formats/cad2d/model.js";
import { JwwError, readJww } from "../../app/static/js/formats/jww/index.js";
import { detectFormat, explainError, readModel } from "../../app/static/js/formats/open.js";
import { describeItem } from "../../app/static/js/viewer2d/describe.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { compareJww, read } from "../../tools/jww-check.mjs";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/drawings/jww");
const SAMPLES = path.join(ROOT, "samples/dwg");
const fixture = (name) => read(path.join(FIXTURES, `${name}.gz`));
const sample = (name) => new Uint8Array(fs.readFileSync(path.join(SAMPLES, name)));
const PAIRS = fs.readdirSync(FIXTURES).filter((n) => n.endsWith(".jww.gz")).map((n) => n.replace(/\.jww\.gz$/, ""));
const entitiesOf = (drawing) => drawing.blocks.get(drawing.layouts[0].block).entities;

test("形式: 先頭の印（JwwData.）で見分け、図面として開く。サンプルの JWW は全て開けて描ける", async () => {
  assert.ok(PAIRS.length >= 10);
  for (const name of PAIRS) assert.equal(isDrawing("x.bin", fixture(`${name}.jww`)), "jww", name);
  const jwws = fs.readdirSync(SAMPLES).filter((n) => /\.jww$/i.test(n));
  assert.ok(jwws.length >= 2);
  for (const name of jwws) {
    assert.equal(detectFormat(name, sample(name)), "drawing", name);
    const model = await readModel(sample(name), name);
    assert.equal(model.kind, "drawing");
    assert.match(model.meta, /^JWW 700 · 用紙 A3/, name);
    const scene = buildScene(model.drawing, model.drawing.layouts[0]);
    assert.ok(scene.items.length > 0 && scene.extents, name);
  }
  // 壊れたファイル・違う中身は、理由を説明する
  const cut = fixture("basic.jww").subarray(0, 600);
  assert.throws(() => readJww(cut), JwwError);
  assert.match(explainError(new JwwError("ファイルが途中で切れています。")), /^Jw_cad の図面（JWW）として読めませんでした。/);
  assert.throws(() => readJww(new TextEncoder().encode("JwwDatX.0000")), /JwwData/);
});

test("Jw_cad の DXF と突き合わせる: 線と塗りの縁・文字が一致する（11 組）", () => {
  for (const name of PAIRS) {
    // 楕円は Jw_cad の DXF が 10° ごとの線分で書く（弦のずれ）ので、許容差 0.1 mm。塗りは DXF が輪の内側の縁を書かないので、DXF の点だけ
    const tol = name === "ellipse" || name === "solid" ? 0.1 : 0.05;
    const r = compareJww(fixture(`${name}.jww`), fixture(`${name}.dxf`), { tol });
    if (name !== "solid") assert.ok(r.precision >= (name === "ellipse" ? 0.98 : 1), `${name} 余計に描かない ${r.precision}`);
    assert.ok(r.recall >= (name === "ellipse" || name === "solid" ? 0.99 : 1), `${name} 描き漏らさない ${r.recall}`);
    // 文字: Jw_cad の DXF が日本語を「???」にしたもの（text_auto_end の 2 つ）を除き、全て同じ位置に同じ文字
    const lost = name === "text_auto_end" ? 2 : 0;
    assert.equal(r.texts[0], r.texts[1] - lost, `${name} 文字 ${r.texts}`);
  }
});

test("見出し: 用紙・画層グループの縮尺と状態・画面の色・線種の模様", () => {
  const settings = readJww(fixture("settings.jww"));
  assert.equal(settings.version, 700);
  assert.equal(settings.paperSize, 4); // A4
  assert.deepEqual(settings.groups.slice(0, 3).map((g) => [g.state, g.scale]), [[0, 0.5], [1, 0.5], [3, 50]]);
  const drawing = readDrawing(fixture("settings.jww"), "settings.jww");
  assert.deepEqual(drawing.layouts[0].paper, { min: [-148.5, -105], max: [148.5, 105] });
  assert.deepEqual(layerScales(drawing), [0.5, 50]);
  // 状態 0 の画層グループの画層は隠す
  assert.ok([...drawing.layers.values()].some((l) => l.off));

  const attributes = readJww(fixture("attributes.jww"));
  // 画面の色（COLORREF）: 地は白・線色 1 は水色・2 は黒（Jw_cad の画面の絵と同じ）
  assert.deepEqual(attributes.palette.pens.slice(0, 3), [0xffffff, 0xc0c000, 0x000000]);
  // 線種 2（点線 1）: 印刷の長さ（mm）の線とすき間
  assert.deepEqual(attributes.lineTypes.get(2), [0.625, 0.625]);
});

test("図面のモデル: 色・補助線の画層・内部の設定の文字・実寸の読み出し", () => {
  const drawing = readDrawing(fixture("attributes.jww"), "attributes.jww");
  const entities = entitiesOf(drawing);
  assert.equal(entities.length, 72);
  // 線色 1 は Jw_cad の画面の色（水色）。前景色（白地の黒）は色番号 7
  const pen = (n) => entities.find((e) => e.layer.startsWith(`0-${n}`)).color;
  assert.deepEqual(pen(1), { index: 7, rgb: 0x00c0c0 });
  assert.deepEqual(pen(2), { index: 7 });
  // 補助線は「補助線（印刷しない）」の画層にまとめ、Jw_cad の画面と同じ色・点線
  const aux = drawing.layers.get("0 補助線（印刷しない）");
  assert.ok(aux && !aux.plot && !aux.off);
  assert.equal(entities.filter((e) => e.layer === aux.name).length, 8);
  assert.deepEqual(aux.color, { index: 211, rgb: 0xff80ff });
  // Jw_cad が内部の設定を書いた文字（用紙の外 y = -1000）は描かない
  assert.ok(!entities.some((e) => e.type === "TEXT"));
  // 指した図形の長さは実寸（画層グループの縮尺を掛ける）。文字の高さは図面の長さのまま
  const line = entities.find((e) => e.type === "LINE");
  const item = { entity: line, layer: line.layer };
  assert.match(describeItem(item, "mm", 50), /長さ 2750 mm · 角度 0° · 縮尺 1:50 · 画層 /);
  assert.match(describeItem(item, "mm"), /長さ 55 mm · 角度 0° · 画層 /);
});

test("塗り: ソリッドの順・RGB の色・円の塗り（扇形は中心を通る・105 の輪は相似・106 の輪は帯の幅が一定）", () => {
  const drawing = readDrawing(fixture("solid.jww"), "solid.jww");
  const [square, triangle, disk, sector, ring105, ring106] = entitiesOf(drawing);
  assert.deepEqual(square.subpaths[0].points, [-60, -20, -40, -20, -40, 0, -60, 0]);
  assert.deepEqual(triangle.color, { index: 7, rgb: 0xab5612 }); // Jw_cad の画面の茶色
  assert.equal(disk.subpaths.length, 1);
  const pts = (p) => Array.from({ length: p.length / 2 }, (_, i) => [p[2 * i], p[2 * i + 1]]);
  assert.deepEqual(pts(sector.subpaths[0].points).at(-1), [-50, 30]); // 中心
  const extent = (p, c) => {
    const q = pts(p);
    return [Math.max(...q.map(([x]) => Math.abs(x - c[0]))), Math.max(...q.map(([, y]) => Math.abs(y - c[1])))].map((v) => Number(v.toFixed(6)));
  };
  // 外側は半径 15・扁平率 0.8。内側の半径 8: 105 は 8 × 0.8、106 は 12 − (15 − 8)（Jw_cad の画面で測った 5 mm）
  assert.deepEqual(extent(ring105.subpaths[0].points, [-10, 30]), [15, 12]);
  assert.deepEqual(extent(ring105.subpaths[1].points, [-10, 30]), [8, 6.4]);
  assert.deepEqual(extent(ring106.subpaths[1].points, [30, 30]), [8, 5]);
});

test("文字・寸法・ブロック: 角度・書体・日本語（Shift_JIS の DXF も文字コードを推して読む）", () => {
  const rotations = entitiesOf(readDrawing(fixture("text_rotations.jww"), "a.jww"));
  assert.deepEqual(rotations.map((e) => Math.round((e.rotation * 180) / Math.PI)), [0, 45, 90, 180, 270, 359]);
  const basic = entitiesOf(readDrawing(fixture("basic.jww"), "a.jww"));
  const text = basic.find((e) => e.type === "TEXT" && /日本語/.test(e.text));
  assert.ok(text, "日本語の文字");
  // Jw_cad の DXF は $DWGCODEPAGE を書かない Shift_JIS。中身から推して日本語を読む
  const dxf = entitiesOf(readDrawing(fixture("basic.dxf"), "a.dxf"));
  assert.ok(dxf.some((e) => e.type === "TEXT" && e.text === text.text));

  const dimension = readDrawing(fixture("dimension.jww"), "a.jww");
  const dims = entitiesOf(dimension).filter((e) => e.type === "DIMENSION");
  assert.equal(dims.length, 3);
  for (const d of dims) assert.ok(dimension.blocks.get(d.block).entities.some((e) => e.type === "TEXT"));
  const block = readDrawing(fixture("block.jww"), "a.jww");
  const inserts = entitiesOf(block).filter((e) => e.type === "INSERT");
  assert.ok(inserts.length >= 1 && inserts.every((e) => block.blocks.get(e.block)?.entities.length));
});
