// 右側の仕様パネル（ファイル情報・外形寸法・形状要素・位相・ファイル構造）を描く。

import { AXES, fmt } from "../viewer/describe.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * @param {{ report: object, scene: object, describe: object, thumbnailUrl: string|null, isSample: boolean }} model
 * @param {{ onEnter: (group: object) => void, onLeave: () => void }} handlers
 * @returns {Map<string, HTMLElement>} 形状要素グループのキー → 行（3D 側からの強調に使う）
 */
export function renderPanel({ report, scene, describe, thumbnailUrl, isSample }, { onEnter, onLeave }) {
  const body = scene.bodies[0];
  const s = body.summary;

  $("file-name").textContent = scene.file;
  $("file-source").textContent = scene.source ? `${scene.source.kernel} · ${scene.source.saved_at}` : "";
  $("sample-badge").hidden = !isSample;
  const thumb = $("thumb");
  thumb.hidden = !thumbnailUrl;
  if (thumbnailUrl) thumb.src = thumbnailUrl;

  $("dims").replaceChildren(
    ...AXES.map(([name], i) => {
      const cell = el("div");
      cell.style.setProperty("--axis-color", `var(--axis-${name.toLowerCase()})`);
      cell.append(el("dt", null, name), el("dd", null, fmt(s.size[i])));
      return cell;
    }),
  );

  const rows = new Map();
  const items = describe.groups.map((g) => {
    const button = el("button", "feature");
    button.type = "button";
    button.append(el("span", "kind", g.name), el("span", "dim", g.dim), el("span", "count", `×${g.items.length}`), el("span", "sub", g.detail));
    button.addEventListener("pointerenter", () => onEnter(g));
    button.addEventListener("focus", () => onEnter(g));
    button.addEventListener("pointerleave", onLeave);
    button.addEventListener("blur", onLeave);
    rows.set(g.key, button);
    const li = el("li");
    li.append(button);
    return li;
  });
  $("features").replaceChildren(...(items.length ? items : [el("li", "empty", "穴・R などの円筒形状はありません")]));

  const surfaces = Object.entries(s.surfaces).map(([k, v]) => `${scene.labels.surfaces[k] ?? k} ${v}`).join("・");
  const topology = [
    ["面", `${s.faces}（${surfaces}）`],
    ["稜線 / 頂点", `${s.edges} / ${s.vertices}`],
    ["貫通穴（種数）", s.genus ?? "—"],
    ["状態", s.closed ? "閉じたソリッド" : "開いたシート"],
  ];
  if (describe.unsupported) topology.push(["表示未対応の面", `${describe.unsupported}（稜線のみ表示）`]);
  if (scene.bodies.length > 1) topology.push(["ボディ", `${scene.bodies.length}（寸法は 1 つ目）`]);
  $("topology").replaceChildren(...topology.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));

  const table = $("segments");
  table.replaceChildren(
    ...report.segments.map((seg) => {
      const tr = el("tr");
      tr.append(el("td", null, seg.name), el("td", "num", kb(seg.data_stored)), el("td", "num", kb(seg.data_expanded)), el("td", null, seg.compressed ? "zstd" : "—"));
      return tr;
    }),
  );
  $("structure-summary").textContent = `OLE2 ストリーム ${report.container.streams.length} 本・セグメント ${report.segments.length} 個・${kb(report.file.size)}`;
  return rows;
}
