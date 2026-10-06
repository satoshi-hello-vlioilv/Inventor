// 2026-10 の画面の作り直しで比べた案（docs/ui.md の 3・4 節）を、今の画面（E×B）への CSS と DOM の組み替えで再現する。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-layout.mjs --states empty,html,done
// 再現は近似: 配置・目立たせ方・常に見えるものの違いを見るためのもので、案ごとの細部（文言・間隔）は作り込んでいない。

const NO_STEPS = "#steps { display: none !important; }";

// 行動ドックを持たない案: 作るボタンと状態を欄の流れの中（単位の次）に置き、照合の結果をその下に置く（作り直す前と同じ並び）
const DOCK_IN_FLOW = {
  css: `.dock { border-top: 0; background: transparent; box-shadow: 0 -1px 0 var(--rule-soft); padding: 14px 0; }
        .dock-title { margin: 0; font-size: var(--fs-m); font-weight: 600; }`,
  ops: [
    ["insert", '<h2 class="dock-title">CAD ファイルを作る</h2>', "afterbegin", "#dock-build"],
    ["move", "#dock", "after", "#unit-card"],
    ["move", "#result-card", "after", "#dock"],
  ],
};

// 左のファイルの一覧（3 ペイン）
const FILES_PANE = {
  css: `:root { --files-w: 250px; }
        .app { grid-template-columns: var(--files-w) minmax(0, 1fr) var(--side-w); grid-template-areas: "bar bar bar" "files stage side"; }
        .app.is-html { grid-template-columns: var(--files-w) minmax(0, 1fr) minmax(0, 1fr) var(--side-w); grid-template-areas: "bar bar bar bar" "files source stage side"; }
        .app.is-empty { grid-template-columns: var(--files-w) minmax(0, 1fr); grid-template-areas: "bar bar" "files stage"; }
        .files-pane { grid-area: files; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px;
          background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); box-shadow: var(--shadow-1); }
        .files-pane > div { display: flex; flex-direction: column; gap: 10px; }
        .files-pane h3 { margin: 0; display: flex; gap: 6px; align-items: baseline; font-size: var(--fs-xs); }
        .files-pane h3 small { display: none; }
        .files-pane .sample-rows { grid-template-columns: minmax(0, 1fr); gap: 1px; }
        .files-pane .sample-row { grid-template-columns: minmax(0, 1fr) !important; padding: 4px 8px; border: 0; border-radius: 6px; }
        .files-pane .sample-name { -webkit-line-clamp: 1; font-size: var(--fs-xs); }
        .files-pane .sample-size { display: none; }
        #show-start { display: none; }`,
  ops: [
    ["insert", '<section class="files-pane" id="files-pane" aria-label="ファイル"><p class="eyebrow">ファイル</p></section>', "afterend", ".appbar"],
    ["clone", "#sample-groups", "append", "#files-pane"],
  ],
};

// 3D を画面いっぱいにし、右の欄を 3D の上に浮かべる
const FLOAT_SIDE = `.app, .app.is-empty { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "stage"; }
  .app.is-html { grid-template-columns: minmax(0, 1fr) minmax(0, 1.7fr); grid-template-areas: "bar bar" "source stage"; }
  .side { position: fixed; top: 84px; right: 32px; width: 360px; max-height: calc(100vh - 210px); z-index: 5; border-radius: 14px;
    box-shadow: 0 10px 36px rgba(10, 20, 30, 0.22); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(6px); }
  .side-scroll { flex: 0 1 auto; }
  .mouse-help { display: none; }`;

// 行動ドックだけを、浮かぶ欄とは別に 3D の右下に浮かべる
const FLOAT_DOCK = {
  css: `.side { max-height: calc(100vh - 84px - 290px); }
        #dock { position: fixed; right: 32px; bottom: 32px; width: 360px; z-index: 6; border-radius: 14px; box-shadow: 0 10px 36px rgba(10, 20, 30, 0.22); }`,
  ops: [["move", "#dock", "append", "#app"]],
};

// 段を画面の上いっぱいの帯にする（B の帯）
const STEPS_TOP = {
  css: `.app { grid-template-rows: auto auto minmax(0, 1fr); grid-template-areas: "bar bar" "steps steps" "stage side"; }
        .app.is-html { grid-template-areas: "bar bar bar" "steps steps steps" "source stage side"; }
        .app.is-empty { grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "bar" "stage"; }
        #steps { grid-area: steps; padding: 12px 24px; border: 1px solid var(--rule); border-radius: var(--radius); background: var(--surface); }
        #steps ol { max-width: 1100px; margin: 0 auto; }
        #steps .step-label { font-size: var(--fs-m); }`,
  ops: [["move", "#steps", "after", ".appbar"]],
};

