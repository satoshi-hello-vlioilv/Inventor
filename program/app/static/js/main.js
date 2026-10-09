// アプリの入口: 受け取ったファイルを読み（formats/open.js）、3D（viewer/）と右の欄（ui/panel.js）に表示し、両者を連動させる。
// 次にすること（主のボタン 1 つ）は ui/flow.js が決め、段階の帯（ui/steps.js）と行動ドックに出す（docs/ui.md）。
//   .ipt・.iam・.stp … モデル（部品・組立）として読み、表示する
//   .dwg・.dxf・.pdf・.jww・.sfc・.p21 … 2D の図面として読み（formats/cad2d）、Canvas に描く（viewer2d/）。レイアウト（PDF はページ）の切り替え・画層の表示・
//                      図形の読み出し。3D を含む PDF は、主役の場所のタブで 3D（formats/model3d.js → viewer/）に切り替える
//   .html            … 隔離した iframe で動かし、three.js の形状を取り出して認識し（convert/recognize）、変換データを作る
//   .json            … 変換データ（.inventor.json）。作る形を 3D で示し（convert/preview.js）、「Inventor で作る」で作る
// ファイルの受け付けは ui/files.js、窓（Inventor3DTool.exe）とのやりとり（サンプル・起動で受け取ったファイル）は desktop.js、
// サンプルの窓は ui/start.js、変換データの受け渡しは ui/convert.js、「作る」と行動ドックは ui/build.js、
// 流れの状態（表示・取り込み・単位・作る仕事）は ui/flow.js が持ち、段階の帯（ui/steps.js）と行動ドックがそれを見て描く。

import { buildInventorSpec, readSpec } from "./convert/inventor.js";
import { describeSpec, previewScene } from "./convert/preview.js";
import { recognizeSnapshot } from "./convert/recognize/index.js";
import { read3d } from "./formats/model3d.js";
import { ACCEPT, FORMATS, FORMAT_NAMES, OPENABLE, detectFormat, explainError, partOf, readModel } from "./formats/open.js";
import { buildDisplayMeshes, describeRecognition } from "./html/describe.js";
import { SourceFrame } from "./html/frame.js";
import { setSpec } from "./ui/convert.js";
import { onFlow, setNext, updateFlow } from "./ui/flow.js";
import "./ui/steps.js";
import { claimLaunch, listSamples, onLaunch } from "./desktop.js";
import { PartLibrary, acceptFiles } from "./ui/files.js";
import { initBuild } from "./ui/build.js";
import { setupUnit } from "./ui/units.js";
import { initSettings, offerShortcut, showNews } from "./ui/settings.js";
import { selectViewTab, setViewTabs } from "./ui/viewtabs.js";
import { renderAsmPanel, renderAsmStructure, renderDrawingPanel, renderHeader, renderHtmlPanel, renderIptPanel, renderModel3dPanel, renderSpecPanel, setPanelMode } from "./ui/panel.js";
import { startDialog } from "./ui/start.js";
import { hiddenIds } from "./ui/tree.js";
import { describeAssembly, describeBody, describeMeshes, describeStructure } from "./viewer/describe.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";
import { describeDrawing, describeItem } from "./viewer2d/describe.js";
import { buildScene } from "./viewer2d/scene.js";
import { DrawingViewer } from "./viewer2d/viewer2d.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
// 何も指していないときの案内。指す単位（部品は面、組立・HTML は部品）に合わせる
const IDLE_TEXT = { ipt: readoutChip.textContent, asm: "部品にカーソルを合わせると、名前と寸法を表示します" };
IDLE_TEXT.html = IDLE_TEXT.spec = IDLE_TEXT.model3d = IDLE_TEXT.asm;
IDLE_TEXT.drawing = "線・文字・寸法にカーソルを合わせると、種類と寸法を表示します";
const SETTLE_MS = 1200; // 元のページの最初の描画から取り込みまで待つ時間（初期化の完了待ち）
const READY_TIMEOUT_MS = 15000;
// 見出しバーの種類の札（いま何を見ているか）
const EYEBROW = { "part:ipt": "部品 .ipt", "part:step": "STEP 部品", "assembly:step": "STEP 組立", "assembly:iam": "組立 .iam" };
const eyebrowOf = (model) => EYEBROW[`${model.kind}:${model.format}`] ?? (model.kind === "drawing" ? `図面 .${model.format}` : undefined);

