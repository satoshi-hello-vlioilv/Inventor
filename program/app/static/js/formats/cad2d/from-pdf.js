// PDF → 図面のモデル（model.js）。ページを紙のレイアウト（ブロック *Page1 …）に、画層（OCG）を画層にする。
// 座標はページの左下を原点にした mm（PDF の 1 pt = 25.4 / 72 mm。ページの回転 /Rotate も入れる）。
// PDF には円も寸法も無く、線と曲線の「パス」・文字・画像だけなので、図形は次の 3 つ（model.js の説明も参照）:
//   PATH  { subpaths: [{ points: [x, y, …], curves: [[i, c1x, c1y, c2x, c2y]], closed }], width（mm。0 = いちばん細い線）, dashes（mm）,
//           cap, fill: null | "nonzero" | "evenodd", alpha }
//   TEXT  （DWG と同じ。送り幅が分かれば 2 点の間に収める = halign 5。font: { family, weight, italic }）
//   IMAGE { matrix（画像の単位の正方形 → 図面）, image（pdf/images.js）}
// どれも clip（切り取りの外形 { min, max }）を持てる。描く順序に意味がある（後の図形が前の図形を隠す）ので drawing.ordered = true、
// 色は PDF の色そのまま（地に合わせて補正しない）なので drawing.exactColors = true。

import { annotations3d, runPage } from "../pdf/content.js";
import { PdfFile } from "../pdf/file.js";
import { extract3d } from "../pdf/three-d.js";
import { PdfError } from "../pdf/objects.js";
import { createDrawing, unitsOf } from "./model.js";

export { PdfError };

const MM_PER_PT = 25.4 / 72;
export const NO_LAYER = "画層なし";

/**
 * PDF のバイト列 → 図面のモデル。3D の注記は drawing.models3d に集める:
 *   [{ page（ページの番号）, rect（ページの上の枠, mm）, format: "U3D" | "PRC", bytes, name, view（既定の視点）}]
 */
export function drawingFromPdf(bytes) {
  const pdf = new PdfFile(bytes);
  const drawing = createDrawing({ format: "pdf", version: pdf.version });
  drawing.units = unitsOf(4);
  drawing.ordered = true;
  drawing.exactColors = true;
  drawing.repaired = pdf.repaired;
  drawing.models3d = [];
  // 画層: 名前ごとに 1 つ（同じ名前の OCG はまとめる）。並びは PDF の /Order
  const ocgs = pdf.layers();
  const layerKey = new Map();
  for (const [dict, l] of ocgs) {
    layerKey.set(dict, l.name);
    if (!drawing.layers.has(l.name)) drawing.layers.set(l.name, layerRecord(l.name, !l.on));
  }
  const pages = pdf.pages();
  if (!pages.length) throw new PdfError("PDF にページがありません。");
  // ページの中身は、そのページを初めて表示するとき（block.entities を初めて読むとき）に実行する（ページの多い PDF でも速く開く）。
  // 3D の注記だけは開くときに集める（3D のタブを出すため。中身は実行しない）
  pages.forEach((page, index) => {
    const { matrix, size } = pageTransform(pdf, page);
    const name = `*Page${index + 1}`;
    const block = { name, handle: "", base: [0, 0, 0], anonymous: false, xref: false, unsupported: new Map(), places3d: [] };
    let entities = null;
    Object.defineProperty(block, "entities", { enumerable: true, get: () => (entities ??= readPage(pdf, drawing, page, index, matrix, block, layerKey, ocgs)) });
    drawing.blocks.set(name, block);
    drawing.layouts.push({ name: page.label, block: name, model: false, tabOrder: index, paper: { min: [0, 0], max: size } });
    for (const found of annotations3d(pdf, page, matrix)) {
      const data = extract3d(pdf, found);
      if (!data) block.unsupported.set("読めない 3D の注記", (block.unsupported.get("読めない 3D の注記") ?? 0) + 1);
      else {
        drawing.models3d.push({ page: index, rect: found.rect, ...data });
        if (!found.poster && found.rect) block.places3d.push({ rect: found.rect, number: drawing.models3d.length });
      }
    }
  });
  return drawing;
}

