// 2026-11（起動画面と初期画面）: 起動してから使えるまでの表示（起動の幕）と、何も開いていない画面（始め方）を、有料の製品の質に。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-welcome.mjs --states start,empty
// start（起動直後）に起動の幕を出し、Esc（empty へ進む操作）で幕を外して始め方を見せる。点数は 2026-11-welcome.json（rule 2）。
// 今の画面の画像で見えたこと:
// ① 起動中は窓の地の色だけで、部品が組み上がるまで何も出ない（固まったのか読み込み中か分からない）
// ② 始め方は中央に小さく固まり、上下に大きな空き。製品の「顔」（名前・版・何ができるか）が弱い
// ③ 形式の札がドロップの枠（11 個）と「見る」のカード（9 個）に重複して並ぶ（読む量が多い）
// ④ 点線の枠とカード 2 枚が同じ重さで並び、どこから始めるかの順が弱い
// ⑤ 配る版にはサンプルが無い（「サンプルで試す」は出ない）。サンプルに頼らずに成り立つこと
// 共通の前提: 主の青は「ファイルを選ぶ」1 つだけ。版とこの PC の状態（Inventor・Python）を出す（画面が update・build の状態から取れる）。

const LOGO = (size) => `<svg class="pv-logo" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 3.2 19.6 7.6 12 12 4.4 7.6z" fill="#5d9cf0"/><path d="M4.4 7.6 12 12v8.8l-7.6-4.4z" fill="#1a62c4"/><path d="M19.6 7.6v8.8L12 20.8V12z" fill="#134c9a"/></svg>`;
const NAME = "Inventor 3Dツール";
const VERSION = "2.9.0";
const TAGLINE = "Inventor の部品・組立と 2D の図面を、Inventor なしで開いて確かめる。three.js の 3D は CAD に";
// この PC の状態（実装では update・build の状態から）
const ENV = `<p class="pv-env"><span class="pv-dot is-ok"></span>版 ${VERSION}<span class="pv-sep"></span><span class="pv-dot is-ok"></span>Inventor 2026 で作れます<span class="pv-sep"></span><span class="pv-dot is-ok"></span>Python 3.12</p>`;
const PRIVACY = `<p class="pv-privacy">ファイルはこの PC の中だけで解析し、外へは送りません</p>`;
// 等角の部品の線画（穴のある角材）
const PART = (w) => `<svg class="pv-art" width="${w}" viewBox="0 0 240 200" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
  <path d="M40 70 120 25 200 70 120 115z" fill="var(--pv-face-top, rgba(93,156,240,.18))"/><path d="M40 70v60l80 45v-60z" fill="var(--pv-face-left, rgba(26,98,196,.12))"/>
  <path d="M200 70v60l-80 45v-60z" fill="var(--pv-face-right, rgba(19,76,154,.2))"/><ellipse cx="120" cy="70" rx="26" ry="14"/><path d="M94 70v18m52-18v18"/>
  <path d="M94 88a26 14 0 0 0 52 0" stroke-dasharray="4 4"/></svg>`;
// 図面の線画（用紙・表題欄・寸法）
const SHEET = (w) => `<svg class="pv-art" width="${w}" viewBox="0 0 240 170" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">
  <rect x="6" y="6" width="228" height="158" rx="3"/><rect x="150" y="128" width="78" height="30"/><path d="M150 140h78M180 128v30"/>
  <circle cx="80" cy="80" r="34"/><circle cx="80" cy="80" r="12"/><path d="M38 80h84M80 38v84" stroke-dasharray="8 3 2 3"/>
  <path d="M46 132h68M46 126v12M114 126v12"/><path d="M50 132l-4-2v4zM110 132l4-2v4z" fill="currentColor"/></svg>`;

const ICON = {
  part: `<svg viewBox="0 0 24 24"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>`,
  step: `<svg viewBox="0 0 24 24"><path d="M4 6h7v7H4zM13 11h7v7h-7z"/><path d="M11 9.5h4.5V11"/></svg>`,
  sheet: `<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="10" cy="12" r="3.5"/><path d="M14.5 16.5h4"/></svg>`,
  make: `<svg viewBox="0 0 24 24"><path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5"/><path d="M13.5 5 10.5 19"/></svg>`,
};

// 共通の部品の CSS（案の中で使う）
const BASE = `
  .pv-logo { display: block; }
  .pv-env { margin: 0; display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
  .pv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--steel); }
  .pv-dot.is-ok { background: var(--ok); }
  .pv-sep { width: 1px; height: 12px; margin: 0 6px; background: var(--rule); }
  .pv-privacy { margin: 0; font-size: var(--fs-xs); color: var(--muted); }
  .pv-icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .pv-fmt { font: 500 var(--fs-xs)/1.5 var(--font-num); color: var(--muted); letter-spacing: .02em; }
  #stage-empty > .paths, #stage-empty > .welcome-note { display: none; }
  #welcome-samples, #show-start { display: none !important; } /* 配る版と同じ（サンプルは入らない） */`;