let idleText = IDLE_TEXT.ipt;
let current = null; // 表示中の強調の対応 { info: Map<id, {group, text}>, rows: Map<groupKey, element> }
let specParts = null; // 表示中の変換データの部品（変換データの部品の順）。作った結果を 3D に塗る先・結果の升目から強調する先
let thumbnailUrl = null;
let assembly = null; // 表示中（または部品を開く前）の組立 { model, header, doc: { bytes, name, isSample } }
let source = null; // 表示中の元のページ（SourceFrame）
let sourceName = ""; // 表示中の HTML のファイル名
let captured = null; // 最後に取り込んだシーン { snapshot, at, unit }（単位を変えたら認識し直す）
let sheet = null; // 表示中の図面 { model, layout（番号）, layers: Map<画層, 表示するか>（利用者が切り替えたもの）, scene, rows,
//                  view（主役の場所のタブ: "sheet" か 3D の PDF の "3d:番号"）, shown3d: Map<番号, read3d の結果か { error }> }

// ---- 強調表示（3D ⇄ パネルの双方向） -----------------------------------------
function highlight(ids, text, groupKey) {
  viewer?.highlight(ids);
  readoutChip.textContent = text ?? idleText;
  readout.classList.toggle("is-live", Boolean(text));
  // 同じ行が複数の key で引けることがある（組立の木: 行の key と部品表の key）ので、行ごとに 1 回だけ付け外しする
  const active = current?.rows?.get(groupKey);
  for (const row of new Set(current?.rows?.values() ?? [])) row.classList.toggle("is-active", row === active);
}

function onHover(id) {
  const info = id === null ? null : current?.info.get(id);
  if (info) highlight([id], info.text, info.group);
  else highlight([]);
}

const rowHandlers = (idsOf) => ({
  onEnter: (g) => highlight(idsOf(g), g.text ?? `${g.label} ${g.main} × ${g.ids.length}`, g.key),
  onLeave: () => highlight([]),
});

let viewer = null;
try {
  viewer = new Viewer({ stage: $("stage"), canvas: $("view"), gizmo: $("gizmo") }, { onHover });
} catch {
  const note = document.createElement("p");
  note.className = "message";
  note.textContent = "この環境では 3D 表示（WebGL）が使えません。ブラウザのハードウェアアクセラレーション設定を確認してください。";
  $("stage").append(note);
}

// 2D の図面（Canvas 2D なので WebGL が無くても動く）。全体表示は、上のツールバー（と主役の場所のタブ）・下の読み出しの内側に収める
const overlayInsets = () => {
  const stage = $("stage").getBoundingClientRect();
  const bars = [...document.querySelectorAll("#stage .toolbar > :not([hidden]), #view-tabs:not([hidden])")].map((el) => el.getBoundingClientRect()).filter((r) => r.height);
  const top = Math.max(0, ...bars.map((r) => r.bottom - stage.top)) + 8;
  const chip = readoutChip.getBoundingClientRect();
  return { top, bottom: chip.height ? stage.bottom - chip.top + 8 : 0, left: 0, right: 0 };
};
const drawingViewer = new DrawingViewer({ stage: $("stage"), canvas: $("view2d") }, { onHover: onDrawingHover, insets: overlayInsets });

function showMessage(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}
const showAlert = (message) => showMessage("alert", message);
/** 誤りではない知らせ（開かなかったファイルなど）。 */
const showNotice = (message) => showMessage("notice", message);

/** 表示モード: empty（何も開いていない）・ipt（部品）・asm（組立）・html・spec（変換データ）。 */
function setMode(mode) {
  $("app").classList.toggle("is-html", mode === "html");
  $("app").classList.toggle("is-empty", mode === "empty");
  $("app").classList.toggle("is-drawing", mode === "drawing");
  $("view").hidden = mode === "drawing";
  $("view2d").hidden = mode !== "drawing";
  $("stage").setAttribute("aria-label", mode === "drawing" ? "図面" : "3D ビュー");
  if (mode !== "drawing") {
    sheet = null;
    drawingViewer.clear();
    delete $("app").dataset.layout;
  }
  $("stage-empty").hidden = mode !== "empty";
  $("source").hidden = mode !== "html";
  $("back-to-assembly").hidden = $("add-missing").hidden = true;
  setPanelMode(mode);
  // HTML は 元のページ ⇄ 取り込んだ形 を主役の場所のタブで切り替える（読み込みの間は元のページ）
  setViewTabs(mode === "html" ? HTML_VIEWS : null, "source");
  idleText = IDLE_TEXT[mode] ?? IDLE_TEXT.ipt;
  if (mode !== "html" && source) {
    source.dispose();
    source = null;
  }
  specParts = null;
  updateFlow({ mode, ...(mode !== "html" && { capture: "none", revision: null, unit: null }) });
  setNext("view", mode === "empty" ? $("welcome-open") : null); // 何も開いていなければ「ファイルを選ぶ」
}

function setThumbnail(png) {
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl = png ? URL.createObjectURL(new Blob([png], { type: "image/png" })) : null;
  return thumbnailUrl;
}

