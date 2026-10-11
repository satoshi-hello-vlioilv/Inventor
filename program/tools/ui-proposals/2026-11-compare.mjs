// 2026-11（図面の旧版と新版を比べる）: 図面を開いて旧版を選んだとき、違い（変わった・足した・消した）をどう見せると、見落とさずに
// 早く把握でき、気になる違いへすぐ寄れるか。状態は compare（A1 の図面 = 新版に、旧版を選んだ直後。変わった 3・足した 2・消した 1）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-compare.mjs --states compare
// 今の画面（土台: 新しい機能なので、まず素直に作った形）で見えたこと:
// ① 違いは色で分かるが、大きな図面の中の小さな印（穴の円・ねじ穴・面取りの線）は、図のどこにあるかを探す
// ② 変わった穴は、前の形（淡い赤）と後の形（琥珀）が重なり、どう変わったかが図では分からない（一覧の「Φ6 → Φ6.6」を読む）
// ③ 色の意味（凡例）は欄の数の札にしかなく、図を見ている目からは遠い
// ④ 一覧の行と図の違いを結ぶのは、行にカーソルを合わせたときの強調だけ
// 案は、土台の切り替え（見せ方・同じ図形を隠す・改訂の印・色を付けない・順に見る）を実際に操作し、CSS と組み替えで置き方を変える。

// 比べ始めたら（帯が出たら）1 度だけ動かす
const WHEN_COMPARING = (body) => `
  const band = document.getElementById("compare-band");
  let done = false;
  const run = () => { if (done || band.hidden) return; done = true; setTimeout(() => { ${body} }, 150); };
  new MutationObserver(run).observe(band, { attributes: true, attributeFilter: ["hidden"] });
  run();`;
const show = (...ids) => ids.map((id) => `document.getElementById("${id}").hidden = false;`).join(" ");
const click = (...ids) => ids.map((id) => `document.getElementById("${id}").click();`).join(" ");

// 一覧を違いのまとまりの番号の順に並べ替える（雲・順に見るのと同じ順。番号の無い行は後ろ）
const SORT_ROWS = `
  const list = document.getElementById("compare-list");
  const no = (li) => Number(li.querySelector(".diff-no")?.textContent) || 1e9;
  list.append(...[...list.children].sort((a, b) => no(a) - no(b)));`;
// 今見ている違い（番号 n）の行を強める
const CURRENT_ROW = (n) => `
  for (const li of document.getElementById("compare-list").children) li.classList.toggle("is-current", li.querySelector(".diff-no")?.textContent === "${n}");`;
// 帯に、今見ている違い（番号 n）が何かを書く（行の種類・図形・値）
const STEP_DETAIL = (n) => `
  const rows = [...document.getElementById("compare-list").querySelectorAll(".diff-row")].filter((b) => b.querySelector(".diff-no")?.textContent === "${n}");
  const say = rows.map((b) => [b.querySelector(".kind").textContent, b.querySelector(".dim").textContent, b.querySelector(".sub")?.textContent].filter(Boolean).join(" ")).join("／");
  const span = Object.assign(document.createElement("span"), { className: "compare-step-detail", textContent: say });
  document.getElementById("compare-step").after(span);`;
// 値を先に（E）: 行の 1 行目に何がどう変わったか、種類と画層は小さく 2 行目
const VALUE_FIRST_CSS = `
  .diff-list .feature { grid-template-columns: minmax(3.6em, max-content) 1fr; row-gap: 0; }
  .diff-list .feature .kind { grid-row: span 2; align-self: start; }
  .diff-list .feature .sub { grid-column: 2; grid-row: 1; font: 600 var(--fs-m) var(--font-num); color: var(--ink); overflow-wrap: anywhere; }
  .diff-list .feature .dim, .diff-list .feature .count { grid-column: 2; grid-row: 2; font-size: var(--fs-xs); color: var(--muted); font-weight: 400; }
  .diff-list .feature .count { justify-self: end; }
  .compare-card.has-numbers .diff-list .feature { grid-template-columns: 1.8em minmax(3.6em, max-content) 1fr; }
  .compare-card.has-numbers .diff-list .feature .sub { grid-column: 3; }
  .compare-card.has-numbers .diff-list .feature .dim, .compare-card.has-numbers .diff-list .feature .count { grid-column: 3; }`;
const CURRENT_CSS = `
  .diff-list li.is-current .feature { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }`;
// 同じ図形を淡く（B のエッセンス: 隠さずに、違いを浮かせる）
const FAINT_SAME_CSS = `
  #stage { --diff-same: #dfe3e8; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) #stage { --diff-same: #2f3843; } }
  :root[data-theme="dark"] #stage { --diff-same: #2f3843; }`;

// 図の上の凡例（数の札を、主役の場所の右下に）
const LEGEND_CSS = `
  #compare-counts { position: absolute; right: 12px; bottom: 14px; z-index: 3; padding: 8px 10px; background: var(--surface); border: 1px solid var(--rule);
    border-radius: 10px; box-shadow: var(--shadow-1); gap: 4px 6px; max-width: 420px; }`;

