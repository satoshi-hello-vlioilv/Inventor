// 2026-11（図面を直す画面）: 選んだ図形を動かす・写す・回す・消す命令、取り消し、DXF で保存をどこに置くか。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-drawedit.mjs --states edit-select,edit,edit-done
// 今の画面（直す前。測る・選ぶだけ）の画像で見えたこと:
// ① ツールバーは「レイアウト・線の太さ・測る・全体表示」だけで、図面を直せること・保存できることが見えない
// ② 図形を押すと右の欄に「選んだ図形」のカードが出るが、読むだけで、直す入口が無い
// ③ 測るときは図の上の帯に「いま・次・やめる」が出る（直す命令の手順にも同じ型が使える）
// ④ 図面のときの右の欄は下半分が空いている。見出しには設定・サンプル・ファイルを開くだけで、保存が無い
// 部品（命令のボタン #edit-tools・手順の帯 #edit-band・画層と文字 #selection-edit・保存 #save-dxf-group・変更あり #edit-dirty）は
// 今の画面に置いてあり（案 A の並び）、案ごとに置き場所を変える。点数は 2026-11-drawedit.json

// 選んでいる間だけ出す（選んだ図形のカードの出し入れに合わせる）
const WHILE_SELECTED = (selector, extra = "") => `
  const run = () => {
    const on = !document.getElementById("selection-card").hidden ${extra};
    for (const el of document.querySelectorAll("${selector}")) el.hidden = !on;
  };
  for (const id of ["selection-card", "edit-band"]) new MutationObserver(run).observe(document.getElementById(id), { attributes: true });
  run();`;

// F の保存の強調（2 回目の複合案でも使う）
const SAVE_EMPHASIS = {
  css: `
    #edit-dirty { display: none !important; }
    .save-dxf.is-dirty #save-dxf { color: var(--accent-ink, #fff); background: var(--accent); border-color: var(--accent); }
    .save-dxf.is-dirty #save-dxf::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-inline-end: 6px; border-radius: 50%; background: var(--warn); vertical-align: 1px; }
  `,
  op: ["script", `
    const run = () => document.getElementById("save-dxf-group").classList.toggle("is-dirty", !document.getElementById("edit-dirty").hidden);
    new MutationObserver(run).observe(document.getElementById("edit-dirty"), { attributes: true });
    run();`],
};

