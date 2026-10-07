// ファイルを読み、表示と変換で共通に使う「モデル」にする（DOM に依存しない。画面は ui/、表示は viewer/ が受け持つ）。
//   detectFormat(name, bytes) → "ipt" | "iam" | "step" | "html" | "drawing"（2D の図面: .dwg・.dxf）
//   readModel(bytes, name, { findPart }) → モデル（html は iframe で動かす必要があるので対象外。html/ が扱う）
//   partOf(model, index) → 組立のモデルから、部品 1 つのモデル
//
// モデル
//   { kind: "part",     format, name, scene: { bodies, labels }, report?, properties, thumbnail?, meta, warning? }
//   { kind: "assembly", format, name, scene: { parts, instances, labels, source, unplaced? }, thumbnail?, meta, warning?, missing }
//   { kind: "drawing",  format: "dwg" | "dxf", name, drawing（cad2d/model.js の図面）, meta, warning? }
//   meta … 見出しに添える一行（作成したソフト・保存日時など）、warning … 表示はできるが知らせること
//   properties … { material, density_g_per_cm3 }（iProperties・STEP の材質）

import { DwgError, DxfError, isDrawing, readDrawing } from "./cad2d/index.js";
import { buildIamScene, parseIam } from "./iam/index.js";
import { CfbError, parseIpt } from "./ipt/index.js";
import { StepError, parseStepFile } from "./step/index.js";

/** 利用者に見せる説明を持つ読み取りの失敗 */
export class ModelError extends Error {}

export const OPENABLE = /\.(ipt|iam|stp|step|html?|dwg|dxf)$/i;
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const head = (bytes) => new TextDecoder().decode(bytes.subarray(0, 2048));
const isOle2 = (bytes) => OLE2.every((b, i) => bytes[i] === b);

/** 形式を名前（拡張子）と中身から決める。拡張子が違っても、中身が HTML・STEP ならそれとして扱う */
export function detectFormat(name, bytes) {
  if (isDrawing(name, bytes)) return "drawing";
  if (/\.html?$/i.test(name) || (!isOle2(bytes) && /<html|<!doctype|<script/i.test(head(bytes)))) return "html";
  if (/\.(stp|step)$/i.test(name) || (!isOle2(bytes) && /^\s*ISO-10303-21\s*;/.test(head(bytes)))) return "step";
  if (/\.iam$/i.test(name)) return "iam";
  return "ipt";
}

/** 読み取りの失敗を、利用者に見せる説明にする */
export function explainError(error) {
  if (error instanceof ModelError) return error.message;
  if (error instanceof CfbError) return "Inventor のファイル形式（OLE2）ではありません。.ipt・.iam・.stp・.dwg・.dxf・.html のいずれかを選んでください。";
  if (error instanceof StepError) return `STEP として読めませんでした（${error.message}）。`;
  if (error instanceof DwgError) return `DWG として読めませんでした。${error.message}`;
  if (error instanceof DxfError) return `DXF として読めませんでした。${error.message}`;
  return `形状データを読み取れませんでした（${error.message}）。動作を確認しているのは Inventor 2026 で保存したファイルです。`;
}

const densityPerCm3 = (part) => (part.density_g_per_mm3 ? part.density_g_per_mm3 * 1000 : null);
const partProperties = (part) => ({ material: part.material ?? null, density_g_per_cm3: densityPerCm3(part) });

function readIpt(bytes, name) {
  const { report, scene, thumbnail, properties } = parseIpt(bytes, name);
  if (!scene.bodies.length) throw new ModelError("表示できる形状（B-rep）が見つかりませんでした。図面（.idw）やプレゼンテーション（.ipn）には対応していません。");
  const kernel = scene.source;
  return { kind: "part", format: "ipt", name, scene, report, properties, thumbnail, meta: kernel ? `${kernel.kernel} · ${kernel.saved_at}` : "" };
}

function readStep(bytes, name) {
  const { scene } = parseStepFile(new TextDecoder().decode(bytes), name);
  if (!scene.parts.length) throw new ModelError("表示できる形状（ソリッド）が見つかりませんでした。");
  const meta = [scene.source.system, scene.source.time?.slice(0, 10)].filter(Boolean).join(" · ");
  if (scene.instances.length <= 1 && scene.parts.length === 1) {
    const [part] = scene.parts;
    return { kind: "part", format: "step", name, scene: { bodies: part.bodies, labels: scene.labels }, properties: partProperties(part), meta };
  }
  return { kind: "assembly", format: "step", name, scene, meta, missing: [] };
}

/**
 * 組立。参照先の部品は findPart(reference) → { name, bytes } | null で探す（受け取ったファイル・サンプルなど）。
 * @param {(ref: { path, file, stem, display }) => Promise<{ name: string, bytes: Uint8Array } | null>} findPart
 */
async function readIam(bytes, name, findPart) {
  const iam = parseIam(bytes, name);
  const found = new Map();
  for (const ref of iam.references) {
    const hit = await findPart(ref);
    if (hit) found.set(ref.path, hit);
  }
  const scene = buildIamScene(iam, name, (ref) => found.get(ref.path) ?? null);
  const warning = iam.report.paired ? null
    : `部品の配置を読み取れませんでした（出現 ${iam.occurrences.length} に対し配置 ${iam.report.placements}）。部品は原点に置いて表示します。`;
  return {
    kind: "assembly", format: "iam", name, scene, thumbnail: iam.thumbnail, meta: `部品の参照 ${iam.references.length} 件`, warning,
    missing: scene.parts.filter((p) => p.missing && p.file).map((p) => p.file),
  };
}

/** 2D の図面（DWG・DXF）。見出しには形式・版・単位を添える */
function readDrawingModel(bytes, name) {
  const drawing = readDrawing(bytes, name);
  const count = [...drawing.blocks.values()].filter((b) => drawing.layouts.some((l) => l.block === b.name)).reduce((n, b) => n + b.entities.length, 0);
  if (!count) throw new ModelError("表示できる図形が見つかりませんでした（モデル・レイアウトが空です）。");
  const meta = [`${drawing.format.toUpperCase()} ${drawing.version}`, drawing.units.name && `単位 ${drawing.units.name}`].filter(Boolean).join(" · ");
  const failed = drawing.failures.length;
  const warning = failed ? `読めなかったオブジェクトが ${failed} 個あります。読めたものは表示しています。` : null;
  return { kind: "drawing", format: drawing.format, name, drawing, meta, warning };
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {{ findPart?: Function }} options
 */
export async function readModel(bytes, name, { findPart = async () => null } = {}) {
  const format = detectFormat(name, bytes);
  if (format === "html") throw new ModelError("three.js の HTML は、ページを動かして形状を取り出します（html/）。");
  if (format === "drawing") return readDrawingModel(bytes, name);
  if (format === "step") return readStep(bytes, name);
  if (format === "iam") return readIam(bytes, name, findPart);
  return readIpt(bytes, name);
}

/** 組立の中の部品 1 つを、部品のモデルにする（見出しはファイル名。組立に記録された完全なパスは利用者のフォルダ名を含むので出さない） */
export function partOf(model, index) {
  const part = model.scene.parts[index];
  if (!part?.bodies?.length) return null;
  return {
    kind: "part", format: model.format, name: part.name, scene: { bodies: part.bodies, labels: model.scene.labels },
    properties: partProperties(part), meta: part.file ?? part.number ?? "", assembly: model.name,
  };
}