// 起動の幕（start で出し、Esc で外す）
const BOOT = (html, css) => ({
  css: `#pv-boot { position: fixed; inset: 0; z-index: 100; } ${css}`,
  ops: [["insert", `<div id="pv-boot" role="status" aria-label="起動しています">${html}</div>`, "beforeend", "body"],
    ["script", `document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("pv-boot")?.remove(); }, { capture: true });`]],
});
const STEPS = (label) => `<div class="pv-boot-steps"><span class="is-done">画面</span><span class="is-now">${label}</span><span>受け取ったファイル</span></div>`;
const BAR = `<div class="pv-bar"><i></i></div>`;
const BAR_CSS = `.pv-bar { width: 220px; height: 3px; border-radius: 3px; background: var(--rule-soft); overflow: hidden; }
  .pv-bar i { display: block; width: 42%; height: 100%; border-radius: 3px; background: var(--accent); }`;

/** 方眼（製図台の地） */
const GRID = (c) => `repeating-linear-gradient(0deg, transparent 0 23px, ${c} 23px 24px), repeating-linear-gradient(90deg, transparent 0 23px, ${c} 23px 24px)`;

/** 案を組み立てる（起動の幕 ＋ 始め方） */
const proposal = (key, name, boot, css, ops) => ({ key, name, css: `${BASE} ${boot.css} ${css}`, ops: [...boot.ops, ...ops] });

// ---- 2 回目の組合せで使う部品 -------------------------------------------------------------------------------------
const FOOT = `<footer class="pv-foot">${ENV}${PRIVACY}</footer>`;
const NAME_ROW = `<div class="pv-name-row">${LOGO(34)}<h2>${NAME}</h2><small>${VERSION}</small></div>`;
const KEYS = `<div class="pv-keys"><span><kbd>Ctrl+O</kbd>開く</span><span><kbd>ドラッグ</kbd>回す</span><span><kbd>M</kbd>測る</span><span><kbd>F</kbd>全体を見る</span></div>`;
// D の 1 行の受け口（主のボタン 1 つ）
const D_BAR = `
  #dropzone { width: min(700px, 100%); flex-direction: row; padding: 10px 10px 10px 20px; border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-1); gap: 12px; text-align: left; }
  #dropzone > svg { width: 22px; height: 22px; } #dropzone h2 { flex: 1; font-size: var(--fs-l); font-weight: 500; color: var(--muted); }
  #dropzone .formats, #dropzone .welcome-sub { display: none; } #dropzone .welcome-actions { margin: 0; flex-wrap: nowrap; }
  .pv-name-row { display: flex; align-items: center; gap: 12px; } .pv-name-row h2 { margin: 0; font-size: 24px; font-weight: 600; }
  .pv-name-row small { color: var(--muted); font-variant-numeric: tabular-nums; }
  .pv-keys { display: flex; gap: 22px; font-size: var(--fs-xs); color: var(--muted); } .pv-keys span { display: inline-flex; gap: 6px; align-items: center; }
  .pv-foot { display: grid; justify-items: center; gap: 4px; margin-top: 6px; }`;
// F の物語（開く → 3D → 図面）
const STORY = `<div class="pv-story"><figure><div class="pv-f-file">.ipt .iam .stp<br>.dwg .dxf .pdf<br>.jww .sfc .html</div><figcaption>開く<small>ドロップか選ぶ</small></figcaption></figure>
  <span class="pv-f-arrow"></span><figure>${PART(170)}<figcaption>3D で見る<small>寸法・穴やねじ・部品表</small></figcaption></figure>
  <span class="pv-f-arrow"></span><figure>${SHEET(180)}<figcaption>図面で確かめる<small>測る・直して DXF・SXF に</small></figcaption></figure></div>`;
const STORY_CSS = `
  .pv-story { display: flex; align-items: center; gap: 18px; color: var(--accent); }
  .pv-story figure { margin: 0; display: grid; justify-items: center; gap: 8px; }
  .pv-story figcaption { color: var(--ink); font-size: var(--fs-s); font-weight: 600; text-align: center; } .pv-story figcaption small { display: block; font-weight: 400; color: var(--muted); }
  .pv-f-arrow { width: 54px; height: 2px; background: linear-gradient(90deg, var(--rule), var(--accent)); position: relative; }
  .pv-f-arrow::after { content: ""; position: absolute; right: -2px; top: -4px; border: 5px solid transparent; border-left-color: var(--accent); }
  .pv-f-file { width: 124px; height: 150px; border-radius: 10px; border: 1.5px solid var(--rule); background: var(--surface); display: grid; place-items: center; text-align: center; font: 500 var(--fs-xs)/1.9 var(--font-num); color: var(--muted); box-shadow: var(--shadow-1); }`;