// ---- 部品・組立 ------------------------------------------------------------------
/** 部品を表示する（.ipt・STEP の部品・組立の中の部品で共通） */
function showPart(model, header) {
  setMode("ipt");
  renderHeader(header);
  $("back-to-assembly").hidden = !model.assembly;
  const describe = describeBody(model.scene.bodies[0], model.scene.labels);
  const { volume = 0 } = viewer?.show(model.scene) ?? {};
  const rows = renderIptPanel({ report: model.report, scene: model.scene, describe, properties: model.properties, volume }, rowHandlers((g) => g.faceIds));
  current = { info: describe.faceInfo, rows };
  highlight([]);
}

/** 組立を表示する（.iam・STEP で共通）。部品表の行で部品を開き、見つからない部品はファイルを選んで加える */
function showAssembly(model, header) {
  setMode("asm");
  renderHeader(header);
  $("back-to-assembly").hidden = true;
  const { volumes = [] } = viewer?.show(model.scene) ?? {};
  const describe = describeAssembly(model.scene, volumes);
  const rows = renderAsmPanel({ describe, scene: model.scene }, {
    ...rowHandlers((g) => g.ids),
    onClick: (g) => (g.missing ? $("file-input").click() : openAssemblyPart(g.index)),
    onMissing: () => $("file-input").click(),
  });
  current = { info: describe.info, rows };
  // 構成の木（サブ組立があれば最初から木で見せる）。開閉・消した行は、部品を開いて戻っても保つ
  const structure = describeStructure(model.scene, describe.groups);
  const same = assembly?.model === model && assembly.tree;
  const tree = same ? assembly.tree : {
    open: new Set(branchKeys(structure.nodes)), hidden: new Set(), view: structure.depth > 1 ? "tree" : "kinds",
  };
  assembly = { ...assembly, model, header, structure, tree, bomRows: rows };
  renderStructure();
  highlight([]);
  // 見つからない部品があれば、次にすることは「部品を加える」（行動ドック）。Content Center の標準部品だけなら、
  // この PC では .ipt を用意できないことが多いので、ボタンは控えめにし、主の行動にしない（欄の説明で用意の仕方を示す）
  const addable = describe.missing.some((g) => !g.standard);
  $("add-missing").hidden = !describe.missing.length;
  $("add-missing").className = addable ? "primary" : "secondary";
  $("add-missing").textContent = `見つからない部品を加える（${describe.missing.length} 種類）`;
  setNext("view", addable ? $("add-missing") : null);
}

/** 構成の木を描き直し、消した部品を 3D から消す（開閉・目・見方の切り替えのたび） */
function renderStructure() {
  const { structure, tree, bomRows } = assembly;
  const rows = renderAsmStructure(structure, tree, {
    onEnter: (node) => highlight(node.ids, node.text, node.key),
    onLeave: () => highlight([]),
    onPick: (node) => node.group && !node.group.missing && openAssemblyPart(node.group.index),
    onChange: renderStructure,
  });
  current = { ...current, rows: rows ?? bomRows };
  viewer?.setHidden(hiddenIds(structure.nodes, tree));
}

const branchKeys = (nodes) => nodes.flatMap((n) => (n.children.length ? [n.key, ...branchKeys(n.children)] : []));

$("bom-view").addEventListener("click", (event) => {
  const view = event.target.closest("button")?.dataset.bomView;
  if (!view || !assembly?.tree || view === assembly.tree.view) return;
  assembly.tree.view = view;
  renderStructure();
});

/** 組立の中の部品を 1 つだけ開く（部品と同じ表示。「組立に戻る」で戻る） */
function openAssemblyPart(index) {
  const part = partOf(assembly.model, index);
  if (part) {
    const meta = [`組立 ${assembly.header.name} の部品`, part.meta].filter(Boolean).join(" · ");
    showPart(part, { eyebrow: "組立の部品", name: part.name, meta, isSample: assembly.header.isSample, thumbnailUrl: null });
  }
}

// 作った結果を 3D に塗る（表示中の変換データで作ったとき。一致は緑・不一致は琥珀・失敗は赤・作成中は青、待ちは元の色）。
// 不一致・失敗・作成中があれば、それだけを不透明にし、ほかの部品を透かす（viewer.mark）。凡例は塗った色の種類だけ
onFlow((s) => {
  if (!viewer) return;
  const tones = specParts && s.own ? s.job.parts ?? [] : [];
  viewer.mark(tones.flatMap((tone, i) => (tone === "wait" ? [] : (specParts[i]?.ids ?? []).map((id) => [id, tone]))));
  const shown = new Set(tones);
  for (const item of $("stage-legend").children) item.hidden = !shown.has(item.dataset.tone);
  $("stage-legend").hidden = !tones.some((tone) => tone !== "wait"); // 塗った部品が無ければ（全て待ち）出さない
});

