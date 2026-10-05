// アプリの入口: 受け取ったファイルを読み（formats/open.js）、3D（viewer/）と仕様パネル（ui/panel.js）に表示し、両者を連動させる。
//   .ipt・.iam・.stp … モデル（部品・組立）として読み、表示する
//   .html            … 隔離した iframe で動かし、three.js の形状を取り出して認識し（convert/recognize）、変換データを作る
//   .json            … 変換データ（.inventor.json）。作る形を 3D で示し（convert/preview.js）、「Inventor で作る」で作る
// ファイルの受け付けは ui/files.js、窓（Inventor3DTool.exe）とのやりとり（サンプル・起動で受け取ったファイル）は desktop.js、
// 起動画面は ui/start.js、変換の節は ui/convert.js、「Inventor で作る」は ui/build.js。

import { buildInventorSpec, readSpec } from "./convert/inventor.js";
import { describeSpec, previewScene } from "./convert/preview.js";
import { recognizeSnapshot } from "./convert/recognize/index.js";
import { OPENABLE, detectFormat, explainError, partOf, readModel } from "./formats/open.js";
import { buildDisplayMeshes, describeRecognition } from "./html/describe.js";
import { SourceFrame } from "./html/frame.js";
import { setSpec } from "./ui/convert.js";
import { claimLaunch, listSamples, onLaunch } from "./desktop.js";
import { PartLibrary, acceptFiles } from "./ui/files.js";
import { initBuild } from "./ui/build.js";
import { setupUnit } from "./ui/units.js";
import { renderAsmPanel, renderHeader, renderHtmlPanel, renderIptPanel, renderSpecPanel, setPanelMode } from "./ui/panel.js";
import { startDialog } from "./ui/start.js";
import { describeAssembly, describeBody } from "./viewer/describe.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
// 何も指していないときの案内。指す単位（部品は面、組立・HTML は部品）に合わせる
const IDLE_TEXT = { ipt: readoutChip.textContent, asm: "部品にカーソルを合わせると、名前と寸法を表示します" };
IDLE_TEXT.html = IDLE_TEXT.spec = IDLE_TEXT.asm;
const SETTLE_MS = 1200; // 元のページの最初の描画から取り込みまで待つ時間（初期化の完了待ち）
const READY_TIMEOUT_MS = 15000;
const EYEBROW = {
  "part:ipt": "部品ファイル（ipt）", "part:step": "STEP（部品）", "assembly:step": "STEP（組立）", "assembly:iam": "組立ファイル（iam）",
};

let idleText = IDLE_TEXT.ipt;
let current = null; // 表示中の強調の対応 { info: Map<id, {group, text}>, rows: Map<groupKey, element> }
let thumbnailUrl = null;
let assembly = null; // 表示中（または部品を開く前）の組立 { model, header, doc: { bytes, name, isSample } }
let source = null; // 表示中の元のページ（SourceFrame）
let sourceName = ""; // 表示中の HTML のファイル名
let captured = null; // 最後に取り込んだシーン { snapshot, at, unit }（単位を変えたら認識し直す）

// ---- 強調表示（3D ⇄ パネルの双方向） -----------------------------------------
function highlight(ids, text, groupKey) {
  viewer?.highlight(ids);
  readoutChip.textContent = text ?? idleText;
  readout.classList.toggle("is-live", Boolean(text));
  for (const [key, row] of current?.rows ?? []) row.classList.toggle("is-active", key === groupKey);
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
  $("stage-empty").hidden = mode !== "empty";
  $("source").hidden = mode !== "html";
  setPanelMode(mode);
  idleText = IDLE_TEXT[mode] ?? IDLE_TEXT.ipt;
  if (mode !== "html" && source) {
    source.dispose();
    source = null;
  }
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
  assembly = { ...assembly, model, header };
  highlight([]);
}

/** 組立の中の部品を 1 つだけ開く（部品と同じ表示。「組立に戻る」で戻る） */
function openAssemblyPart(index) {
  const part = partOf(assembly.model, index);
  if (part) showPart(part, { eyebrow: `組立の部品（${assembly.header.name}）`, name: part.name, meta: part.meta, isSample: assembly.header.isSample, thumbnailUrl: null });
}

$("back-to-assembly").addEventListener("click", () => assembly && showAssembly(assembly.model, assembly.header));

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
  const header = { eyebrow: EYEBROW[`${model.kind}:${model.format}`], name, meta: model.meta, isSample, thumbnailUrl: setThumbnail(model.thumbnail) };
  if (model.kind === "part") {
    assembly = null;
    showPart(model, header);
  } else {
    assembly = { doc: model.format === "iam" ? { bytes, name, isSample } : null };
    showAssembly(model, header);
  }
}

// ---- HTML ----------------------------------------------------------------------
const setSourceStatus = (text) => ($("source-status").textContent = text);

async function capture() {
  if (!source) return;
  const button = $("capture");
  button.disabled = true;
  setSourceStatus("取り込み中…");
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
  } catch (error) {
    console.warn(error);
    showAlert(`取り込みに失敗しました（${error.message}）。元のページの表示が終わってから、もう一度お試しください。`);
    setSourceStatus("取り込みに失敗しました");
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
  renderHeader({ eyebrow: "変換データ（Inventor 用）", name, meta: [file && `${file} から取り込み`, when].filter(Boolean).join(" · "), isSample, thumbnailUrl: null });
  const describe = describeSpec(spec);
  viewer?.show(previewScene(spec));
  const rows = renderSpecPanel({ describe }, rowHandlers((g) => g.ids));
  current = { info: describe.partInfo, rows };
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
const opens = (item) => OPENABLE.test(item.name) || SPEC.test(item.name);
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
  const button = $("open");
  button.disabled = true;
  button.textContent = "読み込み中…";
  try {
    const bytes = await readItem(item);
    if (!bytes) return;
    await load(bytes, item.name);
    shown = item;
  } finally {
    button.disabled = false;
    button.textContent = "ファイルを開く";
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
  if (others.length) notes.push(`${nameList(others)} は開けません（対応しているのは .ipt・.iam・.stp・.html・.inventor.json）。`);
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

acceptFiles({ input: $("file-input"), openers: [$("open"), $("dropzone")], dropzone: $("dropzone"), overlay: $("drop-overlay"), isStartOpen: () => startDialog.isOpen }, receive);

// ---- ツールバー ----------------------------------------------------------------
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => viewer?.setView(VIEWS[button.dataset.view]));
}
$("fit").addEventListener("click", () => viewer?.fit());
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
onLaunch(async (claim) => takeLaunch(await claim.catch(noServer(LAUNCH))));
if (!(await takeLaunch(await launchReady))) startDialog.open();
