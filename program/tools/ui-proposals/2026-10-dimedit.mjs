// 2026-10（寸法を直す画面）: 変換データ（.inventor.json）の部品の寸法を、画面で直す案。実物のデータ（試験の変換データ blade の刃）で描く。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-dimedit.mjs --states specedit --themes light,dark
// 寸法と断面は convert/dimensions.js の dimensionsOf と、変換データの断面（sketch.loops）を書き出したもの（DATA に埋め込む）。
// どの案も「直径を 240 → 250 に変えた直後」を描く（一緒に変わった寸法: 外形の幅 240 → 250。取り消しができる）。
// 比べること: 寸法がどの辺かが分かるか（斜めの辺が 6 つ）・直せない寸法（13 のうち 8）に埋もれないか・一緒に変わった寸法と取り消しが見えるか・3D と並ぶか

const DATA = {"loops":[[{"t":"c","c":[0,0],"r":120}],[{"t":"l","a":[-10.453,99.452],"b":[-10.044,99.745]},{"t":"l","a":[-10.044,99.745],"b":[-10,103.854]},{"t":"l","a":[-10,103.854],"b":[-9.74,106]},{"t":"l","a":[-9.74,106],"b":[9.74,106]},{"t":"l","a":[9.74,106],"b":[10,103.854]},{"t":"l","a":[10,103.854],"b":[10.044,99.745]},{"t":"l","a":[10.044,99.745],"b":[10.453,99.452]},{"t":"a","a":[10.453,99.452],"b":[-10.453,99.452],"c":[0,0],"ccw":false}]],"dims":[{"id":"t","kind":"thickness","label":"厚さ","value":5,"editable":true,"reason":null,"at":null},{"id":"S","kind":"scale","label":"外形の幅（形を保って拡大・縮小）","value":240,"editable":true,"reason":null,"at":null},{"id":"D0.0","kind":"diameter","label":"直径","value":240,"editable":true,"reason":null,"at":{"loop":0,"seg":0}},{"id":"L1.0","kind":"length","label":"斜めの辺","value":0.503,"editable":false,"reason":"この辺を伸ばすと円弧の形が保てないため、直せません","at":{"loop":1,"seg":0}},{"id":"L1.1","kind":"length","label":"斜めの辺","value":4.109,"editable":false,"reason":"この辺を伸ばすと斜めの辺の角度が変わるため、直せません","at":{"loop":1,"seg":1}},{"id":"L1.2","kind":"length","label":"斜めの辺","value":2.162,"editable":false,"reason":"この辺を伸ばすと斜めの辺の角度が変わるため、直せません","at":{"loop":1,"seg":2}},{"id":"L1.3","kind":"length","label":"横の辺","value":19.48,"editable":false,"reason":"この辺を伸ばすと円弧の形が保てないため、直せません","at":{"loop":1,"seg":3}},{"id":"L1.4","kind":"length","label":"斜めの辺","value":2.162,"editable":false,"reason":"この辺を伸ばすと斜めの辺の角度が変わるため、直せません","at":{"loop":1,"seg":4}},{"id":"L1.5","kind":"length","label":"斜めの辺","value":4.109,"editable":false,"reason":"この辺を伸ばすと斜めの辺の角度が変わるため、直せません","at":{"loop":1,"seg":5}},{"id":"L1.6","kind":"length","label":"斜めの辺","value":0.503,"editable":false,"reason":"この辺を伸ばすと円弧の形が保てないため、直せません","at":{"loop":1,"seg":6}},{"id":"R1.7","kind":"radius","label":"角の丸み","value":100,"editable":false,"reason":"両側の直線に接していない円弧は直せません","at":{"loop":1,"seg":7}},{"id":"C0","kind":"chamfer","label":"面取り（穴 1の縁・下面）","value":1,"editable":true,"reason":null,"at":{"loop":1}},{"id":"C1","kind":"chamfer","label":"面取り（穴 1の縁・上面）","value":1,"editable":true,"reason":null,"at":{"loop":1}}]};

