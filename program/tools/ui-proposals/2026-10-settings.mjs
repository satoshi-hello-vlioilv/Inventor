// 2026-10（設定）: ショートカットを作る・版の管理（ZIP で版を置く・配る版・消す・残す数・置き場・役割）の画面の置き方の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-settings.mjs --states empty,ipt
// 基本形の画像で見えたこと（状態 empty = 最初の画面、ipt = 部品を開いた画面）:
// ① ショートカット・版・置き場など、アプリそのものに触れる操作がどこにも無い（消したショートカットを作り直せない）
// ② 見出しバーは「サンプル」「ファイルを開く」だけ。右上に、アプリの設定を置く場所の慣例（歯車）が無い
// ③ 版の管理は開発者・メンテナンス者だけ（一般の人には見るだけの状態）。表（版ごとの行と操作）が要るので幅が要る
// 案の中身はどれも同じ（開発者が開いた状態: ショートカットはデスクトップに無い・版 4 つ・配っている版 2.1.0）。
// 違うのは置き方（どこから開き、どの形で出すか）だけ。点数は 2026-10-settings.json、決めたことは docs/ui.md。
// 1 回目の前に作ったショートカットだけの置き場の 6 案（窓の下の帯・最初の画面の一行 など）は、版の管理と同じ画面にまとめるため、
// この比較に組み込んだ（D 案・F 案の入口として残した）。

const GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`;
const LINK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M10 15.5l4.5-4.5M11 11h3.5v3.5"/></svg>`;
const ZIP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M11 6v2m0 2v2m0 2v2"/></svg>`;

// 重ねた物は撮るためだけの見本なので、クリックを素通りさせる（撮影の道具は状態を順にたどるので、塞ぐと先へ進めない）
const CSS = `
  .st-scrim, .st, .st-badge { pointer-events: none; }
  .st-btn { min-height: 32px; padding: 4px 12px; font-size: var(--fs-s); }
  .st h3 { margin: 0; font-size: var(--fs-m); font-weight: 700; display: flex; align-items: baseline; gap: 10px; }
  .st h3 small { font-size: var(--fs-xs); font-weight: 400; color: var(--muted); }
  .st section { display: flex; flex-direction: column; gap: 10px; }
  .st .row { display: flex; align-items: center; gap: 10px; min-height: 34px; font-size: var(--fs-s); }
  .st .row .name { width: 9em; flex: none; color: var(--muted); }
  .st .row .val { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .st .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-inline-end: 6px; vertical-align: 1px; }
  .st .dot.ok { background: var(--ok); } .st .dot.warn { background: var(--warn); }
  .st .mono { font-family: var(--font-num); font-size: var(--fs-xs); color: var(--muted); }
  .st table { width: 100%; border-collapse: collapse; font-size: var(--fs-s); }
  .st th { text-align: start; font-weight: 600; font-size: var(--fs-xs); color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  .st td { padding: 7px 8px; border-bottom: 1px solid var(--rule-soft); vertical-align: middle; }
  .st td.num { font-family: var(--font-num); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .st td.act { text-align: end; white-space: nowrap; }
  .st .tag { display: inline-block; margin-inline-start: 6px; padding: 0 7px; border-radius: 99px; font-size: var(--fs-xs); font-weight: 600; background: var(--surface-2); color: var(--muted); border: 1px solid var(--rule); }
  .st .tag.now { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
  .st tr.is-now td { background: color-mix(in srgb, var(--ok-soft) 50%, transparent); }
  .st .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .st .keep { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-s); color: var(--muted); margin-inline-start: auto; }
  .st .keep input { width: 4em; padding: 4px 6px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); }
  .st .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .st .chip { padding: 2px 10px; border-radius: 99px; background: var(--surface-2); border: 1px solid var(--rule); font-size: var(--fs-s); }
  .st .lead { margin: 0; font-size: var(--fs-xs); color: var(--muted); }
  .st .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .st .card { padding: 12px 14px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 4px; }
  .st .card b { font-size: var(--fs-l); }
  .st .card span { font-size: var(--fs-xs); color: var(--muted); }
  .st-head-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .st-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .st-scrim { position: fixed; inset: 0; z-index: 60; background: rgba(16, 24, 32, 0.45); }
  .st-dialog { position: fixed; z-index: 61; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(1040px, calc(100vw - 48px)); max-height: calc(100vh - 48px);
    display: flex; flex-direction: column; background: var(--surface); color: var(--ink); border: 1px solid var(--rule); border-radius: 16px; box-shadow: var(--shadow-3); overflow: hidden; }
  .st-dialog > header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--rule); }
  .st-dialog > header h2 { margin: 0; font-size: var(--fs-l); }
  .st-dialog .st-body { overflow: auto; padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 22px; }
`;

