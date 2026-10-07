// 2D の図面（DWG・DXF）の評価: 形式の判定・読み取り（3 つの DXF と 2 つの DWG が同じ図面になる）・曲線（AutoCAD の制御点の再現）・
// 文字の書式・描くもの（scene）・指した図形の索引・説明・色。
// 試験の図面は program/tools/make_drawing_sample.py が作る（サンプルの部品 A1 の部品図）。DWG は LibreDWG の dxf2dwg で変換したもの
// （LibreDWG の書き方の都合で、属性定義の名前とビューポートの画層は空になる。比べるときは除く）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cadText } from "../../app/static/js/formats/cad2d/model.js";
import { bulgePoints, interpolateFit, ocsAxes, toOcs, toWcs } from "../../app/static/js/formats/cad2d/curves.js";
import { isDrawing, readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { BitReader } from "../../app/static/js/formats/dwg/bits.js";
import { decompress2004 } from "../../app/static/js/formats/dwg/file.js";
import { detectFormat, readModel } from "../../app/static/js/formats/open.js";
import { ACI, contrast, readable } from "../../app/static/js/viewer2d/colors.js";
import { describeDrawing, describeItem, scaleText } from "../../app/static/js/viewer2d/describe.js";
import { HitIndex } from "../../app/static/js/viewer2d/hit.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { mtextLines, singleLine } from "../../app/static/js/viewer2d/text.js";
import { compareDrawings } from "../../tools/cad2d-compare.mjs";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/drawings");
const SAMPLES = path.join(ROOT, "samples/dwg");
const read = (dir, name) => new Uint8Array(fs.readFileSync(path.join(dir, name)));
const drawingsIn = (dir) => fs.readdirSync(dir).filter((n) => /\.(dwg|dxf)$/i.test(n));
const SAMPLE = "A1_円筒_部品図.dxf";
const DXFS = [[SAMPLES, SAMPLE], [FIXTURES, "A1_R2000_sjis.dxf"], [FIXTURES, "A1_binary.dxf"]];
const DWGS = ["A1_R2000.dwg", "A1_R2004.dwg"];
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const counts = (entities) => entities.reduce((m, e) => m.set(e.type, (m.get(e.type) ?? 0) + 1), new Map());

test("形式: DWG（版の印）・DXF（ASCII・バイナリ・BOM 付き）を中身で見分け、図面として開く", () => {
  for (const [dir, name] of DXFS) assert.equal(isDrawing("x.bin", read(dir, name)), "dxf", name);
  for (const name of DWGS) assert.equal(isDrawing("x.bin", read(FIXTURES, name)), "dwg", name);
  assert.equal(isDrawing("x.txt", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("  0\r\nSECTION\r\n")])), "dxf");
  assert.equal(isDrawing("a.ipt", read(path.join(ROOT, "samples/ipt"), fs.readdirSync(path.join(ROOT, "samples/ipt")).find((n) => n.endsWith(".ipt")))), null);
  for (const name of drawingsIn(SAMPLES)) assert.equal(detectFormat(name, read(SAMPLES, name)), "drawing", name);
  assert.throws(() => readDrawing(new TextEncoder().encode("AC1009 old"), "old.dwg"), /R12 以前/);
});

test("サンプルの図面（全て）は図面のモデルになり、全てのレイアウトを描ける", async () => {
  for (const name of drawingsIn(SAMPLES)) {
    const model = await readModel(read(SAMPLES, name), name);
    assert.equal(model.kind, "drawing", name);
    assert.match(model.meta, /^(DWG|DXF) R\d+/, name);
    for (const layout of model.drawing.layouts) {
      const scene = buildScene(model.drawing, layout);
      assert.ok(scene.items.length > 0 && scene.extents, `${name} ${layout.name}`);
    }
  }
});