// 結果の升目（ui/build.js）にカーソルを合わせると、その部品を 3D で強調する
const resultHover = rowHandlers((g) => g.ids);
$("build-summary").addEventListener("pointerover", (event) => {
  const part = specParts?.[event.target.closest("[data-part]")?.dataset.part];
  if (part) resultHover.onEnter(part);
});
$("build-summary").addEventListener("pointerleave", resultHover.onLeave);

$("back-to-assembly").addEventListener("click", () => assembly && showAssembly(assembly.model, assembly.header));
$("add-missing").addEventListener("click", () => $("file-input").click());

async function loadModel(bytes, name, isSample) {
  let model;
  try {
    model = await readModel(bytes, name, { findPart: (ref) => library.find(ref.file) });
  } catch (error) {
    console.warn(error); // 想定内の入力エラー。利用者には alert で説明する
    showAlert(`${name}: ${explainError(error)}`);
    return;
  }
  showAlert(model.warning ? `${name}: ${model.warning}` : "");
  const header = { eyebrow: eyebrowOf(model), name, meta: model.meta, isSample, thumbnailUrl: setThumbnail(model.thumbnail) };
  if (model.kind === "drawing") {
    assembly = null;
    showDrawing(model, header);
  } else if (model.kind === "part") {
    assembly = null;
    showPart(model, header);
  } else {
    assembly = { doc: model.format === "iam" ? { bytes, name, isSample } : null };
    showAssembly(model, header);
  }
}

// ---- 図面（.dwg・.dxf・.pdf・.jww・.sfc・.p21）-------------------------------------------------------
/** 図面を表示する（最初のレイアウト = モデル）。3D を含む PDF は、主役の場所のタブで 図面 ⇄ 3D を切り替える（最初は 3D） */
function showDrawing(model, header) {
  setMode("drawing");
  renderHeader(header);
  current = null;
  sheet = { model, layout: 0, layers: new Map(), scene: null, rows: new Map(), view: "sheet", shown3d: new Map() };
  renderLayoutTabs();
  renderSheet(true);
  const models = model.drawing.models3d ?? [];
  if (!models.length) return;
  const tabs = [{ key: "sheet", label: "図面" }, ...models.map((m, i) => ({ key: `3d:${i}`, label: models.length > 1 ? `3D ${i + 1}` : "3D" }))];
  setViewTabs(tabs, "3d:0", showDrawingView);
  showDrawingView("3d:0");
}

/** 図面の表示を切り替える（"sheet" = 図面・"3d:番号" = 3D の PDF の 3D）。図面の状態（レイアウト・画層）は残す */
function showDrawingView(key) {
  sheet.view = key;
  const index = key.startsWith("3d:") ? Number(key.slice(3)) : -1;
  const is3d = index >= 0;
  $("app").classList.toggle("is-drawing", !is3d);
  $("view").hidden = !is3d;
  $("view2d").hidden = is3d;
  $("stage").setAttribute("aria-label", is3d ? "3D ビュー" : "図面");
  setPanelMode(is3d ? "model3d" : "drawing");
  idleText = IDLE_TEXT[is3d ? "model3d" : "drawing"];
  current = null;
  if (is3d) show3d(index);
  else {
    renderLayoutTabs(); // 欄の切り替え（data-mode）が出したページのタブを、ページの数に合わせ直す
    highlightItems([]);
  }
}

const FORMAT3D = { ACIS: "ACIS（3D ソリッド）" };

/** 3D の PDF の 3D・図面の 3D ソリッドを表示する（読むのは初めて開いたときの 1 回だけ） */
function show3d(index) {
  const entry = sheet.model.drawing.models3d[index];
  if (!sheet.shown3d.has(index)) {
    try {
      sheet.shown3d.set(index, read3d(entry));
    } catch (error) {
      console.warn(error);
      sheet.shown3d.set(index, { error: explainError(error) });
    }
  }
  const shown = sheet.shown3d.get(index);
  viewer?.show({ meshes: shown.meshes ?? [], view: shown.view });
  const describe = shown.meshes ? describeMeshes(shown) : null;
  const rows = renderModel3dPanel({ format: FORMAT3D[entry.format] ?? entry.format, describe, error: shown.error, warnings: shown.warnings, units: shown.units }, rowHandlers((g) => g.ids));
  current = describe && { info: describe.info, rows };
  highlight([]);
}

