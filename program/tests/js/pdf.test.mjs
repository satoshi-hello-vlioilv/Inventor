// PDF の図面と 3D（U3D）の評価: 字句・ストリームの符号化・壊れた相互参照・文字の対応（CMap）・ページの中身（線・文字・画層）・
// ページを表示するときに読むこと・3D の注記の取り出し・U3D のメッシュ（部品・面の数・大きさ）・最初の視点・サンプルの PDF。
// 試験の PDF は pdf-fixture.mjs が作る（小さな PDF を、ここで組み立てる）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { NO_LAYER } from "../../app/static/js/formats/cad2d/from-pdf.js";
import { isDrawing, readDrawing } from "../../app/static/js/formats/cad2d/index.js";
import { read3d } from "../../app/static/js/formats/model3d.js";
import { readModel } from "../../app/static/js/formats/open.js";
import { PdfFile } from "../../app/static/js/formats/pdf/file.js";
import { decodeStream } from "../../app/static/js/formats/pdf/filters.js";
import { parseCMap } from "../../app/static/js/formats/pdf/fonts.js";
import { Lexer, PdfName, PdfRef, PdfString, parseValue } from "../../app/static/js/formats/pdf/objects.js";
import { readU3d } from "../../app/static/js/formats/u3d/index.js";
import { describeMeshes } from "../../app/static/js/viewer/describe.js";
import { describeDrawing } from "../../app/static/js/viewer2d/describe.js";
import { buildScene } from "../../app/static/js/viewer2d/scene.js";
import { ROOT } from "./helpers.mjs";
import { drawingSet, pdfFile } from "./pdf-fixture.mjs";

const SAMPLES = path.join(ROOT, "samples/dwg");
const PDF3D = "U3D_SimpleShapes_3D.pdf";
const bytesOf = (text) => new TextEncoder().encode(text);
const value = (text) => parseValue(new Lexer(bytesOf(text)));
const MM = 25.4 / 72;
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
/** PDF のバイト列の一部を書き換える（1 バイト 1 文字のまま） */
const replaceText = (bytes, pattern, to) =>
  Uint8Array.from(new TextDecoder("latin1").decode(bytes).replace(pattern, to), (c) => c.charCodeAt(0));

