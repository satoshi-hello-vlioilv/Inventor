// 2026-10（ショートカット）: アプリからデスクトップ・スタートメニューのショートカットを作る（作り直す）操作の置き場の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-shortcut.mjs --states empty,library
// 基本形の画像で見えたこと（状態 empty = 最初の画面、library = サンプル・受け取ったファイルの窓）:
// ① ショートカットに触れる操作が、アプリのどこにも無い（ZIP を展開して使うのでインストーラーも無い。消したら作り直せない）
// ② 見出しバーは「サンプル」「ファイルを開く」だけで、アプリそのもの（版・置き場）のことを置く場所が無い
// ③ サンプルの窓の下の帯は左に「ファイルを選ぶ」だけで、右が空いている
// 案の画像の状態は「デスクトップにもスタートメニューにも無い」（消した・作っていない）。点数は 2026-10-shortcut.json、決めたことは docs/ui.md。

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M10 15.5l4.5-4.5M11 11h3.5v3.5"/></svg>`;
const BASE_CSS = `.sc-btn { display: inline-flex; align-items: center; gap: 6px; }
  .sc-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .sc-state { font-size: var(--fs-xs); color: var(--muted); }
  .sc-state b { color: var(--warn); font-weight: 600; }
  .sc-row { display: flex; align-items: center; gap: 10px; }
  .sc-row .sc-name { min-width: 7.5em; color: var(--ink); font-size: var(--fs-s); font-weight: 600; }
  .sc-row .sc-state { flex: 1; }`;
// 置き場ごとの行（デスクトップ・スタートメニュー）
const ROWS = `<div class="sc-row"><span class="sc-name">デスクトップ</span><span class="sc-state"><b>●</b> ありません</span><button type="button" class="secondary sc-btn">${ICON}作る</button></div>
  <div class="sc-row"><span class="sc-name">スタートメニュー</span><span class="sc-state"><b>●</b> ありません</span><button type="button" class="secondary sc-btn">${ICON}作る</button></div>`;

// A サンプルの窓の下の帯の右: 「デスクトップにショートカットを作る」（いまの状態を添える）
const FOOT = {
  css: `${BASE_CSS} .sc-foot { margin-inline-start: auto; display: flex; align-items: center; gap: 10px; }`,
  ops: [["insert", `<span class="sc-foot"><span class="sc-state"><b>●</b> デスクトップにありません</span><button type="button" class="secondary sc-btn">${ICON}デスクトップにショートカットを作る</button></span>`, "beforeend", ".library-foot"]],
};
// B 最初の画面の一行（無いときだけ）: ドロップの受け口の下に「ショートカットがありません［作る］」
const WELCOME_LINE = {
  css: `${BASE_CSS} .sc-line { display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 14px; border-radius: 10px; background: var(--warn-soft); color: var(--ink); font-size: var(--fs-s); }`,
  ops: [["insert", `<div class="sc-line"><span>デスクトップにショートカットがありません。作ると、次から 1 回で開けます</span><button type="button" class="secondary sc-btn">${ICON}作る</button></div>`, "afterend", "#dropzone"]],
};
// C 見出しバーの「このアプリ」メニュー（版・ショートカット 2 つ・保存先）。画像は開いた状態
const MENU = {
  css: `${BASE_CSS} .sc-menu-btn { font-size: var(--fs-s); }
    .sc-menu { position: fixed; top: 52px; right: 16px; z-index: 50; width: 360px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
      background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; box-shadow: var(--shadow-3); }
    .sc-menu h4 { margin: 0; font-size: var(--fs-xs); color: var(--muted); font-weight: 600; letter-spacing: 0.04em; }
    .sc-menu .sc-ver { font-size: var(--fs-s); color: var(--ink); }
    .sc-menu hr { border: 0; border-top: 1px solid var(--rule-soft); margin: 2px 0; }`,
  ops: [
    ["insert", `<button type="button" class="quiet sc-menu-btn" title="このアプリ">このアプリ ▾</button>`, "afterbegin", ".appbar-actions"],
    ["insert", `<div class="sc-menu"><h4>このアプリ</h4><span class="sc-ver">Inventor 3Dツール 2.0.0</span><hr><h4>ショートカット</h4>${ROWS}</div>`, "beforeend", "body"],
  ],
};
// D 最初の画面の 3 枚目のカード「このアプリ」: 置き場ごとの状態と［作る］
const CARD = {
  css: `${BASE_CSS} .paths { width: min(1000px, 100%); grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .sc-card { display: flex; flex-direction: column; gap: 10px; }
    .sc-card h3 { margin: 0 0 2px; }`,
  ops: [["insert", `<section class="path sc-card"><h3><span class="path-tag">このアプリ</span>ショートカット</h3>${ROWS}</section>`, "beforeend", ".paths"]],
};
// E サンプルの窓の最後の節「このアプリ」: 置き場ごとの状態と［作る］
const SECTION = {
  css: `${BASE_CSS} .sc-section { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; margin-top: 6px; border-top: 1px solid var(--rule); }
    .sc-section h3 { margin: 0; font-size: var(--fs-m); }
    .sc-section p { margin: 0; font-size: var(--fs-xs); color: var(--muted); }`,
  ops: [["insert", `<section class="sc-section"><h3>このアプリのショートカット</h3><p>デスクトップ・スタートメニューから 1 回で開けます。消した・フォルダを移したときは作り直してください</p>${ROWS}</section>`, "beforeend", ".library-body"]],
};
// F 起動したとき無ければ、右下に一度だけ知らせる（作る・今はしない）＋ A
const TOAST = {
  css: `${FOOT.css} .sc-toast { position: fixed; right: 20px; bottom: 20px; z-index: 40; width: 380px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
      background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--accent); border-radius: 12px; box-shadow: var(--shadow-3); font-size: var(--fs-s); }
    .sc-toast b { font-size: var(--fs-m); }
    .sc-toast .sc-acts { display: flex; gap: 8px; justify-content: flex-end; }`,
  ops: [
    ["insert", `<div class="sc-toast"><b>デスクトップにショートカットがありません</b><span>作ると、次から 1 回で開けます（あとで「サンプル・受け取ったファイル」の下からも作れます）</span>
      <div class="sc-acts"><button type="button" class="quiet">今はしない</button><button type="button" class="primary sc-btn">${ICON}作る</button></div></div>`, "beforeend", "body"],
    ...FOOT.ops,
  ],
};

export const PROPOSALS = [
  { key: "base", name: "現状", css: "", ops: [] },
  { key: "A", name: "A 窓の下の帯", ...FOOT },
  { key: "B", name: "B 最初の画面の一行", ...WELCOME_LINE },
  { key: "C", name: "C 見出しバーのメニュー", ...MENU },
  { key: "D", name: "D 最初の画面のカード", ...CARD },
  { key: "E", name: "E 窓の最後の節", ...SECTION },
  { key: "F", name: "F 起動時の知らせ＋A", ...TOAST },
];