const SUMMARY = `<div class="summary">
  <div class="card"><span>この PC の版</span><b>2.1.0</b><span><i class="dot ok"></i>配っている版と同じ</span></div>
  <div class="card"><span>ショートカット</span><b>デスクトップに無し</b><span><i class="dot warn"></i>作ると次から 1 回で開けます</span></div>
  <div class="card"><span>あなたの役割</span><b>開発者</b><span>版の管理と役割の変更ができます</span></div></div>`;
const SHORTCUT = `<section><h3>ショートカット<small>ローカルの exe（C:\\Users\\sato\\Inventor3DTool）を指します</small></h3>
  <div class="row"><span class="name">デスクトップ</span><span class="val"><i class="dot warn"></i>ありません</span><button class="primary st-btn" type="button">${LINK}作る</button></div>
  <div class="row"><span class="name">スタートメニュー</span><span class="val"><i class="dot ok"></i>あります</span><button class="quiet st-btn" type="button">作り直す</button></div></section>`;
const VERSIONS = `<section><h3>版<small>開発者・メンテナンス者だけが操作できます</small></h3>
  <div class="bar"><button class="primary st-btn" type="button">${ZIP}ZIP から版を置く…</button><span class="lead">GitHub の Code → Download ZIP で落とした ZIP</span>
    <label class="keep">残す版の数 <input value="5"> （0 = 全て）</label></div>
  <table><thead><tr><th>版</th><th>置いた日時</th><th>置いた人</th><th>元の ZIP</th><th>大きさ</th><th></th></tr></thead><tbody>
  <tr class="is-now"><td><b>2.1.0</b><span class="tag now">配っている</span><span class="tag">この PC</span></td><td class="num">10/08 18:12</td><td>sato</td><td class="mono">Inventor-main.zip</td><td class="num">39.6 MB</td><td class="act"></td></tr>
  <tr><td>2.0.3<span class="tag">前に配った</span></td><td class="num">10/02 01:40</td><td>sato</td><td class="mono">Inventor-main (3).zip</td><td class="num">38.3 MB</td><td class="act"><button class="secondary st-btn" type="button">この版を配る</button> <button class="quiet st-btn" type="button">消す</button></td></tr>
  <tr><td>2.0.2</td><td class="num">09/24 20:05</td><td>tanaka</td><td class="mono">Inventor-main (2).zip</td><td class="num">38.2 MB</td><td class="act"><button class="secondary st-btn" type="button">この版を配る</button> <button class="quiet st-btn" type="button">消す</button></td></tr>
  <tr><td>2.0.0</td><td class="num">09/10 17:30</td><td>sato</td><td class="mono">Inventor-main.zip</td><td class="num">33.6 MB</td><td class="act"><button class="secondary st-btn" type="button">この版を配る</button> <button class="quiet st-btn" type="button">消す</button></td></tr>
  </tbody></table></section>`;
const SHARE = `<section><h3>置き場<small>全ての PC が、起動のときにここの配っている版へそろえます</small></h3>
  <div class="row"><span class="name">場所</span><span class="val mono">C:\\boxdrive\\Box\\(D)_仕上課\\90_アプリ開発\\90_Releases\\Inventor <i class="dot ok"></i>届きます</span><button class="quiet st-btn" type="button">変える…</button></div>
  <div class="row"><span class="name">新しい PC へ</span><span class="val mono">…\\90_Releases\\Inventor\\Inventor3DTool.exe を開く</span><button class="quiet st-btn" type="button">場所をコピー</button></div></section>`;