/**
 * ページの中身を実行し、図形にする。描けなかったものは、そのページの block.unsupported に数える
 * （読み取りを途中で止めたときも、読めたところまでの図形を返す）
 */
function readPage(pdf, drawing, page, index, matrix, block, layerKey, ocgs) {
  const entities = [];
  let handle = 0;
  const nextHandle = () => `${(index + 1).toString(16).toUpperCase()}.${(++handle).toString(16).toUpperCase()}`;
  const count = (kind) => block.unsupported.set(kind, (block.unsupported.get(kind) ?? 0) + 1);
  const common = (layer, color, clip) => {
    const name = layer ? layerKey.get(layer) ?? NO_LAYER : NO_LAYER;
    if (!drawing.layers.has(name)) drawing.layers.set(name, layerRecord(name, false));
    return { handle: nextHandle(), layer: name, color: { index: 7, rgb: color ? parseInt(color.slice(1), 16) : 0 },
      linetype: "CONTINUOUS", lineweight: -3, ltscale: 1, invisible: false, ...(clip && { clip }) };
  };
  const sink = {
    path({ subpaths, stroke, fill, layer, clip }) {
      if (fill) entities.push({ ...common(layer, fill.color, clip), type: "PATH", subpaths, fill: fill.rule, alpha: fill.alpha, width: 0, dashes: [], cap: 0 });
      if (stroke) {
        entities.push({ ...common(layer, stroke.color, clip), type: "PATH", subpaths, fill: null, alpha: stroke.alpha, width: stroke.width,
          dashes: dashPattern(stroke.dashes), cap: stroke.cap });
      }
    },
    text({ text, origin, end, height, angle, oblique, mirror, color, font, layer, clip }) {
      if (joinText(entities.at(-1), { text, origin, end, height: height * CAP_HEIGHT, angle, mirror, color, font, layer: common(layer, color, clip) })) return;
      entities.push({ ...common(layer, color, clip), type: "TEXT", p: [origin[0], origin[1], 0], align: end ? [end[0], end[1], 0] : null,
        halign: end ? 5 : 0, valign: 0, height: height * CAP_HEIGHT, rotation: angle, widthFactor: 1, oblique, generation: mirror ? 2 : 0,
        text, style: font.name || "PDF", font: { family: font.family, weight: font.weight, italic: font.italic }, extrusion: [0, 0, 1] });
      Object.defineProperty(entities.at(-1), "fontRef", { value: font }); // つなぐ判定にだけ使う（数えない・比べない）
    },
    image({ matrix: m, image, layer, clip }) {
      entities.push({ ...common(layer, "#000000", clip), type: "IMAGE", matrix: m, image });
    },
    unsupported: count,
  };
  try {
    runPage(pdf, page, matrix, sink, { layers: ocgs });
  } catch (error) {
    count(`ページの読み取りを途中で止めた（${error.message}）`);
  }
  for (const { rect, number } of block.places3d) placeholder3d(drawing, entities, rect, drawing.models3d.length > 1 ? number : null, nextHandle());
  return entities;
}

/**
 * 3D を動かす前の絵が無い 3D の注記: ページの上に 3D の場所（枠と案内の文字）を描く。ファイルの図形ではないので、専用の画層に置く。
 * number … 3D のタブの番号（3D が 1 つなら null）
 */
function placeholder3d(drawing, entities, { min, max }, number, handle) {
  const layer = PLACEHOLDER_LAYER;
  if (!drawing.layers.has(layer)) drawing.layers.set(layer, layerRecord(layer, false));
  const base = { handle, layer, color: { index: 7, rgb: 0x8a939e }, linetype: "CONTINUOUS", lineweight: -3, ltscale: 1, invisible: false };
  const [w, h] = [max[0] - min[0], max[1] - min[1]];
  entities.push({ ...base, type: "PATH", fill: null, alpha: 1, width: 0, dashes: [], cap: 0,
    subpaths: [{ points: [min[0], min[1], max[0], min[1], max[0], max[1], min[0], max[1]], curves: [], closed: true }] });
  const height = Math.min(h * 0.04, w * 0.03);
  if (!(height > 0)) return;
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, 0];
  entities.push({ ...base, handle: `${handle}.1`, type: "TEXT", p: center, align: center, halign: 4, valign: 0, height, rotation: 0, widthFactor: 1,
    oblique: 0, generation: 0, text: `3D${number ? ` ${number}` : ""}（上のタブで表示）`, style: "PDF", extrusion: [0, 0, 1] });
}
const PLACEHOLDER_LAYER = "3D の場所（このアプリが描いた枠）";