// A の製品の顔
const HERO = `<header class="pv-hero">${LOGO(48)}<h2>${NAME}</h2><p>${TAGLINE}</p></header>`;
const HERO_CSS = `.pv-hero { display: grid; justify-items: center; gap: 10px; text-align: center; } .pv-hero h2 { margin: 0; font-size: 30px; font-weight: 600; }
  .pv-hero p { margin: 0; max-width: 640px; color: var(--muted); font-size: var(--fs-l); text-wrap: balance; }`;
// できることを 1 行の札に（説明は省き、名前と形式だけ）
const CHIPS = `<div class="pv-chips"><span><i class="pv-icon">${ICON.part}</i>部品・組立<em>.ipt .iam</em></span><span><i class="pv-icon">${ICON.step}</i>STEP<em>.stp</em></span>
  <span><i class="pv-icon">${ICON.sheet}</i>2D の図面<em>.dwg .dxf .pdf .jww .sfc</em></span><span><i class="pv-icon">${ICON.make}</i>CAD にする<em>.html</em></span></div>`;
const CHIPS_CSS = `.pv-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
  .pv-chips span { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: var(--surface); border: 1px solid var(--rule-soft); font-size: var(--fs-s); font-weight: 600; }
  .pv-chips i { color: var(--accent); display: inline-flex; } .pv-chips i svg { width: 18px; height: 18px; } .pv-chips em { font: 500 var(--fs-xs) var(--font-num); font-style: normal; color: var(--muted); }`;
// 静かな 4 列（枠なし。アイコン・名前・1 行）
const COLS = `<div class="pv-cols"><div><i class="pv-icon">${ICON.part}</i><b>部品・組立</b><small>形・寸法・部品表</small><em>.ipt .iam</em></div>
  <div><i class="pv-icon">${ICON.step}</i><b>STEP</b><small>配置をそのまま</small><em>.stp</em></div>
  <div><i class="pv-icon">${ICON.sheet}</i><b>2D の図面</b><small>測る・直して保存</small><em>.dwg .dxf .pdf .jww .sfc</em></div>
  <div><i class="pv-icon">${ICON.make}</i><b>CAD にする</b><small>STEP・Inventor に</small><em>.html</em></div></div>`;
const COLS_CSS = `.pv-cols { width: min(700px, 100%); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin-top: 4px; }
  .pv-cols > div { display: grid; justify-items: center; gap: 2px; padding: 4px 10px; text-align: center; } .pv-cols > div + div { border-inline-start: 1px solid var(--rule-soft); }
  .pv-cols i { color: var(--accent); display: inline-flex; margin-bottom: 4px; } .pv-cols b { font-size: var(--fs-s); } .pv-cols small { color: var(--muted); font-size: var(--fs-xs); }
  .pv-cols em { font: 500 var(--fs-xs) var(--font-num); font-style: normal; color: var(--muted); }`;
// B の濃い起動の幕（steps: 何を読み込んでいるかの段階）
const BOOT_DARK = (steps = false) => BOOT(`<div class="pv-b-boot">${LOGO(72)}<b>${NAME}</b><span>${TAGLINE}</span>${BAR}${steps ? STEPS("設定と受け取ったファイル") : ""}<small>版 ${VERSION}</small></div>`,
  `#pv-boot { display: grid; place-items: center; background: linear-gradient(140deg, #0c1f3a, #12376b 60%, #1a62c4); color: #fff; } ${BAR_CSS}
   #pv-boot .pv-bar { background: rgba(255,255,255,.18); } #pv-boot .pv-bar i { background: #8fc0ff; }
   .pv-b-boot { display: grid; justify-items: center; gap: 14px; text-align: center; } .pv-b-boot b { font-size: 26px; }
   .pv-b-boot > span { max-width: 460px; opacity: .78; } .pv-b-boot small { opacity: .6; font-variant-numeric: tabular-nums; }
   .pv-boot-steps { display: flex; gap: 16px; font-size: var(--fs-xs); color: rgba(233,241,255,.6); } .pv-boot-steps span::before { content: "○ "; }
   .pv-boot-steps .is-done { color: #8fe0a8; } .pv-boot-steps .is-done::before { content: "● "; } .pv-boot-steps .is-now { color: #cfe2ff; } .pv-boot-steps .is-now::before { content: "◐ "; }`);

