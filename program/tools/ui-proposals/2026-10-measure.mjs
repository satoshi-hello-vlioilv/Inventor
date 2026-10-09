// 2026-10（2D で選ぶ・測る）: 図面で図形を選んで性質を読み、2 点を測る画面の案。見本の図面 A1_円筒_部品図.dxf（状態 drawing）で描く。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-measure.mjs --states drawing --themes light,dark
// どの案も同じ場面: φ52.5 の外形の円を選んでいる・円の中心から P.C.D. φ40 の穴の中心までを測った（20 mm・45°）・「測る」を押している。
// 値は viewer2d/snap.js で見本から求めたもの（snap.test.mjs と同じ）。図の上の印は、利用者の画面（1728×1152）での位置（CSS px）に置く。
// 比べること: 選んだ図形の性質と測った結果が、どこに・どう出るか（目を動かす量）・いま何をしているか（測る途中か）が分かるか・図を隠さないか

const C = [804, 516], H = [854, 467], R = 95; // 円の中心・穴の中心・円の半径（画面）
const SELECTED = [["種類", "円"], ["中心", "140, 0"], ["直径", "52.5 mm"], ["半径", "26.25 mm"], ["周長", "164.934 mm"], ["面積", "2,164.75 mm²"], ["画層", "外形線"]];
const MEASURED = [["距離", "20 mm"], ["横（X）", "14.142 mm"], ["縦（Y）", "14.142 mm"], ["角度", "45°"]];
const dl = (rows) => `<dl class="mx-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

/** 図の上の印（選んだ円の強調・測った線・吸い付いた点）。label: 線の中ほどの札の文字 */
const overlay = ({ label = "20 mm", dims = false, marker = true } = {}) => {
  const mid = [(C[0] + H[0]) / 2, (C[1] + H[1]) / 2];
  const dimLine = dims
    ? `<line class="mx-ext" x1="${C[0]}" y1="${C[1]}" x2="${C[0] - 18}" y2="${C[1] - 18}"/><line class="mx-ext" x1="${H[0]}" y1="${H[1]}" x2="${H[0] - 18}" y2="${H[1] - 18}"/>
       <line class="mx-dim" x1="${C[0] - 14}" y1="${C[1] - 14}" x2="${H[0] - 14}" y2="${H[1] - 14}" marker-start="url(#mx-arrow)" marker-end="url(#mx-arrow)"/>
       <text class="mx-dimtext" x="${mid[0] - 30}" y="${mid[1] - 26}" transform="rotate(-45 ${mid[0] - 30} ${mid[1] - 26})">20</text>`
    : `<line class="mx-line" x1="${C[0]}" y1="${C[1]}" x2="${H[0]}" y2="${H[1]}"/>`;
  return `<svg class="mx-svg" width="100%" height="100%"><defs><marker id="mx-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 2 L10 5 L0 8 z" class="mx-arrowhead"/></marker></defs>
    <circle class="mx-sel" cx="${C[0]}" cy="${C[1]}" r="${R}"/>
    ${dimLine}
    <circle class="mx-pt" cx="${C[0]}" cy="${C[1]}" r="4"/><circle class="mx-pt" cx="${H[0]}" cy="${H[1]}" r="4"/>
    ${marker ? `<rect class="mx-snap" x="${H[0] - 7}" y="${H[1] - 7}" width="14" height="14" rx="7"/><text class="mx-snaptext" x="${H[0] + 12}" y="${H[1] - 10}">中心</text>` : ""}
    ${label && !dims ? `<g transform="translate(${mid[0] + 10},${mid[1] + 4})"><rect class="mx-tag" x="0" y="-13" width="${label.length * 8 + 16}" height="22" rx="6"/><text class="mx-tagtext" x="8" y="3">${label}</text></g>` : ""}
  </svg>`;
};

const script = (body) => `(function put() {
  if (document.getElementById("file-name")?.textContent !== "A1_円筒_部品図.dxf" || !document.querySelector("#layers li")) { setTimeout(put, 200); return; }
  if (document.getElementById("mx-x")) return;
  const x = document.createElement("div"); x.id = "mx-x"; document.body.append(x);
  const tools = document.getElementById("toggle-lineweight").parentElement;
  const measure = document.createElement("button"); measure.type = "button"; measure.className = "is-check mx-measure"; measure.setAttribute("aria-pressed", "true");
  measure.innerHTML = '測る <kbd>M</kbd>'; tools.insertBefore(measure, document.getElementById("fit"));
  const chip = document.querySelector("#readout .chip"); if (chip) chip.textContent = "1 点目をクリック（端点・中点・中心・交点に吸い付く）· Esc でやめる";
  ${body}
})();`;
const card = (title, note, html) => `<section class="card mx-card"><h2>${title}<span class="h-note">${note}</span></h2>${html}</section>`;
const before = (html) => `document.querySelector('[data-mode="drawing"].key-card').insertAdjacentHTML("afterend", ${JSON.stringify(html)});`;
const over = (o) => `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(`<div class="mx-over">${overlay(o)}</div>`)});`;

const A = script(over({}) + before(card("選んだ図形", "Esc で外す", dl(SELECTED)) + card("測った結果", "中心 → 中心", dl(MEASURED))));
const B = script(over({ label: "" }) + `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(
  `<div class="mx-pop" style="left:${C[0] + R + 16}px;top:${C[1] - 70}px"><b>円 · φ52.5 mm</b>${dl(SELECTED.slice(1, 6))}</div>` +
  `<div class="mx-pop is-measure" style="left:${H[0] + 20}px;top:${H[1] - 120}px"><b>20 mm</b><span>横 14.142 · 縦 14.142 · 45°</span></div>`)});`);
const Cc = script(over({}) + `const r = document.getElementById("readout"); r.classList.add("mx-wide"); r.innerHTML = ${JSON.stringify(
  `<span class="chip mx-row"><b>選んだ図形</b> 円 · 中心 140, 0 · φ52.5 mm · 周長 164.934 mm · 面積 2,164.75 mm² · 画層 外形線</span><span class="chip mx-row is-measure"><b>測った結果</b> 20 mm · 横 14.142 · 縦 14.142 · 45°（中心 → 中心）</span>`)};`);
const D = script(over({}) + `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(
  `<div class="mx-band"><b>測る</b><span>2 点目をクリック · 吸い付く点: 端点・中点・中心・交点</span><span class="mx-band-result">20 mm · 横 14.142 · 縦 14.142 · 45°</span><button type="button">やめる（Esc）</button></div>`)});` +
  before(card("選んだ図形", "Esc で外す", dl(SELECTED))));
const E = script(over({ label: "①" }) + before(card("測った結果", "Del で消す",
  `<ol class="mx-list"><li><b>① 20 mm</b><span>中心 → 中心 · 横 14.142 · 縦 14.142 · 45°</span></li><li><b>② 77 mm</b><span>端点 → 端点 · 横 77 · 縦 0 · 0°</span></li></ol><button type="button" class="quiet">全て消す</button>`) +
  card("選んだ図形", "Esc で外す", dl(SELECTED))));
const F = script(over({ dims: true }) + before(card("選んだ図形", "Esc で外す", dl(SELECTED))));

// 複合案: 「測る」はチェックの見た目ではなく、押した状態のボタン（モード）にする
const toggle = `const mb = document.querySelector(".mx-measure"); mb.classList.remove("is-check"); mb.classList.add("mx-mode");`;
const band = (text) => `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(`<div class="mx-band"><b>測る</b><span>${text}</span><button type="button">やめる（Esc）</button></div>`)});`;
// G（D＋A）: 帯は測る途中の案内だけ（短く）。結果と選んだ図形は欄のカード
const PG = script(toggle + over({}) + band("2 点目をクリック · 端点・中点・中心・交点に吸い付く") +
  before(card("測った結果", "中心 → 中心", dl(MEASURED)) + card("選んだ図形", "Esc で外す", dl(SELECTED))));
// H（D＋E）: 帯＋番号つきの結果の一覧
const PH = script(toggle + over({ label: "① 20 mm" }) + band("2 点目をクリック · 端点・中点・中心・交点に吸い付く") + before(card("測った結果", "Del で消す",
  `<ol class="mx-list"><li><b>① 20 mm</b><span>中心 → 中心 · 横 14.142 · 縦 14.142 · 45°</span></li><li><b>② 77 mm</b><span>端点 → 端点 · 横 77 · 縦 0 · 0°</span></li></ol>`) +
  card("選んだ図形", "Esc で外す", dl(SELECTED))));
// I（A＋ツールバーの案内）: 帯を出さず、「測る」の横の文字（マウスの案内の場所）で案内する
const PI = script(toggle + over({}) + `const help = document.querySelector('.mouse-help[data-mode="drawing"]'); help.textContent = "測る: 2 点目をクリック（端点・中点・中心・交点に吸い付く）· Esc でやめる"; help.classList.add("mx-help");` +
  before(card("測った結果", "中心 → 中心", dl(MEASURED)) + card("選んだ図形", "Esc で外す", dl(SELECTED))));

const BASE = `.mx-mode[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.mx-help { color: var(--accent); font-weight: 600; background: var(--accent-soft); }
.mx-over { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
.mx-svg { position: absolute; inset: 0; }
.mx-sel { fill: none; stroke: var(--accent); stroke-width: 3; }
.mx-line { stroke: var(--accent); stroke-width: 2; stroke-dasharray: 6 4; }
.mx-pt { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.mx-snap { fill: none; stroke: var(--caution-ink); stroke-width: 2; }
.mx-snaptext { font: 600 12px var(--font-ui); fill: var(--caution-ink); }
.mx-tag { fill: var(--accent); } .mx-tagtext { font: 600 13px var(--font-num); fill: var(--accent-ink, #fff); }
.mx-ext { stroke: var(--accent); stroke-width: 1; } .mx-dim { stroke: var(--accent); stroke-width: 1.5; } .mx-arrowhead { fill: var(--accent); }
.mx-dimtext { font: 600 14px var(--font-num); fill: var(--accent); }
.mx-measure { font-weight: 600; } .mx-measure kbd { margin-left: 4px; }
.mx-dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; font-size: var(--fs-s); }
.mx-dl dt { color: var(--muted); } .mx-dl dd { margin: 0; font-family: var(--font-num); }
.mx-pop { position: fixed; z-index: 60; background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 10px 12px; box-shadow: var(--shadow-2, 0 8px 24px rgba(0,0,0,.18)); display: grid; gap: 6px; font-size: var(--fs-s); }
.mx-pop.is-measure { border-color: var(--accent); } .mx-pop.is-measure b { font: 700 18px var(--font-num); color: var(--accent); } .mx-pop span { color: var(--muted); }
.mx-wide { max-width: calc(100% - 140px); display: grid; gap: 4px; } .mx-row { white-space: normal; } .mx-row b { margin-right: 8px; } .mx-row.is-measure { border-color: var(--accent); }
.mx-band { position: fixed; left: 50%; top: 130px; transform: translateX(-50%); z-index: 60; display: flex; align-items: center; gap: 14px; padding: 8px 14px; background: var(--surface); border: 1px solid var(--accent); border-radius: 10px; box-shadow: var(--shadow-1); font-size: var(--fs-s); }
.mx-band b { color: var(--accent); } .mx-band span { color: var(--muted); } .mx-band .mx-band-result { color: var(--ink); font-family: var(--font-num); font-weight: 600; }
.mx-band button { font: 500 var(--fs-s) var(--font-ui); border: 1px solid var(--rule); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 3px 10px; }
.mx-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-size: var(--fs-s); } .mx-list li { display: grid; } .mx-list b { font-family: var(--font-num); } .mx-list span { color: var(--muted); font-size: var(--fs-xs); }`;

export const PROPOSALS = [
  { key: "A", name: "欄に「選んだ図形」「測った結果」のカード", css: BASE, ops: [["script", A]] },
  { key: "B", name: "図の上の吹き出し", css: BASE, ops: [["script", B]] },
  { key: "C", name: "下の読み出しを 2 段に", css: BASE, ops: [["script", Cc]] },
  { key: "D", name: "測るモードの帯＋選んだ図形のカード", css: BASE, ops: [["script", D]] },
  { key: "E", name: "測った結果の一覧（番号つき）", css: BASE, ops: [["script", E]] },
  { key: "F", name: "測った結果を図面の寸法の見た目で描く", css: BASE, ops: [["script", F]] },
  { key: "G", name: "D＋A（帯は案内だけ・結果は欄のカード）", css: BASE, ops: [["script", PG]] },
  { key: "H", name: "D＋E（帯＋番号つきの一覧）", css: BASE, ops: [["script", PH]] },
  { key: "I", name: "A＋ツールバーの案内（帯なし）", css: BASE, ops: [["script", PI]] },
];
