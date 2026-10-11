// 2026-11（待つ間の表示）: 重い計算を裏（Worker）に移したので、画面は止まらなくなった。待つ間に何を見せると、待ち時間が短く感じられ、
// 次にすることが分かるか。状態は wait-open（ファイルを開く）・wait-3d（図面の 3D を作る）・wait-html（HTML の形を見分ける）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-waiting.mjs --states wait-open,wait-3d,wait-html
// 今の画面（2.9.0）で見えたこと（画像では撮れない: 計算の間は画面が描き直されない）:
// ① 3D のタブ・HTML の取り込みで、画面が 3〜15 秒止まる（タブも押せず、押したのかも分からない）。測った最長の止まり 1.4 秒（3D）
// ② 何をしているか・あとどれくらいかが出ない。取りやめられない
// ③ ファイルを開くと、読み終えるまで前の画面のまま（大きな図面で 0.4 秒ほど止まる）
// 案の共通: 文言と数は同じ（何を待っているか・段階・何個中の何個・経過と残りの見込み・取りやめる）。0.4 秒より早く終われば出さない。
// 実装は ui/waiting.js（#waiting の中の #waiting-title・-detail・-bar・-stage・-count・-time・-cancel に書く）。案は置き場所と形を変える。

const STEPS = {
  "ファイルを開いています": [["ファイルを読む", "now"], ["面と稜線を作る", ""], ["表示する", ""]],
  "3D を作っています": [["図面を読む", "done"], ["3D ソリッドの面を作る", "now"], ["稜線を作る", ""], ["表示する", ""]],
  "取り込んだ形を見分けています": [["元のページから取り込む", "done"], ["形を見分ける", "now"], ["表示と変換データを作る", ""]],
};
// 段階の一覧（案 F・組合せ）: 見出しから段階を選んで描く（実装では仕事が段階を送る）
const STEP_SCRIPT = `
  const steps = ${JSON.stringify(STEPS)};
  const list = document.getElementById("pv-steps");
  const draw = () => {
    const rows = steps[document.getElementById("waiting-title").textContent] ?? [];
    list.innerHTML = rows.map(([t, s]) => '<li class="' + (s ? "is-" + s : "") + '"><i></i><span>' + t + (s === "now" ? ' <b>' + document.getElementById("waiting-count").textContent + '</b>' : "") + '</span></li>').join("");
  };
  draw();
  const watch = new MutationObserver(draw); // 見出しと数だけを見る（一覧を描き直しても、また呼ばれないように）
  for (const id of ["waiting-title", "waiting-count"]) watch.observe(document.getElementById(id), { subtree: true, childList: true, characterData: true });`;

// 共通: 時刻・残りの見込みは数の並びを揃える
const BASE = `.waiting-time, .waiting-count { font-variant-numeric: tabular-nums; }`;
/** 主役の場所（3D・図面）の中に置く。1 回目の B・D・E・F・G はこれで撮り、HTML では元のページの層の下に隠れた。
 *  2 回目は ON_STAGE に直した（上位 3 案の B・E・F も、置き方だけ直して撮り直した。中身は 1 回目と同じ） */
const IN_STAGE = [["move", "#waiting", "append", "#stage"]];
/** 2 回目の置き方: 画面の格子の「主役の場所」の枠に重ねる（元のページの層の上。見出しと右の欄は覆わない） */
const ON_STAGE = [["move", "#waiting", "append", "#app"]];
const ON_STAGE_CSS = `#waiting { position: relative; inset: auto; grid-area: stage; z-index: 5; }`;
const SCRIM = `background: color-mix(in srgb, var(--bg) 62%, transparent); backdrop-filter: blur(2px);`;
// 輪（--ratio を円周に。数は輪の中に重ねる: 同じ格子の枠に置く）
const RING = (size, width) => `width: ${size}px; height: ${size}px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--ratio, 0) * 360deg), var(--rule-soft) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - ${width}px), #000 calc(100% - ${width - 1}px)); mask: radial-gradient(farthest-side, transparent calc(100% - ${width}px), #000 calc(100% - ${width - 1}px));`;
const STEPS_CSS = `
  #pv-steps { margin: 2px 0; padding: 0; list-style: none; display: grid; gap: 7px; font-size: var(--fs-m); }
  #pv-steps li { display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: center; color: var(--muted); }
  #pv-steps i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--rule); justify-self: center; }
  #pv-steps .is-done { color: var(--ink); } #pv-steps .is-done i { background: var(--ok); border-color: var(--ok); }
  #pv-steps .is-now { color: var(--ink); font-weight: 600; } #pv-steps .is-now i { border-color: var(--accent); border-right-color: transparent; animation: pv-spin 1s linear infinite; }
  #pv-steps b { font: 500 var(--fs-s) var(--font-num); color: var(--muted); margin-left: 6px; }
  @keyframes pv-spin { to { transform: rotate(360deg); } }`;

