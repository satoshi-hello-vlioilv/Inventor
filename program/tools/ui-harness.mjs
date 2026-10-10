// 画面の撮影の共通部分（開発用。ui-check.mjs・ui-variants.mjs が使う）。
//
// 窓の代わりの開発用サーバー（ui_server.py）を起こし、Playwright の Chromium（WebView2 と同じ系統）で、
// 利用者の画面と同じ大きさ（2160×1440・表示倍率 125% → 1728×1152）の頁を開く。
// HTML のサンプルが CDN から読む three.js は、同梱の版（static/vendor/three）に差し替える（ネットにつながらない環境でも撮れる）。
// 状態（STATES）は、起動 → … → 作り終えた の順に 1 つの頁で進める（作る仕事は前の状態の続き）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
export const PROGRAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VIEW = { width: 1728, height: 1152 }; // 利用者の PC。フル HD（1920×1080）・125% なら 1536×864
/** "1536x864" → { width, height }（無ければ利用者の PC の大きさ） */
export const parseView = (text) => (text ? Object.fromEntries(text.split("x").map((v, i) => [i ? "height" : "width", Number(v)])) : VIEW);
const FIXTURE = (n) => path.join(PROGRAM, "tests/fixtures/builder", `${n}.inventor.json`);
const IPT = "A1_円筒_両切欠き＋片ネジ_Φ54.5.ipt";
const IAM = "Assembly_全体_Φ54.5.iam";
const HTML = "LS4_parts_viewer.html";
const DRAWING = "A1_円筒_部品図.dxf";
const PDF3D = "U3D_SimpleShapes_3D.pdf";

