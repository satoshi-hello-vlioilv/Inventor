// 2026-10（階層）: 右の欄の情報の階層（何を先に・大きく・畳むか）の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-hierarchy.mjs --states ipt,asm,drawing,done
// 今の画面の画像で見えたこと（ig: 全状態）:
// ① 部品を開くと、欄の一番上は「ファイルの情報 ASM 231.3.1.65535 NT · 日付」。部品が何か（大きさ・質量）より、価値の低い技術情報が先に来る
// ② 節の見出しが全て同じ重さ（14px 太字）で、細い線で区切るだけ。「要点」と「詳しく」の段が無く、欄全体が 1 本の平らな一覧に見える
// ③ 組立の例外（見つからない部品 2 種類）は、上の数の札にしか出ず、行そのものは欄の下（スクロールの先）にある
// 案の中身（数・文言）は同じ。違うのは、並べる順・大きさ・畳み方・面の重ね方だけ。点数は 2026-10-hierarchy.json、決めたことは docs/ui.md。

const card = {
  file: ".side-scroll > .file-card",
  dims: ".side-scroll > section:has(#dims)",
  mass: "#mass-card",
  features: ".side-scroll > section:has(#features)",
  bom: ".side-scroll > section:has(#bom)",
  missing: "#missing-section",
  info: ".side-scroll > section:has(#drawing-info)",
  layers: ".side-scroll > section:has(#layers)",
  more: ".side-scroll > details.more",
};
// 技術的なファイルの情報を一番下へ・小さく（どの案にも入れてよい部品）
const FILE_LAST = `${card.file} { order: 99; padding-block: 10px; } ${card.file} .thumb { width: 40px; height: 40px; } ${card.more} { order: 98; }`;

// A 要点を先頭に: 外形寸法を一番上に大きな数で、材質・質量をその下に 1 行で。ファイルの情報は一番下
const SUMMARY_FIRST = {
  css: `${FILE_LAST}
    ${card.dims} { order: -2; } ${card.mass} { order: -1; }
    ${card.dims} .dims dd { font-size: var(--fs-xl); font-weight: 600; }
    ${card.mass} .topology { grid-template-columns: auto 1fr auto 1fr; }`,
  ops: [],
};

// B 見出しの 3 段: 節の見出しは小さく退かせ（ラベル）、値を前に出す。節の間は線でなく余白で区切る
const TYPE_LEVELS = {
  css: `.side-scroll > .card { box-shadow: none; padding-block: 12px 18px; }
    .side-scroll > .card + .card { border-top: 6px solid var(--surface-2); }
    .card h2 { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; color: var(--muted); }
    .card h2 .h-note { letter-spacing: 0; }
    .dims dd { font-size: var(--fs-xl); }
    .feature .dim { font-weight: 600; }
    .topology dd { color: var(--ink); font-weight: 500; }`,
  ops: [],
};

// C 段階的な開示: 節の見出しを押すと畳める。情報の節（寸法・材質・図面の情報）は畳んだ見出しに要点を 1 行で出し、一覧の節だけ開いておく
const FOLD = {
  css: `.card h2.fold { cursor: pointer; } .card h2.fold::before { content: "▾"; color: var(--muted); font-size: 10px; margin-inline-end: 2px; }
    .card.is-folded h2.fold::before { content: "▸"; }
    .card.is-folded > :not(h2) { display: none !important; }
    .fold-sum { font: 500 var(--fs-s) var(--font-num); color: var(--ink); margin-inline-start: auto; }
    .card h2.fold { width: 100%; }`,
  ops: [["script", `const run = () => {
    document.querySelectorAll(".side-scroll > section.card").forEach((sec) => {
      const h = sec.querySelector(":scope > h2"); if (!h) return;
      if (!h.classList.contains("fold")) { h.classList.add("fold"); h.addEventListener("click", () => sec.classList.toggle("is-folded")); }
      h.querySelector(".fold-sum")?.remove();
      const dl = sec.querySelector(":scope > dl.dims, :scope > dl.topology");
      const isInfo = !!dl && !sec.querySelector(".features");
      sec.classList.toggle("is-folded", isInfo);
      if (isInfo) {
        const dd = [...dl.querySelectorAll("dd")].map((d) => d.textContent.trim()).filter(Boolean);
        const sum = dl.classList.contains("dims") ? dd.join(" × ") : (dd.find((t) => /g$|mm|R\\d|PDF|DXF|DWG|JWW/.test(t)) ?? dd[0] ?? "");
        h.insertAdjacentHTML("beforeend", '<span class="fold-sum">' + sum + '</span>');
      }
    }); };
    let t; new MutationObserver(() => { clearTimeout(t); t = setTimeout(run, 80); }).observe(document.getElementById("side-scroll"), { childList: true, subtree: true, characterData: true });
    run();`]],
};

