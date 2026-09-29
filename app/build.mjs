// app/ を 1 つの HTML ファイル（アプリ）にまとめ、dist/ に書き出す。ソースから作る生成物なので、リポジトリには置かない。
//   node app/build.mjs                    → dist/inventor-3d-tool.html
//   node app/build.mjs --if-stale         → ソース・サンプルが前に作ったものより新しいときだけ作る（起動ファイルが毎回使う）
//   node app/build.mjs --fragment FILE    → 外側の <html> 骨格を持たない断片も書き出す（埋め込み用）
// three.js は importmap で CDN から読み込み、それ以外（解析処理・fzstd）は同梱する。
// samples/ipt・iam・stp・html に置いたファイルは全てサンプルとして埋め込む（起動画面のサンプル一覧に並ぶ）。
// 起動ファイル（起動.bat）は、ドロップされたファイルを埋め込む script をこのページの末尾に付け足した複製を開く
// （アプリの処理は type="module" なので、ページを読み終えてから動く。付け足した script はそれより先に動く）。

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = path.join(ROOT, "dist", "inventor-3d-tool.html");
const SAMPLE_DIRS = [
  { dir: "samples/ipt", pattern: /\.ipt$/i },
  { dir: "samples/iam", pattern: /\.iam$/i },
  { dir: "samples/stp", pattern: /\.(stp|step)$/i },
  { dir: "samples/html", pattern: /\.html?$/i },
];
const HEAD = '<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** サンプルとして埋め込むファイル（ipt → iam → stp → html の順、それぞれ名前順）。 */
export function sampleFiles() {
  return SAMPLE_DIRS.flatMap(({ dir, pattern }) =>
    fs.readdirSync(path.join(ROOT, dir))
      .filter((name) => pattern.test(name))
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((name) => ({ file: path.join(ROOT, dir, name), name })));
}

/** アプリの材料: ソース（app/ の HTML・JavaScript・この build.mjs）、依存の版（package-lock.json）、埋め込むサンプル */
export function buildInputs() {
  const src = fs.readdirSync(path.join(ROOT, "app/src"), { recursive: true }).map((f) => path.join(ROOT, "app/src", f));
  return [
    path.join(ROOT, "app/index.html"), path.join(ROOT, "app/build.mjs"), path.join(ROOT, "package-lock.json"),
    ...src.filter((f) => fs.statSync(f).isFile()),
    ...sampleFiles().map((s) => s.file),
  ];
}

/** 作り直しが要るか: 出力が無い、または材料のどれかが出力より新しい。サンプルを消したときも作り直す（一覧が変わる） */
export function isStale(inputs = buildInputs(), output = OUT, stamp = `${output}.inputs`) {
  if (!fs.existsSync(output)) return true;
  const built = fs.statSync(output).mtimeMs;
  if (inputs.some((f) => fs.statSync(f).mtimeMs > built)) return true;
  return !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== listing(inputs);
}

/** 材料の一覧（リポジトリからの相対パス。ファイルの削除・追加に気づくため、出力の隣に残す） */
const listing = (inputs) => inputs.map((f) => path.relative(ROOT, f).split(path.sep).join("/")).join("\n");

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
  const inputs = buildInputs();
  if (process.argv.includes("--if-stale") && !isStale(inputs)) {
    console.log(`${path.relative(ROOT, OUT)} は最新です`);
    process.exit(0);
  }
  const { page, html } = await buildPage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  fs.writeFileSync(`${OUT}.inputs`, listing(inputs));
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, サンプル ${sampleFiles().length} 件)`);
  const at = process.argv.indexOf("--fragment");
  if (at > 0 && process.argv[at + 1]) {
    fs.writeFileSync(process.argv[at + 1], page);
    console.log(`wrote fragment ${process.argv[at + 1]}`);
  }
}
