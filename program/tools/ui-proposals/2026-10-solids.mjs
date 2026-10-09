// 2026-10（3D ソリッドの一覧）: 図面（DWG）の 3D ソリッドの一覧を、ブロック参照の親子で表す案。実物のデータ（Autodesk の見本
// visualization_-_condominium_with_skylight.dwg の 76 個。立体ごとの道筋・大きさ mm・三角形の数）で描く。
//   UI_SOLIDS_DWG=その DWG node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-solids.mjs --states solids3d
// 木の見た目は組立の構成の木（ui/tree.js・利用者が選んだ H）と同じクラスで描く。どの案も「面」（三角形の数）を「三角形」と書く。
// 比べること: どれが何か分かるか（今は 76 行が全て「3D ソリッド n（画層 0）」）・外の壁を消して中を見る手段・読む量

// [番号, ブロック参照（名前#ハンドル:何番目。直下は ""）, 大きさ [x, y, z] mm, 三角形]
const SOLIDS = [[1,"",[8077,12192,4267],344],[2,"",[5944,12192,4267],156],[3,"",[10668,12192,155],12],[4,"",[10668,12192,416],12],[5,"",[4848,3988,3],20],[6,"",[4848,2745,3],12],[7,"",[142,216,148],41315],[8,"",[2178,488,251],23186],[9,"",[679,391,467],7750],[10,"",[395,395,644],1838],[11,"",[679,391,18],7750],[12,"",[30,233,108],342],[13,"",[1070,8815,3],12],[14,"",[1307,40,2776],5912],[15,"",[10679,275,4841],12],[16,"",[30,488,354],1404],[17,"",[30,488,322],76],[18,"",[275,12198,4841],12],[19,"",[5913,420,137],332],[20,"",[137,1840,3415],80],[21,"",[141,1743,63],12],[22,"",[144,63,3477],12],[23,"",[141,63,1747],12],[24,"",[137,1840,3415],80],[25,"",[141,1743,63],12],[26,"",[144,63,3477],12],[27,"",[141,63,1747],12],[28,"Table#9A0:0",[621,621,650],8988],[29,"Table#9A0:0",[49,49,412],1832],[30,"Table#9A0:0",[81,43,31],4005],[31,"Table#9A0:0",[1085,1085,34],3802],[32,"Seat#AE6:0",[356,438,239],490],[33,"Seat#AE6:0",[371,457,551],19426],[34,"Seat#AE6:0",[426,426,650],7084],[35,"Seat#AE6:0",[50,50,412],1836],[36,"Seat#AE6:0",[86,12,31],3988],[37,"Seat#AE7:0",[510,538,239],490],[38,"Seat#AE7:0",[527,557,551],19426],[39,"Seat#AE7:0",[426,426,650],7084],[40,"Seat#AE7:0",[50,50,412],1836],[41,"Seat#AE7:0",[78,49,31],3988],[42,"",[5913,420,137],332],[43,"",[5913,420,137],328],[44,"",[5913,420,137],334],[45,"",[4007,420,137],332],[46,"",[5913,420,137],332],[47,"",[60,60,4],612],[48,"",[44,44,4],292],[49,"",[60,60,4],614],[50,"",[44,44,4],292],[51,"",[60,60,4],610],[52,"",[44,44,4],292],[53,"",[60,60,4],618],[54,"",[44,44,4],296],[55,"",[60,60,4],618],[56,"",[44,44,4],290],[57,"",[60,60,4],612],[58,"",[44,44,4],290],[59,"",[60,60,4],614],[60,"",[44,44,4],292],[61,"WineGlass#C85:0",[98,98,233],20948],[62,"WineGlass#C86:0",[98,98,233],20948],[63,"",[60,60,4],612],[64,"",[44,44,4],292],[65,"ExposedRecess#D45:0",[63,63,105],4565],[66,"ExposedRecess#D45:0",[37,37,21],4152],[67,"ExposedRecess#D45:0",[12,94,125],716],[68,"ExposedRecess#D45:0",[95,95,2],5440],[69,"ExposedRecess#D46:0",[63,63,105],4565],[70,"ExposedRecess#D46:0",[37,37,21],4152],[71,"ExposedRecess#D46:0",[12,94,125],716],[72,"ExposedRecess#D46:0",[95,95,2],5440],[73,"",[8,4,2460],256],[74,"",[9,11,2461],173],[75,"",[8,4,2460],254],[76,"",[13,6,2462],124]];

const fmt = (n) => n.toLocaleString("en-US");
const sizeText = (s) => `${s.map(fmt).join(" × ")} mm`;
const blockOf = (ref) => ref.split("#")[0];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.1 6.9C3.6 8.6 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1"/></svg>';

