// SXF の図面（.sfc・.p21）の評価: 形式の判定（3D の STEP と見分ける）・SFC の読み（フィーチャの並び・表・複合図形・複合曲線）・
// 図面のモデルへの変換・同じ図面の SFC と P21 の突き合わせ（tools/sxf-check.mjs と同じ比べ方）。
// 試験の素材は ezsxf（MIT）の図面とその書き直し（tests/fixtures/drawings/sxf/README.md）と、サンプルの SXF_A1_円筒_部品図（SFC・P21）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isDrawing, readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { detectFormat, explainError, readModel } from "../../app/static/js/formats/open.js";
import { SxfError, featuresFromSfc, isSxf, readSxf } from "../../app/static/js/formats/sxf/index.js";
import { describeDrawing } from "../../app/static/js/viewer2d/describe.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { compareDrawings } from "../../tools/sxf-check.mjs";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/drawings/sxf");
const SAMPLES = path.join(ROOT, "samples/dwg");
const bytes = (file) => new Uint8Array(fs.readFileSync(file));
const fixture = (name) => bytes(path.join(FIXTURES, name));
const sample = (name) => bytes(path.join(SAMPLES, name));
const SAMPLE = "SXF_A1_円筒_部品図";
const entities = (drawing, block = "*Paper_Space") => drawing.blocks.get(block).entities;
const byType = (list, type) => list.filter((e) => e.type === type);
const sfc = (body) => new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');\n` +
  `FILE_NAME('t.sfc','2026-10-08',(''),(''),'test$$3.1','test','');\nFILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`);
const feature = (n, text) => `/*SXF\n#${n} = ${text}\nSXF*/\n`;

test("形式: 見出し（SCADEC・ASSOCIATIVE_DRAUGHTING）で SXF と見分け、3D の STEP とは分ける。サンプルの SXF は全て開けて描ける", async () => {
  for (const name of ["all_features.sfc", "pair.sfc", "pair.p21"]) {
    assert.ok(isSxf(fixture(name)), name);
    assert.equal(isDrawing("x.bin", fixture(name)), "sxf", name);
  }
  const step = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\n");
  assert.equal(isSxf(step), false);
  assert.equal(detectFormat("a.stp", step), "step");
  const files = fs.readdirSync(SAMPLES).filter((n) => /\.(sfc|p21)$/i.test(n));
  assert.ok(files.length >= 2);
  for (const name of files) {
    assert.equal(detectFormat(name, sample(name)), "drawing", name);
    const model = await readModel(sample(name), name);
    assert.equal(model.kind, "drawing");
    assert.match(model.meta, /^SXF (SFC|P21) Ver\.3\.1 · 用紙 A3 · 縮尺 2:1・1:1/, name);
    const scene = buildScene(model.drawing, model.drawing.layouts[0]);
    assert.ok(scene.items.length > 0 && scene.extents, name);
  }
  // 壊れたファイル・違う中身は、理由を説明する
  assert.throws(() => readSxf(sfc("")), SxfError);
  assert.throws(() => readDrawing(sfc(feature(1, "line_feature('1','1','1','1','0','0','1','1')")), "t.sfc"), /用紙/);
  assert.match(explainError(new SxfError("用紙がありません")), /^SXF の図面（SFC・P21）として読めませんでした。/);
});

test("SFC の読み: 引数の 2 つの書き方（\\'…\\' と '…'）・逃がした \\・Ver.3 の囲み（/*SXF3.1 … SXF3.1*/）・Shift_JIS", () => {
  const { features } = featuresFromSfc(new TextDecoder().decode(fixture("all_features.sfc")));
  assert.equal(features.length, 52);
  const text = features.find((f) => f.id === 27);
  assert.equal(text.name, "text_string");
  assert.equal(text.params[3], "日本語 '), text\\\\path"); // 文字の中の \\ は、変換で \ に戻す
  assert.equal(features.find((f) => f.id === 29).name, "clothoid"); // /*SXF3.1 … SXF3.1*/
  assert.deepEqual(features.find((f) => f.id === 7).params, ["custom dash", "2", "(2.000000,1.000000)"]);
  // サンプルは日本の CAD と同じ Shift_JIS・CRLF
  const drawing = readDrawing(sample(`${SAMPLE}.sfc`), "a.sfc");
  assert.ok([...drawing.layers.keys()].includes("外形線"));
  assert.ok(byType(entities(drawing), "TEXT").some((e) => e.text === "円筒 両切欠き＋片ネジ φ54.5"));
});

