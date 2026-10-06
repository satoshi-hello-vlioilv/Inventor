// 画面の撮影と測定（開発用。画面を直す前と後で同じ物差しで比べる）。
//
//   node program/tools/ui-check.mjs 出力フォルダ [light|dark|both]
//
// 窓の代わりの開発用サーバー（program/tools/ui_server.py）を起こし、Playwright の Chromium（WebView2 と同じ系統）で、
// 利用者の画面と同じ大きさ（2160×1440・表示倍率 125% → 1728×1152）で状態ごとに撮り、迷いやすさに関わる量を測る。
// HTML のサンプルが CDN から読む three.js は、同梱の版（static/vendor/three）に差し替える（ネットにつながらない環境でも撮れる）。
//
// 測る量（状態ごと。metrics.json）:
//   next      … その状態で次に押すべきもの（主の行動）が、スクロールせずに見えているか・大きさ（px²）・押せるか
//   primaries … 見えている主のボタン（塗りの .primary）の数（1 つが望ましい: どれを押すか迷わない）
//   controls  … 見えている操作の数（Hick の法則: 選択肢が多いほど迷う）と、スクロールしないと見えない操作の数
//   text      … 見えている文字数（読む量）と、右の欄の文字数
//   hidden    … 右の欄で、スクロールしないと見えない高さ（px）
//   fonts     … 使っている文字の大きさの種類と、いちばん小さい文字（px）
//   contrast  … 見えている文字のコントラスト比の最小（WCAG。4.5 未満は読みにくい）
//   stage     … 3D 表示が画面に占める割合
//   status    … 作る仕事の状態の見え方（進み具合の棒・段階の表示があるか）

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
const PROGRAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] ?? "ui-check");
const THEMES = { light: ["light"], dark: ["dark"], both: ["light", "dark"] }[process.argv[3] ?? "both"];
const PORT = 8765 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const VIEW = { width: 1728, height: 1152 };
const FIXTURE = (n) => path.join(PROGRAM, "tests/fixtures/builder", `${n}.inventor.json`);
const IPT = "A1_円筒_両切欠き＋片ネジ_Φ54.5.ipt";
const IAM = "Assembly_全体_Φ54.5.iam";
const HTML = "LS4_parts_viewer.html";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const dev = (p) => fetch(`${BASE}/__dev/${p}`, { method: "POST" }).then((r) => r.json());

// CDN の three.js → 同梱の版（隔離した iframe はモジュールを CORS で読むので、許可の見出しを付ける）
async function routeThree(context) {
  const vendor = path.join(PROGRAM, "app/static/vendor/three");
  await context.route(/(cdn\.jsdelivr\.net\/npm|unpkg\.com)\/three@[^/]+\/(.*)$/, (route) => {
    const rest = route.request().url().match(/three@[^/]+\/(.*)$/)[1];
    const file = rest.startsWith("build/") ? path.join(vendor, "three.module.min.js") : path.join(vendor, "addons", rest.replace(/^examples\/jsm\//, ""));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" } });
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, body: "", headers: { "Content-Type": "text/css" } }));
}

/** 画面の中で測る（next: 主の行動の選び方。状態ごとに渡す） */
function measure(nextSelector) {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest("[hidden]");
  };
  const inView = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  const rgb = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  // 文字の後ろの色（半透明は重ねる。グラデーション・画像の上は測らない）
  function backdrop(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null;
      const [r, g, b, a = 1] = rgb(s.backgroundColor);
      if (a > 0) layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    let base = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    return base;
  }
  const controls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary, [role=button]")].filter(visible);
  const seen = controls.filter((el) => inView(el.getBoundingClientRect()));
  const dialog = document.querySelector("dialog[open]");
  const scope = (el) => !dialog || dialog.contains(el);
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (t && visible(n.parentElement) && scope(n.parentElement) && inView(n.parentElement.getBoundingClientRect())) texts.push([n.parentElement, t]);
  }
  const sizes = new Map();
  let minContrast = 99, worst = "";
  for (const [el, t] of texts) {
    const s = getComputedStyle(el);
    sizes.set(s.fontSize, (sizes.get(s.fontSize) ?? 0) + t.length);
    const bg = backdrop(el);
    if (!bg) continue;
    const [r, g, b, a = 1] = rgb(s.color);
    const fg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const c = ratio(fg, bg);
    if (c < minContrast) [minContrast, worst] = [c, t.slice(0, 24)];
  }
  const side = document.querySelector("aside");
  const scroller = document.querySelector("[data-ui='side']") ?? side;
  const sideText = side ? [...texts].filter(([el]) => side.contains(el)).reduce((n, [, t]) => n + t.length, 0) : 0;
  // 書いた順に探す（新しい画面の data-next を、前の画面の部品より先に）
  const next = (nextSelector ?? "").split(",").map((sel) => sel.trim()).filter(Boolean)
    .map((sel) => [...document.querySelectorAll(sel)].find((el) => visible(el) && scope(el))).find(Boolean) ?? null;
  const primaries = [...document.querySelectorAll(".primary")].filter((el) => visible(el) && scope(el) && inView(el.getBoundingClientRect())).length;
  const nr = next?.getBoundingClientRect();
  const stage = document.querySelector("#stage")?.getBoundingClientRect();
  return {
    next: next ? { selector: nextSelector, visible: visible(next) && inView(nr), enabled: !next.disabled, area: Math.round(nr.width * nr.height), top: Math.round(nr.top) } : null,
    primaries,
    controls: { visible: (dialog ? seen.filter(scope) : seen).length, belowFold: controls.filter((el) => scope(el) && !inView(el.getBoundingClientRect())).length },
    text: { visible: texts.reduce((n, [, t]) => n + t.length, 0), side: sideText },
    hidden: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0,
    fonts: { kinds: sizes.size, min: Math.min(...[...sizes.keys()].map(parseFloat)) },
    contrast: { min: Number(minContrast.toFixed(2)), worst },
    stage: stage && !dialog ? Number(((stage.width * stage.height) / (innerWidth * innerHeight)).toFixed(2)) : 0,
    status: { bar: visible(document.querySelector("#build-bar")), steps: visible(document.querySelector("[data-ui='steps']")) },
  };
}

