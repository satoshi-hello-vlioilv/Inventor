// PDF の読み取りの評価（開発用）: こちらの読み取り（formats/cad2d/from-pdf.js）と表示（viewer2d/）で描いたページを、
// PyMuPDF（MuPDF）が描いたページと画素で比べ、インクの一致（余計に描いていないか・描き漏らしが無いか）と、文字の一致を出す。
//
//   node program/tools/pdf-check.mjs [--width 1200] [--pages 3] [--out フォルダ] PDF かフォルダ …
//
// 比べ方は pdf_reference.py（Python・PyMuPDF。pip install pymupdf）。--out を付けると、こちらと基準を並べた画像を残す。
// 紙をキャンバスにぴったり合わせて描くので、2 つの画像の画素は同じ位置を指す。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, PROGRAM } from "./ui-harness.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const WIDTH = Number(option("--width", 1200));
const PAGES = Number(option("--pages", 3));
const OUT = option("--out", null);
const files = args.flatMap((a) => (fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((n) => /\.pdf$/i.test(n)).map((n) => path.join(a, n)) : [a]));
if (!files.length) {
  console.log("使い方: node program/tools/pdf-check.mjs [--width 1200] [--pages 3] [--out フォルダ] PDF かフォルダ …");
  process.exit(1);
}

// 紙をキャンバスにぴったり合わせて 1 ページを描く頁
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<style>:root { --sheet: #fff; --sheet-ink: #000; --accent: #1a62c4; --font-drawing: "IBM Plex Sans JP", "Noto Sans CJK JP", sans-serif; }
body { margin: 0; background: #fff; } #stage { position: absolute; inset: 0; } canvas { width: 100%; height: 100%; display: block; }</style>
<script type="importmap">{ "imports": { "fflate": "/static/vendor/fflate/index.js" } }</script></head>
<body><div id="stage"><canvas id="view"></canvas></div><script type="module">
import { readDrawing } from "/static/js/formats/cad2d/index.js";
import { buildScene } from "/static/js/viewer2d/scene.js";
import { DrawingViewer } from "/static/js/viewer2d/viewer2d.js";
const q = new URLSearchParams(location.search);
const bytes = new Uint8Array(await (await fetch("/file?i=" + q.get("i"))).arrayBuffer());
const t0 = performance.now();
const drawing = readDrawing(bytes, "a.pdf");
const layout = drawing.layouts[Number(q.get("page"))];
const scene = buildScene(drawing, layout);
const read = performance.now() - t0; // 開いて、このページを読むまで（ページの中身は表示するときに読む）
const v = new DrawingViewer({ stage: document.getElementById("stage"), canvas: document.getElementById("view") });
v.show(scene);
await new Promise((r) => setTimeout(r, 200));
const P = scene.paper, k = innerWidth / (P.max[0] - P.min[0]);
v.view = { scale: k, x: innerWidth / 2 - ((P.min[0] + P.max[0]) / 2 - v.origin[0]) * k, y: innerHeight / 2 + ((P.min[1] + P.max[1]) / 2 - v.origin[1]) * k };
v.requestRender();
await new Promise((r) => setTimeout(r, 400));
window.result = { pages: drawing.layouts.length, paper: P, read, texts: scene.texts.map((t) => t.lines.join(" ")),
  unsupported: [...scene.unsupported], items: scene.items.length };
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/harness.html") return res.end(HARNESS);
  if (url.pathname === "/file") return res.end(fs.readFileSync(files[Number(url.searchParams.get("i"))]));
  const file = path.join(PROGRAM, "app", decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(PROGRAM, "app")) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-check-"));
if (OUT) fs.mkdirSync(OUT, { recursive: true });

const rows = [];
for (let i = 0; i < files.length; i++) {
  let pages = 1;
  for (let p = 0; p < Math.min(pages, PAGES); p++) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: WIDTH } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const open = async () => {
      await page.goto(`${base}/harness.html?i=${i}&page=${p}`);
      await page.waitForFunction(() => window.result, null, { timeout: 120000 });
      return page.evaluate(() => window.result);
    };
    let result;
    try {
      result = await open();
      // 紙の縦横の比にキャンバスを合わせて描き直す
      const height = Math.round((WIDTH * (result.paper.max[1] - result.paper.min[1])) / (result.paper.max[0] - result.paper.min[0]));
      await page.setViewportSize({ width: WIDTH, height });
      result = await open();
    } catch (error) {
      rows.push({ file: path.basename(files[i]), page: p + 1, error: errors[0] ?? error.message.split("\n")[0] });
      await page.close();
      break;
    }
    pages = result.pages;
    const png = path.join(work, `${i}-${p}.png`), texts = path.join(work, `${i}-${p}.json`);
    await page.screenshot({ path: png });
    fs.writeFileSync(texts, JSON.stringify(result.texts));
    await page.close();
    try {
      const output = execFileSync("python3", [path.join(PROGRAM, "tools/pdf_reference.py"), files[i], String(p), png, texts]).toString().trim();
      const m = JSON.parse(output.split("\n").at(-1));
      rows.push({ file: path.basename(files[i]), page: p + 1, ...m, read: result.read, unsupported: result.unsupported });
      if (OUT) fs.copyFileSync(png, path.join(OUT, `${path.basename(files[i], ".pdf")}-${p + 1}.png`));
    } catch (error) {
      rows.push({ file: path.basename(files[i]), page: p + 1, error: `基準を作れません（${error.message.split("\n")[0]}）` });
    }
  }
}
await browser.close();
server.close();

const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
console.log("ファイル\tページ\tインク（余計に描かない）\tインク（描き漏らさない）\t文字の語\t読む ms\t近似・未対応");
for (const r of rows) {
  if (r.error) console.log(`${r.file}\t${r.page}\t失敗: ${r.error}`);
  else console.log(`${r.file}\t${r.page}\t${pct(r.ink.precision)}\t${pct(r.ink.recall)}\t${pct(r.words.recall)}（${r.words.count}）\t${Math.round(r.read)}\t${r.unsupported.map(([k, n]) => `${k} ${n}`).join("・")}`);
}
const ok = rows.filter((r) => !r.error);
const mean = (f) => ok.reduce((s, r) => s + f(r), 0) / (ok.length || 1);
const withWords = ok.filter((r) => r.words.recall !== null);
console.log(`\n平均（${ok.length} ページ）: インク 余計に描かない ${pct(mean((r) => r.ink.precision))}・描き漏らさない ${pct(mean((r) => r.ink.recall))}・` +
  `文字の語 ${pct(withWords.reduce((s, r) => s + r.words.recall, 0) / (withWords.length || 1))}（失敗 ${rows.length - ok.length}）`);