export const PROPOSALS = [
  {
    key: "A", name: "全面の待ちモーダル（WAITING）: 画面全体を薄く覆い、中央のカードに見出し・棒・段階・数・経過・取りやめる",
    css: `${BASE}`,
    ops: [],
  },
  {
    key: "B", name: "主役の場所だけのモーダル: 3D・図面の場所だけを覆い、中央のカード。見出しと右の欄は読める・押せる",
    css: `${BASE} ${ON_STAGE_CSS}
      #waiting { background: color-mix(in srgb, var(--bg) 62%, transparent); backdrop-filter: blur(2px); }
      .waiting-card { box-shadow: 0 12px 40px rgba(16, 24, 40, 0.18); border: 1px solid var(--rule); }`,
    ops: ON_STAGE,
  },
  {
    key: "C", name: "上の細い線と見出しの札: 見出しの下の全幅に進み具合の線、見出しの中央に「何をしているか・数・経過・取りやめる」の札",
    css: `${BASE}
      #waiting { position: fixed; inset: 0 0 auto 0; height: 0; background: none; display: block; z-index: 40; }
      .waiting-card { position: fixed; top: 9px; left: 50%; transform: translateX(-50%); width: auto; max-width: 52vw; display: flex; align-items: center; gap: 12px;
        padding: 5px 6px 5px 14px; border-radius: 999px; border: 1px solid var(--rule); box-shadow: var(--shadow-1); white-space: nowrap; }
      .waiting-title, #waiting-detail { display: none; }
      .waiting-bar { position: fixed; top: 66px; left: 0; right: 0; height: 3px; border-radius: 0; background: transparent; }
      .waiting-meta { gap: 10px; font-size: var(--fs-s); } .waiting-time { font-size: var(--fs-s); }
      #waiting-cancel { padding: 3px 10px; font-size: var(--fs-s); }`,
    ops: [],
  },
  {
    key: "D", name: "右下の進み具合のカード（通知型）: 主役の場所の右下に小さなカード。見ている物は覆わない",
    css: `${BASE}
      #waiting { position: absolute; inset: auto 20px 20px auto; background: none; display: block; z-index: 30; }
      .waiting-card { width: 360px; padding: 14px 16px; border: 1px solid var(--rule); box-shadow: 0 10px 30px rgba(16, 24, 40, 0.16); gap: 6px; }`,
    ops: IN_STAGE,
  },
  {
    key: "E", name: "主役の場所の中央に大きな輪: 何 % かを輪と大きな数で示す（読む量を減らし、一目で量が分かる）",
    css: `${BASE} ${ON_STAGE_CSS}
      #waiting { background: color-mix(in srgb, var(--bg) 70%, transparent); }
      .waiting-card { background: none; box-shadow: none; width: 360px; justify-items: center; text-align: center; gap: 10px; grid-template-areas: "title" "detail" "ring" "meta" "time" "cancel"; }
      .waiting-title { grid-area: title; font-size: var(--fs-xl); } #waiting-detail { grid-area: detail; }
      .waiting-bar { grid-area: ring; width: 132px; height: 132px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--ratio, 0) * 360deg), var(--rule-soft) 0);
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 9px)); mask: radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 9px)); }
      .waiting-bar i { display: none; }
      .waiting-meta { grid-area: meta; flex-direction: column; align-items: center; gap: 2px; }
      .waiting-count { order: -1; font: 600 22px var(--font-num); color: var(--ink); margin-top: -96px; margin-bottom: 64px; }
      .waiting-time { grid-area: time; } #waiting-cancel { grid-area: cancel; justify-self: center; }`,
    ops: ON_STAGE,
  },
  {
    key: "F", name: "【方向の違う案】段階の一覧: 何をどの順で進めているか（済んだ・いま・この後）を並べ、いまの段階に数を添える",
    css: `${BASE} ${ON_STAGE_CSS}
      #waiting { background: color-mix(in srgb, var(--bg) 62%, transparent); backdrop-filter: blur(2px); }
      .waiting-card { width: 420px; border: 1px solid var(--rule); box-shadow: 0 12px 40px rgba(16, 24, 40, 0.18); }
      .waiting-meta { display: none; }
      #pv-steps { margin: 4px 0 2px; padding: 0; list-style: none; display: grid; gap: 8px; font-size: var(--fs-m); }
      #pv-steps li { display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: center; color: var(--muted); }
      #pv-steps i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--rule); justify-self: center; }
      #pv-steps .is-done { color: var(--ink); } #pv-steps .is-done i { background: var(--ok); border-color: var(--ok); }
      #pv-steps .is-now { color: var(--ink); font-weight: 600; } #pv-steps .is-now i { border-color: var(--accent); border-right-color: transparent; animation: pv-spin 1s linear infinite; }
      #pv-steps b { font: 500 var(--fs-s) var(--font-num); color: var(--muted); margin-left: 6px; }
      @keyframes pv-spin { to { transform: rotate(360deg); } }`,
    ops: [...ON_STAGE, ["insert", `<ol id="pv-steps"></ol>`, "afterend", "#waiting-detail"], ["script", STEP_SCRIPT]],
  },
  {
    key: "G", name: "【方向の違う案】骨組みの先出し: 覆わずに、できあがる物の骨組み（淡い形・欄の行）を先に見せ、下の帯に数と取りやめる",
    css: `${BASE}
      #waiting { position: absolute; inset: auto 0 0 0; background: none; display: block; z-index: 30; pointer-events: none; }
      .waiting-card { pointer-events: auto; width: auto; margin: 0 auto 18px; max-width: 760px; display: grid; grid-template-columns: auto 1fr auto auto; grid-template-areas: "title bar meta cancel" "detail bar time cancel";
        align-items: center; column-gap: 14px; row-gap: 0; padding: 10px 12px 10px 18px; border: 1px solid var(--rule); box-shadow: var(--shadow-1); }
      .waiting-title { grid-area: title; } #waiting-detail { grid-area: detail; } .waiting-bar { grid-area: bar; min-width: 180px; }
      .waiting-meta { grid-area: meta; } .waiting-time { grid-area: time; text-align: right; } #waiting-cancel { grid-area: cancel; }
      #pv-ghost { position: absolute; inset: 120px 80px 120px 80px; display: grid; place-items: center; pointer-events: none; }
      #pv-ghost svg { width: min(46%, 520px); height: auto; color: var(--rule); animation: pv-breathe 1.8s ease-in-out infinite; }
      @keyframes pv-breathe { 50% { opacity: 0.45; } }
      .pv-skel { display: grid; gap: 10px; margin-top: 8px; } .pv-skel i { height: 34px; border-radius: 8px; background: linear-gradient(90deg, var(--rule-soft), var(--surface-2), var(--rule-soft)); background-size: 200% 100%; animation: pv-shine 1.4s linear infinite; }
      @keyframes pv-shine { to { background-position: -200% 0; } }`,
    ops: [...IN_STAGE,
      ["insert", `<div id="pv-ghost" aria-hidden="true"><svg viewBox="0 0 240 200" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M40 70 120 25 200 70 120 115z"/><path d="M40 70v60l80 45v-60zM200 70v60l-80 45"/></svg></div>`, "beforeend", "#stage"],
      ["script", `const host = [...document.querySelectorAll(".side .panel-mode:not([hidden]) ul, .side ul")].find((el) => el.offsetParent); if (host) host.insertAdjacentHTML("afterend", '<div class="pv-skel"><i></i><i></i><i></i><i></i></div>');`]],
  },

  // ---- 2 回目: 組合せ 4 案（H〜K）と、1 回目の上位 3 案（E・B・F。置き方だけ ON_STAGE に直した）----
  {
    key: "H", name: "【組合せ】B の主役の場所だけのモーダル × E の輪: 横長のカード（左に輪と数、右に何をしているか・経過・取りやめる）",
    css: `${BASE} ${ON_STAGE_CSS} #waiting { ${SCRIM} }
      .waiting-card { width: 480px; grid-template-columns: 104px 1fr; grid-template-areas: "ring title" "ring detail" "ring meta" "ring time" "ring cancel"; column-gap: 20px; row-gap: 4px;
        border: 1px solid var(--rule); box-shadow: 0 12px 40px rgba(16, 24, 40, 0.18); align-items: center; }
      .waiting-title { grid-area: title; } #waiting-detail { grid-area: detail; } .waiting-meta { grid-area: meta; } .waiting-time { grid-area: time; } #waiting-cancel { grid-area: cancel; justify-self: start; }
      .waiting-bar { grid-area: ring; ${RING(104, 9)} } .waiting-bar i { display: none; }
      #waiting-count { grid-area: ring; place-self: center; font: 600 17px var(--font-num); color: var(--ink); }`,
    ops: [...ON_STAGE, ["move", "#waiting-count", "append", ".waiting-card"]],
  },
  {
    key: "I", name: "【組合せ】B × F: 主役の場所だけのモーダル。段階を 1 行の道のり（済んだ ✓・いま ◐ 数・この後 ○）にし、下に棒と経過",
    css: `${BASE} ${ON_STAGE_CSS} #waiting { ${SCRIM} }
      .waiting-card { width: 560px; border: 1px solid var(--rule); box-shadow: 0 12px 40px rgba(16, 24, 40, 0.18); }
      .waiting-meta { display: none; }
      #pv-steps { margin: 6px 0 4px; padding: 0; list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 4px; font-size: var(--fs-s); }
      #pv-steps li { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border-radius: 999px; color: var(--muted); background: var(--surface-2); }
      #pv-steps li + li::before { content: ""; width: 14px; height: 1px; background: var(--rule); margin: 0 6px 0 -10px; }
      #pv-steps i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--rule); }
      #pv-steps .is-done { color: var(--ink); } #pv-steps .is-done i { background: var(--ok); border-color: var(--ok); }
      #pv-steps .is-now { color: var(--accent-ink, #fff); background: var(--accent); font-weight: 600; } #pv-steps .is-now i { border-color: #fff; border-right-color: transparent; animation: pv-spin 1s linear infinite; }
      #pv-steps b { font: 500 var(--fs-xs) var(--font-num); margin-left: 4px; }
      @keyframes pv-spin { to { transform: rotate(360deg); } }`,
    ops: [...ON_STAGE, ["insert", `<ol id="pv-steps"></ol>`, "afterend", "#waiting-detail"], ["script", STEP_SCRIPT]],
  },
  {
    key: "J", name: "【組合せ】E × F: カードを使わず、主役の場所の中央に輪と数、その下に段階の一覧（済んだ・いま・この後）",
    css: `${BASE} ${ON_STAGE_CSS} ${STEPS_CSS} #waiting { background: color-mix(in srgb, var(--bg) 80%, transparent); backdrop-filter: blur(3px); }
      .waiting-card { background: none; box-shadow: none; width: 380px; justify-items: center; text-align: center; gap: 10px;
        grid-template-areas: "title" "detail" "ring" "steps" "time" "cancel"; }
      .waiting-title { grid-area: title; font-size: var(--fs-xl); } #waiting-detail { grid-area: detail; }
      .waiting-bar { grid-area: ring; ${RING(120, 9)} } .waiting-bar i { display: none; }
      #waiting-count { grid-area: ring; place-self: center; font: 600 20px var(--font-num); color: var(--ink); }
      .waiting-meta { display: none; } #pv-steps { grid-area: steps; justify-self: center; text-align: left; } .waiting-time { grid-area: time; } #waiting-cancel { grid-area: cancel; justify-self: center; }`,
    ops: [...ON_STAGE, ["move", "#waiting-count", "append", ".waiting-card"], ["insert", `<ol id="pv-steps"></ol>`, "beforeend", ".waiting-card"], ["script", STEP_SCRIPT]],
  },
  {
    key: "K", name: "【組合せ】B × E × F: 主役の場所だけのモーダル。見出しの左に小さな輪、下に段階の一覧（いまの段階に数）、経過と取りやめる",
    css: `${BASE} ${ON_STAGE_CSS} ${STEPS_CSS} #waiting { ${SCRIM} }
      .waiting-card { width: 440px; grid-template-columns: 52px 1fr; grid-template-areas: "ring title" "ring detail" "steps steps" "time cancel"; column-gap: 14px; row-gap: 6px;
        border: 1px solid var(--rule); box-shadow: 0 12px 40px rgba(16, 24, 40, 0.18); align-items: center; }
      .waiting-title { grid-area: title; align-self: end; } #waiting-detail { grid-area: detail; align-self: start; }
      .waiting-bar { grid-area: ring; ${RING(52, 6)} } .waiting-bar i { display: none; }
      .waiting-meta { display: none; } #pv-steps { grid-area: steps; margin-top: 6px; } .waiting-time { grid-area: time; } #waiting-cancel { grid-area: cancel; }`,
    ops: [...ON_STAGE, ["insert", `<ol id="pv-steps"></ol>`, "beforeend", ".waiting-card"], ["script", STEP_SCRIPT]],
  },
];
