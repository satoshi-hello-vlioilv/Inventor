// 2026-10（木の表示）: 親子関係のある切り替えの一覧（組立の構成など）を、木（階層）で表す案。実物のデータ（Assembly_XY2.stp の構成）で描く。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-tree.mjs --states nested --themes light,dark
// 構成の木は、組立の出現の道筋（scene.instances[].path）から作り、同じ名前・同じ中身の兄弟を「×n」にまとめたもの（mktree の結果を埋め込む）。
// 部品の行の説明（寸法・材質・質量）は、いまの部品表の行から写す。

const TREE = {"name": "Assembly_XY2", "children": [{"name": "Assembly_X2", "count": 2, "leaf": false, "children": [{"name": "Part3_A_X", "count": 1, "leaf": true, "children": [], "row": 1}], "row": null}, {"name": "Assembly_Y2", "count": 2, "leaf": false, "children": [{"name": "Part3_A_Y", "count": 1, "leaf": true, "children": [], "row": 2}], "row": null}, {"name": "Plate", "count": 6, "leaf": true, "children": [], "row": 3}, {"name": "JIS B 1176 - メートル M4 x 6", "count": 12, "leaf": true, "children": [], "row": 4}]};

/** 木を描く頁の中の文（variant ごとに見た目と操作を変える） */
const render = (variant) => `(function draw() {
  const TREE = ${JSON.stringify(TREE)};
  if (${JSON.stringify(variant)}.hideOne) { const y = TREE.children[1]; y.hidden = true; y.children.forEach((c) => { c.hidden = true; c.dim = true; }); y.dim = true; }
  const V = ${JSON.stringify(variant)};
  const bom = document.getElementById("bom");
  if (!bom || document.getElementById("tree-x")) return;
  // この組立の部品表が埋まってから（行の説明を写すため。前の状態の組立の部品表を写さない）
  if (document.getElementById("file-name")?.textContent !== "Assembly_XY2.stp" || !bom.querySelector(".sub")) { setTimeout(draw, 200); return; }
  const info = (row) => { const li = row ? bom.querySelector("li:nth-child(" + row + ")") : null;
    return li ? { dim: li.querySelector(".dim")?.textContent ?? "", sub: li.querySelector(".sub")?.textContent ?? "" } : { dim: "", sub: "" }; };
  const kinds = (n) => n.children.length;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const row = (n, depth, last, open) => {
    const asm = !n.leaf;
    const i = info(n.row);
    const twisty = asm ? '<span class="tx-twisty" aria-hidden="true">' + (open ? "▾" : "▸") + '</span>' : '<span class="tx-twisty is-leaf"></span>';
    const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.1 6.9C3.6 8.6 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1"/></svg>';
    const eye = V.eye || V.eyeIcon ? '<button class="tx-eye' + (n.hidden ? " is-off" : "") + '" title="表示・非表示（親を消すと中も消える）" aria-pressed="' + (n.hidden ? "false" : "true") + '">' + (n.hidden ? EYE_OFF : EYE) + '</button>' : "";
    const icon = asm ? '<span class="tx-icon is-asm" aria-hidden="true">▣</span>' : '<span class="tx-icon" aria-hidden="true">◧</span>';
    const sub = asm ? "サブ組立 · 中の部品 " + kinds(n) + " 種類" : i.sub;
    return '<li class="tx-row' + (asm ? " is-asm" : "") + (n.dim ? " is-dim" : "") + (n.hidden ? " is-hidden" : "") + '" style="--depth:' + depth + '" data-last="' + (last ? 1 : 0) + '">' +
      '<div class="tx-line">' + twisty + icon + '<span class="tx-name">' + esc(n.name) + '</span><span class="tx-count">×' + n.count + '</span>' + eye + '</div>' +
      (sub ? '<div class="tx-sub">' + esc(sub) + '</div>' : "") + '</li>';
  };
  const walk = (nodes, depth) => nodes.flatMap((n, k) => {
    const open = depth === 0 || V.openAll;
    return [row(n, depth, k === nodes.length - 1, open), ...(n.children.length && open ? walk(n.children, depth + 1) : [])];
  });
  let html = "";
  if (V.mode === "tree") html = '<ul class="tx-tree' + (V.guides ? " has-guides" : "") + (V.bands ? " has-bands" : "") + '">' + walk(TREE.children, 0).join("") + "</ul>";
  if (V.mode === "drill") {
    html = '<nav class="tx-crumbs"><b>' + esc(TREE.name) + '</b><span class="tx-crumb-note">組立の中へ入るには › を押す</span></nav><ul class="tx-tree">' +
      TREE.children.map((n) => row(n, 0, false, false).replace('<span class="tx-twisty" aria-hidden="true">▸</span>', '<span class="tx-twisty is-leaf"></span>')
        .replace('</div>', (n.leaf ? "" : '<span class="tx-enter" aria-hidden="true">›</span>') + '</div>')).join("") + "</ul>";
  }
  if (V.mode === "groups") {
    const parts = TREE.children.filter((n) => n.leaf), asms = TREE.children.filter((n) => !n.leaf);
    const group = (title, count, nodes) => '<li class="tx-group"><div class="tx-group-head"><span>' + esc(title) + '</span><span class="tx-count">' + count + '</span></div><ul class="tx-tree">' + nodes.map((n) => row(n, 0, false, false)).join("") + "</ul></li>";
    html = '<ul class="tx-groups">' + asms.map((a) => group(a.name, "×" + a.count, a.children)).join("") + group("組立の直下", "", parts) + "</ul>";
  }
  const wrap = document.createElement("div");
  wrap.id = "tree-x";
  wrap.innerHTML = (V.switcher ? '<div class="tx-switch" role="tablist"><button class="is-on" role="tab" aria-selected="true">構成（木）</button><button role="tab">部品の種類ごと</button></div>' : "") +
    (V.title ? '<h3 class="tx-title">' + V.title + '</h3>' : "") +
    (V.bulk ? '<div class="tx-bulk"><button>すべて開く</button><button>すべて閉じる</button><button>すべて表示</button></div>' : "") + html;
  if (V.place === "replace") { bom.hidden = true; bom.before(wrap); }
  else if (V.place === "before") bom.before(wrap);
  else if (V.place === "card") {
    const card = document.createElement("section");
    card.className = "card"; card.dataset.mode = "asm";
    card.innerHTML = '<h2>構成<span class="h-note">▸ で開く · 行にカーソルで強調</span></h2>';
    card.append(wrap);
    bom.closest("section").before(card);
  }
  const details = bom.closest("section").querySelector("details.more");
  if (details && V.hideDetails) details.hidden = true;
})();`;