const ROLES = `<section><h3>役割<small>開発者だけが変えられます</small></h3>
  <div class="row"><span class="name">開発者</span><span class="val chips"><span class="chip">sato</span></span><button class="quiet st-btn" type="button">足す</button></div>
  <div class="row"><span class="name">メンテナンス者</span><span class="val chips"><span class="chip">tanaka</span><span class="chip">suzuki</span></span><button class="quiet st-btn" type="button">足す</button></div></section>`;

const HEAD_GEAR = ["insert", `<button type="button" class="quiet st-head-btn" title="設定（ショートカット・版）">${GEAR}設定</button>`, "afterbegin", ".appbar-actions"];
const dialog = (title, body, extraClass = "") => `<div class="st-scrim pv"></div><div class="st-dialog st pv ${extraClass}"><header><h2>${title}</h2><button class="icon-button" type="button">✕</button></header><div class="st-body">${body}</div></div>`;

// A 設定の窓＋左の見出し（ショートカット・版・置き場・役割）。版を選んだところ
const NAV = {
  css: `${CSS} .st-split { display: grid; grid-template-columns: 200px minmax(0, 1fr); min-height: 0; flex: 1; }
    .st-nav { border-inline-end: 1px solid var(--rule); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; background: var(--surface-2); }
    .st-nav a { padding: 8px 12px; border-radius: 8px; font-size: var(--fs-s); color: var(--ink); text-decoration: none; }
    .st-nav a[aria-current] { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .st-split .st-body { padding: 16px 20px 20px; }`,
  ops: [HEAD_GEAR, ["insert", `<div class="st-scrim pv"></div><div class="st-dialog st pv"><header><h2>設定</h2><button class="icon-button" type="button">✕</button></header>
      <div class="st-split"><nav class="st-nav"><a>ショートカット</a><a aria-current="page">版</a><a>置き場</a><a>役割</a></nav><div class="st-body">${VERSIONS}</div></div></div>`, "beforeend", "body"]],
};
// B 右の引き出し（1 列。上から ショートカット → 版 → 置き場 → 役割）
const DRAWER = {
  css: `${CSS} .st-drawer { position: fixed; z-index: 61; top: 0; right: 0; bottom: 0; width: 600px; background: var(--surface); border-inline-start: 1px solid var(--rule);
      box-shadow: var(--shadow-3); display: flex; flex-direction: column; }
    .st-drawer > header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--rule); }
    .st-drawer > header h2 { margin: 0; font-size: var(--fs-l); }
    .st-drawer .st-body { overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 22px; }
    .st-drawer td:nth-child(3), .st-drawer th:nth-child(3), .st-drawer td:nth-child(4), .st-drawer th:nth-child(4) { display: none; }`,
  ops: [HEAD_GEAR, ["insert", `<div class="st-scrim pv"></div><aside class="st-drawer st pv"><header><h2>設定</h2><button class="icon-button" type="button">✕</button></header><div class="st-body">${SHORTCUT}${VERSIONS}${SHARE}${ROLES}</div></aside>`, "beforeend", "body"]],
};
// C 全面のページ（主役の場所を置き換え。左 = 要点・ショートカット・置き場・役割、右 = 版の表）
const PAGE = {
  css: `${CSS} .st-page { position: fixed; z-index: 30; left: 16px; right: 16px; top: 64px; bottom: 16px; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
      display: grid; grid-template-columns: 420px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
    .st-page > header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--rule); }
    .st-page > header h2 { margin: 0; font-size: var(--fs-l); }
    .st-page .col { overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 22px; }
    .st-page .col + .col { border-inline-start: 1px solid var(--rule); }
    .st-page .summary { grid-template-columns: minmax(0, 1fr); }`,
  ops: [HEAD_GEAR, ["insert", `<div class="st-page st pv"><header><button class="quiet st-btn" type="button">← 戻る</button><h2>設定</h2></header>
      <div class="col">${SHORTCUT}${SHARE}${ROLES}</div><div class="col">${VERSIONS}</div></div>`, "beforeend", "body"]],
};
// D サンプルの窓のタブ（サンプル・受け取ったファイル ｜ 設定）。設定のタブを開いたところ
const LIB_TAB = {
  css: `${CSS} .st-tabs { display: flex; gap: 4px; }
    .st-tabs span { padding: 6px 14px; border-radius: 8px; font-size: var(--fs-m); color: var(--muted); }
    .st-tabs span[aria-current] { background: var(--accent-soft); color: var(--accent); font-weight: 700; }`,
  ops: [["insert", dialog(`<span class="st-tabs"><span>サンプル・受け取ったファイル</span><span aria-current="page">設定</span></span>`, `${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`), "beforeend", "body"]],
};
// E 設定の窓 1 枚（上に要点のカード 3 つ、下に節を並べてスクロール）
const ONE = { css: CSS, ops: [HEAD_GEAR, ["insert", dialog("設定", `${SUMMARY}${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`), "beforeend", "body"]] };
// F 見出しバーの版のバッジ（v2.1.0・状態の点）から E と同じ窓。ショートカットが無いときはバッジに印
const BADGE = {
  css: `${CSS} .st-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--rule); border-radius: 99px; font: 500 var(--fs-xs) var(--font-num); color: var(--muted); background: var(--surface); }
    .st-badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }`,
  ops: [["insert", `<button type="button" class="st-badge" title="版・ショートカット・置き場"><i></i>v2.1.0</button>`, "afterbegin", ".appbar-actions"],
    ["insert", dialog("この アプリ（v2.1.0）", `${SUMMARY}${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`), "beforeend", "body"]],
};

