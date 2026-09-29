import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SAMPLES_IPT = path.join(ROOT, "samples/ipt");
export const SAMPLE_NAME = "E_Plate_改_Φ54.5.ipt";
/** samples/<dir> に置いた、pattern に合うファイルの名前（名前順）。 */
const listSamples = (dir, pattern) => fs.readdirSync(path.join(ROOT, "samples", dir)).filter((n) => pattern.test(n)).sort((a, b) => a.localeCompare(b, "ja"));
/** samples/ipt に置いた全ての .ipt の名前（名前順）。 */
export const sampleIpts = () => listSamples("ipt", /\.ipt$/i);
export const sampleIams = () => listSamples("iam", /\.iam$/i);
export const sampleSteps = () => listSamples("stp", /\.(stp|step)$/i);
export const readSample = (name = SAMPLE_NAME) => new Uint8Array(fs.readFileSync(path.join(SAMPLES_IPT, name)));
/** samples/<dir>/<name> の中身。 */
export const readSampleFile = (dir, name) => new Uint8Array(fs.readFileSync(path.join(ROOT, "samples", dir, name)));
/** capture-html.mjs が保存した取り出し結果（型付き配列は base64）を読み込む。 */
export function readHtmlFixture(name) {
  const zlib = require("node:zlib");
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "app/test/fixtures/html", `${name}.json.gz`))));
  // Buffer は小さいと共有メモリの一部を指すので、必ず複製してから型付き配列にする
  const decode = (b64, Type) => (b64 ? new Type(Uint8Array.from(Buffer.from(b64, "base64")).buffer) : null);
  snap.meshes = snap.meshes.map((m) => ({
    ...m, positions: decode(m.positions, Float32Array), normals: decode(m.normals, Float32Array), index: decode(m.index, Uint32Array),
  }));
  return snap;
}