// 寸法の置き場所（全体・外周・穴 n）。直せる寸法を先に、直せない寸法は理由とともに畳む
const PLACE = (d) => (!d.at ? "全体" : d.at.loop === 0 ? "外周" : `穴 ${d.at.loop}`);
const fmt = (v) => String(Math.round(v * 1000) / 1000);
const CHANGED = { "D0.0": 250, S: 250 }; // 直した後の値
const BEFORE = { "D0.0": 240, S: 240 };
const UNIT = (d) => (d.kind === "angle" ? "°" : "mm");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const editable = DATA.dims.filter((d) => d.editable);
const fixed = DATA.dims.filter((d) => !d.editable);
const number = new Map(editable.map((d, i) => [d.id, i + 1])); // 断面図の番号

// ---- 断面図（SVG）: 線・円弧・円。focus の辺を強調、markers に番号 ----
function sketch({ w, h, focus = null, markers = true, zoom = null, labels = false }) {
  const pts = DATA.loops.flat().flatMap((s) => (s.t === "c" ? [[s.c[0] - s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] + s.r]] : [s.a, s.b]));
  const box = zoom ?? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const pad = 18, k = Math.min((w - 2 * pad) / (box[2] - box[0]), (h - 2 * pad) / (box[3] - box[1]));
  const ox = (w - (box[2] - box[0]) * k) / 2, oy = (h - (box[3] - box[1]) * k) / 2;
  const X = (x) => ox + (x - box[0]) * k, Y = (y) => h - (oy + (y - box[1]) * k);
  const seg = (s, cls) => {
    if (s.t === "l") return `<line class="${cls}" x1="${X(s.a[0])}" y1="${Y(s.a[1])}" x2="${X(s.b[0])}" y2="${Y(s.b[1])}"/>`;
    if (s.t === "c") return `<circle class="${cls}" cx="${X(s.c[0])}" cy="${Y(s.c[1])}" r="${s.r * k}"/>`;
    const r = Math.hypot(s.a[0] - s.c[0], s.a[1] - s.c[1]) * k;
    const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
    let sweep = s.ccw ? a1 - a0 : a0 - a1; if (sweep < 0) sweep += 2 * Math.PI;
    return `<path class="${cls}" d="M${X(s.a[0])} ${Y(s.a[1])} A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} ${s.ccw ? 0 : 1} ${X(s.b[0])} ${Y(s.b[1])}"/>`;
  };
  const on = (d) => d.at && focus && d.at.loop === focus.loop && (focus.seg === undefined || d.at.seg === focus.seg);
  let body = DATA.loops.map((loop, li) => loop.map((s, si) => seg(s, focus && focus.loop === li && (focus.seg === undefined || focus.seg === si) ? "sk-line is-focus" : "sk-line")).join("")).join("");
  if (markers) {
    for (const d of editable.filter((d) => d.at && d.kind !== "chamfer")) {
      const s = DATA.loops[d.at.loop][d.at.seg];
      const p = s.t === "c" ? [s.c[0] + s.r * Math.cos(0.8), s.c[1] + s.r * Math.sin(0.8)] : [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
      const text = labels ? `${d.label} ${fmt(CHANGED[d.id] ?? d.value)}` : number.get(d.id);
      body += `<g class="sk-mark${on(d) ? " is-focus" : ""}${CHANGED[d.id] ? " is-changed" : ""}" transform="translate(${X(p[0])},${Y(p[1])})">` +
        (labels ? `<rect x="6" y="-12" width="${text.length * 8 + 12}" height="22" rx="6"/><text x="12" y="4">${esc(text)}</text>` : `<circle r="10"/><text y="4">${text}</text>`) + "</g>";
    }
  }
  return `<svg class="sk" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="断面図">${body}</svg>`;
}