test("DXF: ASCII（UTF-8・Shift_JIS）とバイナリが同じ図面になる（画層・レイアウト・図形・日本語）", () => {
  const drawings = DXFS.map(([dir, name]) => readDrawing(read(dir, name), name));
  const [utf8] = drawings;
  assert.deepEqual([...utf8.layers.keys()].sort(), ["0", "Defpoints", "かくれ線", "ハッチング", "中心線", "図枠", "外形線", "寸法", "文字"].sort());
  assert.deepEqual(utf8.layouts.map((l) => [l.name, l.model]), [["Model", true], ["A3", false]]);
  assert.equal(utf8.units.name, "mm");
  const model = utf8.blocks.get("*Model_Space").entities;
  const title = model.find((e) => e.type === "INSERT" && e.block === "表題欄");
  assert.deepEqual(title.attribs.map((a) => [a.tag, a.text]), [["品名", "円筒 両切欠き＋片ネジ Φ54.5"], ["図番", "A1-001"]]);
  for (const d of drawings.slice(1)) {
    const r = compareDrawings(utf8, d);
    assert.deepEqual([r.onlyA, r.onlyB, r.diffs], [[], [], []], d.version);
    assert.ok(r.compared > 90);
  }
  assert.deepEqual([...counts(model)].sort(), [...counts(drawings[2].blocks.get("*Model_Space").entities)].sort());
});

test("DWG（R2000・R2004）を、同じ図面の DXF と図形ごとに突き合わせる（ハンドルが同じ）", () => {
  const dxf = readDrawing(read(FIXTURES, "A1_R2000_sjis.dxf"));
  for (const name of DWGS) {
    const dwg = readDrawing(read(FIXTURES, name), name);
    assert.deepEqual(dwg.failures, [], name);
    const r = compareDrawings(dwg, dxf);
    // LibreDWG が書かない値（属性定義の名前・ビューポートの画層）だけが違う
    const unexpected = r.diffs.filter(([, type, at]) => !/(^|\.)tag$/.test(at) && !(type === "VIEWPORT" && at === "layer"));
    assert.deepEqual(unexpected, [], name);
    assert.deepEqual([r.onlyA.length, r.onlyB.length], [0, 0], name);
    assert.ok(r.compared > 90 && r.equal > 90, `${name}: ${r.equal}/${r.compared}`);
    // R2000 の属性は最初〜最後のハンドル、R2004 は相対のハンドルの参照（+n）で持つ
    const title = dwg.blocks.get("*Model_Space").entities.find((e) => e.type === "INSERT" && e.attribs.length);
    assert.deepEqual(title.attribs.map((a) => a.text), ["円筒 両切欠き＋片ネジ Φ54.5", "A1-001"], name);
  }
});

test("ビット列: BS・BD・相対のハンドルの参照（基準 = 読んでいるオブジェクト）", () => {
  // BS: 00 + RS(0x1234) → 10 ビット + 16 ビット … ここでは 2 ビットの符号ごとに確かめる
  const bits = (s) => {
    const out = new Uint8Array(Math.ceil(s.length / 8));
    [...s].forEach((c, i) => (out[i >> 3] |= c === "1" ? 0x80 >> (i & 7) : 0));
    return out;
  };
  // BS 10 = 0・BS 11 = 256・BD 01 = 1.0・BD 10 = 0.0
  const r = new BitReader(bits("10" + "11" + "01" + "10"), 0, { version: 1015 });
  assert.deepEqual([r.bs(), r.bs(), r.bd(), r.bd()], [0, 256, 1, 0]);
  // ハンドル: 0xA1 0x02 = 基準 + 2、0x61 0x00 = 基準 + 1（6 は値を持たないが、バイト数 1 の書き方もある）
  const h = new BitReader(Uint8Array.of(0xa1, 0x02, 0xc1, 0x03, 0x51, 0x2f), 0, { version: 1015 });
  h.base = 0x10f;
  assert.deepEqual([h.handle(), h.handle(), h.handle()], [0x111, 0x10c, 0x2f]);
});

test("R2004 の圧縮（LZ77）: 文字だけ・繰り返しの参照を解く", () => {
  // 先頭の文字列 4 バイト（長さ 4 は 0x01 + 3）→ 0x11 で終わり
  const literal = Uint8Array.of(0x01, 0x41, 0x42, 0x43, 0x44, 0x11);
  assert.deepEqual([...decompress2004(literal, 0, literal.length, 16)], [0x41, 0x42, 0x43, 0x44]);
});

