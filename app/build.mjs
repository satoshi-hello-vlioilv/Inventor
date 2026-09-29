// app/ を 1 つの HTML ファイルにまとめる（ダブルクリックで開ける配布形）。サンプルのファイルも埋め込む。
//   node app/build.mjs                    → dist/ipt-viewer.html
//   node app/build.mjs --fragment FILE    → 外側の <html> 骨格を持たない断片も書き出す（埋め込み用）
// three.js は importmap で CDN から読み込み、それ以外（解析処理・fzstd）は同梱する。

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 起動時は先頭のサンプルを表示する
const SAMPLES = [
  { file: "E_Plate_改_Φ54.5.ipt", label: "E_Plate（ipt）" },
  { file: "samples/html/LS4_parts_viewer.html", label: "LS-4 部品（html）" },
  { file: "samples/html/spool_reel_assembly_v2.html", label: "スプール組立（html）" },
];
const OUT = path.join(ROOT, "dist", "ipt-viewer.html");
const HEAD = '<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

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
const samples = SAMPLES.map(({ file, label }) => {
  const data = fs.readFileSync(path.join(ROOT, file)).toString("base64");
  return `<script type="application/octet-stream" class="sample" data-name="${escapeAttr(path.basename(file))}" data-label="${escapeAttr(label)}">${data}</script>`;
}).join("\n");

const page = fs
  .readFileSync(path.join(ROOT, "app/index.html"), "utf8")
  .replace("<!-- @samples -->", samples)
  .replace("<!-- @bundle -->", `<script type="module">\n${bundle}</script>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, HEAD + page);
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

const at = process.argv.indexOf("--fragment");
if (at > 0 && process.argv[at + 1]) {
  fs.writeFileSync(process.argv[at + 1], page);
  console.log(`wrote fragment ${process.argv[at + 1]}`);
}
