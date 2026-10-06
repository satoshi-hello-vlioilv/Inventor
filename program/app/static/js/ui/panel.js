// 右の欄の中身。4 つの表示を持つ（欄の上の段階の帯は steps.js、下の行動ドックは build.js と main.js）。
//   ipt  … 部品（.ipt・STEP の部品・組立の中の部品）: 寸法・形状要素・位相・材質と質量・ファイル構造
//   asm  … 組立（.iam・STEP）: 外形寸法・見つからない部品・部品表・構成
//   html … three.js の HTML: 照合の結果・単位・作る部品・除外したもの
//   spec … 変換データ（.inventor.json）: ファイルの情報・照合の結果・作る部品

import { AXES, fmt, fmtMass, fmtSize } from "../viewer/describe.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** 表示モードを切り替える（data-mode 属性を持つ要素の表示・非表示。属性は空白区切りで複数のモードを書ける）。 */
export function setPanelMode(mode) {
  for (const node of document.querySelectorAll("[data-mode]")) node.hidden = !node.dataset.mode.split(" ").includes(mode);
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
function featureRow({ kind, dim, count, sub, note, tone, title }, onEnter, onLeave, onClick) {
  const button = el("button", "feature");
  button.type = "button";
  if (tone) button.dataset.tone = tone;
  if (title) button.title = title;
  button.append(el("span", "kind", kind), el("span", "dim", dim), el("span", "count", `×${count}`), el("span", "sub", sub));
  if (note) button.append(el("span", "note", note));
  for (const type of ["pointerenter", "focus"]) button.addEventListener(type, onEnter);
  for (const type of ["pointerleave", "blur"]) button.addEventListener(type, onLeave);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function renderRows(listId, groups, toRow, { onEnter, onLeave, onClick }, emptyText) {
  const rows = new Map();
  const items = groups.map((g) => {
    const button = featureRow(toRow(g), () => onEnter(g), onLeave, onClick && (() => onClick(g)));
    rows.set(g.key, button);
    const li = el("li");
    li.append(button);
    return li;
  });
  $(listId).replaceChildren(...(items.length ? items : [el("li", "empty", emptyText)]));
  return rows;
}

/** 数の札（色・名前・数）。items: [tone, 名前, 数, 説明（カーソルを合わせたとき）] */
function renderTally(id, items) {
  $(id).replaceChildren(
    ...items.map(([tone, label, value, title]) => {
      const chip = el("span", "tally-chip");
      chip.dataset.tone = tone;
      chip.title = title;
      chip.append(el("span", "swatch"), el("span", null, label), el("b", "num", value));
      return chip;
    }),
  );
}

const definitionList = (id, pairs) => $(id).replaceChildren(...pairs.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));

/** 外形寸法（X・Y・Z の 3 つの欄） */
function renderDims(size) {
  $("dims").replaceChildren(
    ...AXES.map(([name], i) => {
      const cell = el("div");
      cell.style.setProperty("--axis-color", `var(--axis-${name.toLowerCase()})`);
      cell.append(el("dt", null, name), el("dd", null, size ? fmt(size[i]) : "—"));
      return cell;
    }),
  );
}

/** 材質と質量の行（密度が分かれば、表示用の三角形から求めた体積 × 密度） */
function massRows({ material, density_g_per_cm3: density }, volume) {
  const rows = [];
  if (material || density) rows.push(["材質", [material, density ? `${density} g/cm³` : null].filter(Boolean).join(" · ")]);
  if (volume > 0) rows.push(["体積", `${fmt(volume)} mm³`]);
  if (volume > 0 && density) rows.push(["質量", `約 ${fmtMass((volume * density) / 1000)}`]);
  return rows;
}

/**
 * 部品の表示（.ipt・STEP の部品・組立の中の部品）。report が無いときはファイル構造を出さない。
 * @param {{ report?: object, scene: object, describe: object, properties?: object, volume?: number }} data
 * @returns {Map<string, HTMLElement>} 形状要素グループのキー → 行（3D 側からの強調に使う）
 */
export function renderIptPanel({ report, scene, describe, properties = {}, volume = 0 }, handlers) {
  const s = scene.bodies[0].summary;
  renderDims(s.size);
  const rows = renderRows("features", describe.groups,
    (g) => ({ kind: g.name, dim: g.dim, count: g.items.length, sub: g.detail }), handlers, "穴・R・ねじ・円錐などの形状要素はありません");

  const surfaces = Object.entries(s.surfaces).map(([k, v]) => `${scene.labels.surfaces[k] ?? k} ${v}`).join("・");
  const topology = [
    ["面", `${s.faces}（${surfaces}）`],
    ["稜線 / 頂点", `${s.edges} / ${s.vertices}`],
    ["貫通穴（種数）", s.genus ?? "—"],
    ["状態", s.closed ? "閉じたソリッド" : "開いたシート"],
  ];
  if (describe.unsupported) topology.push(["表示未対応の面", `${describe.unsupported}（稜線のみ表示）`]);
  if (scene.bodies.length > 1) topology.push(["ボディ", `${scene.bodies.length}（寸法は 1 つ目）`]);
  topology.push(...massRows(properties, volume));
  definitionList("topology", topology);

  document.querySelector("details.structure[data-mode~='ipt']").hidden = !report;
  if (!report) return rows;
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
 * 組立の表示（.iam・STEP）。
 * @param {{ describe: object, scene: object }} data  describe は describeAssembly の結果
 * @param {{ onEnter, onLeave, onClick, onMissing }} handlers  onClick(部品の行) で部品を開く、onMissing() でファイルを選ぶ
 * @returns {Map<string, HTMLElement>} 部品の行のキー → 行
 */
export function renderAsmPanel({ describe, scene }, handlers) {
  renderDims(describe.size);
  const { totals } = describe;
  const found = describe.groups.filter((g) => !g.missing);
  const tally = [
    ["exact", "部品", `${found.length} 種類`, "形状を表示できる部品"],
    ["exact", "配置", `${scene.instances.length} か所`, "組立の中の部品の数"],
  ];
  if (describe.missing.length) tally.push(["missing", "見つからない", `${describe.missing.length} 種類`, "部品ファイルが無く、表示できない部品"]);
  renderTally("asm-tally", tally);
  const row = (g) => ({
    kind: String(g.number).padStart(2, "0"),
    dim: g.name,
    count: g.count,
    sub: g.missing ? `ファイル ${g.file ?? "?"}` : [g.size ? fmtSize(g.size) : null, g.material, g.mass !== null ? `約 ${fmtMass(g.mass)}` : null].filter(Boolean).join(" · "),
    note: g.missing ? "部品ファイルが見つかりません" : null,
    tone: g.missing ? "missing" : null,
    title: g.missing ? g.path ?? g.file : "押すと、この部品を開きます",
  });
  const rows = renderRows("bom", describe.groups, row, handlers, "部品がありません");
  $("missing-section").hidden = !describe.missing.length;
  renderRows("missing", describe.missing, (g) => ({ kind: "?", dim: g.file ?? g.name, count: g.count, sub: g.path ?? "", tone: "missing" }),
    { onEnter: handlers.onEnter, onLeave: handlers.onLeave, onClick: handlers.onMissing }, "");
  const info = [
    ["部品", `${describe.groups.length} 種類（形状あり ${found.length}）`],
    ["配置", `${scene.instances.length} か所`],
  ];
  if (totals.mass > 0) info.push(["質量", `約 ${fmtMass(totals.mass)}${totals.massComplete ? "" : "（見つからない部品を除く）"}`]);
  const src = scene.source ?? {};
  if (src.format === "STEP") {
    if (src.system) info.push(["作成", src.system]);
    if (src.schema) info.push(["形式", src.schema.replace(/\s*\{.*\}\s*/, "")]);
    if (src.time) info.push(["書き出し", src.time.replace("T", " ")]);
  }
  if (scene.unplaced?.length) info.push(["部品を特定できない", scene.unplaced.join("、")]);
  definitionList("asm-info", info);
  return rows;
}

/**
 * HTML から取り込んだ形状の表示。
 * @returns {Map<string, HTMLElement>} 部品グループのキー → 行
 */
export function renderHtmlPanel({ describe }, handlers) {
  const { counts } = describe;
  renderTally("tally", [
    ["exact", "正確", counts.exact, "回転体・押し出しとして寸法を復元"],
    ["approx", "近似", counts.approx, "三角形のまま（円は多角形）"],
    ["excluded", "除外", counts.excluded, "部品ではない表示物"],
  ]);
  const rows = renderRows("parts", describe.groups,
    (g) => ({ kind: g.label, dim: g.main, count: g.ids.length, sub: g.sub, note: g.note, tone: g.tone }), handlers,
    "取り込める形状がありません。元のページで部品が表示されているか確かめてください。");
  $("excluded-summary").textContent = `除外したもの（${counts.excluded}）`;
  definitionList("excluded", describe.excluded.length ? describe.excluded : [["なし", ""]]);
  return rows;
}

/**
 * 変換データ（.inventor.json）の表示。describe は convert/preview.js の describeSpec の結果。
 * @returns {Map<string, HTMLElement>} 部品のキー → 行
 */
export function renderSpecPanel({ describe }, handlers) {
  const { counts } = describe;
  const tally = [
    ["exact", "作る部品", `${counts.parts} 種類`, "回転体・押し出し（寸法で作る部品）と近似の部品（三角形のまま作る部品）"],
    ["exact", "配置", `${counts.placed} か所`, "組立の中の部品の数（2 か所以上なら組立も作る）"],
  ];
  if (counts.approx) tally.push(["approx", "うち近似", `${counts.approx} 種類`, "三角形のまま作る部品（円は多角形）"]);
  if (counts.skipped) tally.push(["approx", "作らない", `${counts.skipped} 個`, "取り込んだときに近似（三角形のまま）だった部品（版 2 までの変換データ）"]);
  renderTally("spec-tally", tally);
  return renderRows("parts", describe.groups,
    (g) => ({ kind: g.label, dim: g.main, count: g.ids.length, sub: g.sub, note: g.note, tone: g.tone, title: g.name }), handlers,
    "作れる部品がありません");
}