// 状態: [名前, そこへ行く操作, 次に押すべきもの（新しい画面の data-next → 前の画面の部品 の順に探す）]
const STATES = [
  ["start", async () => {}, "[data-next], #start-open"],
  ["empty", async (p) => { await p.keyboard.press("Escape"); }, "[data-next], #open"],
  ["library", async (p) => { await p.click("#show-start"); await p.waitForSelector("dialog[open]"); }, "#start-open"],
  ["ipt", async (p) => { await openSample(p, IPT); }, "[data-next]"],
  ["asm", async (p) => { await openSample(p, IAM); }, "[data-next]"],
  ["html", async (p) => {
    await openSample(p, HTML);
    await p.waitForFunction(() => /取り込み/.test(document.querySelector("#source-status")?.textContent ?? "") && /r\d+/.test(document.querySelector("#source-status").textContent), null, { timeout: 30000 });
  }, "[data-next], #build-step"],
  ["spec", async (p) => { await openFile(p, FIXTURE("reel")); }, "[data-next], #build"],
  ["ask", async (p) => { await dev("env?ready=0"); await p.click("#build"); await p.waitForSelector("#build-ask:not([hidden])"); }, "[data-next], #build-install"],
  ["building", async (p) => {
    await dev("env?ready=1"); await dev("freeze");
    await p.click("#build-ask-no").catch(() => {});
    await p.click("#build");
    await dev("step?n=8");
    await sleep(1800);
  }, "#build-cancel"],
  ["done", async (p) => { await dev("step?n=100"); await sleep(1800); }, "[data-next], #build-open"],
];

async function openSample(page, name) {
  if (!(await page.locator("dialog[open]").count())) await page.click("#show-start");
  await page.click(`button.sample-row[title="${name}"]`);
  await page.waitForFunction((n) => document.querySelector("#file-name")?.textContent === n, name, { timeout: 30000 });
  await sleep(800);
}

async function openFile(page, file) {
  await page.setInputFiles("#file-input", file);
  await page.waitForFunction((n) => document.querySelector("#file-name")?.textContent === n, path.basename(file), { timeout: 30000 });
  await sleep(800);
}

const server = spawn("python3", [path.join(PROGRAM, "tools/ui_server.py"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((done) => server.stdout.once("data", done));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const report = {};
try {
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1.25, colorScheme: theme, locale: "ja-JP" });
    await routeThree(context);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.warn(`[${theme}] page error: ${e.message}`));
    await dev("env?ready=1&inventor=1&python=1");
    await page.goto(BASE);
    await page.waitForSelector("button.sample-row", { state: "attached", timeout: 15000 }); // サンプルの一覧まで組み上がった
    await sleep(600);
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, go, next] of STATES) {
      try {
        await go(page);
      } catch (e) {
        console.warn(`[${theme}] ${name}: ${e.message.split("\n")[0]}`);
      }
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      report[`${name}-${theme}`] = await page.evaluate(measure, next);
      console.log(`${name}-${theme}`, JSON.stringify(report[`${name}-${theme}`]));
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(report, null, 1));
