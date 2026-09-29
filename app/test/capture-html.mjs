// 検証用 HTML（samples/html）を実際のブラウザで動かし、アプリと同じフックで形状を取り出して
// app/test/fixtures/html/ に保存する。形状認識のテストはこのデータを使う。
//
//   node app/test/capture-html.mjs
//
// 開発時だけ使う。Playwright（npm i -g playwright）が必要。three.js を CDN から取得できない環境では、
// THREE_MIRROR にバージョンごとのコピーの場所（<dir>/three-<version>/node_modules/three）を指定する。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { threeHook } from "../src/extract/hook.js";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
const OUT = path.join(ROOT, "app/test/fixtures/html");
const MIRROR = process.env.THREE_MIRROR;

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
};

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
for (const [file, steps] of Object.entries(CASES)) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (MIRROR) {
    await page.route(/three@([\d.]+)\/(.*)$/, (route) => {
      const [, version, rest] = route.request().url().match(/three@([\d.]+)\/(.*)$/);
      route.fulfill({ path: path.join(MIRROR, `three-${version}`, "node_modules/three", rest), contentType: "application/javascript" });
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