/** 1 ページの PDF（内容ストリームと、ページの資源・注記・Catalog の項目を足せる） */
function onePage(content, { resources = "", annots = "", catalog = "", extra = [] } = {}) {
  return pdfFile([
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> ${resources} >> /Contents 4 0 R ${annots} >>`,
    { dict: "", data: bytesOf(content) },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...extra,
  ]);
}

test("字句: 文字列（エスケープ・8 進・16 進）・名前（#xx）・入れ子の配列と辞書・参照", () => {
  assert.equal(new TextDecoder().decode(value("(a\\(b\\)\\n\\101(c))").bytes), "a(b)\nA(c)");
  assert.deepEqual([...value("<48 65 6C6C 6F>").bytes], [...bytesOf("Hello")]);
  assert.deepEqual([...value("<414>").bytes], [0x41, 0x40], "16 進の奇数桁は 0 を補う");
  assert.equal(value("/A#20B").name, "A B");
  const dict = value("<< /Kids [1 0 R 2 0 R] /Size 3.5 /Inner << /On true /Off null >> /Name /X >>");
  assert.ok(dict.get("Kids")[0] instanceof PdfRef && dict.get("Kids")[1].num === 2);
  assert.equal(dict.get("Size"), 3.5);
  assert.equal(dict.get("Inner").get("On"), true);
  assert.equal(dict.get("Inner").get("Off"), null);
  assert.ok(dict.get("Name") instanceof PdfName && dict.get("Name").name === "X");
  assert.equal(new PdfString(Uint8Array.from([0xfe, 0xff, 0x30, 0x42])).text(), "あ", "UTF-16BE の文字の文字列");
});

test("ストリームの符号化: Flate（予測子 PNG 込み）・ASCIIHex・ASCII85・RunLength を解き、画像の符号化は残す", () => {
  const plain = bytesOf("0 0 m 100 100 l S");
  const dict = (text) => value(text);
  assert.deepEqual(decodeStream(zlib.deflateSync(plain), dict("<< /Filter /FlateDecode >>")).data, plain);
  assert.deepEqual(decodeStream(bytesOf("30 20 30>"), dict("<< /Filter /AHx >>")).data, bytesOf("0 0"));
  assert.deepEqual(decodeStream(bytesOf("87cURD]j7BEbo7~>"), dict("<< /Filter /ASCII85Decode >>")).data, bytesOf("Hello world"));
  assert.deepEqual(decodeStream(Uint8Array.from([2, 65, 66, 67, 254, 68, 128]), dict("<< /Filter /RunLengthDecode >>")).data, bytesOf("ABCDDD"));
  // PNG の予測子（Up）: 2 行 × 3 バイト。2 行目は上の行との差
  const rows = Uint8Array.from([2, 1, 2, 3, 2, 1, 1, 1]);
  const png = decodeStream(zlib.deflateSync(rows), dict("<< /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 3 >> >>")).data;
  assert.deepEqual([...png], [1, 2, 3, 2, 3, 4]);
  // 2 段の符号化（ASCII85 → Flate）と、画像の符号化（JPEG）は解かずに名前を返す
  const jpeg = decodeStream(bytesOf("abc"), dict("<< /Filter [/AHx /DCTDecode] >>"));
  assert.equal(jpeg.imageFilter, "DCTDecode");
});

test("壊れた相互参照（startxref のずれ）でも、ファイルを走査して読み直す", () => {
  const broken = replaceText(drawingSet(2), /startxref\n\d+/, "startxref\n99999");
  const pdf = new PdfFile(broken);
  assert.equal(pdf.pages().length, 2);
  assert.ok(pdf.repaired);
});

test("CMap: 符号の範囲・bfchar・bfrange（配列も）で文字に対応させる", () => {
  const cmap = parseCMap(bytesOf(`1 begincodespacerange <0000> <FFFF> endcodespacerange
    2 beginbfchar <0003> <0020> <0024> <30A2> endbfchar
    2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<5186> <7B52>] endbfrange`));
  const text = (c) => cmap.unicode.get(c);
  assert.equal(text(0x03), " ");
  assert.equal(text(0x24), "ア");
  assert.deepEqual([0x10, 0x11, 0x12].map(text), ["A", "B", "C"]);
  assert.deepEqual([0x20, 0x21].map(text), ["円", "筒"]);
});

test("ページの中身: 線・曲線・長方形・破線・文字が、ページの左下を原点にした mm の図形になる。画層（OCG）も", () => {
  const content = `2 w [6 3] 0 d 10 20 m 110 20 l S
    0 0 1 rg 50 50 100 40 re f
    1 0 0 RG 0 w 200 200 m 250 300 300 300 350 200 c S
    /OC /L1 BDC 0 g BT /F1 12 Tf 72 700 Td (Hello) Tj ET EMC`;
  const pdf = onePage(content, {
    resources: "/Properties << /L1 6 0 R >>",
    catalog: "/OCProperties << /OCGs [6 0 R] /D << /Order [6 0 R] >> >>",
    extra: ["<< /Type /OCG /Name <FEFF5BF86CD5> >>"], // 画層の名前「寸法」（UTF-16BE）
  });
  const drawing = readDrawing(pdf, "t.pdf");
  assert.equal(drawing.format, "pdf");
  assert.deepEqual(drawing.layouts.map((l) => [l.name, l.paper.max.map((v) => Math.round(v))]), [["1", [210, 297]]]);
  const entities = drawing.blocks.get(drawing.layouts[0].block).entities;
  const [dashed, filled, curve, text] = entities;
  assert.equal(dashed.type, "PATH");
  assert.ok(close(dashed.width, 2 * MM) && dashed.dashes.length === 2 && close(dashed.dashes[0], 6 * MM));
  assert.deepEqual(dashed.subpaths[0].points.map((v) => Number((v / MM).toFixed(6))), [10, 20, 110, 20]);
  assert.equal(filled.fill, "nonzero");
  assert.equal(filled.color.rgb, 0x0000ff);
  assert.equal(curve.color.rgb, 0xff0000);
  assert.equal(curve.width, 0, "0 w はいちばん細い線");
  assert.equal(curve.subpaths[0].curves.length, 1);
  assert.equal(text.type, "TEXT");
  assert.equal(text.text, "Hello");
  assert.equal(text.layer, "寸法");
  assert.ok(close(text.p[0], 72 * MM) && close(text.p[1], 700 * MM));
  assert.equal(dashed.layer, NO_LAYER);
  // 描くもの（scene）と右の欄の説明: 画層は「寸法」と「画層なし」
  const scene = buildScene(drawing, drawing.layouts[0]);
  const describe = describeDrawing(drawing, scene);
  assert.deepEqual(describe.layers.filter((l) => l.count).map((l) => l.name).sort(), [NO_LAYER, "寸法"].sort());
  assert.equal(scene.broken, 0);
});

test("ページの多い PDF: 開くときはページの中身を読まず、表示するページだけを読む", () => {
  const drawing = readDrawing(drawingSet(40), "set.pdf");
  assert.equal(drawing.layouts.length, 40);
  assert.ok(!drawing.layers.has(NO_LAYER), "まだどのページも読んでいない");
  const page = drawing.blocks.get(drawing.layouts[11].block);
  const texts = page.entities.filter((e) => e.type === "TEXT").map((e) => e.text);
  assert.deepEqual(texts, ["Sheet 12 / 40", "DWG-012"]);
  assert.ok(drawing.layers.has(NO_LAYER), "読んだページの画層が足される");
  assert.equal(page.entities, page.entities, "2 度目は読み直さない（同じ配列）");
});

test("3D の注記: U3D を取り出し、見た目が無ければページに 3D の場所（枠と案内）を描く", async () => {
  const sample = new Uint8Array(fs.readFileSync(path.join(SAMPLES, PDF3D)));
  const u3d = readDrawing(sample, PDF3D).models3d[0].bytes;
  const pdf = onePage("0 0 m 10 10 l S", {
    annots: "/Annots [6 0 R]",
    extra: ["<< /Type /Annot /Subtype /3D /Rect [100 100 400 400] /Contents (箱) /3DD 7 0 R >>", { dict: "/Type /3D /Subtype /U3D", data: u3d }],
  });
  const model = await readModel(pdf, "3d.pdf");
  assert.match(model.meta, /PDF 1\.7 · 1 ページ · 3D あり/);
  const [m] = model.drawing.models3d;
  assert.equal(m.format, "U3D");
  assert.equal(m.page, 0);
  assert.deepEqual([m.rect.min, m.rect.max].map((p) => p.map((v) => Math.round(v / MM))), [[100, 100], [400, 400]]);
  const entities = model.drawing.blocks.get(model.drawing.layouts[0].block).entities;
  const place = entities.filter((e) => e.layer.startsWith("3D の場所"));
  assert.deepEqual(place.map((e) => e.type), ["PATH", "TEXT"]);
  assert.equal(place[1].text, "3D（上のタブで表示）");
  assert.equal(buildScene(model.drawing, model.drawing.layouts[0]).broken, 0);
});

test("U3D: サンプルの 3D の PDF の 7 部品（面の数・大きさ・色）と、最初の視点（Z が上）", () => {
  const drawing = readDrawing(new Uint8Array(fs.readFileSync(path.join(SAMPLES, PDF3D))), PDF3D);
  assert.equal(drawing.models3d.length, 1);
  const result = readU3d(drawing.models3d[0].bytes);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.meshes.map((m) => [m.name, m.faces]), [
    ["Floor", 8192], ["WestWall", 1250], ["Platform", 128], ["NorthWall", 1250], ["SouthWall", 2], ["Elbo", 700], ["WestWall2", 2],
  ]);
  for (const m of result.meshes) {
    assert.equal(m.index.length % 3, 0, m.name);
    assert.ok(m.index.every((i) => i < m.positions.length / 3), `${m.name}: 頂点の番号が範囲の内`);
  }
  const scene = read3d(drawing.models3d[0]);
  const describe = describeMeshes(scene);
  assert.deepEqual(describe.size.map((v) => Math.round(v)), [400, 400, 200]);
  assert.equal(describe.faces, 11524);
  assert.equal(describe.info.size, scene.meshes.reduce((n, m) => n + m.groups.length, 0), "群ごとに強調の対応がある");
  assert.ok(scene.meshes.every((m) => m.groups.every((g) => /^#[0-9a-f]{6}$/.test(g.color))), "材質の色");
  // PDF の /3DV は U3D の視点の名前（DefaultView）を指す。カメラの上は +Z に近い
  assert.deepEqual(drawing.models3d[0].view, { node: "DefaultView" });
  const { up, direction } = scene.view;
  assert.ok(up[2] > 0.9, `上: ${up}`);
  assert.ok(close(Math.hypot(...direction), 1));
});

test("サンプルの PDF（全て）は図面のモデルになり、全てのページを描ける", async () => {
  for (const name of fs.readdirSync(SAMPLES).filter((n) => /\.pdf$/i.test(n))) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(SAMPLES, name)));
    assert.equal(isDrawing("x.bin", bytes), "pdf", name);
    const model = await readModel(bytes, name);
    assert.match(model.meta, /^PDF \d\.\d · \d+ ページ/, name);
    for (const layout of model.drawing.layouts) {
      const scene = buildScene(model.drawing, layout);
      assert.ok(scene.items.length > 0 && scene.paper, `${name} ${layout.name}`);
      assert.equal(scene.broken, 0, `${name} ${layout.name}: 壊れた図形`);
    }
  }
});
