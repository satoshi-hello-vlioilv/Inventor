// 右側の仕様パネル。ipt（寸法・形状要素・位相・ファイル構造）と HTML（取り込み結果・部品・除外したもの）の 2 つの表示を持つ。

import { AXES, fmt } from "../viewer/describe.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** 表示モードを切り替える（data-mode 属性を持つ要素の表示・非表示）。 */
export function setPanelMode(mode) {
  for (const node of document.querySelectorAll("[data-mode]")) node.hidden = node.dataset.mode !== mode;
}

/** パネル上部のファイル情報。 */
export function renderHeader({ eyebrow, name, meta, isSample, thumbnailUrl }) {
  $("file-kind").textContent = eyebrow;
  $("file-name").textContent = name;
  $("file-source").textContent = meta ?? "";
  $("sample-badge").hidden = !isSample;
  const thumb = $("thumb");
  thumb.hidden = !thumbnailUrl;
  if (thumbnailUrl) thumb.src = thumbnailUrl;
}

/**
 * 強調表示の行を作る（カーソル・キーボードのフォーカスで連動）。
 * @returns {HTMLButtonElement}
 */
function featureRow({ kind, dim, count, sub, tone }, onEnter, onLeave) {
  const button = el("button", "feature");
  button.type = "button";
  if (tone) button.dataset.tone = tone;
  button.append(el("span", "kind", kind), el("span", "dim", dim), el("span", "count", `×${count}`), el("span", "sub", sub));
  for (const type of ["pointerenter", "focus"]) button.addEventListener(type, onEnter);
  for (const type of ["pointerleave", "blur"]) button.addEventListener(type, onLeave);
  return button;
}

function renderRows(listId, groups, toRow, { onEnter, onLeave }, emptyText) {
  const rows = new Map();
  const items = groups.map((g) => {
    const button = featureRow(toRow(g), () => onEnter(g), onLeave);
    rows.set(g.key, button);
    const li = el("li");
    li.append(button);
    return li;
  });
  $(listId).replaceChildren(...(items.length ? items : [el("li", "empty", emptyText)]));
  return rows;
}

const definitionList = (id, pairs) => $(id).replaceChildren(...pairs.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));

/**
 * ipt の表示。
 * @returns {Map<string, HTMLElement>} 形状要素グループのキー → 行（3D 側からの強調に使う）
 */
export function renderIptPanel({ report, scene, describe }, handlers) {
  const s = scene.bodies[0].summary;
  $("dims").replaceChildren(
    ...AXES.map(([name], i) => {
      const cell = el("div");
      cell.style.setProperty("--axis-color", `var(--axis-${name.toLowerCase()})`);
      cell.append(el("dt", null, name), el("dd", null, fmt(s.size[i])));
      return cell;
    }),
  );
  const rows = renderRows("features", describe.groups,
    (g) => ({ kind: g.name, dim: g.dim, count: g.items.length, sub: g.detail }), handlers, "穴・R などの円筒形状はありません");

  const surfaces = Object.entries(s.surfaces).map(([k, v]) => `${scene.labels.surfaces[k] ?? k} ${v}`).join("・");
  const topology = [
    ["面", `${s.faces}（${surfaces}）`],
    ["稜線 / 頂点", `${s.edges} / ${s.vertices}`],
    ["貫通穴（種数）", s.genus ?? "—"],
    ["状態", s.closed ? "閉じたソリッド" : "開いたシート"],
  ];
  if (describe.unsupported) topology.push(["表示未対応の面", `${describe.unsupported}（稜線のみ表示）`]);
  if (scene.bodies.length > 1) topology.push(["ボディ", `${scene.bodies.length}（寸法は 1 つ目）`]);
  definitionList("topology", topology);

  $("segments").replaceChildren(
    ...report.segments.map((seg) => {
      const tr = el("tr");
      tr.append(el("td", null, seg.name), el("td", "num", kb(seg.data_stored)), el("td", "num", kb(seg.data_expanded)), el("td", null, seg.compressed ? "zstd" : "—"));
      return tr;
    }),
  );
  $("structure-summary").textContent = `OLE2 ストリーム ${report.container.streams.length} 本・セグメント ${report.segments.length} 個・${kb(report.file.size)}`;
  return rows;
}

/**
 * HTML から取り込んだ形状の表示。
 * @returns {Map<string, HTMLElement>} 部品グループのキー → 行
 */
export function renderHtmlPanel({ describe }, handlers) {
  const { counts } = describe;
  const tally = [
    ["exact", "正確", counts.exact, "回転体・押し出しとして寸法を復元"],
    ["approx", "近似", counts.approx, "三角形のまま（円は多角形）"],
    ["excluded", "除外", counts.excluded, "部品ではない表示物"],
  ];
  $("tally").replaceChildren(
    ...tally.map(([tone, label, n, title]) => {
      const chip = el("span", "tally-chip");
      chip.dataset.tone = tone;
      chip.title = title;
      chip.append(el("span", "swatch"), el("span", null, label), el("b", "num", n));
      return chip;
    }),
  );
  const rows = renderRows("parts", describe.groups,
    (g) => ({ kind: g.label, dim: g.main, count: g.ids.length, sub: g.sub, tone: g.tone }), handlers,
    "取り込める形状がありません。元のページで部品が表示されているか確かめてください。");
  $("excluded-summary").textContent = `除外したもの（${counts.excluded}）`;
  definitionList("excluded", describe.excluded.length ? describe.excluded : [["なし", ""]]);
  return rows;
}