/** いまのレイアウト・画層の表示で描き直す（fit: 全体が収まるように） */
function renderSheet(fit) {
  const { drawing } = sheet.model;
  const layout = drawing.layouts[sheet.layout];
  const pick = (on) => new Set([...sheet.layers].filter(([, v]) => v === on).map(([k]) => k));
  sheet.scene = buildScene(drawing, layout, { hidden: pick(false), shown: pick(true) });
  drawingViewer.show(sheet.scene, { fit });
  const visible = (name) => {
    if (sheet.layers.has(name)) return sheet.layers.get(name);
    const l = drawing.layers.get(name);
    return !(l?.off || l?.frozen);
  };
  $("app").dataset.layout = layout.model ? "model" : "paper"; // 地の色をモデルと紙で変えられるように（CSS）
  sheet.rows = renderDrawingPanel({ drawing, describe: describeDrawing(drawing, sheet.scene), layout, visible,
    display: (color) => drawingViewer.displayColor(color) }, {
    onToggle: (name) => {
      sheet.layers.set(name, !visible(name));
      renderSheet(false);
      sheet.rows.get(name)?.focus();
    },
    onEnter: (name) => highlightItems(sheet.scene.items.flatMap((item, i) => (item.layer === name ? [i] : [])), `画層 ${name}`, name),
    onLeave: () => highlightItems([]),
  });
  highlightItems([]);
}

/** レイアウト（PDF はページ）の切り替え。1 つだけなら出さない。8 つまではタブ（名前が見え、1 回で移れる）、
 *  それより多ければページ送り（‹ 何番目 / 全部 ▾ ›。中央を押すと番号の升目の吹き出しが開き、1 回で移れる。PageUp・PageDown でも）。
 *  docs/ui.md §11 */
const TABS_UP_TO = 8;
const layoutName = (l) => (l.model ? "モデル" : l.name);

/** レイアウトのタブ・ページ送りを作る（図面を開いたとき・欄を切り替えたとき）。切り替えで変わる状態は syncLayoutTabs が合わせる */
function renderLayoutTabs() {
  const { layouts } = sheet.model.drawing;
  const group = $("layout-tabs");
  group.hidden = layouts.length < 2;
  group.classList.toggle("pager", layouts.length > TABS_UP_TO);
  if (layouts.length <= TABS_UP_TO) {
    group.replaceChildren(...layouts.map((l, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = layoutName(l);
      button.addEventListener("click", () => showLayout(i));
      return button;
    }));
  } else {
    const step = (text, title, delta) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pager-step";
      button.textContent = text;
      button.title = title;
      button.dataset.delta = String(delta);
      button.addEventListener("click", () => showLayout(sheet.layout + delta));
      return button;
    };
    // 中央: いまの番号と全部の数。押すと、その下に番号の升目の吹き出しが開く（全てのページが 1 目で見え、1 回で移れる）
    const now = document.createElement("button");
    now.type = "button";
    now.className = "pager-now";
    now.title = "押すとページを選ぶ（PageUp・PageDown で前・次）";
    now.setAttribute("aria-haspopup", "dialog");
    now.setAttribute("aria-expanded", "false");
    now.append(document.createElement("span"));
    now.addEventListener("click", () => togglePagePop(!pagePop.hidden ? false : true));
    group.replaceChildren(step("‹", "前のページ（PageUp）", -1), now, step("›", "次のページ（PageDown）", 1));
    pagePop.replaceChildren(...layouts.map((l, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(i + 1);
      button.title = layoutName(l);
      button.addEventListener("click", () => {
        togglePagePop(false);
        showLayout(i);
      });
      return button;
    }));
  }
  togglePagePop(false);
  syncLayoutTabs();
}

/** ページの番号の升目の吹き出し（ページ送りの中央の下）。開くと、いまのページに焦点を置く。Esc・外を押すと閉じる */
const pagePop = $("page-pop");
function togglePagePop(open) {
  const now = $("layout-tabs").querySelector(".pager-now");
  if (open && now) {
    const stage = $("stage").getBoundingClientRect();
    const at = now.getBoundingClientRect();
    pagePop.style.left = `${Math.max(12, at.left - stage.left)}px`;
    pagePop.style.top = `${at.bottom - stage.top + 6}px`;
  }
  pagePop.hidden = !(open && now);
  now?.setAttribute("aria-expanded", String(!pagePop.hidden));
  if (!pagePop.hidden) pagePop.querySelector('[aria-current="true"]')?.focus();
}
addEventListener("pointerdown", (event) => {
  if (!pagePop.hidden && !pagePop.contains(event.target) && !event.target.closest(".pager-now")) togglePagePop(false);
});
pagePop.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  togglePagePop(false);
  $("layout-tabs").querySelector(".pager-now")?.focus();
});