// ---- 寸法の欄 ----
// 見出し（置き場所）と重なる言葉を省いた短い名前と、添える説明（複合案 G・H・I）
const SHORT = (d) => (d.kind === "scale" ? "外形の幅" : d.kind === "chamfer" ? d.label.replace(/（穴 \d+の縁・(.+)）/, "（$1）") : d.label);
const NOTE = { scale: "形を保って拡大・縮小" };
const field = (d, { num = false, compact = false, short = false } = {}) => {
  const v = CHANGED[d.id] ?? d.value, changed = d.id in CHANGED;
  const place = PLACE(d);
  return `<li class="dm-row${changed ? " is-changed" : ""}${d.id === "D0.0" ? " is-focus" : ""}">` +
    (num && number.has(d.id) && d.at && d.kind !== "chamfer" ? `<span class="dm-num">${number.get(d.id)}</span>` : num ? '<span class="dm-num is-none"></span>' : "") +
    `<span class="dm-label">${compact ? "" : `<small>${place}</small>`}${esc(short ? SHORT(d) : d.label)}${short && NOTE[d.kind] ? `<small class="dm-note">${NOTE[d.kind]}</small>` : ""}</span>` +
    `<span class="dm-input"><input value="${fmt(v)}" inputmode="decimal" aria-label="${esc(d.label)}"><em>${UNIT(d)}</em></span>` +
    (changed ? `<span class="dm-was">← ${fmt(BEFORE[d.id])}</span>` : '<span class="dm-was"></span>') + "</li>";
};
const fixedList = (open = false) => `<details class="dm-fixed"${open ? " open" : ""}><summary>直せない寸法 ${fixed.length}<span>（角度や円弧の形が保てない）</span></summary><ul>` +
  fixed.map((d) => `<li title="${esc(d.reason)}"><span>${PLACE(d)} · ${esc(d.label)}</span><b>${fmt(d.value)}</b></li>`).join("") + "</ul></details>";
const grouped = (opts) => ["全体", "外周", "穴 1"].map((g) => {
  const list = editable.filter((d) => PLACE(d) === g);
  return list.length ? `<li class="dm-group"><h4>${g}</h4><ul>${list.map((d) => field(d, { ...opts, compact: true })).join("")}</ul></li>` : "";
}).join("");
const toolbar = (extra = "") => `<div class="dm-bar"><span class="dm-count">変更 1 件</span><button class="dm-btn" title="取り消す（Ctrl+Z）">↶ 取り消す</button><button class="dm-btn" disabled title="やり直す（Ctrl+Y）">↷ やり直す</button>${extra}</div>`;
const linked = '<p class="dm-linked">一緒に変わった寸法: 外形の幅 240 → 250（外径と同じ）</p>';
const save = '<button class="dm-save secondary">直した変換データを保存</button>';

/** 頁の中で: 刃の変換データが開き、部品の行が出てから挿入する */
const insert = (fn) => `(function put() {
  if (document.getElementById("file-name")?.textContent !== "blade.inventor.json" || !document.querySelector("#parts li")) { setTimeout(put, 200); return; }
  if (document.getElementById("dm-x")) return;
  (${fn})();
})();`;

const BASE = `
.sk { display: block; max-width: 100%; height: auto; background: var(--surface-2); border-radius: 8px; }
.sk-line { fill: none; stroke: var(--muted); stroke-width: 1.4; }
.sk-line.is-focus { stroke: var(--accent); stroke-width: 3; }
.sk-mark circle { fill: var(--surface); stroke: var(--muted); stroke-width: 1.2; }
.sk-mark text { font: 600 11px var(--font-num); fill: var(--ink); text-anchor: middle; }
.sk-mark rect { fill: var(--surface); stroke: var(--rule); }
.sk-mark rect + text { text-anchor: start; font: 500 12px var(--font-ui); }
.sk-mark.is-focus circle, .sk-mark.is-focus rect { fill: var(--accent); stroke: var(--accent); }
.sk-mark.is-focus text { fill: var(--accent-ink, #fff); }
#dm-x { display: flex; flex-direction: column; gap: 10px; }
.dm-list, .dm-group ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dm-group h4 { margin: 6px 0 2px; font-size: var(--fs-xs); color: var(--muted); font-weight: 600; letter-spacing: .04em; }
.dm-row { display: grid; grid-template-columns: auto 1fr auto 52px; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; }
.dm-row:not(:has(.dm-num)) { grid-template-columns: 1fr auto 52px; }
.dm-row.is-focus { background: var(--accent-soft); }
.dm-num { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--muted); display: grid; place-items: center; font: 600 11px var(--font-num); color: var(--ink); }
.dm-num.is-none { border: 0; }
.dm-row.is-focus .dm-num { background: var(--accent); border-color: var(--accent); color: var(--accent-ink, #fff); }
.dm-label { font-size: var(--fs-s); min-width: 0; }
.dm-label small { display: block; font-size: var(--fs-xs); color: var(--muted); }
.dm-input { display: inline-flex; align-items: baseline; gap: 4px; }
.dm-input input { width: 84px; font: 500 var(--fs-m) var(--font-num); text-align: right; padding: 4px 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); }
.dm-row.is-changed .dm-input input { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.dm-input em { font-style: normal; font-size: var(--fs-xs); color: var(--muted); width: 2em; }
.dm-was { font: 500 var(--fs-xs) var(--font-num); color: var(--muted); }
.dm-fixed { font-size: var(--fs-s); }
.dm-fixed summary { cursor: pointer; color: var(--muted); padding: 4px 6px; }
.dm-fixed summary span { font-size: var(--fs-xs); }
.dm-fixed ul { list-style: none; margin: 0; padding: 0 6px; }
.dm-fixed li { display: flex; justify-content: space-between; padding: 3px 0; color: var(--muted); border-bottom: 1px solid var(--rule-soft); }
.dm-fixed b { font: 500 var(--fs-xs) var(--font-num); }
.dm-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dm-count { font-size: var(--fs-xs); font-weight: 600; color: var(--accent); padding: 2px 8px; border-radius: 99px; background: var(--accent-soft); margin-right: auto; }
.dm-btn { font: 500 var(--fs-s) var(--font-ui); padding: 4px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); cursor: pointer; }
.dm-btn:disabled { color: var(--muted); opacity: .6; }
.dm-linked { margin: 0; font-size: var(--fs-xs); color: var(--muted); padding: 6px 8px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 6px 6px 0; }
.dm-save { align-self: flex-start; }
.dm-head { display: flex; align-items: baseline; gap: 8px; }
.dm-head b { font-size: var(--fs-m); }
.dm-head span { font-size: var(--fs-xs); color: var(--muted); }
.dm-cap { margin: -4px 0 0; font-size: var(--fs-xs); color: var(--muted); }
.dm-note { display: block; font-size: var(--fs-xs); color: var(--muted); }
.dm-back { font: 500 var(--fs-s) var(--font-ui); color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; align-self: flex-start; }
`;

