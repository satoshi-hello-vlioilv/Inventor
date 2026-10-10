// 2026-11（寸法の欄の Inventor での名前）: 変換データの寸法の欄で、各寸法が Inventor で作った部品のどの名前つきの値（パラメータ）になるかを出す。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-dimnames.mjs --states dimedit,dimedit-plate
// 今の画面（寸法の欄。案 H の小さな断面図と札）の画像で見えたこと:
// ① 寸法の欄で直した値が、Inventor で作った部品のどのパラメータ（D0_0・t・C0 …）になるかが分からない。
//    Inventor で直そうとすると、パラメータの表（d0, d1 … と名前つきの値の並び）から当てずっぽうで探すことになる
// ② 向かいの辺（参照寸法）と、形を保って拡大・縮小（Inventor に対応する値が無い）は、Inventor では直せないが、欄ではほかの寸法と同じに見える
// ③ 欄の幅は 388 px。名前・数の欄・単位・元の値（← 240）で、1 行の横はほぼ埋まっている
// 名前は convert/parametric.js の inventorNames。行の .dim-inv（名前つきの値は名前・参照寸法は「参照」・対応なしは「—」）と
// 一覧の上の #dim-inventor（名前つきの値の要約）を、今の画面では出さずに置いてあり、案ごとに出し方を変える。点数は 2026-11-dimnames.json

// 行は直すたびに描き直すので、組み替えは描き直しを見張って当て直す
const WATCH = (target, fn) => `
  const run = ${fn};
  const box = document.getElementById("${target}");
  new MutationObserver(() => run()).observe(box, { childList: true, subtree: true, characterData: true });
  run();`;

const CHIP = `
  .dim-inv { display: inline-block; margin-inline-start: 6px; padding: 0 6px; border-radius: 5px; vertical-align: 1px;
    font: 500 var(--fs-xs)/1.5 var(--font-num); color: var(--accent); background: var(--accent-soft); }
  .dim-inv[data-kind="driven"], .dim-inv[data-kind="none"] { color: var(--muted); background: var(--surface-2); font-family: var(--font-ui); }
`;
const SUMMARY = `
  .dim-inv-summary:not([hidden]) { display: block; margin: 2px 0 6px; padding: 6px 10px; border-radius: 8px; background: var(--surface-2);
    font-size: var(--fs-xs); color: var(--muted); }
`;

export const PROPOSALS = [
  { key: "N", name: "今の画面（名前を出さない）", css: "", ops: [] },
  {
    key: "A",
    name: "名前の横に札（名前つきの値は青・参照と対応なしは灰色）",
    css: CHIP,
    ops: [],
  },
  {
    key: "B",
    name: "行の右端に名前の列（元の値の後ろ）",
    css: `
      .dim-row { grid-template-columns: minmax(0, 1fr) auto 50px 52px; }
      .dim-row > .dim-inv { display: block; justify-self: end; font: 500 var(--fs-xs)/1.4 var(--font-num); color: var(--accent); }
      .dim-row > .dim-inv[data-kind="driven"], .dim-row > .dim-inv[data-kind="none"] { color: var(--muted); font-family: var(--font-ui); }
      .dim-row .dim-error { grid-column: 1 / -1; }
    `,
    ops: [["script", WATCH("dim-groups", `() => {
      for (const row of document.querySelectorAll("#dim-groups .dim-row")) {
        const tag = row.querySelector(".dim-label .dim-inv");
        if (tag) row.querySelector(".dim-was").after(tag);
      }
    }`)]],
  },
  {
    key: "C",
    name: "名前の下の 2 段目に「Inventor: D0_0」",
    css: `
      .dim-inv { display: block; font-size: var(--fs-xs); color: var(--muted); }
      .dim-inv::before { content: "Inventor: "; }
      .dim-inv[data-kind="param"] { font-family: var(--font-num); color: var(--accent); }
      .dim-inv[data-kind="param"]::before { font-family: var(--font-ui); color: var(--muted); }
      .dim-inv[data-kind="driven"]::after { content: "寸法（直せません）"; }
      .dim-inv[data-kind="none"] { display: none; }
    `,
    ops: [],
  },
  {
    key: "D",
    name: "断面図の札にだけ名前（光っている寸法の「直径 250 · D0_0」）",
    css: "",
    ops: [["script", WATCH("dim-sketch", `() => {
      const row = document.querySelector("#dim-groups .dim-row.is-focus");
      const tag = row?.querySelector(".dim-inv[data-kind='param']");
      const text = document.querySelector("#dim-sketch svg text:last-of-type");
      if (!tag || !text || text.textContent.includes(" · ")) return;
      text.textContent = text.textContent + " · " + tag.textContent;
      const rect = text.previousElementSibling;
      if (rect?.tagName === "rect") rect.setAttribute("width", String(Number(rect.getAttribute("width")) + 7 * (tag.textContent.length + 3)));
    }`)]],
  },
  {
    key: "E",
    name: "一覧の上に要約の 1 行（名前つきの値の一覧）だけ",
    css: SUMMARY,
    ops: [],
  },
  {
    key: "F",
    name: "要約の 1 行＋名前の横の札（E＋A）",
    css: SUMMARY + CHIP,
    ops: [],
  },
  // 2 回目（1 回目は A と F が僅差）: A を元に、F・D の良い所と、A の弱い所（対応なしの「—」が分かりにくい）を直した複合案 3 つ
  {
    key: "G",
    name: "A′ 札は名前つきの値と参照だけ。対応なしは説明の行に理由",
    css: CHIP + `
      .dim-inv[data-kind="none"] { display: none; }
      .dim-row[data-id="S"] .dim-label small::after { content: "・Inventor では各寸法を同じ割合で直します"; }
      .dim-row[data-id="a"] .dim-label::after { content: "Inventor に角度の値はありません（一周）"; display: block; font-size: var(--fs-xs); color: var(--muted); }
    `,
    ops: [],
  },
  {
    key: "H",
    name: "A＋短い要約（取り消しの帯に「Inventor の値 5」の札）",
    css: CHIP + `
      .dim-bar .dim-inv-summary:not([hidden]) { display: inline-block; margin: 0; padding: 1px 8px; border-radius: 99px; font-size: var(--fs-xs);
        color: var(--accent); background: var(--accent-soft); white-space: nowrap; }
    `,
    ops: [["script", WATCH("dim-groups", `() => {
      const s = document.getElementById("dim-inventor");
      const bar = document.querySelector(".dim-bar .dim-count");
      if (!s || !bar) return;
      if (s.parentElement !== bar.parentElement) bar.after(s);
      const n = document.querySelectorAll("#dim-groups .dim-inv[data-kind='param']").length;
      const text = "Inventor の値 " + n;
      if (s.textContent !== text) { s.title = s.textContent; s.textContent = text; }
    }`)]],
  },
  {
    key: "I",
    name: "A＋断面図の札にも名前（光っている寸法）",
    css: CHIP,
    ops: [["script", WATCH("dim-sketch", `() => {
      const row = document.querySelector("#dim-groups .dim-row.is-focus");
      const tag = row?.querySelector(".dim-inv[data-kind='param']");
      const text = document.querySelector("#dim-sketch svg text:last-of-type");
      if (!tag || !text || text.textContent.includes(" · ")) return;
      text.textContent = text.textContent + " · " + tag.textContent;
      const rect = text.previousElementSibling;
      if (rect?.tagName === "rect") rect.setAttribute("width", String(Number(rect.getAttribute("width")) + 7 * (tag.textContent.length + 3)));
    }`)]],
  },
];