// ---- 2 回目（1 回目は B 80.0・A 74.0・E 74.0 で僅差。B を元にした複合案 3 つと、元の上位 2 案 B・E） ----
const STRIP = `<div class="st-strip"><span><i class="dot ok"></i>この PC は <b>2.1.0</b>（配っている版と同じ）</span><span>あなたは <b>開発者</b>（sato）</span></div>`;
const STRIP_CSS = `.st-strip { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: var(--fs-s); }`;
const drawer = (body, width = 600, hideCols = true) => ({
  css: `${DRAWER.css.replace("width: 600px", `width: ${width}px`)}${hideCols ? "" : " .st-drawer td, .st-drawer th { display: table-cell !important; }"} ${STRIP_CSS}`,
  body: `<div class="st-scrim pv"></div><aside class="st-drawer st pv"><header><h2>設定</h2><button class="icon-button" type="button">✕</button></header><div class="st-body">${body}</div></aside>`,
});
// G B＋要点の 1 行（この PC の版・あなたの役割）を引き出しの上に
const G_ = drawer(`${STRIP}${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`);
const STRIP_DRAWER = { css: G_.css, ops: [HEAD_GEAR, ["insert", G_.body, "beforeend", "body"]] };
// H B＋見出しバーの入口を「歯車と版」に（v2.1.0 と状態の点。ショートカットが無い・版が違うと点が橙）
const H_ = drawer(`${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`);
const BADGE_DRAWER = {
  css: `${H_.css} ${BADGE.css}`,
  ops: [["insert", `<button type="button" class="quiet st-head-btn" title="設定（ショートカット・版）">${GEAR}設定<span class="st-badge"><i></i>v2.1.0</span></button>`, "afterbegin", ".appbar-actions"],
    ["insert", H_.body, "beforeend", "body"]],
};
// I B を広げて（760px）表の列を全て見せる＋要点の 1 行
const I_ = drawer(`${STRIP}${SHORTCUT}${VERSIONS}${SHARE}${ROLES}`, 760, false);
const WIDE_DRAWER = { css: I_.css, ops: [HEAD_GEAR, ["insert", I_.body, "beforeend", "body"]] };

export const PROPOSALS = [
  { key: "base", name: "現状", css: "", ops: [] },
  { key: "A", name: "A 窓＋左の見出し", ...NAV },
  { key: "B", name: "B 右の引き出し", ...DRAWER },
  { key: "C", name: "C 全面のページ", ...PAGE },
  { key: "D", name: "D サンプルの窓のタブ", ...LIB_TAB },
  { key: "E", name: "E 1 枚の窓（要点＋節）", ...ONE },
  { key: "F", name: "F 版のバッジから", ...BADGE },
  { key: "G", name: "G B＋要点の 1 行", ...STRIP_DRAWER },
  { key: "H", name: "H B＋歯車と版のバッジ", ...BADGE_DRAWER },
  { key: "I", name: "I 広い引き出し＋要点", ...WIDE_DRAWER },
];