export const PROPOSALS = [
  { key: "A", name: "ツールバーに直す命令の群・見出しに DXF で保存（版つき）・カードに画層", css: "", ops: [] },
  {
    key: "B",
    name: "右の欄に集約（選んだ図形のカードに命令・図面のカードに保存）",
    css: `
      .selection-card #edit-tools { margin-top: 10px; box-shadow: none; flex-wrap: wrap; }
      .selection-card #edit-tools button { flex: 1 1 auto; }
      .key-card #save-dxf-group { margin-top: 10px; }
      .key-card #save-dxf { flex: 1; }
    `,
    ops: [["move", "#edit-tools", "after", "#selection-info"], ["move", "#save-dxf-group", "append", ".key-card"]],
  },
  {
    key: "C",
    name: "選んだときだけ、図の下の中央に浮かぶ命令の帯（保存は見出し）",
    css: `
      #edit-tools.floating { position: absolute; left: 50%; bottom: 64px; transform: translateX(-50%); pointer-events: auto; box-shadow: var(--shadow-2, 0 6px 18px rgba(0,0,0,.18)); }
      #edit-tools.floating[hidden] { display: none; }
    `,
    ops: [["move", "#edit-tools", "append", "#stage"], ["class", "#edit-tools", "tool-group edit-tools floating"], ["script", WHILE_SELECTED("#edit-tools", "|| !document.getElementById('edit-band').hidden")]],
  },
  {
    key: "D",
    name: "図の左に縦の道具箱（CAD の道具の並び。保存は見出し）",
    css: `
      #edit-tools.palette { position: absolute; left: 12px; top: 72px; flex-direction: column; pointer-events: auto; }
      #edit-tools.palette button { border-inline-end: 0; border-bottom: 1px solid var(--rule); text-align: left; }
      #edit-tools.palette button:last-child { border-bottom: 0; }
      .app.is-drawing .measure-row { padding-inline-start: 120px; }
    `,
    ops: [["move", "#edit-tools", "append", "#stage"], ["class", "#edit-tools", "tool-group edit-tools palette"]],
  },
  {
    key: "E",
    name: "選んだら、ツールバーの下の帯に命令が並ぶ（命令の間は手順に変わる。保存は見出し）",
    css: `
      #edit-row { flex-basis: 100%; display: flex; justify-content: center; pointer-events: none; }
      #edit-row[hidden] { display: none; }
      #edit-row .tool-group { border-color: var(--accent); }
      #edit-row .edit-lead { display: flex; align-items: center; padding: 0 12px; font-size: var(--fs-s); font-weight: 600; color: var(--accent); }
    `,
    ops: [
      ["insert", '<div class="measure-row" id="edit-row"></div>', "beforebegin", "#edit-band"],
      ["move", "#edit-tools", "append", "#edit-row"],
      ["insert", '<span class="edit-lead">選んだ図形を</span>', "afterbegin", "#edit-tools"],
      ["script", WHILE_SELECTED("#edit-row", "&& document.getElementById('edit-band').hidden")],
    ],
  },
  { key: "F", name: "A ＋ 直した後は保存を主の色に（「変更あり」は保存のボタンの点に）", css: SAVE_EMPHASIS.css, ops: [SAVE_EMPHASIS.op] },
  // 2 回目（1 回目は F と A が僅差）: F を元に、E の読みやすさ・ツールバーの長さ・取り消しの置き場所を変えた複合案 3 つ
  {
    key: "G",
    name: "F ＋ 命令の群の頭に「選んだ図形を」（文のように読む。いつも同じ所）",
    css: SAVE_EMPHASIS.css + `
      #edit-tools .edit-lead { display: flex; align-items: center; padding: 0 10px; font-size: var(--fs-s); color: var(--muted); border-inline-end: 1px solid var(--rule); white-space: nowrap; }
    `,
    ops: [SAVE_EMPHASIS.op, ["insert", '<span class="edit-lead">選んだ図形を</span>', "afterbegin", "#edit-tools"]],
  },
  {
    key: "H",
    name: "F ＋ 取り消し・やり直しを見出しの保存の隣へ（直した履歴と保存を 1 か所に。ツールバーは命令だけ）",
    css: SAVE_EMPHASIS.css + `
      #edit-history { display: flex; margin-inline-end: 6px; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
      #edit-history button { border: 0; background: var(--surface); color: var(--ink); min-width: 34px; font-size: var(--fs-l); cursor: pointer; }
      #edit-history button + button { border-inline-start: 1px solid var(--rule); }
      #edit-history button:disabled { color: var(--muted); opacity: 0.45; }
    `,
    ops: [SAVE_EMPHASIS.op, ["insert", '<div id="edit-history"></div>', "afterbegin", "#save-dxf-group"],
      ["move", "#edit-undo", "append", "#edit-history"], ["move", "#edit-redo", "append", "#edit-history"]],
  },
  {
    key: "I",
    name: "F ＋ E: 命令は選んだら帯に（「選んだ図形を …」）、取り消し・やり直しはツールバーにいつも",
    css: SAVE_EMPHASIS.css + `
      #edit-row { flex-basis: 100%; display: flex; justify-content: center; pointer-events: none; }
      #edit-row[hidden] { display: none; }
      #edit-row .tool-group { border-color: var(--accent); }
      #edit-row .edit-lead { display: flex; align-items: center; padding: 0 12px; font-size: var(--fs-s); font-weight: 600; color: var(--accent); }
    `,
    ops: [SAVE_EMPHASIS.op,
      ["insert", '<div class="tool-group" role="group" aria-label="取り消し" id="edit-history-group"></div>', "afterend", "#edit-tools"],
      ["move", "#edit-undo", "append", "#edit-history-group"], ["move", "#edit-redo", "append", "#edit-history-group"],
      ["insert", '<div class="measure-row" id="edit-row"></div>', "beforebegin", "#edit-band"],
      ["move", "#edit-tools", "append", "#edit-row"],
      ["insert", '<span class="edit-lead">選んだ図形を</span>', "afterbegin", "#edit-tools"],
      ["script", WHILE_SELECTED("#edit-row", "&& document.getElementById('edit-band').hidden")],
    ],
  },
];
