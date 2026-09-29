// アプリの入口: 受け取ったファイルを読み（formats/open.js）、3D（viewer/）と仕様パネル（ui/panel.js）に表示し、両者を連動させる。
//   .ipt・.iam・.stp … モデル（部品・組立）として読み、表示する
//   .html            … 隔離した iframe で動かし、three.js の形状を取り出して認識し（convert/recognize）、変換データを作る
// ファイルの受け付けは ui/files.js、起動画面は ui/start.js、変換データの保存は ui/convert.js。

import { buildInventorSpec } from "./convert/inventor.js";
import { recognizeSnapshot } from "./convert/recognize/index.js";
import { OPENABLE, detectFormat, explainError, partOf, readModel } from "./formats/open.js";
import { buildDisplayMeshes, describeRecognition } from "./html/describe.js";
import { SourceFrame } from "./html/frame.js";
import { setSpec } from "./ui/convert.js";
import { PartLibrary, acceptFiles, decodeBase64, readLaunch } from "./ui/files.js";
import { renderAsmPanel, renderHeader, renderHtmlPanel, renderIptPanel, setPanelMode } from "./ui/panel.js";
import { LAUNCHER } from "./ui/product.js";
import { startDialog } from "./ui/start.js";
import { describeAssembly, describeBody } from "./viewer/describe.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
// 何も指していないときの案内。指す単位（部品は面、組立・HTML は部品）に合わせる
const IDLE_TEXT = { ipt: readoutChip.textContent, asm: "部品にカーソルを合わせると、名前と寸法を表示します" };
IDLE_TEXT.html = IDLE_TEXT.asm;
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

/** 表示モード: empty（何も開いていない）・ipt（部品）・asm（組立）・html。 */
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
    const recognition = recognizeSnapshot(snapshot);
    const describe = describeRecognition(recognition);
    const rows = renderHtmlPanel({ describe }, rowHandlers((g) => g.ids));
    current = { info: describe.partInfo, rows };
    viewer?.show({ meshes: buildDisplayMeshes(snapshot, recognition) });
    highlight([]);
    showAlert(recognition.parts.length ? "" : "取り込める形状がありませんでした。元のページで部品を表示してから、もう一度取り込んでください。");
    const now = new Date();
    setSourceStatus(`${now.toLocaleTimeString("ja-JP")} に取り込み · three.js r${snapshot.revision ?? "?"}`);
    setSpec(buildInventorSpec({ file: sourceName, revision: snapshot.revision, capturedAt: now.toISOString() }, recognition), sourceName);
  } catch (error) {
    console.warn(error);
    showAlert(`取り込みに失敗しました（${error.message}）。元のページの表示が終わってから、もう一度お試しください。`);
    setSourceStatus("取り込みに失敗しました");
  } finally {
    button.disabled = false;
  }
}
$("capture").addEventListener("click", capture);

function loadHtml(text, name, isSample = false) {
  showAlert("");
  assembly = null;
  setMode("html");
  sourceName = name;
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

async function load(bytes, name, isSample = false) {
  startDialog.close();
  showNotice("");
  if (detectFormat(name, bytes) === "html") loadHtml(new TextDecoder().decode(bytes), name, isSample);
  else await loadModel(bytes, name, isSample);
}

// ---- 受け取ったファイル（ドロップ・選択・起動ファイル）-----------------------------
// 開けるものの最初の 1 つを開く（組立 → STEP → そのほかの順）。2 つ以上なら起動画面の「受け取ったファイル」に並べて切り替える。
const library = new PartLibrary(); // 組立が参照する部品を探す場所（受け取ったファイル・サンプル）
const OPEN_FIRST = [/\.iam$/i, /\.(stp|step)$/i];
const rank = (item) => {
  const i = OPEN_FIRST.findIndex((re) => re.test(item.name));
  return i < 0 ? OPEN_FIRST.length : i;
};
const SPEC = /\.json$/i;
const nameList = (items) => items.map((i) => i.name).join("、");
let received = [];
let shown = null; // 表示中の受け取ったファイル（サンプルを開いたら null）

const renderReceived = () => startDialog.setReceived(received, shown, openItem);

async function openItem(item) {
  const button = $("open");
  button.disabled = true;
  button.textContent = "読み込み中…";
  try {
    await load(await item.read(), item.name);
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
  const usable = items.filter((i) => OPENABLE.test(i.name));
  const specs = items.filter((i) => SPEC.test(i.name));
  const others = items.filter((i) => !OPENABLE.test(i.name) && !SPEC.test(i.name));
  if (!usable.length && !specs.length) usable.push(others.shift()); // 拡張子が違っても、中身で判断して開いてみる
  const notes = [];
  if (specs.length) notes.push(`変換データ（${nameList(specs)}）はこの画面では開きません。Inventor のある PC で、起動ファイル（${LAUNCHER}）にドラッグ＆ドロップすると部品を作ります。`);
  if (others.length) notes.push(`${nameList(others)} は開けません（対応しているのは .ipt・.iam・.stp・.html）。`);
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

// ---- サンプル（build.mjs がページに埋め込む）---------------------------------------
const samples = [...document.querySelectorAll("script.sample")].map((node) => ({
  name: node.dataset.name, size: Number(node.dataset.size), read: async () => decodeBase64(node.textContent),
}));
samples.forEach((item) => library.add(item));
startDialog.setSamples(samples, async (item) => {
  await load(await item.read(), item.name, true);
  shown = null;
  renderReceived();
});

// ---- 起動 ----------------------------------------------------------------------
setMode("empty");
const launch = readLaunch(window.INVENTOR_TOOL_LAUNCH);
startDialog.showPythonHelp(launch.messages.includes("python-missing"));
if (launch.items.length) await receive(launch.items); // 開き終えてから起動画面（案内）を出す（開くと起動画面は閉じるため）
// 起動ファイルからの知らせ（ソースからアプリを作り直せず、前に作ったものを開いたとき・受け取れなかったファイルがあるとき）
const LAUNCH_NOTICES = {
  "node-missing": "Node.js が見つからないため、ソースからアプリを作り直せませんでした。前に作ったアプリを開いています（最近の変更が入っていない場合があります）。",
  "build-failed": "ソースからアプリを作り直せませんでした。前に作ったアプリを開いています。リポジトリのフォルダで npm run build を実行すると理由が分かります。",
};
const launchNotes = launch.messages.map((m) => LAUNCH_NOTICES[m]).filter(Boolean);
if (launch.unreadable) launchNotes.push("起動ファイルから受け取れなかったファイルがあります（ほかのアプリが使用中の可能性があります）。");
if (launchNotes.length) showNotice([$("notice").hidden ? "" : $("notice").textContent, ...launchNotes].join(" ").trim());
if (!launch.items.length || launch.messages.includes("python-missing")) startDialog.open();
