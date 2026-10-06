// 改良案を画像で比べる（開発用。見た目を変えるときは、案を必ずこれで画像にして見比べてから選ぶ: CLAUDE.md）。
//
//   node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs [--states empty,html,done] [--themes light,dark] [--only A,B] [--view 1536x864]
//
// 案の定義（ES モジュール）は PROPOSALS = [{ key, name, css, ops }] を書き出す（例: ui-proposals/2026-10-layout.mjs）。
// 今の画面に案ごとの CSS と DOM の組み替え（ops）を当て、利用者の画面と同じ大きさ（1728×1152・表示倍率 125%。--view で
// フル HD・125% の 1536×864 なども）で、
// 状態ごとに撮る（状態-テーマ-案.png）。測る量は ui-check.mjs と同じ（metrics.json）。状態ごとに全案を並べた
// 一覧（sheet-状態-テーマ.png）も作る。一覧で全体を、1 枚ずつの画像で細部を見て採点する（ui_score.py）。
//
// ops（上から順に当てる。動かした要素の id はそのままなので、画面の仕組みは動き続ける）:
//   ["move", 動かすもの, "before"|"after"|"prepend"|"append", 基準]
//   ["class", 対象, クラス名]                                          … クラスを置き換える
//   ["insert", HTML, "beforebegin"|"afterbegin"|"beforeend"|"afterend", 基準]
//   ["clone", 写すもの, "before"|"after"|"prepend"|"append", 基準]     … 見た目だけの写し（押しても動かない。id は外す）

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launch, measure, parseView, walk } from "./ui-harness.mjs";

const [outArg, defsArg, ...rest] = process.argv.slice(2);
if (!outArg || !defsArg) {
  console.error("使い方: node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs [--states empty,html,done] [--themes light,dark] [--only A,B] [--view 1536x864]");
  process.exit(2);
}
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return (i >= 0 ? rest[i + 1] : fallback).split(",");
};
const OUT = path.resolve(outArg);
const STATES = option("states", "empty,html,done");
const THEMES = option("themes", "light");
const ONLY = option("only", "");
const VIEW = parseView(option("view", "")[0]);
const { PROPOSALS } = await import(pathToFileURL(path.resolve(defsArg)).href);
const TAKE = PROPOSALS.filter((p) => !ONLY[0] || ONLY.includes(p.key)); // 一覧の画像には、撮り直さなかった案も前の画像で並べる

/** 案を頁に当てる（page.evaluate に渡す） */
function applyOps(ops) {
  const pick = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`見つからない: ${selector}`);
    return el;
  };
  const place = (node, where, target) => ({ before: () => target.before(node), after: () => target.after(node), prepend: () => target.prepend(node), append: () => target.append(node) })[where]();
  for (const [kind, a, b, c] of ops) {
    if (kind === "move") place(pick(a), b, pick(c));
    else if (kind === "class") pick(a).className = b;
    else if (kind === "insert") pick(c).insertAdjacentHTML(b, a);
    else if (kind === "clone") {
      const copy = pick(a).cloneNode(true);
      for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
      place(copy, b, pick(c));
    } else throw new Error(`知らない操作: ${kind}`);
  }
}

/** 状態ごとに全案を並べた一覧の画像 */
async function contactSheet(browser, state, theme, metrics) {
  const shot = (key) => `${state}-${theme}-${key}.png`;
  const shown = PROPOSALS.filter(({ key }) => fs.existsSync(path.join(OUT, shot(key)))); // このフォルダで撮った案だけ
  const cols = Math.min(4, shown.length);
  const tiles = shown.map(({ key, name }) => {
    const m = metrics[`${state}-${theme}-${key}`];
    const facts = m ? `主ボタン ${m.primaries} · 3D ${Math.round(m.stage * 100)}% · 見える文字 ${m.text.visible} · 欄のスクロール先 ${m.hidden}px` : "";
    return `<figure><figcaption><b>${key}</b> ${name}<small>${facts}</small></figcaption><img src="${encodeURIComponent(shot(key))}"></figure>`;
  }).join("");
  const dark = theme === "dark";
  const tileH = Math.round((560 * VIEW.height) / VIEW.width);
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 20px; background: ${dark ? "#0d1117" : "#e9edf2"}; color: ${dark ? "#e6ebf1" : "#16202b"}; font: 15px system-ui, sans-serif; }
    h1 { margin: 0 0 14px; font-size: 20px; }
    main { display: grid; grid-template-columns: repeat(${cols}, 560px); gap: 16px; }
    figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
    figcaption { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
    figcaption b { font-size: 16px; } figcaption small { flex-basis: 100%; opacity: 0.75; }
    img { width: 560px; height: ${tileH}px; border: 1px solid ${dark ? "#2e3a48" : "#c5ced9"}; border-radius: 6px; }
  </style><h1>${state}（${theme}・${VIEW.width}×${VIEW.height}）</h1><main>${tiles}</main>`;
  const file = path.join(OUT, `sheet-${state}-${theme}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: cols * 576 + 24, height: 400 } });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(OUT, `sheet-${state}-${theme}.png`), fullPage: true });
  await page.close();
  fs.rmSync(file);
}

const app = await launch();
const saved = path.join(OUT, "metrics.json");
const metrics = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : {}; // 一部の案だけ撮り直すとき、前の測定を残す
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const theme of THEMES) {
    for (const p of TAKE) {
      const page = await app.newPage(theme, VIEW);
      if (p.css) await page.addStyleTag({ content: p.css });
      if (p.ops?.length) await page.evaluate(applyOps, p.ops);
      await walk(page, app.dev, async (state, next) => {
        const id = `${state}-${theme}-${p.key}`;
        await page.screenshot({ path: path.join(OUT, `${id}.png`) });
        metrics[id] = await page.evaluate(measure, next);
        console.log(id, JSON.stringify({ primaries: metrics[id].primaries, stage: metrics[id].stage, text: metrics[id].text, hidden: metrics[id].hidden }));
      }, STATES);
      await page.context().close();
    }
    for (const state of STATES) await contactSheet(app.browser, state, theme, metrics);
  }
} finally {
  await app.close();
}
fs.writeFileSync(saved, JSON.stringify(metrics, null, 1));