export const PROPOSALS = [
  proposal("A", "製品の顔 ＋ 1 つの受け口 ＋ できることの 4 枚の札",
    BOOT(`<div class="pv-a-boot">${LOGO(64)}<b>${NAME}</b><small>版 ${VERSION}</small>${BAR}</div>`,
      `#pv-boot { display: grid; place-items: center; background: var(--bg); } ${BAR_CSS}
       .pv-a-boot { display: grid; justify-items: center; gap: 12px; } .pv-a-boot b { font-size: 22px; letter-spacing: .01em; } .pv-a-boot small { color: var(--muted); font-variant-numeric: tabular-nums; }`),
    `#stage-empty { gap: 28px; justify-content: center; }
     .pv-a-head { display: grid; justify-items: center; gap: 10px; text-align: center; }
     .pv-a-head h2 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: .01em; }
     .pv-a-head p { margin: 0; max-width: 620px; color: var(--muted); font-size: var(--fs-l); text-wrap: balance; }
     #dropzone { width: min(760px, 100%); padding: 30px 28px; border: 1px solid var(--rule); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-1); gap: 12px; }
     #dropzone > svg { width: 40px; height: 40px; } #dropzone .formats { display: none; }
     .pv-a-tiles { width: min(760px, 100%); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
     .pv-a-tile { padding: 14px 14px 12px; border-radius: 12px; background: color-mix(in srgb, var(--surface) 70%, transparent); border: 1px solid var(--rule-soft); display: grid; gap: 6px; align-content: start; }
     .pv-a-tile .pv-icon { color: var(--accent); } .pv-a-tile b { font-size: var(--fs-s); } .pv-a-tile small { color: var(--muted); font-size: var(--fs-xs); line-height: 1.5; }
     .pv-a-foot { display: grid; justify-items: center; gap: 6px; }`,
    [["insert", `<header class="pv-a-head">${LOGO(52)}<h2>${NAME}</h2><p>${TAGLINE}</p></header>`, "afterbegin", "#stage-empty"],
      ["insert", `<div class="pv-a-tiles">
        <div class="pv-a-tile"><span class="pv-icon">${ICON.part}</span><b>部品・組立</b><small>形・外形寸法・穴やねじ・部品表</small><span class="pv-fmt">.ipt .iam</span></div>
        <div class="pv-a-tile"><span class="pv-icon">${ICON.step}</span><b>STEP</b><small>部品と組立の配置をそのまま</small><span class="pv-fmt">.stp</span></div>
        <div class="pv-a-tile"><span class="pv-icon">${ICON.sheet}</span><b>2D の図面</b><small>画層・寸法・測る・直して保存</small><span class="pv-fmt">.dwg .dxf .pdf .jww .sfc</span></div>
        <div class="pv-a-tile"><span class="pv-icon">${ICON.make}</span><b>CAD にする</b><small>three.js の 3D を STEP・Inventor に</small><span class="pv-fmt">.html</span></div></div>
        <footer class="pv-a-foot">${ENV}${PRIVACY}</footer>`, "beforeend", "#stage-empty"]]),

  proposal("B", "左右 2 分割: 濃い色の製品の面（名前・できること・版）＋ 行動の面（受け口・形式）",
    BOOT(`<div class="pv-b-boot">${LOGO(72)}<b>${NAME}</b><span>${TAGLINE}</span>${BAR}<small>版 ${VERSION}</small></div>`,
      `#pv-boot { display: grid; place-items: center; background: linear-gradient(140deg, #0c1f3a, #12376b 60%, #1a62c4); color: #fff; } ${BAR_CSS}
       #pv-boot .pv-bar { background: rgba(255,255,255,.18); } #pv-boot .pv-bar i { background: #8fc0ff; }
       .pv-b-boot { display: grid; justify-items: center; gap: 14px; text-align: center; } .pv-b-boot b { font-size: 26px; }
       .pv-b-boot span { max-width: 460px; opacity: .78; } .pv-b-boot small { opacity: .6; font-variant-numeric: tabular-nums; }`),
    `#stage-empty { display: grid; grid-template-columns: minmax(380px, 40%) minmax(0, 1fr); padding: 0; gap: 0; align-items: stretch; justify-content: stretch; }
     .pv-b-brand { padding: 56px 48px; display: flex; flex-direction: column; gap: 18px; color: #e9f1ff; background: linear-gradient(160deg, #0c1f3a, #12376b 62%, #1a5bb5); position: relative; overflow: hidden; }
     .pv-b-brand h2 { margin: 0; font-size: 30px; color: #fff; } .pv-b-brand p { margin: 0; opacity: .82; font-size: var(--fs-l); max-width: 440px; }
     .pv-b-brand ul { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; } .pv-b-brand li { display: flex; gap: 10px; align-items: center; opacity: .92; }
     .pv-b-brand li .pv-icon { color: #8fc0ff; } .pv-b-brand .pv-art { position: absolute; right: -30px; bottom: -10px; color: rgba(143,192,255,.35); --pv-face-top: rgba(143,192,255,.12); --pv-face-left: rgba(143,192,255,.06); --pv-face-right: rgba(143,192,255,.1); }
     .pv-b-brand .pv-env { margin-top: auto; color: rgba(233,241,255,.7); } .pv-b-brand .pv-sep { background: rgba(255,255,255,.2); }
     .pv-b-act { padding: 56px 56px; display: flex; flex-direction: column; justify-content: center; gap: 18px; }
     .pv-b-act h3 { margin: 0; font-size: var(--fs-xl); }
     #dropzone { width: min(640px, 100%); align-items: flex-start; text-align: left; padding: 28px; }
     #dropzone .welcome-actions { justify-content: flex-start; }
     .pv-b-act .pv-privacy { max-width: 640px; }`,
    [["insert", `<section class="pv-b-brand">${LOGO(56)}<h2>${NAME}</h2><p>${TAGLINE}</p>
        <ul><li><span class="pv-icon">${ICON.part}</span>部品・組立・STEP を 3D で見る</li><li><span class="pv-icon">${ICON.sheet}</span>2D の図面を見る・測る・直して保存</li>
        <li><span class="pv-icon">${ICON.make}</span>three.js の 3D を STEP・Inventor の部品に</li></ul>${PART(300)}${ENV}</section>`, "afterbegin", "#stage-empty"],
      ["insert", `<section class="pv-b-act" id="pv-b-act"><h3>始める</h3></section>`, "beforeend", "#stage-empty"],
      ["move", "#dropzone", "append", "#pv-b-act"],
      ["insert", PRIVACY, "beforeend", "#pv-b-act"]]),

  proposal("C", "作業別の 3 枚のカード（何をしますか？）。どこにドロップしても開く",
    BOOT(`<div class="pv-c-boot">${LOGO(48)}<b>${NAME}</b>${STEPS("サンプル・設定")}</div>`,
      `#pv-boot { display: grid; place-items: center; background: var(--bg); }
       .pv-c-boot { display: grid; justify-items: center; gap: 12px; } .pv-c-boot b { font-size: 20px; }
       .pv-boot-steps { display: flex; gap: 14px; font-size: var(--fs-xs); color: var(--muted); } .pv-boot-steps span::before { content: "○ "; }
       .pv-boot-steps .is-done { color: var(--ok); } .pv-boot-steps .is-done::before { content: "● "; } .pv-boot-steps .is-now { color: var(--accent); } .pv-boot-steps .is-now::before { content: "◐ "; }`),
    `#stage-empty { gap: 22px; }
     .pv-c-head { display: grid; justify-items: center; gap: 6px; } .pv-c-head h2 { margin: 0; font-size: 26px; } .pv-c-head p { margin: 0; color: var(--muted); }
     .pv-c-cards { width: min(980px, 100%); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
     .pv-c-card { padding: 22px; border-radius: 14px; background: var(--surface); border: 1px solid var(--rule); box-shadow: var(--shadow-1); display: grid; gap: 10px; align-content: start; }
     .pv-c-card .pv-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
     .pv-c-card h3 { margin: 0; font-size: var(--fs-l); } .pv-c-card p { margin: 0; color: var(--muted); font-size: var(--fs-s); }
     .pv-c-card .secondary { justify-self: start; margin-top: 4px; }
     #dropzone { width: min(980px, 100%); flex-direction: row; justify-content: center; padding: 14px 18px; border-width: 1.5px; gap: 14px; }
     #dropzone > svg { width: 24px; height: 24px; } #dropzone h2 { font-size: var(--fs-m); } #dropzone .formats, #dropzone .welcome-sub { display: none; }
     #dropzone .welcome-actions { margin: 0; } #dropzone .welcome-actions .primary, #dropzone .welcome-actions .secondary { min-height: 38px; font-size: var(--fs-m); }
     .pv-c-foot { display: grid; justify-items: center; gap: 6px; }`,
    [["insert", `<header class="pv-c-head"><h2>何をしますか？</h2><p>ファイルを画面のどこにドロップしても開きます</p></header>
       <div class="pv-c-cards">
        <article class="pv-c-card"><span class="pv-icon">${ICON.part}</span><h3>3D を見る</h3><p>部品・組立・STEP。形・外形寸法・穴やねじ・部品表（材質・質量）</p><span class="pv-fmt">.ipt  .iam  .stp</span><button type="button" class="secondary">部品・組立を開く</button></article>
        <article class="pv-c-card"><span class="pv-icon">${ICON.sheet}</span><h3>図面を見る・直す</h3><p>画層・寸法と文字・測る・動かして DXF・SXF で保存。PDF の 3D も</p><span class="pv-fmt">.dwg  .dxf  .pdf  .jww  .sfc  .p21</span><button type="button" class="secondary">図面を開く</button></article>
        <article class="pv-c-card"><span class="pv-icon">${ICON.make}</span><h3>3D を CAD にする</h3><p>three.js の HTML を取り込み、単位を確かめて STEP・Inventor の部品に</p><span class="pv-fmt">.html  .inventor.json</span><button type="button" class="secondary">HTML を開く</button></article>
       </div>`, "afterbegin", "#stage-empty"],
      ["insert", `<footer class="pv-c-foot">${ENV}${PRIVACY}</footer>`, "beforeend", "#stage-empty"]]),

  proposal("D", "静かな中央の受け口（最小）。1 行の受け口と、キーの案内",
    BOOT(`<div class="pv-d-boot">${LOGO(40)}</div>`,
      `#pv-boot { display: grid; place-items: center; background: var(--bg); } .pv-d-boot { opacity: .9; }`),
    `#stage-empty { gap: 18px; }
     .pv-d-head { display: flex; align-items: center; gap: 12px; } .pv-d-head h2 { margin: 0; font-size: 22px; font-weight: 600; }
     .pv-d-head small { color: var(--muted); font-variant-numeric: tabular-nums; }
     #dropzone { width: min(680px, 100%); flex-direction: row; padding: 10px 10px 10px 20px; border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-1); gap: 12px; text-align: left; }
     #dropzone > svg { width: 22px; height: 22px; } #dropzone h2 { flex: 1; font-size: var(--fs-l); font-weight: 500; color: var(--muted); }
     #dropzone .formats, #dropzone .welcome-sub { display: none; } #dropzone .welcome-actions { margin: 0; flex-wrap: nowrap; }
     .pv-d-keys { display: flex; gap: 22px; font-size: var(--fs-xs); color: var(--muted); } .pv-d-keys span { display: inline-flex; gap: 6px; align-items: center; }
     .pv-d-fmts { margin: 0; font: 500 var(--fs-xs)/1.6 var(--font-num); color: var(--muted); letter-spacing: .04em; }
     .pv-d-foot { position: absolute; bottom: 22px; left: 0; right: 0; display: grid; justify-items: center; gap: 4px; }`,
    [["insert", `<div class="pv-d-head">${LOGO(30)}<h2>${NAME}</h2><small>${VERSION}</small></div>`, "afterbegin", "#stage-empty"],
      ["insert", `<p class="pv-d-fmts">ipt · iam · stp · dwg · dxf · pdf · jww · sfc · p21 · html</p>
        <div class="pv-d-keys"><span><kbd>Ctrl+O</kbd>開く</span><span><kbd>ドラッグ</kbd>回す</span><span><kbd>M</kbd>測る</span><span><kbd>F</kbd>全体を見る</span></div>
        <footer class="pv-d-foot">${ENV}${PRIVACY}</footer>`, "beforeend", "#stage-empty"]]),

  proposal("E", "製図台の方眼 ＋ 下に浮かぶ操作の帯（作業の場所そのものを始め方に）",
    BOOT(`<div class="pv-e-boot">${LOGO(56)}<b>${NAME}</b>${BAR}</div>`,
      `#pv-boot { display: grid; place-items: center; background: ${GRID("var(--rule-soft)")}, var(--surface); }
       ${BAR_CSS} .pv-e-boot { display: grid; justify-items: center; gap: 12px; padding: 24px 40px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-1); } .pv-e-boot b { font-size: 20px; }`),
    `#stage-empty { justify-content: center; gap: 16px;
       background: repeating-linear-gradient(0deg, transparent 0 23px, color-mix(in srgb, var(--rule) 45%, transparent) 23px 24px),
                   repeating-linear-gradient(90deg, transparent 0 23px, color-mix(in srgb, var(--rule) 45%, transparent) 23px 24px); }
     .pv-e-art { color: color-mix(in srgb, var(--accent) 55%, var(--muted)); display: flex; gap: 40px; align-items: center; opacity: .9; }
     .pv-e-title { margin: 0; font-size: 26px; font-weight: 600; } .pv-e-sub { margin: -8px 0 0; color: var(--muted); }
     #dropzone { position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%); width: auto; flex-direction: row; padding: 12px 14px 12px 20px; gap: 14px;
       border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-3); }
     #dropzone > svg { width: 22px; height: 22px; } #dropzone h2 { font-size: var(--fs-m); white-space: nowrap; } #dropzone .formats, #dropzone .welcome-sub { display: none; }
     #dropzone .welcome-actions { margin: 0; flex-wrap: nowrap; }
     .pv-e-env { position: absolute; top: 18px; left: 22px; } .pv-e-privacy { position: absolute; top: 18px; right: 22px; }`,
    [["insert", `<div class="pv-e-art">${PART(220)}${SHEET(250)}</div><h2 class="pv-e-title">ここに部品と図面を広げる</h2>
        <p class="pv-e-sub">3D の部品・組立・STEP と、2D の図面（DWG・DXF・PDF・Jw_cad・SXF）。three.js の 3D は CAD に</p>`, "afterbegin", "#stage-empty"],
      ["insert", `<div class="pv-e-env">${ENV}</div><div class="pv-e-privacy">${PRIVACY}</div>`, "beforeend", "#stage-empty"]]),

  proposal("F", "【方向の違う案】絵で伝える: 3D の部品と図面の絵で「開く → 見る → CAD・図面に」を示す",
    BOOT(`<div class="pv-f-boot">${PART(200)}<b>${NAME}</b>${BAR}</div>`,
      `#pv-boot { display: grid; place-items: center; background: radial-gradient(1200px 600px at 50% 40%, var(--surface), var(--bg)); }
       ${BAR_CSS} .pv-f-boot { display: grid; justify-items: center; gap: 14px; color: var(--accent); } .pv-f-boot b { color: var(--ink); font-size: 22px; }`),
    `#stage-empty { gap: 26px; background: radial-gradient(1200px 640px at 50% 32%, var(--surface), transparent); }
     .pv-f-story { display: grid; grid-template-columns: auto auto auto auto auto; align-items: center; gap: 18px; color: var(--accent); }
     .pv-f-story figure { margin: 0; display: grid; justify-items: center; gap: 8px; }
     .pv-f-story figcaption { color: var(--ink); font-size: var(--fs-s); font-weight: 600; } .pv-f-story figcaption small { display: block; font-weight: 400; color: var(--muted); text-align: center; }
     .pv-f-arrow { width: 54px; height: 2px; background: linear-gradient(90deg, var(--rule), var(--accent)); position: relative; }
     .pv-f-arrow::after { content: ""; position: absolute; right: -2px; top: -4px; border: 5px solid transparent; border-left-color: var(--accent); }
     .pv-f-file { width: 120px; height: 150px; border-radius: 10px; border: 1.5px solid var(--rule); background: var(--surface); display: grid; place-items: center; font: 600 var(--fs-s) var(--font-num); color: var(--muted); box-shadow: var(--shadow-1); }
     .pv-f-title { margin: 0; font-size: 28px; font-weight: 600; text-align: center; } .pv-f-title small { display: block; margin-top: 6px; font-size: var(--fs-l); font-weight: 400; color: var(--muted); }
     #dropzone { border: none; background: none; padding: 0; } #dropzone > svg, #dropzone h2, #dropzone .formats { display: none; }
     .pv-f-foot { display: grid; justify-items: center; gap: 6px; }`,
    [["insert", `<h2 class="pv-f-title">${NAME}<small>${TAGLINE}</small></h2>
       <div class="pv-f-story"><figure><div class="pv-f-file">.ipt .dwg<br>.stp .html</div><figcaption>開く<small>ドロップか選ぶ</small></figcaption></figure>
        <span class="pv-f-arrow"></span><figure>${PART(180)}<figcaption>3D で見る<small>寸法・穴・部品表</small></figcaption></figure>
        <span class="pv-f-arrow"></span><figure>${SHEET(190)}<figcaption>図面で確かめる<small>測る・直して保存</small></figcaption></figure></div>`, "afterbegin", "#stage-empty"],
      ["insert", `<footer class="pv-f-foot">${ENV}${PRIVACY}</footer>`, "beforeend", "#stage-empty"]]),

  proposal("G", "【方向の違う案】はじめての案内: 手順のチェックリスト（何ができるかを操作の順に）＋ 受け口",
    BOOT(`<div class="pv-g-boot">${LOGO(44)}<div><b>${NAME}</b>${STEPS("サンプル・設定")}</div></div>`,
      `#pv-boot { display: grid; place-items: center; background: var(--bg); }
       .pv-g-boot { display: flex; gap: 16px; align-items: center; padding: 20px 26px; border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-1); } .pv-g-boot b { font-size: 18px; display: block; }
       .pv-boot-steps { display: flex; gap: 14px; font-size: var(--fs-xs); color: var(--muted); } .pv-boot-steps span::before { content: "○ "; }
       .pv-boot-steps .is-done { color: var(--ok); } .pv-boot-steps .is-done::before { content: "● "; } .pv-boot-steps .is-now { color: var(--accent); } .pv-boot-steps .is-now::before { content: "◐ "; }`),
    `#stage-empty { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 560px); align-content: center; justify-content: center; gap: 28px; }
     .pv-g-guide { padding: 24px 26px; border-radius: 14px; background: var(--surface); border: 1px solid var(--rule); box-shadow: var(--shadow-1); display: grid; gap: 14px; align-content: start; }
     .pv-g-guide h2 { margin: 0; font-size: var(--fs-xl); } .pv-g-guide ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; counter-reset: s; }
     .pv-g-guide li { display: grid; grid-template-columns: 26px 1fr; gap: 2px 10px; counter-increment: s; }
     .pv-g-guide li::before { content: counter(s); grid-row: span 2; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font: 600 var(--fs-xs) var(--font-num); color: var(--accent); background: var(--accent-soft); }
     .pv-g-guide li b { font-size: var(--fs-s); } .pv-g-guide li small { color: var(--muted); font-size: var(--fs-xs); }
     #dropzone { width: 100%; align-self: stretch; justify-content: center; }
     .pv-g-foot { grid-column: 1 / -1; display: grid; justify-items: center; gap: 6px; }`,
    [["insert", `<section class="pv-g-guide"><h2>はじめに</h2><ol>
        <li><b>ファイルを開く</b><small>右へドロップするか「ファイルを選ぶ」（Ctrl+O）。部品・組立・STEP・図面・HTML</small></li>
        <li><b>回して見る</b><small>ドラッグで回転・右ドラッグで移動・ホイールで拡大。右の欄に寸法と部品表</small></li>
        <li><b>図面を測る・直す</b><small>M で測る。選んで動かし、DXF・SXF で保存</small></li>
        <li><b>CAD にする</b><small>three.js の HTML を取り込み、STEP・Inventor の部品を作る</small></li></ol></section>`, "afterbegin", "#stage-empty"],
      ["insert", `<footer class="pv-g-foot">${ENV}${PRIVACY}</footer>`, "beforeend", "#stage-empty"]]),

  // ---- 2 回目: エッセンスを組み直した 4 案（1 回目の上位 D・F・A と比べる）------------------------------------------
  proposal("H", "【組合せ】D の 1 行の受け口 × F の物語（小さく）× B の濃い起動の幕", BOOT_DARK(), `${D_BAR} ${STORY_CSS}
     #stage-empty { gap: 22px; } .pv-story { transform: scale(.82); margin: -18px 0; }`,
    [["insert", `${NAME_ROW}${STORY}`, "afterbegin", "#stage-empty"], ["insert", `${KEYS}${FOOT}`, "beforeend", "#stage-empty"]]),

  proposal("I", "【組合せ】A の製品の顔 × D の 1 行の受け口 × できることを 1 行の札に × B の濃い起動の幕", BOOT_DARK(), `${D_BAR} ${HERO_CSS} ${CHIPS_CSS}
     #stage-empty { gap: 24px; }`,
    [["insert", HERO, "afterbegin", "#stage-empty"], ["insert", `${CHIPS}${FOOT}`, "beforeend", "#stage-empty"]]),

  proposal("J", "【組合せ】F の物語 × E の方眼の地 × D の 1 行の受け口 × 方眼の起動の幕",
    BOOT(`<div class="pv-e-boot">${LOGO(56)}<b>${NAME}</b>${BAR}</div>`,
      `#pv-boot { display: grid; place-items: center; background: ${GRID("var(--rule-soft)")}, var(--surface); } ${BAR_CSS}
       .pv-e-boot { display: grid; justify-items: center; gap: 12px; padding: 24px 40px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-1); } .pv-e-boot b { font-size: 20px; }`),
    `${D_BAR} ${STORY_CSS} #stage-empty { gap: 22px; background: ${GRID("color-mix(in srgb, var(--rule) 40%, transparent)")}; }
     .pv-j-title { margin: 0; text-align: center; font-size: 28px; font-weight: 600; } .pv-j-title small { display: block; margin-top: 6px; font-size: var(--fs-l); font-weight: 400; color: var(--muted); }`,
    [["insert", `<h2 class="pv-j-title">${NAME}<small>${TAGLINE}</small></h2>${STORY}`, "afterbegin", "#stage-empty"], ["insert", FOOT, "beforeend", "#stage-empty"]]),

  proposal("K", "【組合せ】D の最小 × 静かな 4 列のできること × B の濃い起動の幕（何を読み込んでいるかの段階つき）", BOOT_DARK(true), `${D_BAR} ${COLS_CSS}
     #stage-empty { gap: 20px; }`,
    [["insert", NAME_ROW, "afterbegin", "#stage-empty"], ["insert", `${COLS}${KEYS}${FOOT}`, "beforeend", "#stage-empty"]]),
];