export const PROPOSALS = [
  {
    key: "A", name: "改訂の印: 違いのまとまりごとに改訂の雲と番号（図面の慣習）を図に描き、一覧の行にも同じ番号",
    css: "",
    ops: [["script", WHEN_COMPARING(`${show("compare-clouds-row")} ${click("compare-clouds")}`)]],
  },
  {
    key: "B", name: "違いだけを見せる: 同じ図形を隠し、違う図形だけを描く（帯の「同じ図形を隠す」で戻せる）",
    css: "",
    ops: [["script", WHEN_COMPARING(`${show("compare-hide-same-row")} ${click("compare-hide-same")}`)]],
  },
  {
    key: "C", name: "順に見る: 帯の「‹ 1 / 5 ›」で違いのまとまりへ 1 つずつ寄り、今の違いに改訂の印。一覧も同じ番号",
    css: "",
    ops: [["script", WHEN_COMPARING(`${show("compare-step")} ${click("compare-next")}`)]],
  },
  {
    key: "D", name: "図の上の凡例: 色の意味と数（変わった・足した・消した・同じ）を図の右下に置き、欄は違いの一覧だけ",
    css: LEGEND_CSS,
    ops: [["move", "#compare-counts", "append", "#stage"]],
  },
  {
    key: "E", name: "値を先に: 一覧の行は「Φ6 → Φ6.6」「文字 …」など何がどう変わったかを大きく、図形の種類と画層は小さく",
    css: `
      .diff-list .feature { grid-template-columns: minmax(3.6em, max-content) 1fr; row-gap: 0; }
      .diff-list .feature .kind { grid-row: span 2; align-self: start; }
      .diff-list .feature .sub { grid-column: 2; grid-row: 1; font: 600 var(--fs-m) var(--font-num); color: var(--ink); overflow-wrap: anywhere; }
      .diff-list .feature .dim, .diff-list .feature .count { grid-column: 2; grid-row: 2; font-size: var(--fs-xs); color: var(--muted); font-weight: 400; }
      .diff-list .feature .count { justify-self: end; }`,
    ops: [],
  },
  {
    key: "F", name: "【方向の違う案】めくり比べ: 色を付けず、帯の「重ねる｜旧版｜新版」で 2 つの版を切り替えて目で比べる（写真は旧版を見ているところ）",
    css: "",
    ops: [["script", WHEN_COMPARING(`${show("compare-views")} document.querySelector('[data-compare-view="older"]').click();`)]],
  },
  {
    key: "G", name: "【方向の違う案】改訂の記録: 図面は色を変えずに改訂の雲と番号だけ、欄は番号ごとの改訂の記録（何がどう変わったか）",
    css: "",
    ops: [["script", WHEN_COMPARING(`${show("compare-plain-row", "compare-clouds-row")} ${click("compare-plain", "compare-clouds")}`)]],
  },
  // ---- 2 回目: 1 回目の上位 3 案（C・A・E）のエッセンスを組み合わせた 4 案 ----
  {
    key: "H", name: "【組合せ】C × A × E: 全ての違いに改訂の雲と番号、帯の「‹ 1 / 4 ›」で番号の順に寄る。一覧は番号の順・値を先に、今の違いの行を強める",
    css: VALUE_FIRST_CSS + CURRENT_CSS,
    ops: [["script", WHEN_COMPARING(`${show("compare-step")} ${click("compare-clouds", "compare-next")} ${SORT_ROWS} ${CURRENT_ROW(1)}`)]],
  },
  {
    key: "I", name: "【組合せ】A × E × D: 見渡す。全ての違いに雲と番号、色の意味と数は図の右下、一覧は番号の順・値を先に（順に見る操作は無し）",
    css: VALUE_FIRST_CSS + LEGEND_CSS,
    ops: [["move", "#compare-counts", "append", "#stage"], ["script", WHEN_COMPARING(`${click("compare-clouds")} ${SORT_ROWS}`)]],
  },
  {
    key: "J", name: "【組合せ】C × B × E: 違いを浮かせて順に見る。同じ図形は淡く、帯の「‹ 1 / 4 ›」の横に今の違いが何か（変わった 寸法 動いた 6 mm）を書く",
    css: VALUE_FIRST_CSS + CURRENT_CSS + FAINT_SAME_CSS + `
      .compare-step-detail { font: 600 var(--fs-s) var(--font-num); color: var(--ink); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
    ops: [["script", WHEN_COMPARING(`${show("compare-step")} ${click("compare-next")} ${SORT_ROWS} ${CURRENT_ROW(1)} ${STEP_DETAIL(1)}`)]],
  },
  {
    key: "K", name: "【組合せ】A × B × E × C: 見渡してから順に。全ての違いに雲と番号、同じ図形は淡く、一覧は番号の順・値を先に。帯に「‹ – / 4 ›」（押すと 1 番へ寄る）",
    css: VALUE_FIRST_CSS + FAINT_SAME_CSS,
    ops: [["script", WHEN_COMPARING(`${show("compare-step")} ${click("compare-clouds")} ${SORT_ROWS}`)]],
  },
];
