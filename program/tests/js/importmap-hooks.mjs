// importmap.mjs が登録する読み込みの係。importmap の "/static/..." を program/app/static/... のファイルに置き換える。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROGRAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const page = fs.readFileSync(path.join(PROGRAM, "app/templates/index.html"), "utf8");
export const { imports } = JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);

/** importmap の対応（"three/addons/" のように / で終わる名前は、その下をまとめて対応させる）→ ファイルの URL。対応しなければ null */
export function mapped(specifier) {
  for (const [key, target] of Object.entries(imports)) {
    const rest = key.endsWith("/") ? (specifier.startsWith(key) ? specifier.slice(key.length) : null) : specifier === key ? "" : null;
    if (rest !== null) return pathToFileURL(path.join(PROGRAM, "app", target + rest)).href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  const url = mapped(specifier);
  return url ? { url, shortCircuit: true } : next(specifier, context);
}