/** 木の行（ui/tree.js と同じ形）。node: { name, count, sub, children?, open?, hidden?, dim?, depth } */
function row(n, depth, parentHidden = false) {
  const branch = Boolean(n.children?.length);
  return `<li class="tree-row${branch ? " is-branch" : ""}${parentHidden ? " is-dim" : ""}${n.hidden ? " is-hidden" : ""}" data-depth="${depth}" style="--depth:${depth}">` +
    `<div class="tree-line"><span class="tree-twisty">${branch ? (n.open ? "▾" : "▸") : ""}</span><span class="tree-icon${branch ? " is-branch" : ""}">${branch ? "▣" : "◧"}</span>` +
    `<span class="tree-name">${esc(n.name)}</span>${n.count ? `<span class="tree-count">×${n.count}</span>` : ""}` +
    `<button class="tree-eye${n.hidden ? " is-off" : ""}" type="button">${n.hidden ? EYE_OFF : EYE}</button></div>` +
    (n.sub ? `<div class="tree-sub">${esc(n.sub)}</div>` : "") + "</li>" +
    (branch && n.open ? n.children.map((c) => row(c, depth + 1, parentHidden || n.hidden)).join("") : "");
}
const tree = (nodes) => '<ul class="tree">' + nodes.map((n) => row(n, 0)).join("") + "</ul>";

// ブロックごと（参照の数・1 つの参照の中の立体）と、ブロックの外の立体
const refs = new Map();
for (const [i, ref, size, tris] of SOLIDS) if (ref) (refs.get(ref) ?? refs.set(ref, []).get(ref)).push({ i, size, tris });
const blocks = new Map();
for (const [ref, list] of refs) (blocks.get(blockOf(ref)) ?? blocks.set(blockOf(ref), []).get(blockOf(ref))).push(list);
const outside = SOLIDS.filter(([, ref]) => !ref).map(([i, , size, tris]) => ({ i, size, tris }));
const leaf = (s, name = `3D ソリッド ${s.i}`) => ({ name, sub: `${sizeText(s.size)} · 三角形 ${fmt(s.tris)}` });
const blockNodes = (open = null, nameOf) => [...blocks].map(([name, inserts]) => ({
  name, count: inserts.length, open: name === open, sub: `ブロック · 中のソリッド ${inserts[0].length}`,
  children: inserts[0].map((s) => (nameOf ? nameOf(s) : leaf(s))),
}));
/** 大きさが同じ立体を ×n に */
const bySize = (list) => {
  const m = new Map();
  for (const s of list) { const k = s.size.join("x"); (m.get(k) ?? m.set(k, []).get(k)).push(s); }
  return [...m.values()];
};

const insert = (html) => `(function put() {
  const list = document.getElementById("model3d-parts");
  if (!/condominium/.test(document.getElementById("file-name")?.textContent ?? "") || !list?.querySelector("li")) { setTimeout(put, 200); return; }
  if (document.getElementById("sx")) return;
  const box = document.createElement("div"); box.id = "sx"; box.innerHTML = ${JSON.stringify(html)};
  list.hidden = true; list.before(box);
  const h = list.closest("section").querySelector("h2 .h-note"); if (h) h.textContent = "カーソルを合わせると強調 · 目で消す";
})();`;

const outsideNode = (open, children, sub = "") => ({ name: "ブロックに入っていないソリッド", count: null, open, sub: sub || `${outside.length} 個`, children });
const sized = [...outside].sort((a, b) => b.size.reduce((p, v) => p * v, 1) - a.size.reduce((p, v) => p * v, 1));

const A = insert(tree([...blockNodes("Seat"), outsideNode(false, outside.map((s) => leaf(s)))]));
const B = insert(tree([...blockNodes(), outsideNode(true, bySize(outside).map((g) => ({ ...leaf(g[0], g.length > 1 ? "3D ソリッド（同じ大きさ）" : `3D ソリッド ${g[0].i}`), count: g.length > 1 ? g.length : null })), `${outside.length} 個 · 大きさ ${bySize(outside).length} 種類`)]));
const C = insert(tree([...blockNodes(null, (s) => ({ name: sizeText(s.size), sub: `3D ソリッド ${s.i} · 三角形 ${fmt(s.tris)}` })),
  outsideNode(true, sized.map((s, k) => ({ name: sizeText(s.size), sub: `3D ソリッド ${s.i} · 三角形 ${fmt(s.tris)}`, hidden: k < 2 })), `${outside.length} 個 · 大きい順`)]));