// D 例外を先に: 見つからない部品・近似の注記など「目を向けるもの」を一番上に琥珀の囲みで。ファイルの情報は一番下
const EXCEPTIONS_FIRST = {
  css: `${FILE_LAST}
    ${card.missing} { order: -3; margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: var(--warn-soft); box-shadow: none; }
    ${card.missing} .feature { border-bottom-color: color-mix(in srgb, var(--warn) 30%, transparent); }`,
  ops: [],
};

// E 概要と一覧のタブ: 欄の上に「概要｜一覧」。概要は寸法・材質・図面の情報・数の札、一覧は形状要素・部品表・画層
const TABS = {
  css: `.side-tabs { position: sticky; top: 0; z-index: 2; display: flex; gap: 4px; padding: 10px 0 8px; background: var(--surface); border-bottom: 1px solid var(--rule); }
    .side-tabs span { padding: 6px 14px; border-radius: 7px; font: 600 var(--fs-s)/1 var(--font-ui); color: var(--muted); }
    .side-tabs span[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }
    .side-scroll[data-tab="list"] > .card:not(:has(.features)):not(.side-tabs) { display: none; }
    .side-scroll[data-tab="list"] > details.more { display: none; }`,
  ops: [["script", `const side = document.getElementById("side-scroll");
    const run = () => {
      const hasList = !!side.querySelector(".card:not([hidden]) .features:not(:empty)");
      const hasInfo = !!side.querySelector(".card:not([hidden]) dl:not(:empty)");
      side.querySelector(".side-tabs")?.remove();
      if (!(hasList && hasInfo)) { side.removeAttribute("data-tab"); return; }
      side.dataset.tab = "list";
      side.insertAdjacentHTML("afterbegin", '<div class="side-tabs pv" role="tablist"><span>概要</span><span aria-selected="true">一覧</span></div>');
    };
    let t; new MutationObserver((m) => { if (m.every((r) => [...r.addedNodes].some((n) => n.classList?.contains("side-tabs")))) return; clearTimeout(t); t = setTimeout(run, 80); })
      .observe(side, { childList: true, subtree: true });
    run();`]],
};

// F 2 層の面: 「要点」（寸法・材質・図面の情報）を淡い地の囲みにまとめて上に、一覧はその下の白い面に。ファイルの情報は一番下
const LAYERS2 = {
  css: `${FILE_LAST}
    ${card.dims}, ${card.mass}, ${card.info} { order: -2; background: var(--surface-2); box-shadow: none; padding: 12px 14px; margin-inline: -4px; }
    ${card.dims} { margin-top: 12px; border-radius: 10px 10px 0 0; } ${card.mass} { border-radius: 0 0 10px 10px; margin-bottom: 6px; padding-top: 0; }
    ${card.info} { margin-top: 12px; border-radius: 10px; margin-bottom: 6px; }
    ${card.dims} .dims div { background: var(--surface); }`,
  ops: [],
};

// ---- 2 回目（1 回目は D 84.5・F 82.5 で僅差。D は順、F は面を直すので重ねられる） ----
const join = (...ps) => ({ css: ps.map((p) => p.css).join("\n"), ops: ps.flatMap((p) => p.ops) });
const BIG_DIMS = { css: `${card.dims} .dims dd { font-size: var(--fs-xl); font-weight: 600; }`, ops: [] };

export const PROPOSALS = [
  { key: "base", name: "現状", css: "", ops: [] },
  { key: "A", name: "A 要点を先頭に", ...SUMMARY_FIRST },
  { key: "B", name: "B 見出しの 3 段", ...TYPE_LEVELS },
  { key: "C", name: "C 畳んで要点を見出しに", ...FOLD },
  { key: "D", name: "D 例外を先に", ...EXCEPTIONS_FIRST },
  { key: "E", name: "E 概要と一覧のタブ", ...TABS },
  { key: "F", name: "F 要点の面を重ねる", ...LAYERS2 },
  { key: "G", name: "G 例外を先に＋要点の面", ...join(EXCEPTIONS_FIRST, LAYERS2) },
  { key: "H", name: "H G＋見出しの 3 段", ...join(EXCEPTIONS_FIRST, LAYERS2, TYPE_LEVELS) },
  { key: "I", name: "I G＋寸法を大きな数で", ...join(EXCEPTIONS_FIRST, LAYERS2, BIG_DIMS) },
];