/** タブ・ページ送りを、いまのレイアウトに合わせる（作り直さないので、押したボタンの焦点はそのまま） */
function syncLayoutTabs() {
  const { layouts } = sheet.model.drawing;
  const group = $("layout-tabs");
  if (!group.classList.contains("pager")) {
    [...group.children].forEach((button, i) => button.setAttribute("aria-current", String(i === sheet.layout)));
    return;
  }
  for (const button of group.querySelectorAll(".pager-step")) button.disabled = !layouts[sheet.layout + Number(button.dataset.delta)];
  group.querySelector(".pager-now span").replaceChildren(layoutName(layouts[sheet.layout]),
    Object.assign(document.createElement("small"), { textContent: ` / ${layouts.length}` }));
  [...pagePop.children].forEach((button, i) => button.setAttribute("aria-current", String(i === sheet.layout)));
}

/** レイアウト（ページ）を切り替える */
function showLayout(index) {
  if (!sheet?.model.drawing.layouts[index] || sheet.layout === index) return;
  sheet.layout = index;
  syncLayoutTabs();
  renderSheet(true);
}

// PageUp・PageDown で前・次のレイアウト（ページ）。図面を見ているときだけ（入力の欄・一覧を操作しているときは除く）
addEventListener("keydown", (event) => {
  if (!sheet || sheet.view !== "sheet" || !["PageUp", "PageDown"].includes(event.key) || event.target.closest?.("input, select, textarea")) return;
  event.preventDefault();
  showLayout(sheet.layout + (event.key === "PageDown" ? 1 : -1));
});

/** 図面の図形の強調（読み出しの文と、画層の行の印） */
function highlightItems(items, text, layer) {
  drawingViewer.highlight(items);
  readoutChip.textContent = text ?? idleText;
  readout.classList.toggle("is-live", Boolean(text));
  for (const [name, row] of sheet?.rows ?? []) row.classList.toggle("is-active", name === layer);
}

function onDrawingHover(index) {
  const item = index === null ? null : sheet?.scene?.items[index];
  const { drawing } = sheet?.model ?? {};
  if (item) highlightItems([index], describeItem(item, drawing.units.name, drawing.layers.get(item.layer)?.scale ?? 1), item.layer);
  else highlightItems([]);
}

$("toggle-lineweight").addEventListener("click", (event) => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", String(on));
  drawingViewer.setLineweights(on);
});

// ---- HTML ----------------------------------------------------------------------
const setSourceStatus = (text) => ($("source-status").textContent = text);

const HTML_VIEWS = [{ key: "model", label: "取り込んだ形（3D）" }, { key: "source", label: "元のページ" }];

/** 取り込みの状態（none・run・ok・bad）を流れに知らせる。取り込めていなければ「この状態を取り込む」が次にすること。
 *  取り込めたら取り込んだ形を、取り込めなかったら元のページ（取り込みのボタンがある）を主役の場所に出す */
function setCapture(state, revision = null) {
  if (state === "ok") selectViewTab("model");
  else if (state === "bad") selectViewTab("source");
  updateFlow({ capture: state, revision });
  $("capture").className = state === "ok" || state === "run" ? "secondary" : "primary";
  setNext("view", state === "ok" || state === "run" ? null : $("capture"));
}

async function capture() {
  if (!source) return;
  const button = $("capture");
  button.disabled = true;
  setSourceStatus("取り込み中…");
  setCapture("run");
  try {
    const snapshot = await source.extract();
    captured = { snapshot, at: new Date() };
    captured.unit = setupUnit(sourceName, snapshot, (unit) => {
      captured.unit = unit;
      analyze();
    });
    analyze();
    showAlert(snapshot.meshes.length ? "" : "取り込める形状がありませんでした。元のページで部品を表示してから、もう一度取り込んでください。");
    setSourceStatus(`${captured.at.toLocaleTimeString("ja-JP")} に取り込み · three.js r${snapshot.revision ?? "?"}`);
    setCapture(snapshot.meshes.length ? "ok" : "bad", snapshot.revision);
  } catch (error) {
    console.warn(error);
    showAlert(`取り込みに失敗しました（${error.message}）。元のページの表示が終わってから、もう一度お試しください。`);
    setSourceStatus("取り込みに失敗しました");
    setCapture("bad");
  } finally {
    button.disabled = false;
  }
}
$("capture").addEventListener("click", capture);

/** 取り込んだシーンを、選んだ単位で認識し、表示と変換データを作り直す */
function analyze() {
  const { snapshot, at, unit } = captured;
  const recognition = recognizeSnapshot(snapshot, { unit });
  const describe = describeRecognition(recognition);
  const rows = renderHtmlPanel({ describe }, rowHandlers((g) => g.ids));
  current = { info: describe.partInfo, rows };
  viewer?.show({ meshes: buildDisplayMeshes(snapshot, recognition) });
  highlight([]);
  setSpec(buildInventorSpec({ file: sourceName, revision: snapshot.revision, capturedAt: at.toISOString() }, recognition), sourceName);
}