test("変換: 表（画層・色・線種・線幅）・複合図形（部品・作図グループ・属性）・図形の種類・文字の基準点", () => {
  const drawing = readDrawing(fixture("all_features.sfc"), "a.sfc");
  assert.equal(drawing.format, "sxf");
  assert.equal(drawing.version, "SFC Ver.3.1");
  assert.deepEqual(drawing.layouts[0].paper, { min: [0, 0], max: [300, 200] }); // 自由な大きさ（種類 9）
  assert.deepEqual([...drawing.layers.keys()].slice(0, 2), ["土木", "文字"]);
  assert.equal(drawing.layers.get("文字").off, true); // lflag 0 = 隠す
  assert.deepEqual(drawing.linetypes.get("custom dash").dashes, [2, -1]); // 利用者の線種（番号 17）
  const line = byType(entities(drawing), "LINE")[0];
  assert.deepEqual(line.color, { index: 7, rgb: 0x0c2238 }); // 利用者の色（番号 17 = RGB 12・34・56）
  assert.equal(line.linetype, "custom dash");
  assert.equal(line.lineweight, 31); // 利用者の線幅（番号 11 = 0.31 mm）
  // 複合図形はブロック、置く場所は INSERT（角度・縦横の尺度）
  assert.deepEqual(drawing.blocks.get("部品").entities.map((e) => e.type), ["LINE", "CIRCLE"]);
  const insert = entities(drawing, "グループ").find((e) => e.type === "INSERT");
  assert.equal(insert.block, "部品");
  assert.deepEqual(insert.scale, [2, 0.5, 1]);
  assert.ok(Math.abs(insert.rotation - Math.PI / 6) < 1e-12);
  assert.deepEqual(drawing.attributes.map((a) => [a.mechanism, a.figure, a.value]), [["S", "表題_工事名", undefined], ["U", "等高線", "12.5"], ["F", undefined, undefined]]);
  // 図形の種類（クロソイドは折れ線・点の記号は点・寸法は無名のブロック付き）
  const types = new Map();
  for (const e of entities(drawing)) types.set(e.type, (types.get(e.type) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(types), { LINE: 1, LWPOLYLINE: 8, CIRCLE: 2, ARC: 1, ELLIPSE: 2, TEXT: 1, SPLINE: 1, DIMENSION: 5, POINT: 2,
    PATH: 2, HATCH: 3, INSERT: 4 }); // 折れ線: 折れ線・クロソイド・引出線・バルーン・ハッチングの見える境界 4
  const ellipseArc = byType(entities(drawing), "ELLIPSE")[1];
  assert.ok(ellipseArc.ratio <= 1);
  // 3 点のスプラインは点を通る曲線（3n+1 点ならベジェの並び）
  const spline = byType(entities(drawing), "SPLINE")[0];
  assert.deepEqual(spline.fit.map((p) => p.slice(0, 2)), [[0, 0], [5, 10], [10, 0]]);
  // 外部の記号・外部定義とタイルのハッチングは、置く点・境界だけ描くと知らせる
  assert.deepEqual([...drawing.unsupported.keys()].sort(), ["タイルのハッチング（境界だけ）", "外部定義のハッチング（境界だけ）", "外部定義の記号（置く点だけ）"].sort());
});

test("部分図: 縮尺は置き場所の尺度。線種のピッチ・矢印は用紙の大きさ（部分図の中では縮尺で割る）", () => {
  const drawing = readDrawing(sample(`${SAMPLE}.sfc`), "a.sfc");
  assert.deepEqual(drawing.figureScales, [0.5, 1]); // 2:1・1:1（実寸 = 用紙の長さ × k）
  const detail = drawing.blocks.get("詳細図A").entities;
  assert.ok(detail.every((e) => e.ltscale === 0.5));
  const front = drawing.blocks.get("正面図").entities;
  const dim = front.find((e) => e.type === "DIMENSION" && e.text === "77");
  assert.equal(dim.measurement, 77);
  const arrow = drawing.blocks.get(dim.block).entities.find((e) => e.arrow);
  assert.equal(arrow.arrow.size, 3); // 尺度 0.3 × 10 mm
  // 実物の図面（縮尺 1:20 の部分図で矢印の尺度 0.2667）なら、部分図の中の大きさは 53.3（用紙で 2.67 mm）
  const big = readDrawing(sfc([
    feature(10, "line_feature('0','1','1','1','0','0','100','0')"),
    feature(20, "linear_dim_feature('0','1','1','1','0','0','100','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','6','1','0','0','0.26666666666666','6','1','100','0','0.26666666666666','0','0',\\'\\','0','0','0','0','0','0','0','1','1')"),
    feature(30, "sfig_org_feature(\\'部分図-1\\','1')"),
    feature(40, "sfig_locate_feature('0',\\'部分図-1\\','10','10','0','0.05','0.05')"),
    feature(50, "drawing_sheet_feature(\\'図面\\','1','1','841','594')"),
  ].join("")), "t.sfc");
  const parts = big.blocks.get(big.blocks.get("部分図-1").entities[1].block).entities;
  assert.ok(Math.abs(parts.find((e) => e.arrow).arrow.size - 53.333333) < 1e-4);
  assert.equal(big.blocks.get("部分図-1").entities[0].ltscale, 20);
  assert.deepEqual(big.figureScales, [20]);
});

test("ハッチング: 境界は複合曲線（番号は出てきた順）。模様の線・塗り・見える境界", () => {
  const drawing = readDrawing(fixture("all_features.sfc"), "a.sfc");
  const hatches = byType(entities(drawing), "HATCH");
  const solid = hatches.find((h) => h.solid);
  assert.equal(solid.loops.length, 2); // 外側（複合曲線 1）と内側（2）
  assert.deepEqual(solid.loops[0].points, [[0, 0], [10, 0], [10, 10], [0, 10]]);
  const lines = hatches.filter((h) => h.lines.length);
  assert.deepEqual(lines.map((h) => h.lines[0].angle * 180 / Math.PI).map(Math.round), [60, 30]);
  assert.ok(Math.abs(Math.hypot(...lines[0].lines[0].offset) - 5) < 1e-12);
  // 複合曲線 1 は見える（印 1）ので、ハッチングごとにその線も描く。2 は見えない
  const outlines = byType(entities(drawing), "LWPOLYLINE").filter((e) => e.points.length === 5 && e.points[1][0] === 10);
  assert.ok(outlines.length >= 1);
});

test("SFC と P21: 同じ図面を描いたものが、線・文字・矢印まで一致する（サンプルと ezsxf の組）", () => {
  for (const [a, b] of [[sample(`${SAMPLE}.sfc`), sample(`${SAMPLE}.p21`)], [fixture("pair.sfc"), fixture("pair.p21")]]) {
    const r = compareDrawings(readDrawing(a, "a.sfc"), readDrawing(b, "a.p21"), { arrows: true });
    assert.equal(r.precision, 1);
    assert.equal(r.recall, 1);
    assert.equal(r.texts[0], r.texts[1]);
    assert.equal(r.texts[1], r.texts[2]);
  }
  // P21 だけの作り: 寸法は呼び出し（DRAUGHTING_CALLOUT）から DIMENSION に、文字の配置点は SFC の基準点に戻す
  const p21 = readDrawing(sample(`${SAMPLE}.p21`), "a.p21");
  assert.equal(p21.version, "P21 Ver.3.1");
  const dims = byType(p21.blocks.get("正面図").entities, "DIMENSION");
  assert.deepEqual(dims.map((d) => d.text).sort(), ["30", "77", "R5", "φ54.5"].sort());
  assert.equal(dims.find((d) => d.text === "77").measurement, 77);
});

test("画層の一覧: 部分図の中の図形も、その画層に数える（部分図の線の画層を表示・非表示できる）", () => {
  const drawing = readDrawing(sample(`${SAMPLE}.sfc`), "a.sfc");
  const scene = buildScene(drawing, drawing.layouts[0]);
  const layers = Object.fromEntries(describeDrawing(drawing, scene).layers.filter((l) => l.count).map((l) => [l.name, l.count]));
  assert.ok(layers["外形線"] > 10 && layers["中心線"] > 0 && layers["かくれ線"] > 0 && layers["ハッチング"] > 0, JSON.stringify(layers));
  // 外形線を隠すと、部分図の中の外形線も描かない
  const hidden = buildScene(drawing, drawing.layouts[0], { hidden: new Set(["外形線"]) });
  const ink = (s) => s.strokes.reduce((n, st) => n + st.lines.length, 0);
  assert.ok(ink(hidden) < ink(scene));
});
