// app/ を 1 つの HTML ファイルにまとめ、配布フォルダに書き出す（ダブルクリックでも、起動ファイルからも開ける）。
//   node app/build.mjs                    → Inventor部品ビューア/アプリ本体/ipt-viewer.html
//   node app/build.mjs --fragment FILE    → 外側の <html> 骨格を持たない断片も書き出す（埋め込み用）
// three.js は importmap で CDN から読み込み、それ以外（解析処理・fzstd）は同梱する。
// samples/ipt・samples/html に置いたファイルは全てサンプルとして埋め込む（起動画面のサンプル一覧に並ぶ）。
// 起動ファイル（起動.bat）は、ドロップされたファイルを埋め込む script をこのページの末尾に付け足した複製を開く
// （アプリの処理は type="module" なので、ページを読み終えてから動く。付け足した script はそれより先に動く）。

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = path.join(ROOT, "Inventor部品ビューア", "アプリ本体");
export const OUT = path.join(APP_DIR, "ipt-viewer.html");
const SAMPLE_DIRS = [
  { dir: "samples/ipt", pattern: /\.ipt$/i },
  { dir: "samples/html", pattern: /\.html?$/i },
];
const HEAD = '<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** サンプルとして埋め込むファイル（ipt → html の順、それぞれ名前順）。 */
export function sampleFiles() {
  return SAMPLE_DIRS.flatMap(({ dir, pattern }) =>
    fs.readdirSync(path.join(ROOT, dir))
      .filter((name) => pattern.test(name))
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((name) => ({ file: path.join(ROOT, dir, name), name })));
}

/** 完成したページ（{ page: 骨格なし, html: 骨格あり }）を作る。書き込みはしない。 */
export async function buildPage() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [path.join(ROOT, "app/src/main.js")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    charset: "utf8",
    legalComments: "eof",
    external: ["three", "three/addons/*"],
    write: false,
  });
  const bundle = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const samples = sampleFiles().map(({ file, name }) => {
    const bytes = fs.readFileSync(file);
    return `<script type="application/octet-stream" class="sample" data-name="${escapeAttr(name)}" data-size="${bytes.length}">${bytes.toString("base64")}</script>`;
  }).join("\n");
  // 差し込みは関数で渡す（文字列で渡すと、中の "$&" などが置換の記号として解釈され、コードが壊れる）
  const page = fs
    .readFileSync(path.join(ROOT, "app/index.html"), "utf8")
    .replace("<!-- @samples -->", () => samples)
    .replace("<!-- @bundle -->", () => `<script type="module">\n${bundle}</script>`);
  return { page, html: HEAD + page };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { page, html } = await buildPage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, サンプル ${sampleFiles().length} 件)`);
  const at = process.argv.indexOf("--fragment");
  if (at > 0 && process.argv[at + 1]) {
    fs.writeFileSync(process.argv[at + 1], page);
    console.log(`wrote fragment ${process.argv[at + 1]}`);
  }
}