/** ページの多い PDF（試験用に作る 40 ページの図面。ページ送りの見え方を撮る） */
async function manyPages() {
  const { drawingSet } = await import("../tests/js/pdf-fixture.mjs");
  const file = path.join(os.tmpdir(), "図面セット_40ページ.pdf");
  fs.writeFileSync(file, drawingSet(40));
  return file;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** サーバーとブラウザーを起こす。{ dev(要求), newPage(テーマ), close() } */
export async function launch() {
  const port = 8765 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("python3", [path.join(PROGRAM, "tools/ui_server.py"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((done) => server.stdout.once("data", done));
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const dev = (p) => fetch(`${base}/__dev/${p}`, { method: "POST" }).then((r) => r.json());
  return {
    browser,
    dev,
    /** 起動直後（サンプルの一覧まで組み上がった）の頁 */
    async newPage(theme, view = VIEW) {
      const context = await browser.newContext({ viewport: view, deviceScaleFactor: 1.25, colorScheme: theme, locale: "ja-JP" });
      await routeThree(context);
      const page = await context.newPage();
      page.on("pageerror", (e) => console.warn(`[${theme}] page error: ${e.message}`));
      await dev("env?ready=1&inventor=1&python=1"); // 模擬の状態を既定に戻す（前のテーマで変えた物を持ち越さない）
      await dev("shortcut?desktop=ok&start=missing&made=0"); await dev("samples?off=0");
      await dev("update?role=developer&reachable=1&news=0");
      await page.goto(base);
      await page.waitForSelector("button.sample-row", { state: "attached", timeout: 15000 });
      await sleep(600);
      return page;
    },
    async close() {
      await browser.close();
      server.kill();
    },
  };
}

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

/** サンプル・受け取ったファイルの窓を開く（案によっては見出しバーのボタンが無いので、そのときは直接開く） */
async function openLibrary(page) {
  if (await page.locator("dialog[open]").count()) return;
  if (await page.locator("#show-start").isVisible()) await page.click("#show-start");
  else await page.evaluate(() => document.getElementById("start").showModal());
  await page.waitForSelector("dialog[open]");
}

async function openSample(page, name) {
  await openLibrary(page);
  await page.click(`#start button.sample-row[title="${name}"]`);
  await page.waitForFunction((n) => document.querySelector("#file-name")?.textContent === n, name, { timeout: 30000 });
  await sleep(800);
}

async function openFile(page, file) {
  // 中身で渡す（Playwright は、日本語の入ったパスを渡すと選んだことにならない）
  await page.setInputFiles("#file-input", { name: path.basename(file), mimeType: "application/octet-stream", buffer: fs.readFileSync(file) });
  await page.waitForFunction((n) => document.querySelector("#file-name")?.textContent === n, path.basename(file), { timeout: 30000 });
  await sleep(800);
}

/** 図面の上でカーソルを動かし、図形の読み出しが出たら止める（出なければ最後の位置のまま） */
async function hoverDrawing(page) {
  const box = await page.locator("#view2d").boundingBox();
  if (!box) return;
  for (let fy = 0.35; fy <= 0.65; fy += 0.05) {
    for (let fx = 0.3; fx <= 0.7; fx += 0.02) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await sleep(40);
      if (await page.locator("#readout.is-live").count()) return;
    }
  }
}

/**
 * 図面の座標 → 画面の位置を求める（測っている間に使う）。カーソルを粗い格子で動かし、読み出し（指した点の種類と図面の座標）の組から
 * 画面 = 図面 × k ＋ 位置（y は上下が逆）を最小二乗で求める（吸い付く範囲 12 px の誤差は平均で薄まる）
 */
async function drawingMap(page) {
  const box = await page.locator("#view2d").boundingBox();
  const pairs = [];
  for (let fy = 0.25; fy <= 0.75; fy += 0.1) {
    for (let fx = 0.15; fx <= 0.85; fx += 0.05) {
      const at = [box.x + box.width * fx, box.y + box.height * fy], w = await snapReadout(page, at);
      if (w) pairs.push([at, w]);
    }
  }
  if (pairs.length < 2) throw new Error("図面の上で読み出しが出ない");
  const mean = (f) => pairs.reduce((s, p) => s + f(p), 0) / pairs.length;
  const [sx, sy, wx, wy] = [mean((p) => p[0][0]), mean((p) => p[0][1]), mean((p) => p[1].x), mean((p) => p[1].y)];
  const k = mean((p) => (p[0][0] - sx) * (p[1].x - wx) - (p[0][1] - sy) * (p[1].y - wy)) / mean((p) => (p[1].x - wx) ** 2 + (p[1].y - wy) ** 2);
  return (x, y) => [sx + (x - wx) * k, sy - (y - wy) * k];
}

/** カーソルを動かし、測っている間の読み出し「種類 · x, y」を読む */
async function snapReadout(page, at) {
  await page.mouse.move(...at);
  await sleep(25);
  const m = (await page.locator("#readout .chip").textContent()).match(/^(\S+) · (-?[\d.]+), (-?[\d.]+)/);
  return m && { kind: m[1], x: Number(m[2]), y: Number(m[3]) };
}

/** 測っている間に、図面の座標 (x, y) の吸い付く点（種類 kind）を押す。見込みの位置から近い順に 3 px おきに探す */
async function clickSnap(page, map, kind, x, y) {
  const guess = map(x, y), same = (a, b) => Math.abs(a - b) < 5e-4;
  for (let r = 0; r <= 24; r += 3) {
    for (let dy = -r; dy <= r; dy += 3) {
      for (let dx = -r; dx <= r; dx += 3) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 内側の環から
        const at = [guess[0] + dx, guess[1] + dy], w = await snapReadout(page, at);
        if (w?.kind === kind && same(w.x, x) && same(w.y, y)) return page.mouse.click(...at);
      }
    }
  }
  throw new Error(`${kind} (${x}, ${y}) が見つからない`);
}

/** 選ぶ・測る（見本の図面）: 外形の円弧を押して選び、測る（M）で円の中心から P.C.D. の穴の中心まで（20 mm・45°）を測る */
async function measureDrawing(page) {
  await page.keyboard.press("m");
  const map = await drawingMap(page);
  await page.keyboard.press("m");
  const t = (250 * Math.PI) / 180; // 外形の円弧（中心 140, 0・半径 27.25）の上で、ほかの線から離れた所
  await page.mouse.click(...map(140 + 27.25 * Math.cos(t), 27.25 * Math.sin(t)));
  await page.keyboard.press("m");
  await clickSnap(page, map, "中心", 140, 0);
  await clickSnap(page, map, "中心", 154.142, 14.142);
  await sleep(300);
}

/** 「Inventor で作る」を押し、仕事が始まる（中止のボタンが出る）まで待つ（その前に段階を進めると、進める先が無い） */
async function startJob(page) {
  await page.click("#build");
  await page.waitForSelector("#build-cancel:not([hidden])", { timeout: 10000 });
}

// 状態: [名前, そこへ行く操作, 次に押すべきもの（新しい画面の data-next → 前の画面の部品 の順に探す）]
export const STATES = [
  ["start", async () => {}, "[data-next], #start-open"],
  ["empty", async (p) => { await p.keyboard.press("Escape"); }, "[data-next], #open"],
  ["library", openLibrary, "#start-open"],
  ["ipt", async (p) => { await openSample(p, IPT); }, "[data-next]"],
  ["asm", async (p) => { await openSample(p, IAM); }, "[data-next]"],
  // 入れ子の組立（サブ組立 2 種類 × 2 と、直下の部品）。構成の木の見え方を撮る
  ["nested", async (p) => { await openSample(p, "Assembly_XY2.stp"); }, "[data-next]"],
  // 図面（2D）。図形にカーソルを合わせた様子（読み出し・強調）も撮る: 図面の上を格子状に動かし、読み出しが出た所で止める
  ["drawing", async (p) => { await openSample(p, DRAWING); await hoverDrawing(p); }, "[data-next], #open"],
  // 選ぶ・測る: 外形の円弧を押して選び、測る（M）で円の中心どうしを測る（結果と選んだ図形は欄のカード、案内は図の上の帯）
  ["measure", measureDrawing, "#measure-stop"],
  ["layout", async (p) => { await p.click("#layout-tabs button:nth-child(2)"); await sleep(600); await hoverDrawing(p); }, "[data-next], #open"],
  // PDF: ページの多い図面（ページ送り）・3D を含む PDF（主役の場所のタブ: 3D → 図面）
  ["pages", async (p) => { await openFile(p, await manyPages()); }, "[data-next], #open"],
  ["pages-pop", async (p) => { await p.click("#layout-tabs .pager-now"); await p.waitForSelector("#page-pop:not([hidden])"); await sleep(200); }, "#page-pop [aria-current=\"true\"]"],
  ["pdf3d", async (p) => { await openSample(p, PDF3D); }, "[data-next], #open"],
  ["pdf3d-sheet", async (p) => { await p.click('#view-tab-list [data-view="sheet"]'); await sleep(600); }, "[data-next], #open"],
  ["html", async (p) => {
    await openSample(p, HTML);
    await p.waitForFunction(() => /取り込み/.test(document.querySelector("#source-status")?.textContent ?? "") && /r\d+/.test(document.querySelector("#source-status").textContent), null, { timeout: 30000 });
  }, "[data-next], #build-step"],
  // 主役の場所のタブで「元のページ」に切り替えた様子（取り込みのボタンが見えるか）
  ["source", async (p) => { await p.click('#view-tab-list [data-view="source"]'); await sleep(400); }, "[data-next], #capture"],
  ["spec", async (p) => { await openFile(p, FIXTURE("reel")); }, "[data-next], #build"],
  ["ask", async (p, dev) => { await dev("env?ready=0"); await p.click("#build"); await p.waitForSelector("#build-ask:not([hidden])"); }, "[data-next], #build-install"],
  ["building", async (p, dev) => {
    await dev("env?ready=1"); await dev("freeze");
    await p.click("#build-ask-no").catch(() => {});
    await startJob(p);
    await dev("step?n=8");
    await sleep(1800);
  }, "#build-cancel"],
  ["done", async (p, dev) => { await dev("step?n=100"); await sleep(1800); }, "[data-next], #build-open"],
  // 作り直して、不一致 2 つ・失敗 1 つが混じった結果（例外の見せ方を確かめる）
  ["mixed", async (p, dev) => { await dev("mix?mismatch=4,11&failed=19"); await startJob(p); await dev("step?n=100"); await sleep(1800); await dev("mix"); },
    "[data-next], #build-open"],
  // 設定のページ: 開発者が開いた様子（概要・版・置き場（古い形が残っている））・一般の利用者が開いた様子。
  // 起動のときのショートカットの問い（デスクトップに無いとき）
  ["settings", async (p) => { await openSettings(p); }, "#settings-body .primary, #settings-back"],
  ["settings-versions", async (p) => { await settingsPane(p, "versions"); }, "#settings-body .primary, #settings-back"],
  ["settings-share", async (p, dev) => { await dev("update?legacy=1"); await settingsPane(p, "share", true); }, "#settings-body .secondary, #settings-back"],
  ["settings-user", async (p, dev) => { await dev("update?role=user&legacy=0"); await p.click("#settings-back"); await openSettings(p); await settingsPane(p, "versions"); }, "#settings-back"],
  // 起動でそろえた後の「変わったこと」（右下）と、設定の要点の下で読める様子
  ["news", async (p, dev) => {
    await dev("update?role=developer&news=1"); await p.reload();
    await p.waitForSelector("#news:not([hidden])"); if (await p.$("#start[open]")) await p.keyboard.press("Escape");
  }, "#news-close"],
  ["offer", async (p, dev) => {
    await dev("update?role=developer&news=0"); await dev("shortcut?desktop=missing");
    await p.reload(); await p.waitForSelector("#shortcut-offer:not([hidden])");
    if (await p.$("#start[open]")) await p.keyboard.press("Escape");
  }, "#shortcut-offer-make"],
  // 置き場の入口から入れた直後（ショートカットを作った知らせ）と、サンプルの無い配る形の最初の画面
  ["installed", async (p, dev) => {
    await dev("shortcut?made=1"); await dev("samples?off=1");
    await p.reload(); await p.waitForSelector("#shortcut-offer:not([hidden])"); await sleep(600);
  }, "#shortcut-offer-no, #welcome-open"],
  // 変換データの寸法を直す（穴・面取り・直せない斜めの辺のある刃）。前の状態の問い・知らせは閉じる
  ["specedit", async (p, dev) => {
    await dev("shortcut?desktop=ok&made=0"); await dev("samples?off=0"); await p.reload(); await sleep(600);
    if (await p.$("#start[open]")) await p.keyboard.press("Escape");
    await openFile(p, FIXTURE("blade"));
  }, "[data-next], #build"],
  // 寸法を直す欄（部品の行を押し、直径を 240 → 250 に）。欄の無い版では、変換データの一覧のまま
  ["dimedit", async (p) => {
    await p.click("#parts li button"); await sleep(400);
    if (await p.$("#dim-D0\\.0")) { await p.fill("#dim-D0\\.0", "250"); await p.press("#dim-D0\\.0", "Enter"); await sleep(800); }
  }, "[data-next], #build"],
  // 寸法の欄（穴の板: 名前つきの値・参照寸法（向かいの辺）・Inventor に対応の無い「形を保って拡大・縮小」が並ぶ）
  ["dimedit-plate", async (p) => {
    await openFile(p, FIXTURE("plate-holes")); await p.click("#parts li button"); await sleep(600);
  }, "[data-next], #build"],
  // 図面の 3D ソリッド（ブロックの入れ子のある DWG）。再配布できるサンプルが無いので、手元のファイルを UI_SOLIDS_DWG で渡したときだけ撮る
  ...(process.env.UI_SOLIDS_DWG ? [["solids3d", async (p) => {
    await openFile(p, process.env.UI_SOLIDS_DWG);
    await p.click('#view-tab-list [data-view^="3d"]'); await sleep(4000);
  }, "[data-next], #open"]] : []),
];

async function openSettings(p) {
  await p.click("#show-settings");
  await p.waitForSelector("#settings-nav .st-nav-badge");
  await sleep(300);
}

/** 設定のページで区分を選ぶ（reopen: 窓の答えを変えた後に、開き直して読み直す） */
async function settingsPane(p, pane, reopen = false) {
  if (reopen) {
    await p.click("#settings-back");
    await openSettings(p);
  }
  // 目次は案によって見えない（区分の升目から入る案など）ので、目次のボタンを直接押す
  await p.evaluate((id) => document.querySelector(`#settings-nav [data-pane="${id}"]`).click(), pane);
  await p.waitForFunction((id) => document.querySelector("#settings-nav [aria-current]")?.dataset.pane === id, pane, { timeout: 5000 });
  await sleep(300);
}

/** 状態を順に進め、各状態で visit(名前, 次に押すべきもの) を呼ぶ（only を渡せば、その状態だけ） */
export async function walk(page, dev, visit, only = null) {
  for (const [name, go, next] of STATES) {
    try {
      await go(page, dev);
    } catch (e) {
      console.warn(`${name}: ${e.message.split("\n")[0]}`);
    }
    if (!only || only.includes(name)) await visit(name, next);
  }
}

/**
 * 画面の中で測る（page.evaluate に渡す。next: 主の行動の選び方）。
 *   next      … その状態で次に押すべきもの（主の行動）が、スクロールせずに見えているか・大きさ（px²）・押せるか
 *   primaries … 見えている主のボタン（塗りの .primary）の数（1 つが望ましい: どれを押すか迷わない）
 *   controls  … 見えている操作の数（Hick の法則: 選択肢が多いほど迷う）と、スクロールしないと見えない操作の数
 *   text      … 見えている文字数（読む量）と、右の欄の文字数
 *   hidden    … 右の欄で、スクロールしないと見えない高さ（px）
 *   fonts     … 使っている文字の大きさの種類と、いちばん小さい文字（px）
 *   contrast  … 見えている文字のコントラスト比の最小（WCAG。4.5 未満は読みにくい）
 *   stage     … 3D 表示が画面に占める割合（ほかの欄が重なっている部分は除く）
 *   status    … 作る仕事の状態の見え方（進み具合の棒・段階の表示があるか）
 */
export function measure(nextSelector) {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest("[hidden]");
  };
  const inView = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  // 色 → [r, g, b, a]（0〜255）。color-mix() の結果は color(srgb r g b / a)（0〜1）で返るので、255 倍する
  const rgb = (c) => {
    const n = (c.match(/[\d.]+/g) ?? []).map(Number);
    return c.startsWith("color(srgb") ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n;
  };
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
  const controls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary, [role=button], [role=treeitem]")].filter(visible);
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
  // 3D の見えている面積: 3D の枠から、上に重なる欄（浮かぶ欄など）を 8px 刻みで除く
  let stage = 0;
  const box = document.querySelector("#stage")?.getBoundingClientRect();
  if (box && !dialog) {
    let shown = 0, all = 0;
    for (let y = Math.max(0, box.top) + 4; y < Math.min(innerHeight, box.bottom); y += 8) {
      for (let x = Math.max(0, box.left) + 4; x < Math.min(innerWidth, box.right); x += 8) {
        all++;
        if (document.elementFromPoint(x, y)?.closest("#stage")) shown++;
      }
    }
    stage = all ? (shown / all) * ((box.width * box.height) / (innerWidth * innerHeight)) : 0;
  }
  return {
    next: next ? { selector: nextSelector, visible: visible(next) && inView(nr), enabled: !next.disabled, area: Math.round(nr.width * nr.height), top: Math.round(nr.top) } : null,
    primaries,
    controls: { visible: (dialog ? seen.filter(scope) : seen).length, belowFold: controls.filter((el) => scope(el) && !inView(el.getBoundingClientRect())).length },
    text: { visible: texts.reduce((n, [, t]) => n + t.length, 0), side: sideText },
    hidden: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0,
    fonts: { kinds: sizes.size, min: Math.min(...[...sizes.keys()].map(parseFloat)) },
    contrast: { min: Number(minContrast.toFixed(2)), worst },
    stage: Number(stage.toFixed(2)),
    status: { bar: visible(document.querySelector("#build-bar")), steps: visible(document.querySelector("[data-ui='steps']")) },
  };
}