// 共通の見た目（行は部品表と同じ区切り・数字の書体）
const BASE = `
#tree-x { display: flex; flex-direction: column; gap: 8px; }
.tx-tree { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.tx-row { padding: 7px 6px 7px calc(6px + var(--depth) * 20px); border-bottom: 1px solid var(--rule-soft); position: relative; }
.tx-row:hover { background: var(--accent-soft); border-radius: 8px; border-bottom-color: transparent; }
.tx-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.tx-twisty { flex: none; width: 1em; color: var(--muted); font-size: var(--fs-xs); text-align: center; }
.tx-icon { flex: none; color: var(--muted); font-size: var(--fs-xs); }
.tx-icon.is-asm { color: var(--accent); }
.tx-name { flex: 1; min-width: 0; font: 500 var(--fs-m)/1.35 var(--font-num); overflow-wrap: anywhere; }
.tx-row.is-asm .tx-name { font-weight: 600; }
.tx-count { flex: none; font: 500 var(--fs-s) var(--font-num); color: var(--muted); }
.tx-sub { padding-left: calc(2em + 12px); font-size: var(--fs-xs); color: var(--muted); }
`;


const SWITCH = `
    .tx-switch { display: inline-flex; align-self: flex-start; padding: 3px; gap: 2px; border-radius: 10px; background: var(--surface-2); }
    .tx-switch button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; font: 500 var(--fs-s) var(--font-ui); color: var(--muted); }
    .tx-switch button.is-on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-1); }`;
const GUIDES = `
    .tx-tree.has-guides .tx-row[style*="--depth:1"]::before { content: ""; position: absolute; left: calc(6px + 0.5em); top: 0; bottom: 50%; border-left: 1px solid var(--rule); border-bottom: 1px solid var(--rule); width: 12px; }`;
const EYES = `
    .tx-eye { flex: none; display: inline-grid; place-items: center; width: 26px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); }
    .tx-eye:hover { background: var(--surface-2); color: var(--ink); }
    .tx-eye.is-off { color: var(--caution-ink); }
    .tx-row.is-dim .tx-name, .tx-row.is-dim .tx-sub, .tx-row.is-dim .tx-count, .tx-row.is-dim .tx-icon { opacity: 0.45; }`;
const HOVER_EYES = `
    .tx-eye { visibility: hidden; } .tx-row:hover .tx-eye, .tx-eye.is-off { visibility: visible; }`;
