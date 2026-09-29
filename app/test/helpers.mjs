import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SAMPLE_NAME = "E_Plate_改_Φ54.5.ipt";
export const readSample = () => new Uint8Array(fs.readFileSync(path.join(ROOT, SAMPLE_NAME)));
export const readGolden = () => JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/E_Plate.expected.json"), "utf8"));

/** 2 つの JSON 値の差分を列挙する（数値は許容誤差内なら一致とみなす）。 */
export function diff(actual, expected, tolerance = 1e-6, at = "$", out = []) {
  if (typeof expected === "number" && typeof actual === "number") {
    if (!(Math.abs(actual - expected) <= tolerance)) out.push(`${at}: ${actual} ≠ ${expected}`);
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push(`${at}: 長さ ${Array.isArray(actual) ? actual.length : typeof actual} ≠ ${expected.length}`);
    } else expected.forEach((e, i) => diff(actual[i], e, tolerance, `${at}[${i}]`, out));
  } else if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") out.push(`${at}: ${JSON.stringify(actual)} ≠ object`);
    else {
      const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
      for (const k of keys) diff(actual[k], expected[k], tolerance, `${at}.${k}`, out);
    }
  } else if (actual !== expected) out.push(`${at}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  return out;
}

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
