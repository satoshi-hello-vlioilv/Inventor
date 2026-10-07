// 2026-10（2 回目の改良）: 作り直した画面を画像で評価して見つけた問題（docs/ui.md の 8 節）への改良案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-improve.mjs --states asm,ipt,html,building,done,mixed
// 「現状」は比べるための今の画面（案ではない）。再現は近似: 配置・目立たせ方・見える量の違いを見るためのもの。
// A・A′ の 3D の色は、比べたときだけの画面の試作（<html data-result-tones="on" / "focus"> のときだけ動く）で塗った。
// 選んだ B×D×A′ は画面に入ったので、今の画面では全ての案で 3D に A′ の色が付く（この定義の attr は効かない。記録として残す）。
// 点数は 2026-10-improve.json、決めたことは docs/ui.md の 8 節。

// 結果の行のうち、部品の行（STEP と組立の行を除く）
const PART_ROWS = `[...document.querySelectorAll("#build-results li")].filter((li) => /^\\d/.test(li.querySelector(".name")?.textContent ?? ""))`;

// 要点を先に: 一致・待ちの行は畳む（例外と、いま作っている部品だけを並べる）
const EXCEPTION_ROWS = `.build-results li:not(:first-child):has(> .verdict:is([data-tone="ok"], [data-tone="wait"])) { display: none; }`;
const EXCEPTIONS_ONLY = {
  css: `${EXCEPTION_ROWS}
        .build-results .is-folded { display: block; padding: 4px 0 0; font-size: var(--fs-s); color: var(--muted); }`,
  ops: [["script", `
    const list = document.getElementById("build-results");
    const paint = () => {
      list.querySelector(".is-folded")?.remove();
      const rows = ${PART_ROWS};
      const ok = rows.filter((li) => li.querySelector(".verdict").dataset.tone === "ok").length;
      const wait = rows.filter((li) => li.querySelector(".verdict").dataset.tone === "wait").length;
      if (!ok && !wait) return;
      const li = document.createElement("li");
      li.className = "is-folded";
      li.textContent = [ok && "一致 " + ok + " 件", wait && "待ち " + wait + " 件"].filter(Boolean).join("・") + " は畳んでいます（すべて表示）";
      list.append(li);
    };
    new MutationObserver(() => { if (!list.querySelector(".is-folded") || list.lastElementChild?.className !== "is-folded") paint(); })
      .observe(list, { childList: true });
    paint();`]],
};

// 要点を先に: 部品の材質・質量を寸法のすぐ下に開いて出す。組立の見つからない部品は部品表の下に短く
const KEY_FACTS = {
  css: `#missing .sub, #missing-hint { display: none; }
        .cc-note { margin: 0; font-size: var(--fs-xs); color: var(--muted); }`,
  ops: [
    ["move", "#side-scroll > details.card.more[data-mode='ipt']:not(.structure)", "after", "#side-scroll > section.card:has(#dims)"],
    ["attr", "#side-scroll > details.card.more[data-mode='ipt']:not(.structure)", "open", ""],
    ["move", "#missing-section", "after", "#side-scroll > section.card:has(#bom)"],
    ["insert", '<p class="cc-note">Content Center の標準部品です。Inventor で .ipt に書き出してドロップすると、組立に加わります</p>', "afterbegin", "#missing-section"],
    ["script", `
      // 見つからない部品が全て Content Center の標準部品なら、加えるボタンは主にしない（この PC では用意できないことが多い）
      const button = document.getElementById("add-missing");
      const paint = () => {
        const rows = [...document.querySelectorAll("#missing .feature")];
        if (rows.length && rows.every((b) => /Content Center/.test(b.querySelector(".sub")?.textContent ?? ""))) button.className = "secondary";
      };
      new MutationObserver(paint).observe(document.getElementById("missing"), { childList: true });
      paint();`],
  ],
};

// 判定の升目: 部品ごとの結果を色の升目で 1 目に（行は畳み、升目に番号）
const GRID = {
  css: `.verdict-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 4px; }
        .verdict-grid span { height: 30px; display: grid; place-items: center; border-radius: 6px; font: 600 var(--fs-xs) var(--font-num);
          color: var(--tone-ink); background: var(--tone-soft); border: 1.5px solid var(--tone); }
        .verdict-grid span[data-tone="ok"] { color: var(--surface); background: var(--ok); }
        .verdict-grid span[data-tone="run"] { color: var(--accent-ink); background: var(--accent); }`,
  ops: [["script", `
    const list = document.getElementById("build-results");
    const grid = document.createElement("div");
    grid.className = "verdict-grid";
    document.getElementById("build-summary").after(grid);
    const paint = () => grid.replaceChildren(...${PART_ROWS}.map((li) => {
      const cell = document.createElement("span");
      cell.dataset.tone = li.querySelector(".verdict").dataset.tone;
      cell.textContent = li.querySelector(".name").textContent.slice(0, 2);
      cell.title = li.title;
      return cell;
    }));
    new MutationObserver(paint).observe(list, { childList: true });
    paint();`]],
};

const VERDICT_GRID = { css: `${GRID.css} .build-results li:not(:first-child) { display: none; }`, ops: GRID.ops };

