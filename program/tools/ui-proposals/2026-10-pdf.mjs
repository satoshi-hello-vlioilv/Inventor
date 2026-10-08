// 2026-10（PDF の図面）: PDF を開けるようにした基本形（ページ = レイアウトのタブ）を画像で評価して見つけた問題への改良案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-pdf.mjs --states pages,pdf3d-sheet
// 見つけた問題（基本形の画像から。状態 pages = 試験用に作った 40 ページの図面）:
// ① ページのタブが 40 個並び、ツールバーが 3 行に折り返す（「線の太さ」「全体表示」が下の行へ押し出され、図面の上に重なる）
// ② いま何ページ目か・全部で何ページかが、タブの列からは読み取りにくい（右の欄の「ページ 1（全 40）」まで目を動かす）
// ③ 前・次のページへ移る操作が無い（タブを探して押す。Hick の法則: 選択肢が 40 個）
// ④ 3D を含む PDF の図面のタブで、ツールバーが紙の上端に重なる（全体表示が、上に重ねた帯の高さを空けない）
// 「現状」は比べるための今の画面（案ではない）。点数は 2026-10-pdf.json、決めたことは docs/ui.md。

const join = (...parts) => ({ css: parts.map((p) => p.css).join("\n"), ops: parts.flatMap((p) => p.ops) });

// ページの一覧（今の #layout-tabs のボタンから読む。2 ページ未満なら、どの案も出さない）
const PAGES = `const tabs = [...document.querySelectorAll("#layout-tabs button")];
  const labels = tabs.map((b) => b.textContent);
  const cur = Math.max(0, tabs.findIndex((b) => b.getAttribute("aria-current") === "true"));
  const many = labels.length >= 2;`;
// 案の組み替えは、ファイルを開くたび（タブが変わるたび）に当て直す。足した要素には .pv（と組み替えごとの印 key）を付け、当て直す前に外す。
// タブを隠す案は #app に data-pager を付ける（CSS で隠す。タブの属性を変えると、見張りが自分の変更で回り続ける）
const install = (body, key = "pv") => ["script", `const run = () => { ${PAGES}
    document.querySelectorAll(".pv.${key}").forEach((n) => n.remove());
    document.getElementById("app").toggleAttribute("data-pager", many);
    if (many) { ${body} } };
  new MutationObserver(run).observe(document.getElementById("layout-tabs"), { childList: true, subtree: true, attributeFilter: ["aria-current"] });
  run();`];
const HIDE_TABS = `.app[data-pager] #layout-tabs { display: none; }`;
// 送りのボタン（‹ 何ページ目 / 全ページ ›）。中央は押すとページを選べる（見た目の試作）
const pager = (cls) => `\`<div class="tool-group pager pv ${cls}" role="group" aria-label="ページ">
  <button type="button" title="前のページ（PageUp）">‹</button>
  <button type="button" class="pager-now" title="押すとページを選ぶ">\${labels[cur]} <small>/ \${labels.length}</small> <span class="caret">▾</span></button>
  <button type="button" title="次のページ（PageDown）">›</button></div>\``;
const PAGER_CSS = `.pager button { min-width: 36px; font-variant-numeric: tabular-nums; }
  .pager .pager-now { min-width: 96px; font-weight: 600; color: var(--ink); }
  .pager .pager-now small { color: var(--muted); font-weight: 400; font-size: var(--fs-s); }
  .pager .caret { color: var(--muted); font-size: 10px; margin-inline-start: 4px; }`;

// A ツールバーのページ送り: タブの代わりに ‹ 1 / 40 › を置く（ツールバーは 1 行に収まる）
const TOOLBAR_PAGER = {
  css: `${PAGER_CSS} ${HIDE_TABS}`,
  ops: [install(`document.getElementById("layout-tabs").insertAdjacentHTML("beforebegin", ${pager("")});`)],
};
// B 下中央のページ送り（PDF を読むソフトの見立て）: 図面の下の中央に浮かべる。ツールバーは道具だけ
const BOTTOM_PAGER = {
  css: `${PAGER_CSS} ${HIDE_TABS}
    .pager.is-float { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 3; }`,
  ops: [install(`document.getElementById("stage").insertAdjacentHTML("beforeend", ${pager("is-float")});`)],
};
// C 左のページの帯: 図面の左に、ページの番号を縦に並べる（スクロール。いまのページに印）
const LEFT_RAIL = {
  css: `.page-rail { position: absolute; left: 12px; top: 60px; bottom: 64px; width: 56px; z-index: 3; display: flex; flex-direction: column; gap: 2px;
      overflow-y: auto; padding: 6px; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow-1); }
    .page-rail button { font: 500 var(--fs-s)/1 var(--font-num); padding: 7px 0; border: 0; border-radius: 6px; background: none; color: var(--ink); }
    .page-rail button[aria-current="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .page-rail b { font: 600 var(--fs-xs)/1 var(--font-ui); color: var(--muted); text-align: center; padding: 4px 0 6px; }
    ${HIDE_TABS}`,
  ops: [install(`document.getElementById("stage").insertAdjacentHTML("beforeend", '<nav class="page-rail pv" aria-label="ページ"><b>全 ' + labels.length + '</b>' +
        labels.map((l, i) => '<button type="button" aria-current="' + (i === cur) + '">' + l + '</button>').join("") + '</nav>');`)],
};
// D 右の欄のページの升目: 「図面」の欄の下に、ページの番号を升目で（押すと移る）。ツールバーは ‹ › だけ
const PANEL_GRID = {
  css: `${PAGER_CSS}
    .page-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
    .page-grid button { font: 500 var(--fs-s)/1 var(--font-num); padding: 7px 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); }
    .page-grid button[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    ${HIDE_TABS}`,
  ops: [install(`document.getElementById("layout-tabs").insertAdjacentHTML("beforebegin", ${pager("")});
      document.getElementById("layers").closest(".card").insertAdjacentHTML("beforebegin", '<section class="card pv"><h2>ページ<span class="h-note">押すと移る（全 ' +
        labels.length + '）</span></h2><div class="page-grid">' + labels.map((l, i) => '<button type="button" aria-current="' + (i === cur) + '">' + l + '</button>').join("") +
        '</div></section>');`)],
};
// E タブを 1 行に: 収まらないタブは横にスクロールし、両端に ‹ ›（ツールバーは 1 行）
const SCROLL_TABS = {
  css: `#layout-tabs { flex-wrap: nowrap; max-width: min(56%, 760px); overflow-x: auto; scrollbar-width: none; }
    #layout-tabs button { flex: none; }
    .tab-arrow { pointer-events: auto; }`,
  ops: [install(`const t = document.getElementById("layout-tabs");
      t.insertAdjacentHTML("beforebegin", '<div class="tool-group tab-arrow pv"><button type="button" title="前のページ">‹</button></div>');
      t.insertAdjacentHTML("afterend", '<div class="tool-group tab-arrow pv"><button type="button" title="次のページ">›</button></div>');`)],
};
// F 下のシートのタブ（AutoCAD のレイアウトのタブの見立て）: ページのタブを図面の下の端に 1 行で（横にスクロール）。読み出しはその上
const BOTTOM_TABS = {
  css: `.app[data-pager] #layout-tabs { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 3; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: thin; }
    .app[data-pager] #layout-tabs button { flex: none; }
    .app[data-pager].is-drawing .readout { bottom: 62px; }`,
  ops: [install(`document.getElementById("stage").append(document.getElementById("layout-tabs"));`)],
};

