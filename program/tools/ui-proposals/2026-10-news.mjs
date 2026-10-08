// 2026-10（変わったこと）: 起動でそろえた後に、その版で変わったことを 1 度だけ見せる場所の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-news.mjs --states start,empty,ipt
// 前提: いまは各 PC が黙ってそろえるだけで、利用者は何が変わったかを知る手段が無い（改善案のまとめ「配布・運用」）。
// 見せる中身は同じ（2.0.3 → 2.1.0 の 3 行）。違うのは、どこに・どの形で出すかだけ。点数は 2026-10-news.json。
// 起動の直後はサンプルの窓（起動画面）が開いている（状態 start）。閉じると最初の画面（empty）、部品を開くと ipt。

const NOTES = ["設定の画面（ショートカット・版の管理）を足しました", "3D の形を見やすくしました（陰影・全体表示）", "PDF のページを番号の升目から選べます"];
const LIST = `<ul class="nw-list">${NOTES.map((n) => `<li>${n}</li>`).join("")}</ul>`;
const HEAD = `<p class="nw-head"><b>2.1.0</b> にそろえました <small>（2.0.3 から）</small></p>`;
const CSS = `.nw { pointer-events: none; }
  .nw-head { margin: 0; font-size: var(--fs-m); } .nw-head small { color: var(--muted); font-size: var(--fs-s); }
  .nw-list { margin: 0; padding-inline-start: 1.2em; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-s); }
  .nw-btn { align-self: flex-start; min-height: 32px; padding: 4px 12px; font-size: var(--fs-s); }`;
const close = (label = "閉じる", kind = "quiet") => `<button type="button" class="${kind} nw-btn">${label}</button>`;

// A 右下の知らせ（起動のときのショートカットの問いと同じ形・場所）
const TOAST = {
  css: `${CSS} .nw-toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; width: 400px; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
    border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-2); }`,
  ops: [["insert", `<div class="nw nw-toast" role="status">${HEAD}${LIST}${close()}</div>`, "beforeend", "body"]],
};
// B 見出しバーの下の帯（全幅。閉じるまで残る）
const BANNER = {
  css: `${CSS} .nw-band { grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; margin: 0 -0px; padding: 8px 16px; background: var(--accent-soft); border-bottom: 1px solid var(--rule); }
    .nw-band .nw-list { flex-direction: row; gap: 4px 18px; flex-wrap: wrap; flex: 1; }
    .app { grid-template-rows: auto auto minmax(0, 1fr); grid-template-areas: "bar bar" "band band" "stage side"; } .app.is-empty { grid-template-areas: "bar" "band" "stage"; }
    .nw-band { grid-area: band; }`,
  ops: [["insert", `<div class="nw nw-band" role="status">${HEAD}${LIST}${close()}</div>`, "afterend", ".appbar"]],
};
// C 起動の窓（サンプル・受け取ったファイル）の一番上の節
const START = {
  css: `${CSS} .nw-start { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px; background: var(--accent-soft); }`,
  ops: [["insert", `<section class="nw nw-start">${HEAD}${LIST}</section>`, "afterbegin", ".library-body"]],
};
// D 窓（真ん中。読んで「始める」を押すまで先へ進めない）
const MODAL = {
  css: `${CSS} .nw-scrim { position: fixed; inset: 0; z-index: 70; background: rgba(16, 24, 32, 0.45); }
    .nw-modal { position: fixed; z-index: 71; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 460px; display: flex; flex-direction: column; gap: 10px; padding: 20px 22px;
      background: var(--surface); border: 1px solid var(--rule); border-radius: 16px; box-shadow: var(--shadow-3); }`,
  ops: [["insert", `<div class="nw nw-scrim"></div><div class="nw nw-modal" role="dialog"><h2 style="margin:0;font-size:var(--fs-l)">この版で変わったこと</h2>${HEAD}${LIST}${close("始める", "primary")}</div>`, "beforeend", "body"]],
};
// E 設定の歯車に印（押すと、要点の 1 行の下に変わったこと）。画像では閉じた見出しバーの印を撮る
const GEAR_DOT = {
  css: `${CSS} #show-settings { position: relative; } .nw-dot { position: absolute; top: 6px; left: 22px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }`,
  ops: [["insert", `<i class="nw nw-dot" title="2.1.0 で変わったこと"></i>`, "beforeend", "#show-settings"]],
};
// F 最初の画面（始め方）の上に、変わったことのカード
const WELCOME = {
  css: `${CSS} .nw-welcome { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-radius: 12px; background: var(--surface); border: 1px solid var(--rule); max-width: 560px; }`,
  ops: [["insert", `<section class="nw nw-welcome">${HEAD}${LIST}</section>`, "afterbegin", "#stage-empty"]],
};

// ---- 2 回目（1 回目は A 82.5・F 80.0 で僅差） ----
const join = (...ps) => ({ css: ps.map((p) => p.css).join("\n"), ops: ps.flatMap((p) => p.ops) });
// 設定の引き出しの要点の 1 行の下に「2.1.0 で変わったこと」を畳んで置く（閉じた後でも、いつでも読める）
const IN_SETTINGS = {
  css: `.nw-more { margin: 0; font-size: var(--fs-s); } .nw-more summary { cursor: pointer; color: var(--accent); font-weight: 600; }`,
  ops: [["script", `const add = () => { const b = document.getElementById("settings-body"); if (!b || b.querySelector(".nw-more")) return;
      const strip = b.querySelector(".st-strip"); if (!strip) return;
      strip.insertAdjacentHTML("afterend", '<details class="nw-more" open><summary>2.1.0 で変わったこと</summary>${LIST.replace(/'/g, "\\'")}</details>'); };
    new MutationObserver(add).observe(document.getElementById("settings-body"), { childList: true }); add();`]],
};
// 開いている物で場所を変える: 何も開いていなければ始め方の上のカード、ファイルを開いていれば右下の知らせ
const ADAPT = { css: `body:has(.app.is-empty) .nw-toast { display: none; }`, ops: [] };

export const PROPOSALS = [
  { key: "base", name: "現状（知らせない）", css: "", ops: [] },
  { key: "A", name: "A 右下の知らせ", ...TOAST },
  { key: "B", name: "B 見出しの下の帯", ...BANNER },
  { key: "C", name: "C 起動の窓の一番上", ...START },
  { key: "D", name: "D 真ん中の窓", ...MODAL },
  { key: "E", name: "E 設定の歯車に印", ...GEAR_DOT },
  { key: "F", name: "F 始め方の上のカード", ...WELCOME },
  { key: "G", name: "G A＋設定でいつでも読める", ...join(TOAST, IN_SETTINGS) },
  { key: "H", name: "H 何も開いていなければ F、開いていれば A", ...join(TOAST, WELCOME, ADAPT) },
  { key: "I", name: "I H＋設定でいつでも読める", ...join(TOAST, WELCOME, ADAPT, IN_SETTINGS) },
];