test("通過点のスプライン: AutoCAD の制御点・ノットを再現する（接線あり・なし。AutoCAD が書いた DXF の値）", () => {
  // example_2018.dxf の SPLINE 16E（両端の接線あり）
  const withTangents = {
    fit: [[-1160.70828949499, 1466.2995980182498, 0], [-803.2584206390579, 1216.7735574306182, 0], [-1263.536333621469, 1021.0668596204771, 0],
      [-1297.8123483302957, 1896.8543336404111, 0], [-1493.6752901126752, 1867.4983280891886, 0], [-1449.6061289332692, 1436.9435924670272, 0]],
    startTangent: [-0.8122360233169472, -0.5833289315868635, 0], endTangent: [-0.036041372146852574, -0.9993502986909907, 0],
    knots: [0, 0, 0, 0, 435.9284960592313, 936.0853402063389, 1812.54329403786, 2010.593961861958, 2443.398157005357, 2443.398157005357, 2443.398157005357, 2443.398157005357],
    controls: [[-1160.70828949499, 1466.29959801825], [-1278.733898858219, 1381.536363400083], [-393.9544459252916, 1231.131526494542],
      [-1793.156271927829, 719.5692228288901], [-936.5505143705686, 1967.430418368798], [-1656.363244849998, 1879.620298503901],
      [-1444.406509911975, 1581.117926364117], [-1449.606128933269, 1436.943592467027]],
  };
  // 2000/TS1.dxf の SPLINE 225（接線なし = 両端の 2 階微分 0）
  const natural = {
    fit: [[25.62621049725817, 12.371899998216037, 0], [25.62621049725817, 15.76702556299918, 0], [28.758083094860524, 13.344462018234452, 0],
      [29.625098583818954, 16.527392278018226, 0], [31.659323459940836, 14.493167401896343, 0]],
    knots: [0, 0, 0, 0, 3.395125564783143, 7.354600289545956, 10.65350327337877, 13.53033168210706, 13.53033168210706, 13.53033168210706, 13.53033168210706],
    controls: [[25.62621049725817, 12.37189999821604], [25.34885040204111, 14.12682716616591], [24.74802648620394, 17.92839138264598],
      [29.5336468321851, 10.72643392370707], [29.05477696649714, 18.25518476135446], [30.83162019051585, 15.68870531066294],
      [31.65932345994084, 14.49316740189634]],
  };
  for (const c of [withTangents, natural]) {
    const s = interpolateFit(c);
    assert.equal(s.knots.length, c.knots.length);
    s.knots.forEach((k, i) => assert.ok(close(k, c.knots[i], 1e-12), `ノット ${i}`));
    s.controls.forEach((p, i) => assert.ok(close(p[0], c.controls[i][0], 1e-12) && close(p[1], c.controls[i][1], 1e-12), `制御点 ${i}`));
  }
});

test("膨らみ（bulge）と OCS: 半円の向き・押し出しが -Z の鏡映", () => {
  const ccw = bulgePoints([0, 0], [2, 0], 1, Math.PI / 4);
  assert.ok(ccw.some((p) => close(p[0], 1, 1e-12) && close(p[1], -1, 1e-12)), "正の膨らみ（反時計回り）は弦の右下を回る");
  assert.ok(bulgePoints([0, 0], [2, 0], -1, Math.PI / 4).some((p) => close(p[1], 1, 1e-12)), "負は上を回る");
  assert.deepEqual(toWcs(ocsAxes([0, 0, -1]), [1, 2, 0]).map((v) => v + 0), [-1, 2, 0]);
  const tilted = ocsAxes([0.3, -0.4, 0.866]);
  const back = toOcs(tilted, toWcs(tilted, [3, -2, 5]));
  [3, -2, 5].forEach((v, i) => assert.ok(close(back[i], v, 1e-12), "OCS → WCS → OCS で元に戻る"));
  assert.equal(ocsAxes([0, 0, 1]), null);
});

test("文字: 逃がし（\\U+・\\M+）・%% の符号・MTEXT の書式", () => {
  assert.equal(cadText("108\\U+00B0"), "108°");
  assert.equal(cadText("\\M+182A0"), "あ");
  assert.equal(cadText("a\\\\U+0041"), "a\\\\U+0041", "\\ を逃がした後の U+ は文字のまま");
  assert.equal(singleLine("%%c25 %%p0.1 45%%d"), "⌀25 ±0.1 45°");
  assert.deepEqual(mtextLines("{\\fArial|b0;ABC}\\P\\C1;赤\\Pa\\~b \\S1^2;"), ["ABC", "赤", "a b 1/2"]);
});