const CAP_HEIGHT = 0.72; // 文字の大きさ（em）→ 図面の文字の高さ（大文字の高さ。viewer2d と同じ比）

/**
 * 1 文字ずつ（1 語ずつ）置かれた文字を、前の文字の図形につなぐ（同じ書体・大きさ・向き・色・画層・切り取りで、前の終わりのすぐ先から
 * 始まるとき）。つないだら true。描く順序を変えないよう、直前の図形が文字のときだけつなぐ
 */
function joinText(last, next) {
  if (last?.type !== "TEXT" || !last.align || !next.end || last.fontRef !== next.font) return false;
  const same = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (!same(last.height, next.height) || !same(last.rotation, next.angle) || last.generation !== (next.mirror ? 2 : 0)) return false;
  const l = next.layer;
  if (last.layer !== l.layer || last.color.rgb !== l.color.rgb || JSON.stringify(last.clip ?? null) !== JSON.stringify(l.clip ?? null)) return false;
  const em = next.height / CAP_HEIGHT;
  const dx = next.origin[0] - last.align[0], dy = next.origin[1] - last.align[1];
  const along = dx * Math.cos(next.angle) + dy * Math.sin(next.angle), across = -dx * Math.sin(next.angle) + dy * Math.cos(next.angle);
  if (Math.abs(across) > 0.1 * em || along < -0.2 * em || along > 1.0 * em) return false;
  const space = along > 0.2 * em && !last.text.endsWith(" ") && !next.text.startsWith(" ") ? " " : "";
  last.text += space + next.text;
  last.align = [next.end[0], next.end[1], 0];
  return true;
}

const layerRecord = (name, off) => ({ name, color: { index: 7 }, off, frozen: false, locked: false, plot: true, linetype: "CONTINUOUS", lineweight: -3 });

/** PDF の破線 [線, すき間, …] → 図面の破線（正 = 線・負 = すき間）。長さ 0 の線は点 */
function dashPattern(d) {
  if (!d?.length || d.every((x) => !(x > 0))) return [];
  const list = d.length % 2 ? [...d, ...d] : d;
  return list.map((x, i) => (i % 2 ? -Math.abs(x) : Math.abs(x)));
}

/** ページの空間 → 図面（mm・左下が原点・回転を入れる）の行列と、紙の大きさ */
export function pageTransform(pdf, page) {
  const media = normalize(page.mediaBox ?? [0, 0, 612, 792]);
  const crop = page.cropBox ? normalize(page.cropBox) : media;
  const box = [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])];
  if (box[2] <= box[0] || box[3] <= box[1]) box.splice(0, 4, ...media);
  const k = MM_PER_PT * (Number(pdf.value(page.dict, "UserUnit", 1)) || 1);
  const [x0, y0, x1, y1] = box;
  const rotate = (((Number(page.rotate) || 0) % 360) + 360) % 360;
  switch (rotate) {
    case 90: return { matrix: [0, -k, k, 0, -y0 * k, x1 * k], size: [(y1 - y0) * k, (x1 - x0) * k] };
    case 180: return { matrix: [-k, 0, 0, -k, x1 * k, y1 * k], size: [(x1 - x0) * k, (y1 - y0) * k] };
    case 270: return { matrix: [0, k, -k, 0, y1 * k, -x0 * k], size: [(y1 - y0) * k, (x1 - x0) * k] };
    default: return { matrix: [k, 0, 0, k, -x0 * k, -y0 * k], size: [(x1 - x0) * k, (y1 - y0) * k] };
  }
}
const normalize = (b) => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];

/** 中身が PDF か（先頭 1 KB に %PDF-。前に別のデータが付いた PDF もある） */
export function isPdf(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
  return head.includes("%PDF-");
}