function loadHtml(text, name, isSample = false) {
  showAlert("");
  assembly = null;
  setMode("html");
  sourceName = name;
  captured = null;
  setSpec(null);
  renderHeader({ eyebrow: "three.js の HTML", name, meta: "元のページで表示を選び「この状態を取り込む」を押すと、その形状を取り込みます", isSample });
  current = null;
  viewer?.clear();
  renderHtmlPanel({ describe: { counts: { exact: 0, approx: 0, excluded: 0 }, groups: [], excluded: [] } }, rowHandlers(() => []));
  setSourceStatus("読み込み中…");
  setCapture("run");
  source?.dispose();
  let ready = false;
  const frame = new SourceFrame($("source-frame"), text, {
    onReady: () => {
      if (ready) return;
      ready = true;
      setSourceStatus("描画を確認しました。取り込み中…");
      setTimeout(() => source === frame && capture(), SETTLE_MS);
    },
  });
  source = frame;
  setTimeout(() => {
    if (!ready && source === frame) {
      setSourceStatus("three.js の描画が見つかりません");
      setCapture("bad");
      showAlert(`${name}: three.js（WebGLRenderer）による描画が見つかりませんでした。three.js を使ったページか、必要なファイルがそろっているかを確かめてください。`);
    }
  }, READY_TIMEOUT_MS);
}

// ---- 変換データ（.inventor.json）-----------------------------------------------------
function loadSpec(text, name, isSample = false) {
  let spec;
  try {
    spec = readSpec(text);
  } catch (error) {
    showAlert(`${name}: ${error.message}`);
    return;
  }
  showAlert("");
  assembly = null;
  setMode("spec");
  const { file, captured_at: at } = spec.source;
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toLocaleString("ja-JP") : null;
  renderHeader({ eyebrow: "変換データ", name, meta: [file && `${file} から取り込み`, when].filter(Boolean).join(" · "), isSample, thumbnailUrl: null });
  const describe = describeSpec(spec);
  viewer?.show(previewScene(spec));
  const rows = renderSpecPanel({ describe }, rowHandlers((g) => g.ids));
  current = { info: describe.partInfo, rows };
  specParts = describe.groups;
  highlight([]);
  setSpec(spec, name);
}

async function load(bytes, name, isSample = false) {
  startDialog.close();
  showNotice("");
  if (SPEC.test(name)) loadSpec(new TextDecoder().decode(bytes), name, isSample);
  else if (detectFormat(name, bytes) === "html") loadHtml(new TextDecoder().decode(bytes), name, isSample);
  else await loadModel(bytes, name, isSample);
}

// ---- 受け取ったファイル（ドロップ・選択・exe へのドロップ）-----------------------------
// 開けるものの最初の 1 つを開く（組立 → STEP → そのほかの順）。2 つ以上なら起動画面の「受け取ったファイル」に並べて切り替える。
const library = new PartLibrary(); // 組立が参照する部品を探す場所（受け取ったファイル・サンプル）
const SPEC = /\.json$/i; // 変換データ（.inventor.json）
const opens = (item) => OPENABLE.test(item.name);
const OPEN_FIRST = [/\.iam$/i, /\.(stp|step)$/i];
const rank = (item) => {
  const i = OPEN_FIRST.findIndex((re) => re.test(item.name));
  return i < 0 ? OPEN_FIRST.length : i;
};
const nameList = (items) => items.map((i) => i.name).join("、");
let received = [];
let shown = null; // 表示中の受け取ったファイル（サンプルを開いたら null）

const renderReceived = () => startDialog.setReceived(received, shown, openItem);

/** 受け取ったもの・サンプルの中身。読めなければ（窓に届かない・ファイルが消えた）理由を知らせて null */
async function readItem(item) {
  try {
    return await item.read();
  } catch (error) {
    console.warn(error);
    startDialog.close(); // 知らせはパネルに出るので、起動画面を閉じて見えるようにする
    showAlert(`${item.name} を読み込めませんでした。${error.message}。`);
    return null;
  }
}

async function openItem(item) {
  const button = $("open"), label = button.querySelector(".label");
  button.disabled = true;
  label.textContent = "読み込み中…"; // 印と Ctrl+O は残す
  try {
    const bytes = await readItem(item);
    if (!bytes) return;
    await load(bytes, item.name);
    shown = item;
  } finally {
    button.disabled = false;
    label.textContent = "ファイルを開く";
    renderReceived();
  }
}