test("描くもの: モデルとレイアウト（ビューポートで切る）・画層を隠す・ファイルの非表示を表示に上書き", () => {
  const drawing = readDrawing(read(SAMPLES, SAMPLE), SAMPLE);
  const [model, sheet] = drawing.layouts;
  const scene = buildScene(drawing, model);
  const [w, h] = describeDrawing(drawing, scene).extents;
  assert.ok(w > 300 && w < 400 && h > 120 && h < 160, `大きさ ${w} × ${h}`);
  assert.ok(scene.texts.some((t) => t.lines.includes("円筒 両切欠き＋片ネジ Φ54.5")), "属性の文字");
  assert.ok(scene.fills.length + scene.strokes.length > 0);
  // 紙のレイアウト: 図枠（紙の図形）とビューポートの中のモデル（枠で切る）
  const paper = buildScene(drawing, sheet);
  assert.ok(paper.strokes.some((s) => s.lines.some((l) => l.clip)), "ビューポートの中身は枠で切る");
  assert.ok(paper.extents.max[0] - paper.extents.min[0] <= 420 + 1e-6, "外形は紙の大きさ（中身ではみ出さない）");
  // 画層を隠すと、その画層の図形が消える
  const hidden = buildScene(drawing, model, { hidden: new Set(["寸法"]) });
  assert.equal(hidden.items.filter((i) => i.layer === "寸法").length, scene.items.filter((i) => i.layer === "寸法").length, "指せる図形の並びは同じ");
  assert.ok(hidden.strokes.reduce((n, s) => n + s.lines.length, 0) < scene.strokes.reduce((n, s) => n + s.lines.length, 0));
  // ファイルで非表示の画層も、利用者が表示にできる
  drawing.layers.get("中心線").off = true;
  const off = buildScene(drawing, model), on = buildScene(drawing, model, { shown: new Set(["中心線"]) });
  assert.ok(off.strokes.reduce((n, s) => n + s.lines.length, 0) < on.strokes.reduce((n, s) => n + s.lines.length, 0));
});

test("指した図形の索引と説明: 外形線の上の点で外形線を拾い、種類・寸法・画層を言う", () => {
  const drawing = readDrawing(read(SAMPLES, SAMPLE), SAMPLE);
  const scene = buildScene(drawing, drawing.layouts[0]);
  const index = new HitIndex(scene);
  // 正面図の下の辺（y = -27.25、x = 0〜77）の、寸法の補助線・ハッチングから離れた所
  const hit = index.find(45, -27.25, 0.5);
  // ハッチングの境界の線の上では、塗りより線を拾う（右下の部分断面: x = 57〜77）
  assert.equal(scene.items[index.find(66, -27.25, 0.5)].type, "LWPOLYLINE");
  assert.equal(scene.items[index.find(66, -15, 0.5)].type, "HATCH", "内側はハッチング");
  assert.notEqual(hit, null);
  assert.equal(scene.items[hit].layer, "外形線");
  assert.match(describeItem(scene.items[hit], "mm"), /^ポリライン · 頂点 4 · 長さ [\d.]+ mm · 画層 外形線$/);
  assert.equal(index.find(-500, -500, 1), null, "何も無い所");
  const circle = scene.items.find((i) => i.type === "CIRCLE" && Math.abs(i.entity.radius - 3.3) < 1e-9);
  assert.equal(describeItem(circle, "mm"), "円 · Φ6.6 mm · 半径 3.3 mm · 画層 外形線");
  assert.deepEqual([scaleText(0.5), scaleText(2), scaleText(1)], ["1:2", "2:1", "1:1"]);
});

test("色: 色番号の規則・地に読める色（白地のシアン・黄を濃く、届く色はそのまま）", () => {
  assert.deepEqual([ACI[1], ACI[2], ACI[5], ACI[7], ACI[10], ACI[11], ACI[250], ACI[255]],
    ["#ff0000", "#ffff00", "#0000ff", null, "#ff0000", "#ff7f7f", "#333333", "#ffffff"]);
  assert.deepEqual([ACI[13], ACI[15]], ["#a55252", "#7f3f3f"], "切り捨て（AutoCAD の値）");
  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  for (const c of ["#00ffff", "#ffff00", "#00ff00"]) {
    const fixed = readable(c, "#ffffff", "#1b2430", 3);
    assert.ok(contrast(rgb(fixed), [255, 255, 255]) >= 3, `${c} → ${fixed}`);
  }
  assert.equal(readable("#ff0000", "#ffffff", "#1b2430", 3), "#ff0000");
  assert.equal(readable("#00ffff", "#ffffff", "#1b2430", 0), "#00ffff", "下限 0 は補正しない");
});
