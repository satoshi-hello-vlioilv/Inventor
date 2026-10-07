// 2026-10（2D の図面）: 図面（.dwg・.dxf）の画面を組み込んだ基本形を画像で評価して見つけた問題への改良案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-drawing.mjs --states drawing,layout
// 見つけた問題（基本形の画像から）: ① 白地でシアン・黄・緑の線と文字（寸法・ねじ・かくれ線）が読みにくい
// ② ファイルの情報と「図面」の欄が同じこと（形式・単位）を 2 回言う ③ 画層の行が背高で欄の半分を占め、説明も 2 行
// ④ 図形の内訳の札が 11 個並び、優先度の低い情報が目立つ ⑤「線の太さ」（入・切）がレイアウトのタブ（いま選んでいるもの）と同じ見た目
// 「現状」は比べるための今の画面（案ではない）。点数は 2026-10-drawing.json、決めたことは docs/ui.md。
// 1 回目・2 回目とも僅差。上位 2 案（H・C）に共通の C（色の補正・入切の印・簡潔な欄）は画面に入ったので、今の画面では
// どの案にも C が入って見える（COMPACT の ops は効かない。記録として残す）。H の線の見本を足すかは利用者に確かめる。

// 色の補正: 地とのコントラスト比 3 に届かない図面の色を、前景の側へ寄せる（viewer2d が --sheet-contrast を読む）
const COLOR_FIX = `.app.is-drawing { --sheet-contrast: 3; }`;
// 暗い作図面（AutoCAD のモデル空間の見立て）: テーマによらず、図面だけ暗い地
const DARK_SHEET = `.app.is-drawing { --sheet: #1e252e; --sheet-ink: #e8edf2; --sheet-contrast: 3; }`;
// 白黒（印刷の見た目）: 全ての色を前景色に（コントラスト比 21 = 前景色そのもの）。色は画層の欄の見本でだけ分かる
const MONO = `.app.is-drawing { --sheet-contrast: 21; }`;
// 入・切のボタンを、選んでいるタブと見分ける（塗らずに印 ✓ で）
const TOGGLE = `.tool-group #toggle-lineweight[aria-pressed] { background: transparent; color: var(--ink); }
  #toggle-lineweight::before { content: "☐ "; color: var(--muted); }
  #toggle-lineweight[aria-pressed="true"]::before { content: "☑ "; color: var(--accent); }`;
// 簡潔な欄: ファイルの情報を「図面」の欄に一本化・画層は 1 行ずつ低く・説明は短く・図形の内訳は畳む
const COMPACT = {
  css: `.app.is-drawing .file-card { display: none; }
    .layers { gap: 0; }
    .layers .feature { padding: 5px 10px; border-color: transparent; background: transparent; border-radius: 8px; }
    .layers .feature:hover, .layers .feature.is-active { border-color: var(--accent); background: var(--accent-soft); }
    .layers .feature[aria-pressed="false"] .kind { background: transparent; }
    #types-more summary { font-size: var(--fs-s); }`,
  // 画面に入った後（今の画面）でも当てられるよう、まだ無いときだけ組み替える
  ops: [["script", `
    document.querySelector("#layers").closest(".card").querySelector(".h-note").textContent = "押すと表示・非表示";
    const types = document.querySelector("#drawing-types");
    if (!types.closest("details")) {
      const more = document.createElement("details");
      more.className = "more";
      more.id = "types-more";
      more.innerHTML = "<summary>図形の内訳</summary>";
      types.after(more);
      more.append(types);
    }`]],
};
// 下のタブ（AutoCAD の見立て）: レイアウトの切り替えを図面の左下に置き、読み出しをその右に
const BOTTOM_TABS = {
  css: `.layout-dock { position: absolute; left: 12px; right: 12px; bottom: 14px; display: flex; align-items: center; gap: 10px; pointer-events: none; }
    .layout-dock .tool-group { pointer-events: auto; }
    .layout-dock .readout { position: static; flex: 1; min-width: 0; }`,
  ops: [
    ["insert", `<div class="layout-dock" id="layout-dock"></div>`, "beforeend", "#stage"],
    ["move", "#layout-tabs", "append", "#layout-dock"],
    ["move", "#readout", "append", "#layout-dock"],
  ],
};

// 2 回目（複合案）の部品
// モデルは暗い作図面・紙のレイアウトは白い紙（AutoCAD と同じ約束。main.js が #app に data-layout を付ける）
const MODEL_DARK = `.app.is-drawing[data-layout="model"] { --sheet: #1e252e; --sheet-ink: #e8edf2; }`;
// 画層の見本を線の見本に（色と線種: 実線・破線・鎖線。panel.js が見本に data-dash を付ける）
const LINE_SWATCH = `.layers .feature { grid-template-columns: 26px 1fr auto; }
  .layers .feature .kind { width: 24px; height: 0; border: 0; border-radius: 0; background: none; border-top: 2.5px solid var(--swatch); }
  .layers .feature .kind[data-dash="dash"] { border-top-style: dashed; }
  .layers .feature .kind[data-dash="chain"] { border-top: 0; height: 2.5px;
    background: linear-gradient(90deg, var(--swatch) 0 45%, transparent 45% 58%, var(--swatch) 58% 66%, transparent 66% 79%, var(--swatch) 79%); }
  .layers .feature[aria-pressed="false"] .kind { opacity: 0.4; }`;
// 色・白黒の切り替え（見た目だけの試作: 押しても描き直さない。置き場所と分かりやすさを見る）
const COLOR_TOGGLE = {
  css: "",
  ops: [["insert", `<button type="button" aria-pressed="true" class="color-toggle">☑ 色</button>`, "beforebegin", "#fit"]],
};

const join = (...parts) => ({
  css: parts.map((p) => (typeof p === "string" ? p : p.css)).join("\n"),
  ops: parts.flatMap((p) => (typeof p === "string" ? [] : p.ops)),
});

export const PROPOSALS = [
  { key: "0", name: "現状", css: "", ops: [] },
  { key: "A", name: "A 白地＋色の補正", ...join(COLOR_FIX, TOGGLE) },
  { key: "B", name: "B 暗い作図面", ...join(DARK_SHEET, TOGGLE) },
  { key: "C", name: "C 白地＋補正＋簡潔な欄", ...join(COLOR_FIX, TOGGLE, COMPACT) },
  { key: "D", name: "D 暗い作図面＋簡潔な欄", ...join(DARK_SHEET, TOGGLE, COMPACT) },
  { key: "E", name: "E 白地＋補正＋下のタブ＋簡潔な欄", ...join(COLOR_FIX, TOGGLE, COMPACT, BOTTOM_TABS) },
  { key: "F", name: "F 白黒（印刷の見た目）＋簡潔な欄", ...join(MONO, TOGGLE, COMPACT) },
  // 2 回目: 1 回目が僅差（C 81.0・D 78.5）なので、複合案 3 つと上位 2 案（C・D）で選び直す
  { key: "G", name: "G C＋モデルは暗く・紙は白", ...join(COLOR_FIX, MODEL_DARK, TOGGLE, COMPACT) },
  { key: "H", name: "H C＋画層に線の見本", ...join(COLOR_FIX, TOGGLE, COMPACT, LINE_SWATCH) },
  { key: "I", name: "I C＋色・白黒の切り替え", ...join(COLOR_FIX, TOGGLE, COMPACT, COLOR_TOGGLE) },
];