// 段を見出しバーの中に、1 段 1 行で並べる（縦の場所を取らない）
const STEPS_IN_BAR = {
  css: `.appbar { grid-template-columns: auto minmax(0, 1fr) auto auto; }
        .appbar #steps { padding: 0; border: 0; background: none; }
        .appbar #steps ol { display: flex; gap: 22px; }
        .appbar #steps li + li::before { top: 50%; right: calc(100% + 3px); width: 16px; }
        .appbar .step { display: grid; grid-template-columns: auto auto; column-gap: 8px; row-gap: 0; align-items: center; text-align: start; padding: 0; }
        .appbar .step-mark { grid-row: 1 / 3; width: 26px; height: 26px; }
        .appbar .step-note { max-width: 9em; }`,
  ops: [["move", "#steps", "after", ".current"]],
};

export const PROPOSALS = [
  {
    key: "A", name: "磨き上げ",
    // 作り直す前の並び（右の欄の上に、開いているものと「ファイルを開く」（主）、作るボタンは欄の途中）を、今の色と文字で
    css: `${NO_STEPS} ${DOCK_IN_FLOW.css}
      :root { --side-w: 340px; }
      .appbar { display: none; }
      .app { grid-template-rows: minmax(0, 1fr); grid-template-areas: "stage side"; padding-top: 16px; }
      .app.is-html { grid-template-areas: "source stage side"; }
      .app.is-empty { grid-template-columns: minmax(0, 1fr) var(--side-w); grid-template-areas: "stage side"; }
      .app.is-empty .side { display: flex; }
      .side .current { flex-wrap: wrap; padding: 16px 0 8px; border: 0; }
      .side .appbar-actions { flex-direction: column; align-items: stretch; padding-bottom: 14px; }
      .side .appbar-actions #open { order: -1; }`,
    ops: [["move", ".current", "prepend", "#side-scroll"], ["move", ".appbar-actions", "after", ".current"], ["class", "#open", "primary"], ...DOCK_IN_FLOW.ops],
  },
  {
    key: "B", name: "段階型",
    // 段を画面の上いっぱいに置き、右の欄はいまの段の中身だけ（作るボタンは中身の終わり）
    css: `${DOCK_IN_FLOW.css} ${STEPS_TOP.css}
      body:has(#step-list li:nth-child(3) .step:is([data-status="now"], [data-status="run"])) #unit-card { display: none; }
      body:has(#step-list li:nth-child(4) .step:is([data-status="done"], [data-status="warn"], [data-status="bad"])) :is(#unit-card, #side-scroll > section.card[data-mode="html spec"], #side-scroll > .save-card) { display: none; }`,
    ops: [...STEPS_TOP.ops, ...DOCK_IN_FLOW.ops, ["move", "#dock", "after", "#side-scroll > section.card[data-mode='html spec']"]],
  },
  {
    key: "C", name: "3 ペイン",
    css: `${NO_STEPS} ${DOCK_IN_FLOW.css} ${FILES_PANE.css}`,
    ops: [...FILES_PANE.ops, ...DOCK_IN_FLOW.ops],
  },
  {
    key: "D", name: "カード",
    // 右の欄を広げ、中身を枠付きのカードの格子に（作るボタンもカードの 1 つ）
    css: `${NO_STEPS} ${DOCK_IN_FLOW.css}
      :root { --side-w: 600px; }
      .side { background: transparent; border: 0; box-shadow: none; }
      .side-scroll { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-content: start; padding: 0; }
      .side-scroll > .card, .side-scroll > .dock { margin: 0; padding: 14px; background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); box-shadow: var(--shadow-1); }
      .side-scroll > .card:has(.features, .build-results), .side-scroll > .alert, .side-scroll > .notice { grid-column: 1 / -1; }`,
    ops: [...DOCK_IN_FLOW.ops],
  },
  { key: "E", name: "行動ドック", css: NO_STEPS, ops: [] },
  {
    key: "F", name: "3D 全画面",
    css: `${NO_STEPS} ${DOCK_IN_FLOW.css} ${FLOAT_SIDE}`,
    ops: [...DOCK_IN_FLOW.ops],
  },
  { key: "E×B", name: "行動ドック ＋ 段階の帯", css: "", ops: [] },
  {
    key: "E×B×F", name: "E×B を 3D 全画面に",
    css: `${FLOAT_SIDE} ${FLOAT_DOCK.css}`,
    ops: [...FLOAT_DOCK.ops],
  },
  {
    key: "E×F", name: "行動ドック ＋ 3D 全画面",
    css: `${NO_STEPS} ${FLOAT_SIDE} ${FLOAT_DOCK.css}`,
    ops: [...FLOAT_DOCK.ops],
  },
  {
    key: "E×C", name: "行動ドック ＋ 3 ペイン",
    css: `${NO_STEPS} ${FILES_PANE.css}`,
    ops: [...FILES_PANE.ops],
  },
  // 画像で比べて足した複合案（B の帯の見やすさと、E のドックの場所の一定を合わせる）
  { key: "E×B′", name: "行動ドック ＋ 上の段階の帯", css: STEPS_TOP.css, ops: STEPS_TOP.ops },
  { key: "E×B″", name: "行動ドック ＋ 見出しバーの段階", css: STEPS_IN_BAR.css, ops: STEPS_IN_BAR.ops },
];