// 部品の行の中に開く（アコーディオン）
const A = insert(`() => {
  const li = document.querySelector("#parts li");
  li.classList.add("is-active");
  const box = document.createElement("div"); box.id = "dm-x"; box.className = "dm-inline";
  box.innerHTML = ${JSON.stringify(toolbar() + '<ul class="dm-list">' + editable.map((d) => field(d)).join("") + "</ul>" + linked + fixedList() + save)};
  li.after(box);
}`);

// 掘り下げ（部品の詳しい欄に切り替え）: 断面図に番号、欄に同じ番号、置き場所で分ける
const B = insert(`() => {
  const list = document.getElementById("parts"); list.hidden = true;
  document.getElementById("spec-tally").hidden = true;
  const box = document.createElement("div"); box.id = "dm-x";
  box.innerHTML = ${JSON.stringify('<button class="dm-back">← 作る部品の一覧（1 種類）</button><div class="dm-head"><b>押し出し 240 × 240 × 5</b><span>刃 · 面取り C1</span></div>' +
    sketch({ w: 400, h: 220, focus: { loop: 0, seg: 0 } }) + toolbar() + '<ul class="dm-list">' + grouped({ num: true }) + "</ul>" + linked + fixedList() + save)};
  list.before(box);
}`);

// 3D の上に浮かぶ寸法の窓（右の欄は今のまま、行を選んだ印）
const C = insert(`() => {
  document.querySelector("#parts li").classList.add("is-active");
  const box = document.createElement("div"); box.id = "dm-x"; box.className = "dm-float";
  box.innerHTML = ${JSON.stringify('<div class="dm-head"><b>寸法を直す</b><span>押し出し 240 × 240 × 5</span></div>' + toolbar() + '<ul class="dm-list">' + editable.map((d) => field(d)).join("") + "</ul>" + linked + fixedList() + save)};
  document.getElementById("stage").append(box);
}`);