const D = insert('<div class="seg"><button type="button" aria-selected="false">構成（木）</button><button type="button" aria-selected="true">形の種類ごと</button></div>' +
  tree(bySize(SOLIDS.map(([i, , size, tris]) => ({ i, size, tris }))).sort((a, b) => b.length - a.length).slice(0, 40)
    .map((g) => ({ name: sizeText(g[0].size), count: g.length, sub: `三角形 ${fmt(g[0].tris)}${g.length > 1 ? " · 同じ大きさ" : ""}` }))));
const E = insert(tree([{ name: "画層 0", open: true, sub: `${SOLIDS.length} 個`, children: SOLIDS.map(([i, ref, size, tris]) => ({ name: `3D ソリッド ${i}${ref ? `（${blockOf(ref)}）` : ""}`, sub: `${sizeText(size)} · 三角形 ${fmt(tris)}` })) }]));
const F = insert('<div class="sx-chips">' + ["すべて 76", ...[...blocks].map(([n, ins]) => `${n} ${ins.length * ins[0].length}`), `ブロックの外 ${outside.length}`].map((t, k) => `<button class="sx-chip${k === 0 ? " is-on" : ""}">${t}</button>`).join("") + "</div>" +
  '<ul class="features is-bom">' + SOLIDS.map(([i, ref, size, tris]) => `<li><button class="feature"><span class="kind">${String(i).padStart(2, "0")}</span><span class="dim">3D ソリッド ${i}${ref ? ` <em class="sx-tag">${blockOf(ref)}</em>` : ""}</span><span class="count"></span><span class="sub">${sizeText(size)} · 三角形 ${fmt(tris)}</span></button></li>`).join("") + "</ul>");

// G（A＋C）: ブロックの木はそのまま。ブロックの外は大きい順で、名前を大きさに（壁を消した様子）
const big = (s, hidden = false) => ({ name: sizeText(s.size), sub: `3D ソリッド ${s.i} · 三角形 ${fmt(s.tris)}`, hidden });
const G = insert(tree([...blockNodes(), outsideNode(true, sized.map((s, k) => big(s, k < 2)), `${outside.length} 個 · 大きい順`)]));
// H（G＋B）: G の大きい順に、同じ大きさを ×n でまとめる
const groupsBySize = bySize(sized);
const H = insert(tree([...blockNodes(), outsideNode(true, groupsBySize.map((g, k) => ({ ...big(g[0], k < 2), count: g.length > 1 ? g.length : null,
  sub: g.length > 1 ? `3D ソリッド ${g.length} 個 · 同じ大きさ` : `3D ソリッド ${g[0].i} · 三角形 ${fmt(g[0].tris)}` })), `${outside.length} 個 · 大きさ ${groupsBySize.length} 種類 · 大きい順`)]));
// I: 「ブロックの外」の枝を作らず、ブロックの後ろに大きい順で並べる
const I = insert(tree([...blockNodes(), ...sized.map((s, k) => big(s, k < 2))]));

const BASE = `#sx { display: flex; flex-direction: column; gap: 8px; }
.sx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sx-chip { font: 500 var(--fs-xs) var(--font-ui); padding: 3px 10px; border: 1px solid var(--rule); border-radius: 99px; background: var(--surface); color: var(--ink); }
.sx-chip.is-on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.sx-tag { font-style: normal; font-size: var(--fs-xs); padding: 0 6px; border-radius: 4px; background: var(--surface-2); color: var(--muted); margin-left: 4px; }`;

export const PROPOSALS = [
  { key: "A", name: "ブロックで木（H のまま）", css: BASE, ops: [["script", A]] },
  { key: "B", name: "A＋同じ大きさを ×n にまとめる", css: BASE, ops: [["script", B]] },
  { key: "C", name: "A＋名前を大きさに（大きい順・壁を消した様子）", css: BASE, ops: [["script", C]] },
  { key: "D", name: "形の種類ごと（大きさでまとめる）に切り替え", css: BASE, ops: [["script", D]] },
  { key: "E", name: "画層ごとの木", css: BASE, ops: [["script", E]] },
  { key: "F", name: "平らな一覧＋ブロックの札と絞り込み", css: BASE, ops: [["script", F]] },
  { key: "G", name: "A＋C（ブロックの外だけ大きさの名前・大きい順）", css: BASE, ops: [["script", G]] },
  { key: "H", name: "G＋同じ大きさを ×n", css: BASE, ops: [["script", H]] },
  { key: "I", name: "G で「ブロックの外」の枝を作らない", css: BASE, ops: [["script", I]] },
];
