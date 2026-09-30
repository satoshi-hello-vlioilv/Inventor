// 検証用 HTML（samples/html）を実際のブラウザで動かし、アプリと同じフックで形状を取り出して
// tests/fixtures/html/ に保存する。形状認識のテストはこのデータを使う。
//
//   npm run fixtures:html               全ての HTML
//   npm run fixtures:html -- 2号機       名前がこれで始まる HTML だけ
//
// 開発時だけ使う。Playwright（npm i -g playwright）が必要。CDN（unpkg・jsdelivr・cdnjs）から取得できない環境では、
// THREE_MIRROR にパッケージのコピーの場所を指定する: <dir>/<名前>-<版>/node_modules/<名前>（例 three-0.160.0、cannon-es-0.20.0。
// npm i で作れる）。cdnjs の three.js（…/three.js/r128/…）は three-0.128.0 を使う。見つからないもの（書体・画像）は 404 にする。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { threeHook } from "../app/static/js/html/hook.js";
import { ROOT } from "../tests/js/helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
const OUT = path.join(ROOT, "tests/fixtures/html");
const MIRROR = process.env.THREE_MIRROR;

// 取り込む状態: [名前, その状態にする操作]。null は開いたときの表示のまま
const CASES = {
  "LS4_parts_viewer.html": [
    ["blade", null],
    ["spacer-t10", (p) => p.selectOption("#part", "spacer")],
    ["spacer-t50", (p) => p.selectOption("#spacerThk", "50")],
    ["rubber", (p) => p.selectOption("#part", "rubber")],
    ["finger", (p) => p.selectOption("#part", "finger")],
  ],
  "spool_reel_assembly_v2.html": [
    ["steel", null],
    ["paper", (p) => p.click("#kind [data-k=paper]")],
    ["rubber", (p) => p.click("#kind [data-k=rubber]")],
    ["reel", (p) => p.click("#kind [data-k=reel]")],
    ["assy", async (p) => { await p.click("#mode [data-m=assy]"); await p.click("#aSleeve [data-s='1']"); await p.click("#aSpool [data-p=steel]"); }],
  ],
  "2号機.html": [["mill", null]], // 32 単位 = 1500 mm。開いた円筒の壁とリングで作った筒
  "クレーン外観R10.html": [["crane", null]], // 1 単位 = 1 m
  "メッセンジャーワイヤー方式.html": [["wire", null]], // 1 単位 = 1 m。端の開いた管（TubeGeometry）
  "タイヤシミュレータR2.html": [["tire", null]], // three.js r128（isWebGLRenderer が無い版）
  // 本体とパッドだけ（吊荷のコイル・シャックルを消す）。丸い面取りが、へこんだ角で端面を折り返して重ねる（平面上の自己交差）
  "C_tong_3D.html": [["body", async (p) => { await p.click("text=吊荷コイルを表示"); await p.click("text=シャックル・ワイヤを表示"); }]],
};

const TYPES = { ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css" };
/** CDN の URL → THREE_MIRROR の中のファイル */
function mirrored(url) {
  let m = url.match(/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/(@?[^@/]+)@([\d.]+)\/(.*)$/);
  if (m) return path.join(MIRROR, `${m[1]}-${m[2]}`, "node_modules", m[1], m[3]);
  m = url.match(/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r(\d+)\/(.*)$/);
  if (m) return path.join(MIRROR, `three-0.${m[1]}.0`, "node_modules/three/build", m[2]);
  return null;
}

// ページ内でフックに取り出しを依頼し、型付き配列を base64 にして返す
const EXTRACT = () => new Promise((resolve) => {
  const id = Math.random();
  const encode = (a) => {
    if (!a) return null;
    const bytes = new Uint8Array(a.buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  addEventListener("message", function onMessage(e) {
    if (e.data?.type !== "ipt:scene" || e.data.id !== id) return;
    removeEventListener("message", onMessage);
    const { meshes, ...rest } = e.data;
    resolve({ ...rest, meshes: meshes.map((m) => ({ ...m, positions: encode(m.positions), normals: encode(m.normals), index: encode(m.index) })) });
  });
  postMessage({ type: "ipt:extract", id }, "*");
});

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const only = process.argv.slice(2);
for (const [file, steps] of Object.entries(CASES).filter(([f]) => !only.length || only.some((o) => f.startsWith(o)))) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (MIRROR) {
    await page.route(/^https?:\/\//, (route) => {
      const file = mirrored(route.request().url());
      if (file && fs.existsSync(file)) return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] ?? "application/octet-stream" });
      return route.fulfill({ status: 404, body: "" });
    });
  }
  await page.addInitScript(`(${threeHook.toString()})()`);
  await page.goto("file://" + path.join(ROOT, "samples/html", file));
  await page.waitForTimeout(2500);
  for (const [state, act] of steps) {
    if (act) { await act(page); await page.waitForTimeout(1200); }
    const snapshot = await page.evaluate(EXTRACT);
    const name = `${path.basename(file, ".html")}.${state}.json.gz`;
    const gz = zlib.gzipSync(JSON.stringify({ source: file, state, ...snapshot }));
    fs.writeFileSync(path.join(OUT, name), gz);
    console.log(`${name}: meshes ${snapshot.meshes.length}, ${(gz.length / 1024).toFixed(0)} KB`);
  }
  await page.close();
}
await browser.close();