// 断面図を主役に（主役の場所で 断面図 ⇄ 3D）: 図の上に寸法の札、札を押して直す。右の欄は置き場所ごとの一覧
const D = insert(`() => {
  const stage = document.getElementById("stage");
  const tabs = document.createElement("div"); tabs.className = "dm-tabs";
  tabs.innerHTML = '<button class="is-on">断面図</button><button>3D</button>';
  const big = document.createElement("div"); big.className = "dm-stage";
  big.innerHTML = ${JSON.stringify(sketch({ w: 1100, h: 760, focus: { loop: 0, seg: 0 }, labels: true }) +
    '<div class="dm-inset"><span>穴 1（拡大）</span>' + sketch({ w: 260, h: 150, zoom: [-14, 97, 14, 108], markers: false }) + "</div>")};
  stage.append(big, tabs);
  const list = document.getElementById("parts"); list.hidden = true;
  const box = document.createElement("div"); box.id = "dm-x";
  box.innerHTML = ${JSON.stringify(toolbar() + '<ul class="dm-list">' + grouped({}) + "</ul>" + linked + fixedList() + save)};
  list.before(box);
}`);

// 下の帯の表（3D の下に、全ての寸法を表で）
const E = insert(`() => {
  const stage = document.getElementById("stage");
  const box = document.createElement("div"); box.id = "dm-x"; box.className = "dm-drawer";
  const rows = ${JSON.stringify(DATA.dims.map((d) => ({ place: PLACE(d), label: d.label, v: fmt(CHANGED[d.id] ?? d.value), unit: UNIT(d), ok: d.editable, why: d.reason ?? "", ch: d.id in CHANGED, was: BEFORE[d.id] })))};
  box.innerHTML = '<div class="dm-drawer-head"><b>寸法</b><span>押し出し 240 × 240 × 5</span>' + ${JSON.stringify(toolbar())} + '</div><div class="dm-table"><table><tr><th>場所</th><th>寸法</th><th>値</th><th>前</th><th>直せるか</th></tr>' +
    rows.map((r) => '<tr class="' + (r.ch ? "is-changed" : "") + (r.ok ? "" : " is-fixed") + '"><td>' + r.place + '</td><td>' + r.label + '</td><td>' + (r.ok ? '<input value="' + r.v + '"> ' + r.unit : r.v) + '</td><td>' + (r.was ?? "") + '</td><td>' + (r.ok ? "直せる" : r.why) + '</td></tr>').join("") + "</table></div>";
  stage.append(box);
}`);

// 掘り下げ（断面図なし）: 置き場所ごとの一覧だけ。行にカーソルを合わせると 3D の辺を強調（読み出しに出す）
const F = insert(`() => {
  const list = document.getElementById("parts"); list.hidden = true;
  document.getElementById("spec-tally").hidden = true;
  const box = document.createElement("div"); box.id = "dm-x";
  box.innerHTML = ${JSON.stringify('<button class="dm-back">← 作る部品の一覧（1 種類）</button><div class="dm-head"><b>押し出し 240 × 240 × 5</b><span>行にカーソルを合わせると 3D で強調</span></div>' +
    toolbar() + '<ul class="dm-list">' + grouped({}) + "</ul>" + linked + fixedList() + save)};
  list.before(box);
  const chip = document.querySelector(".readout-chip, #readout-chip"); if (chip) chip.textContent = "外周 · 直径 250 mm（240 から）";
}`);

// G（B＋F）: 掘り下げ。断面図は番号なしで、選んだ行の辺だけ光らせる。短い名前
const G = insert(`() => {
  const list = document.getElementById("parts"); list.hidden = true;
  document.getElementById("spec-tally").hidden = true;
  const box = document.createElement("div"); box.id = "dm-x";
  box.innerHTML = ${JSON.stringify('<button class="dm-back">← 作る部品の一覧（1 種類）</button><div class="dm-head"><b>押し出し 240 × 240 × 5</b><span>刃 · 面取り C1</span></div>' +
    sketch({ w: 400, h: 190, focus: { loop: 0, seg: 0 }, markers: false }) + '<p class="dm-cap">光っている辺: 外周 · 直径（行にカーソルを合わせると、その辺が光る）</p>' +
    toolbar() + '<ul class="dm-list">' + grouped({ short: true }) + "</ul>" + linked + fixedList() + save)};
  list.before(box);
}`);

// H（B＋D）: 掘り下げ。小さな断面図の上に寸法の札。短い名前
const H = insert(`() => {
  const list = document.getElementById("parts"); list.hidden = true;
  document.getElementById("spec-tally").hidden = true;
  const box = document.createElement("div"); box.id = "dm-x";
  box.innerHTML = ${JSON.stringify('<button class="dm-back">← 作る部品の一覧（1 種類）</button><div class="dm-head"><b>押し出し 240 × 240 × 5</b><span>刃 · 面取り C1</span></div>' +
    sketch({ w: 400, h: 220, focus: { loop: 0, seg: 0 }, labels: true }) +
    toolbar() + '<ul class="dm-list">' + grouped({ short: true }) + "</ul>" + linked + fixedList() + save)};
  list.before(box);
}`);