const BULK = `
    .tx-bulk { display: flex; gap: 6px; } .tx-bulk button { border: 1px solid var(--rule); background: var(--surface); border-radius: 8px; padding: 3px 10px; font: 500 var(--fs-xs) var(--font-ui); color: var(--muted); }`;

export const PROPOSALS = [
  { key: "base", name: "いま（部品の種類ごとの部品表・構成は数だけ）", css: "", ops: [] },
  { key: "A", name: "A 構成の木のカード（▸ で開閉・線で親子）＋部品表はそのまま", css: BASE + `
    .tx-tree.has-guides .tx-row[style*="--depth:1"]::before { content: ""; position: absolute; left: calc(6px + 0.5em); top: 0; bottom: 50%; border-left: 1px solid var(--rule); border-bottom: 1px solid var(--rule); width: 12px; }`,
    ops: [["script", render({ mode: "tree", place: "card", guides: true, openAll: true, hideDetails: true })]] },
  { key: "B", name: "B 部品表の中で切り替え（構成（木）⇄ 種類ごと）", css: BASE + `
    .tx-switch { display: inline-flex; align-self: flex-start; padding: 3px; gap: 2px; border-radius: 10px; background: var(--surface-2); }
    .tx-switch button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; font: 500 var(--fs-s) var(--font-ui); color: var(--muted); }
    .tx-switch button.is-on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-1); }`,
    ops: [["script", render({ mode: "tree", place: "replace", switcher: true, openAll: true, hideDetails: true })]] },
  { key: "C", name: "C 木＋行ごとの表示の切り替え（👁。親を消すと中も消える）", css: BASE + `
    .tx-eye { flex: none; width: 1.6em; text-align: center; font-size: var(--fs-s); opacity: 0.75; }
    .tx-row:hover .tx-eye { opacity: 1; }`,
    ops: [["script", render({ mode: "tree", place: "replace", eye: true, openAll: true, title: "構成と表示", hideDetails: true })]] },
  { key: "D", name: "D 掘り下げ（いまの階層だけを並べ、› で中へ。道筋の札）", css: BASE + `
    .tx-crumbs { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-s); }
    .tx-crumb-note { color: var(--muted); font-size: var(--fs-xs); }
    .tx-enter { flex: none; color: var(--accent); font-size: var(--fs-l); line-height: 1; }`,
    ops: [["script", render({ mode: "drill", place: "replace", hideDetails: true })]] },
  { key: "E", name: "E 深さを色の帯で（全て開いた輪郭。開閉の印なし）", css: BASE + `
    .tx-tree.has-bands .tx-twisty { display: none; }
    .tx-tree.has-bands .tx-row { border-left: calc(3px + var(--depth) * 3px) solid color-mix(in srgb, var(--accent) calc(20% + var(--depth) * 30%), transparent); margin-left: calc(var(--depth) * 10px); }`,
    ops: [["script", render({ mode: "tree", place: "replace", bands: true, openAll: true, hideDetails: true })]] },
  { key: "F", name: "F サブ組立ごとの見出しで部品表を分ける（入れ子は 1 段）", css: BASE + `
    .tx-groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .tx-group-head { display: flex; justify-content: space-between; padding: 4px 6px; border-radius: 6px; background: var(--surface-2); font-size: var(--fs-s); font-weight: 600; }
    .tx-group .tx-twisty { display: none; }`,
    ops: [["script", render({ mode: "groups", place: "replace", hideDetails: true })]] },
  // ---- 2 回目（B と C が僅差: 複合 3 案）----
  { key: "G", name: "G B ＋ 行ごとの表示の切り替え（線画の目。常に見せる）", css: BASE + SWITCH + EYES,
    ops: [["script", render({ mode: "tree", place: "replace", switcher: true, openAll: true, eyeIcon: true, hideOne: true, hideDetails: true })]] },
  { key: "H", name: "H B ＋ 親子の線 ＋ 目はカーソルの行と消した行だけ", css: BASE + SWITCH + GUIDES + EYES + HOVER_EYES,
    ops: [["script", render({ mode: "tree", place: "replace", switcher: true, guides: true, openAll: true, eyeIcon: true, hideOne: true, hideDetails: true })]] },
  { key: "I", name: "I B ＋ 親子の線 ＋ 目（常に）＋ すべて開く・閉じる・表示", css: BASE + SWITCH + GUIDES + EYES + BULK,
    ops: [["script", render({ mode: "tree", place: "replace", switcher: true, guides: true, openAll: true, eyeIcon: true, bulk: true, hideOne: true, hideDetails: true })]] },
];