// 2 回目（複合案）の部品
// 升目の吹き出し: 送りの中央（1 / 40 ▾）を押すと、ページの番号の升目がその下に開く（画像では開いた様子を撮る）
const POPOVER = {
  css: `.page-pop { position: absolute; top: 56px; left: 12px; z-index: 4; width: 340px; padding: 10px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px;
      background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; box-shadow: var(--shadow-2, 0 8px 24px rgb(0 0 0 / 0.16)); }
    .page-pop button { font: 500 var(--fs-s)/1 var(--font-num); padding: 7px 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); }
    .page-pop button[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 700; }`,
  ops: [install(`document.getElementById("stage").insertAdjacentHTML("beforeend", '<div class="page-pop pv pop" role="dialog" aria-label="ページを選ぶ">' +
      labels.map((l, i) => '<button type="button" aria-current="' + (i === cur) + '">' + l + '</button>').join("") + '</div>');`, "pop")],
};
// 欄に畳んだ升目: 右の欄に「ページ（全 40）」を畳んで置く（開くと升目）
const FOLDED_GRID = {
  css: `.page-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; margin-top: 8px; }
    .page-grid button { font: 500 var(--fs-s)/1 var(--font-num); padding: 7px 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); }
    .page-grid button[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 700; }`,
  ops: [install(`document.getElementById("layers").closest(".card").insertAdjacentHTML("beforebegin", '<details class="card more pv fold"><summary>ページ<span class="h-note">全 ' +
      labels.length + '・押すと移る</span></summary><div class="page-grid">' + labels.map((l, i) => '<button type="button" aria-current="' + (i === cur) + '">' + l +
      '</button>').join("") + '</div></details>');`, "fold")],
};
// 少ないページ（レイアウト）はタブのまま: 8 つまではタブ（名前が見え、1 回で移れる）、9 つからは送り
const ADAPTIVE = {
  css: `${PAGER_CSS} .app[data-pager-many] #layout-tabs { display: none; }`,
  ops: [["script", `const run = () => { ${PAGES}
    document.querySelectorAll(".pv").forEach((n) => n.remove());
    const pager = labels.length > 8;
    document.getElementById("app").toggleAttribute("data-pager-many", pager);
    if (pager) document.getElementById("layout-tabs").insertAdjacentHTML("beforebegin", ${pager("")}); };
  new MutationObserver(run).observe(document.getElementById("layout-tabs"), { childList: true, subtree: true, attributeFilter: ["aria-current"] });
  run();`]],
};

export const PROPOSALS = [
  { key: "0", name: "現状", css: "", ops: [] },
  { key: "A", name: "A ツールバーのページ送り", ...TOOLBAR_PAGER },
  { key: "B", name: "B 下中央のページ送り", ...BOTTOM_PAGER },
  { key: "C", name: "C 左のページの帯", ...LEFT_RAIL },
  { key: "D", name: "D 右の欄のページの升目＋送り", ...PANEL_GRID },
  { key: "E", name: "E タブを 1 行（スクロール）", ...SCROLL_TABS },
  { key: "F", name: "F 下のシートのタブ", ...BOTTOM_TABS },
  // 2 回目: 1 回目の上位 2 案（A・D）と、複合案 3 つ
  { key: "G", name: "G A＋升目の吹き出し", ...join(TOOLBAR_PAGER, POPOVER) },
  { key: "H", name: "H A＋欄に畳んだ升目", ...join(TOOLBAR_PAGER, FOLDED_GRID) },
  { key: "I", name: "I A＋少ないときはタブ", ...ADAPTIVE },
];