// I（G＋A）: 部品の行の中に開く。小さな断面図（選んだ行の辺が光る）と置き場所ごとの一覧
const I = insert(`() => {
  const li = document.querySelector("#parts li");
  li.classList.add("is-active");
  const box = document.createElement("div"); box.id = "dm-x"; box.className = "dm-inline";
  box.innerHTML = ${JSON.stringify(sketch({ w: 380, h: 170, focus: { loop: 0, seg: 0 }, markers: false }) + '<p class="dm-cap">光っている辺: 外周 · 直径</p>' +
    toolbar() + '<ul class="dm-list">' + grouped({ short: true }) + "</ul>" + linked + fixedList() + save)};
  li.after(box);
}`);

export const PROPOSALS = [
  { key: "A", name: "部品の行の中に開く", css: BASE + `.dm-inline { padding: 8px 4px 12px 14px; border-left: 3px solid var(--accent); margin: 0 0 8px; }`, ops: [["script", A]] },
  { key: "B", name: "掘り下げ＋断面図に番号", css: BASE, ops: [["script", B]] },
  { key: "C", name: "3D の上に浮かぶ窓", css: BASE + `.dm-float { position: absolute; left: 16px; top: 64px; width: 420px; padding: 14px; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; box-shadow: var(--shadow-2, 0 8px 24px rgba(0,0,0,.18)); z-index: 5; }`, ops: [["script", C]] },
  { key: "D", name: "断面図を主役に（札で直す）", css: BASE + `.dm-stage { position: absolute; inset: 56px 0 0 0; background: var(--bg); display: grid; place-items: center; z-index: 4; }
.dm-stage > .sk { background: transparent; }
.dm-inset { position: absolute; right: 24px; bottom: 24px; background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 8px; font-size: var(--fs-xs); color: var(--muted); display: grid; gap: 4px; }
.dm-tabs { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--surface-2); z-index: 6; }
.dm-tabs button { border: 0; background: transparent; padding: 6px 16px; border-radius: 8px; font: 600 var(--fs-s) var(--font-ui); color: var(--muted); }
.dm-tabs .is-on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-1); }`, ops: [["script", D]] },
  { key: "E", name: "3D の下の表", css: BASE + `.dm-drawer { position: absolute; left: 0; right: 0; bottom: 0; height: 42%; background: var(--surface); border-top: 1px solid var(--rule); z-index: 5; padding: 10px 16px; display: flex; flex-direction: column; gap: 8px; }
.dm-drawer-head { display: flex; align-items: center; gap: 10px; } .dm-drawer-head .dm-bar { margin-left: auto; }
.dm-drawer-head span { color: var(--muted); font-size: var(--fs-xs); }
.dm-table { overflow: auto; } .dm-table table { border-collapse: collapse; width: 100%; font-size: var(--fs-s); }
.dm-table th, .dm-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--rule-soft); }
.dm-table th { color: var(--muted); font-weight: 600; font-size: var(--fs-xs); }
.dm-table input { width: 80px; font: 500 var(--fs-s) var(--font-num); text-align: right; padding: 2px 6px; border: 1px solid var(--rule); border-radius: 5px; background: var(--surface); color: var(--ink); }
.dm-table tr.is-changed input { border-color: var(--accent); }
.dm-table tr.is-fixed td { color: var(--muted); }`, ops: [["script", E]] },
  { key: "F", name: "掘り下げ（一覧だけ・3D で強調）", css: BASE, ops: [["script", F]] },
  { key: "G", name: "B＋F（断面図は選んだ辺だけ光らせる）", css: BASE, ops: [["script", G]] },
  { key: "H", name: "B＋D（小さな断面図に札）", css: BASE, ops: [["script", H]] },
  { key: "I", name: "G＋A（行の中に断面図と一覧）", css: BASE + `.dm-inline { padding: 8px 4px 12px 14px; border-left: 3px solid var(--accent); margin: 0 0 8px; }`, ops: [["script", I]] },
];
