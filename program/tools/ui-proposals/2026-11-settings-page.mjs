// 2026-11（設定のページ）: 右の引き出しだった設定を、メインの画面を切り替える大きなページにする（利用者の依頼: 一時的な画面ではなく、
// いろいろな機能を足していける広さと拡張性）。ページの置き方の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-settings-page.mjs --states settings,settings-versions,settings-share
// 今の画面（右の引き出し。2.4.0）の画像で見えたこと:
// ① 1536×864 では「役割」が下で切れる（巻物が要る）。区分を足すほど縦に伸びるだけで、目次が無い
// ② 引き出しの幅に収めるため、版の表の「置いた人・元の ZIP」の列を隠し、変わったことは 1 行目を「…」で切っている
// ③ 置き場の道が 2 行に折れる。この PC のこと（ショートカット）と配布の管理（版・置き場・役割）が 1 列に混ざる
// ④ 後ろの 3D は暗くした 64% の幅を占めるだけで、何にも使っていない
// 案の中身はどれも同じ（区分: 概要・ショートカット・版・置き場・役割。ui/settings/panes.js）。違うのは区分の並べ方と移り方だけ。
// A を基本の形として作り（ui/settings.js）、ほかの案は CSS と組み替えで再現する。点数は 2026-11-settings-page.json、決めたことは docs/ui.md §20

// 区分を選ぶたびに描き直すので、案の組み替えは描き直しを見張って当て直す
const WATCH = (fn) => `
  const run = ${fn};
  const body = document.getElementById("settings-body");
  new MutationObserver(() => run()).observe(body, { childList: true });
  run();`;

export const PROPOSALS = [
  {
    key: "A",
    name: "左の目次（まとまり・状態つき）＋区分ごとの中身",
    css: "",
    ops: [],
  },
  {
    key: "B",
    name: "上のタブ＋区分ごとの中身（幅を全て中身に）",
    css: `
      .settings { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .settings-nav { flex-direction: row; align-items: center; gap: 18px; padding: 8px 24px; border-inline-end: 0; border-bottom: 1px solid var(--rule); overflow: visible; }
      .settings-back { align-self: center; }
      #settings-nav { flex-direction: row; gap: 18px; }
      .st-nav-group { flex-direction: row; align-items: center; gap: 4px; padding-inline-start: 18px; border-inline-start: 1px solid var(--rule); }
      .st-nav-label { margin: 0 6px 0 0; padding: 0; }
      .st-nav-item { width: auto; grid-template-columns: 18px auto; padding: 6px 12px; }
      .st-nav-item[aria-current="page"] { box-shadow: inset 0 -3px 0 var(--accent); }
      .st-nav-badge { display: none; }
    `,
    ops: [],
  },
  {
    key: "C",
    name: "1 枚の巻物（全ての区分を縦に）＋左の目次で飛ぶ",
    css: `
      .settings-head h2, .settings-lead { display: none; }
      .st-sec-head { margin: 22px 0 0; font-size: var(--fs-xl); font-weight: 600; }
      .st-sec-head:first-child { margin-top: 0; }
      .st-sec-lead { margin: -10px 0 0; font-size: var(--fs-s); color: var(--muted); }
    `,
    ops: [["script", WATCH(`() => {
      const body = document.getElementById("settings-body");
      if (!body.firstChild || body.firstChild.dataset.composed) return;
      const current = body.firstChild.dataset.pane;
      const all = document.createElement("div");
      all.dataset.composed = "1";
      all.className = "st-pane";
      for (const b of document.querySelectorAll("#settings-nav .st-nav-item")) {
        b.click();
        const h = Object.assign(document.createElement("h2"), { className: "st-sec-head", textContent: b.querySelector("b").textContent });
        h.dataset.sec = b.dataset.pane;
        const lead = Object.assign(document.createElement("p"), { className: "st-sec-lead", textContent: document.getElementById("settings-lead").textContent });
        all.append(h, lead, ...body.firstChild.cloneNode(true).childNodes);
      }
      body.replaceChildren(all);
      for (const b of document.querySelectorAll("#settings-nav .st-nav-item")) b.toggleAttribute("aria-current", b.dataset.pane === current);
      const target = all.querySelector('[data-sec="' + current + '"]');
      const main = document.getElementById("settings-main");
      main.scrollTop = target && current !== "overview" ? target.offsetTop - main.offsetTop - 8 : 0;
    }`)]],
  },
  {
    key: "D",
    name: "区分の升目から入る（目次なし。区分の中では「設定の一覧へ」）",
    css: `
      .settings { grid-template-columns: minmax(0, 1fr); position: relative; }
      .settings-nav { position: absolute; left: 24px; top: 14px; padding: 0; border: 0; background: none; z-index: 1; }
      #settings-nav { display: none; }
      .settings-main { padding-top: 58px; }
      .st-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
      .st-tiles .st-nav-item { padding: 18px 18px; border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); grid-template-columns: 28px minmax(0, 1fr); }
      .st-tiles .st-nav-item svg { width: 26px; height: 26px; }
      .st-tiles .st-nav-item b { font-size: var(--fs-l); }
      .st-tiles .st-nav-item[aria-current] { box-shadow: none; background: var(--surface); }
      .st-tiles .st-nav-item[aria-current] b { color: var(--ink); }
      .st-crumb { color: var(--accent); }
    `,
    ops: [["script", WATCH(`() => {
      const body = document.getElementById("settings-body");
      const pane = body.firstChild?.dataset.pane;
      const eyebrow = document.querySelector(".settings-head .eyebrow");
      if (!pane) return;
      eyebrow.innerHTML = pane === "overview" ? "設定" : '<span class="st-crumb">設定</span> ›';
      if (pane !== "overview" || body.querySelector(".st-tiles")) return;
      const tiles = document.createElement("div");
      tiles.className = "st-tiles";
      for (const b of document.querySelectorAll("#settings-nav .st-nav-item")) if (b.dataset.pane !== "overview") tiles.append(b.cloneNode(true));
      body.firstChild.querySelector(".st-cards")?.replaceWith(tiles);
    }`)]],
  },
  {
    key: "E",
    name: "左の目次＋中身を 2 列のカードに（表は全幅）",
    css: `
      .st-pane { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
      .st-pane > .st-cards, .st-pane > .st-bar, .st-pane > .st-block:has(table), .st-pane > .st-block:has(.st-tree), .st-pane > .st-form { grid-column: 1 / -1; }
      .settings-main > * { max-width: none; }
    `,
    ops: [],
  },
  {
    key: "F",
    name: "細い帯（印と名前だけ）＋広い中身",
    css: `
      .settings { grid-template-columns: 96px minmax(0, 1fr); }
      .settings-nav { padding: 10px 6px; align-items: stretch; }
      .settings-back { flex-direction: column; align-self: stretch; padding: 6px 4px; font-size: var(--fs-xs); }
      .settings-back kbd { display: none; }
      .st-nav-label { display: none; }
      .st-nav-group { gap: 4px; padding-top: 8px; border-top: 1px solid var(--rule); }
      .st-nav-item { grid-template-columns: 1fr; justify-items: center; text-align: center; gap: 4px; padding: 8px 4px; }
      .st-nav-text b { font-size: var(--fs-xs); }
      .st-nav-badge { font-size: 0; justify-content: center; }
      .st-nav-item[aria-current="page"] { box-shadow: inset 3px 0 0 var(--accent); }
      .settings-main > * { max-width: 1320px; }
    `,
    ops: [],
  },
];