// 元のページと 3D を切り替える（HTML のとき、元のページを常には並べない）
const SOURCE_TAB = {
  // 元のページは隠さず 3D の下に重ねる（display: none や画面の外にすると、元のページの three.js が描かず、取り込めない）
  css: `.app.is-html { grid-template-columns: minmax(0, 1fr) var(--side-w); grid-template-areas: "bar bar" "stage side"; }
        .app.is-html .source { grid-area: stage; z-index: 0; }
        .app.is-html .stage { z-index: 1; }
        .view-tabs { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 10px; z-index: 2;
          padding: 4px; background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; box-shadow: var(--shadow-1); }
        .app.is-html .view-tabs { display: flex; }
        .view-tabs button { font: 600 var(--fs-s) var(--font-ui); padding: 7px 14px; border: 0; border-radius: 7px; background: none; color: var(--muted); }
        .view-tabs button[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }
        .view-tabs .meta { padding-inline: 4px 10px; }
        .app.is-html .toolbar { top: 64px; }`,
  ops: [
    ["insert", '<div class="view-tabs" role="tablist"><button type="button" role="tab" aria-selected="true">取り込んだ形（3D）</button><button type="button" role="tab">元のページ</button></div>', "afterbegin", "#stage"],
    ["move", "#source-status", "append", ".view-tabs"],
  ],
};

// 静かな画面: 常に出ている操作の説明を消す（必要なときだけ出す）
const QUIET = `.mouse-help, .readout:not(.is-live), .card h2 .h-note, #missing-hint { display: none !important; }`;

// 右の欄をタブに: 概要・部品・結果。状態に合わせて開くタブを選ぶ
const SIDE_TABS = {
  css: `.side-tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--rule); background: var(--surface); }
        .side-tabs button { font: 600 var(--fs-s) var(--font-ui); padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted); }
        .side-tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
        .side-tabs button[hidden] { display: none; }
        .side[data-tab="summary"] #side-scroll > :is(#result-card, section.card:has(#parts), section.card:has(#bom), section.card:has(#features), details.card.more[data-mode="ipt"]),
        .side[data-tab="parts"] #side-scroll > :is(#result-card, .file-card, #unit-card, section.card:has(#dims), #missing-section, .save-card),
        .side[data-tab="result"] #side-scroll > :not(#result-card, .alert, .notice) { display: none !important; }`,
  ops: [
    ["insert", '<div class="side-tabs" role="tablist"><button type="button" role="tab" data-tab="summary">概要</button><button type="button" role="tab" data-tab="parts">部品</button><button type="button" role="tab" data-tab="result">結果</button></div>', "beforebegin", "#side-scroll"],
    ["script", `
      const side = document.querySelector("aside.side");
      const tabs = [...side.querySelectorAll(".side-tabs button")];
      const set = (tab) => { side.dataset.tab = tab; for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.tab === tab)); };
      for (const b of tabs) b.addEventListener("click", () => set(b.dataset.tab));
      const auto = () => {
        const result = !document.getElementById("result-card").hidden;
        tabs[2].hidden = !result;
        set(result ? "result" : !document.getElementById("unit-card").hidden ? "summary" : "parts");
      };
      new MutationObserver(auto).observe(document.getElementById("result-card"), { attributes: true, attributeFilter: ["hidden"] });
      new MutationObserver(auto).observe(document.getElementById("unit-card"), { attributes: true, attributeFilter: ["hidden"] });
      auto();`],
  ],
};

const RESULT_TONES = { ops: [["attr", "html", "data-result-tones", "on"]] };
const FOCUS_TONES = { ops: [["attr", "html", "data-result-tones", "focus"]] }; // 例外だけ不透明（ほかは透かす）

export const PROPOSALS = [
  { key: "現状", name: "今の画面（比べるため。案ではない）", css: "", ops: [] },
  { key: "A", name: "3D に結果を塗る", css: "", ops: RESULT_TONES.ops },
  { key: "B", name: "要点を先に（例外だけ並べる）", css: `${EXCEPTIONS_ONLY.css} ${KEY_FACTS.css}`, ops: [...EXCEPTIONS_ONLY.ops, ...KEY_FACTS.ops] },
  { key: "C", name: "元のページと 3D を切り替え", css: SOURCE_TAB.css, ops: SOURCE_TAB.ops },
  { key: "D", name: "判定の升目", css: VERDICT_GRID.css, ops: VERDICT_GRID.ops },
  { key: "E", name: "静かな画面（説明を消す）", css: QUIET, ops: [] },
  { key: "F", name: "右の欄をタブに", css: SIDE_TABS.css, ops: SIDE_TABS.ops },
  // 2 回目: 1 回目の上位 2 案（B・D）を組み合わせた複合案 3 つ。升目で全体を、その下に例外（不一致・失敗・作成中）の行だけを詳しく。
  // A′ は A の見直し: 例外があれば、例外だけを不透明の色で、ほかの部品を薄く透かす（A は内側の部品の例外が外から見えなかった）
  { key: "B×D", name: "升目 ＋ 例外の行 ＋ 要点を先に", css: `${GRID.css} ${EXCEPTION_ROWS} ${KEY_FACTS.css}`, ops: [...GRID.ops, ...KEY_FACTS.ops] },
  { key: "B×D×A′", name: "B×D ＋ 3D で例外を透かして見せる", css: `${GRID.css} ${EXCEPTION_ROWS} ${KEY_FACTS.css}`,
    ops: [...GRID.ops, ...KEY_FACTS.ops, ...FOCUS_TONES.ops] },
  { key: "B×D×A′×C", name: "B×D×A′ ＋ 元のページと 3D を切り替え", css: `${GRID.css} ${EXCEPTION_ROWS} ${KEY_FACTS.css} ${SOURCE_TAB.css}`,
    ops: [...GRID.ops, ...KEY_FACTS.ops, ...FOCUS_TONES.ops, ...SOURCE_TAB.ops] },
];