async function receive(items) {
  if (!items.length) return;
  items = [...new Map(items.map((i) => [i.name.toLowerCase(), i])).values()]; // 同じ名前は 1 つにする（組立と同じフォルダの部品など）
  items.forEach((item) => library.add(item));
  // 組立を表示中に、見つからなかった部品だけを受け取ったら、組立に加える（開き直さない）
  const missing = new Set((assembly?.model?.missing ?? []).map((f) => f.toLowerCase()));
  if (assembly?.doc && items.every((i) => missing.has(i.name.toLowerCase()))) {
    const { bytes, name, isSample } = assembly.doc;
    await loadModel(bytes, name, isSample);
    showNotice(`${nameList(items)} を組立に加えました。`);
    return;
  }
  items = [...items].sort((a, b) => rank(a) - rank(b));
  const usable = items.filter(opens);
  const others = items.filter((i) => !opens(i));
  if (!usable.length) usable.push(others.shift()); // 拡張子が違っても、中身で判断して開いてみる
  const notes = [];
  if (others.length) notes.push(`${nameList(others)} は開けません（対応しているのは ${FORMAT_NAMES}）。`);
  if (!usable.length) {
    startDialog.close();
    showAlert(notes.join(" "));
    return;
  }
  received = usable;
  await openItem(usable[0]);
  if (usable.length > 1) notes.unshift(`${usable.length} 件を受け取り、${usable[0].name} を開きました。ほかのファイルは「サンプル・使い方」の一覧から開けます。`);
  showNotice(notes.join(" "));
}

// 開ける形式の案内（ファイルを選ぶ窓・最初の画面の札・ドロップの案内）は formats/open.js の並びから作る
$("file-input").accept = ACCEPT;
$("dropzone").querySelector(".formats").replaceChildren(...FORMATS.map(([name]) => Object.assign(document.createElement("span"), { textContent: name })));
$("drop-overlay").querySelector("p").textContent = `ドロップして開く（${FORMAT_NAMES}）`;
acceptFiles({ input: $("file-input"), openers: [$("open"), $("welcome-open"), $("start-open")], dropzone: $("dropzone"), overlay: $("drop-overlay"),
  isDropzoneShown: () => !$("stage-empty").hidden }, receive);

// ---- ツールバー ----------------------------------------------------------------
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => viewer?.setView(VIEWS[button.dataset.view]));
}
$("fit").addEventListener("click", () => (sheet?.view === "sheet" ? drawingViewer.fit() : viewer?.fit()));
$("toggle-edges").addEventListener("click", (event) => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", String(on));
  viewer?.setEdgesVisible(on);
});

// ---- サンプル（program/samples フォルダ。中身は開くときに読む）------------------------------
const noServer = (what) => (error) => {
  console.warn(error);
  showAlert(`${what}を読み込めませんでした。${error.message}。`);
  return null;
};
// 一覧と受け取ったファイルは同時に尋ねる（待ち時間を重ねない）
const samplesReady = listSamples().catch(noServer("サンプルの一覧"));
const LAUNCH = "起動で受け取ったファイル";
const launchReady = claimLaunch().catch(noServer(LAUNCH));
const samples = (await samplesReady) ?? [];
samples.forEach((item) => library.add(item));
startDialog.setSamples(samples, async (item) => {
  const bytes = await readItem(item);
  if (!bytes) return;
  await load(bytes, item.name, true);
  shown = null;
  renderReceived();
});

// ---- 起動 ----------------------------------------------------------------------
/** 起動で受け取ったもの（起動したとき・開いたまま exe へドロップされたとき）を開く。→ 開くものがあったか */
async function takeLaunch(launch) {
  const { items, parts, missing } = launch ?? { items: [], parts: [], missing: [] };
  parts.forEach((item) => library.add(item)); // 組立と同じフォルダの部品（組立が参照する部品を探す置き場）
  if (items.length) await receive(items); // 開き終えてから起動画面（案内）を出す（開くと起動画面は閉じるため）
  if (missing.length) {
    const note = `${missing.join("、")} は見つかりませんでした（起動してから画面が受け取るまでに、移動・削除された可能性があります）。`;
    showNotice([$("notice").hidden ? "" : $("notice").textContent, note].join(" ").trim());
  }
  return items.length > 0;
}

setMode("empty");
initBuild(); // 保存先と、作っている途中の仕事（画面を開き直したとき）を読む
initSettings();
onLaunch(async (claim) => takeLaunch(await claim.catch(noServer(LAUNCH))));
await takeLaunch(await launchReady); // 何も受け取っていなければ、3D の場所に始め方が見えている
showNews(); // 起動でそろえた後なら、その版で変わったことを右下に 1 度だけ
offerShortcut(); // デスクトップにショートカットが無ければ、右下で尋ねる（開いた物を見る邪魔をしないよう、開き終えてから）
