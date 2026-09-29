// アプリの入口: ファイルの読み込み（起動画面・ボタン・ドラッグ＆ドロップ・Ctrl+O・サンプル・起動ファイル）、解析、表示、
// 3D ⇄ パネルの連動。
//   .ipt  … ブラウザ内で解析して表示する
//   .html … 隔離した iframe で動かし、three.js の形状を取り出して回転体・押し出しとして認識する
// 起動ファイルにドロップされたファイルは、起動.bat がページの複製の末尾に埋め込んで届ける（window.IPT_VIEWER_LAUNCH）。

import { describeBody } from "./viewer/describe.js";
import { buildInventorSpec, formatSpec } from "./export/inventor.js";
import { buildDisplayMeshes, describeRecognition } from "./extract/describe.js";
import { SourceFrame } from "./extract/frame.js";
import { CfbError, parseIpt } from "./ipt/index.js";
import { recognizeSnapshot } from "./recognize/index.js";
import { renderHeader, renderHtmlPanel, renderIptPanel, setPanelMode } from "./ui/panel.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
const IDLE_TEXT = readoutChip.textContent;
const SETTLE_MS = 1200; // 元のページの最初の描画から取り込みまで待つ時間（初期化の完了待ち）
const READY_TIMEOUT_MS = 15000;

let current = null; // { info: Map<id, {group, text}>, rows: Map<groupKey, element> }
let thumbnailUrl = null;
let source = null; // 表示中の元のページ（SourceFrame）
let sourceName = ""; // 表示中の HTML のファイル名
let spec = null; // 最後に取り込んだ形状の変換データ

// ---- 強調表示（3D ⇄ パネルの双方向） -----------------------------------------
function highlight(ids, text, groupKey) {
  viewer?.highlight(ids);
  readoutChip.textContent = text ?? IDLE_TEXT;
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

function showAlert(message) {
  const alert = $("alert");
  alert.textContent = message;
  alert.hidden = !message;
}

/** 誤りではない知らせ（開かなかったファイルなど）。 */
function showNotice(message) {
  const notice = $("notice");
  notice.textContent = message;
  notice.hidden = !message;
}

/** 表示モード: empty（何も開いていない）・ipt・html。 */
function setMode(mode) {
  $("app").classList.toggle("is-html", mode === "html");
  $("app").classList.toggle("is-empty", mode === "empty");
  $("stage-empty").hidden = mode !== "empty";
  $("source").hidden = mode !== "html";
  setPanelMode(mode);
  if (mode !== "html" && source) {
    source.dispose();
    source = null;
  }
}

// ---- ipt -----------------------------------------------------------------------
function explainIpt(error) {
  if (error instanceof CfbError) {
    return "Inventor のファイル形式（OLE2）ではありません。拡張子 .ipt の部品ファイルか、three.js を使った .html を選んでください。";
  }
  return `形状データを読み取れませんでした（${error.message}）。動作を確認しているのは Inventor 2026 で保存した部品ファイルです。`;
}

function loadIpt(bytes, name, isSample = false) {
  let result;
  try {
    result = parseIpt(bytes, name);
  } catch (error) {
    console.warn(error); // 想定内の入力エラー。利用者には alert で説明する
    showAlert(`${name}: ${explainIpt(error)}`);
    return;
  }
  if (!result.scene.bodies.length) {
    showAlert(`${name}: 表示できる形状（B-rep）が見つかりませんでした。アセンブリ（.iam）や図面（.idw）には対応していません。`);
    return;
  }
  showAlert("");
  setMode("ipt");
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl = result.thumbnail ? URL.createObjectURL(new Blob([result.thumbnail], { type: "image/png" })) : null;
  const kernel = result.scene.source;
  renderHeader({ eyebrow: "部品ファイル（ipt）", name, meta: kernel ? `${kernel.kernel} · ${kernel.saved_at}` : "", isSample, thumbnailUrl });
  const describe = describeBody(result.scene.bodies[0], result.scene.labels);
  const rows = renderIptPanel({ report: result.report, scene: result.scene, describe }, rowHandlers((g) => g.faceIds));
  current = { info: describe.faceInfo, rows };
  viewer?.show(result.scene);
  highlight([]);
}

// ---- HTML ----------------------------------------------------------------------
function setSourceStatus(text) {
  $("source-status").textContent = text;
}

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
    setSpec(buildInventorSpec({ file: sourceName, revision: snapshot.revision, capturedAt: now.toISOString() }, recognition));
  } catch (error) {
    console.warn(error);
    showAlert(`取り込みに失敗しました（${error.message}）。元のページの表示が終わってから、もう一度お試しください。`);
    setSourceStatus("取り込みに失敗しました");
  } finally {
    button.disabled = false;
  }
}

// ---- Inventor 用の変換データ -----------------------------------------------------
const specFileName = () => `${sourceName.replace(/\.[^.]+$/, "")}.inventor.json`;

function setSpec(next) {
  spec = next;
  const kinds = spec?.parts.length ?? 0;
  const placed = spec?.parts.reduce((n, p) => n + p.instances.length, 0) ?? 0;
  const skipped = spec?.skipped.reduce((n, s) => n + s.count, 0) ?? 0;
  const summary = $("convert-summary");
  summary.classList.remove("is-done");
  summary.textContent = !spec ? "取り込むと、変換できる部品の数を表示します"
    : kinds ? `部品 ${kinds} 種類・配置 ${placed} か所を変換します${skipped ? `（近似の ${skipped} 個は変換しません）` : ""}`
      : "正確に認識できた部品がないため、変換できません";
  $("save-spec").disabled = $("copy-spec").disabled = !kinds;
  $("build-command").textContent = `python -m ipt_build ${spec ? specFileName() : "変換データ.json"}`;
}

function reportDone(text) {
  const summary = $("convert-summary");
  summary.textContent = text;
  summary.classList.add("is-done");
}

$("save-spec").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([formatSpec(spec)], { type: "application/json" }));
  link.download = specFileName();
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  reportDone(`${specFileName()} を保存しました（ダウンロードに現れない場合は「コピー」を使ってください）`);
});

$("copy-spec").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatSpec(spec));
    reportDone(`変換データをコピーしました。テキストエディタに貼り付けて ${specFileName()} として保存してください`);
  } catch {
    reportDone("コピーできませんでした。このブラウザではクリップボードが使えません");
  }
});

function loadHtml(text, name, isSample = false) {
  showAlert("");
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

// ---- ファイルの受け付け --------------------------------------------------------
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const isHtml = (name, bytes) => /\.html?$/i.test(name) || (!OLE2.every((b, i) => bytes[i] === b) && /<html|<!doctype|<script/i.test(new TextDecoder().decode(bytes.subarray(0, 2048))));

function load(bytes, name, isSample = false) {
  closeStart();
  showNotice("");
  if (isHtml(name, bytes)) loadHtml(new TextDecoder().decode(bytes), name, isSample);
  else loadIpt(bytes, name, isSample);
}

const VIEWABLE = /\.(ipt|html?)$/i;
const SPEC = /\.json$/i;
const nameList = (items) => items.map((i) => i.name).join("、");

// ---- 受け取ったファイル（ドロップ・選択・起動ファイル）-----------------------------
// .ipt・.html の最初の 1 つを開く。2 つ以上なら起動画面の「受け取ったファイル」に並べ、そこから切り替えられるようにする。
// 受け取ったものは { name, size, read: () => Promise<Uint8Array> } にそろえる。
let received = [];
let shown = null; // 表示中の受け取ったファイル（サンプルを開いたら null）

async function openItem(item) {
  const button = $("open");
  button.disabled = true;
  button.textContent = "読み込み中…";
  try {
    load(await item.read(), item.name);
    shown = item;
  } finally {
    button.disabled = false;
    button.textContent = "ファイルを開く";
    renderReceived();
  }
}

async function receive(items) {
  if (!items.length) return;
  const usable = items.filter((i) => VIEWABLE.test(i.name));
  const specs = items.filter((i) => SPEC.test(i.name));
  const others = items.filter((i) => !VIEWABLE.test(i.name) && !SPEC.test(i.name));
  if (!usable.length && !specs.length) usable.push(others.shift()); // 拡張子が違っても、中身で判断して開いてみる
  const notes = [];
  if (specs.length) notes.push(`変換データ（${nameList(specs)}）はビューアでは開きません。Inventor のある PC で、起動ファイル（Inventor部品ビューア.vbs）にドラッグ＆ドロップすると部品を作ります。`);
  if (others.length) notes.push(`${nameList(others)} は開けません（対応しているのは .ipt・.html）。`);
  if (!usable.length) {
    closeStart();
    showAlert(notes.join(" "));
    return;
  }
  received = usable;
  await openItem(usable[0]);
  if (usable.length > 1) notes.unshift(`${usable.length} 件を受け取り、${usable[0].name} を開きました。ほかのファイルは「サンプル・使い方」の一覧から開けます。`);
  showNotice(notes.join(" "));
}

const fromFiles = (fileList) => [...(fileList ?? [])].map((f) => ({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }));

const input = $("file-input");
$("open").addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  receive(fromFiles(input.files));
  input.value = ""; // 同じファイルを続けて選んでも change が発生するように
});
addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    input.click();
  }
});
$("capture").addEventListener("click", capture);

// ---- 起動画面（ファイルを開く・サンプル・変換の流れ）---------------------------
const start = $("start");
const dropzone = $("dropzone");
function openStart() {
  if (!start.open) start.showModal();
}
function closeStart() {
  if (start.open) start.close();
}
$("show-start").addEventListener("click", openStart);
$("start-close").addEventListener("click", closeStart);
start.addEventListener("click", (event) => event.target === start && closeStart()); // 背景（枠の外）のクリック
dropzone.addEventListener("click", () => input.click()); // 中の「ファイルを選ぶ」ボタンのクリックもここに届く

// ドラッグ＆ドロップ（画面のどこでも受け付ける。起動画面が開いていれば、その受け口を強調する）
const overlay = $("drop-overlay");
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
const showDropTarget = (on) => {
  dropzone.classList.toggle("is-over", on && start.open);
  overlay.hidden = !on || start.open;
};
addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  showDropTarget(true);
});
addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) showDropTarget(false);
});
addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  showDropTarget(false);
  receive(fromFiles(event.dataTransfer.files));
});

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

// ---- 起動画面の一覧（受け取ったファイル・サンプル）--------------------------------
const decodeBase64 = (text) => Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const span = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });

/** 一覧の 1 行（種類・名前・大きさ）。 */
function fileRow({ name, size }, onOpen, current = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sample-row";
  button.title = name;
  if (current) button.setAttribute("aria-current", "true");
  const ext = name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "";
  const kind = ext === "htm" ? "html" : ext;
  button.append(span("sample-kind", kind), span("sample-name", name.replace(/\.[^.]+$/, "")), span("sample-size", sizeText(size)));
  button.addEventListener("click", onOpen);
  const item = document.createElement("li");
  item.append(button);
  return item;
}

function renderReceived() {
  $("start-received").hidden = received.length < 2;
  $("received-rows").replaceChildren(...received.map((item) => fileRow(item, () => openItem(item), item === shown)));
}

const samples = [...document.querySelectorAll("script.sample")];
$("start-samples").hidden = !samples.length;
$("sample-rows").replaceChildren(
  ...samples.map((node) => fileRow({ name: node.dataset.name, size: Number(node.dataset.size) }, () => {
    load(decodeBase64(node.textContent), node.dataset.name, true);
    shown = null;
    renderReceived();
  })),
);

// ---- 起動ファイルから届いたもの（起動.bat が埋め込む）----------------------------
//   { name, data } … ドロップされたファイル。certutil の Base64（名前は UTF-16LE の文字列、中身はファイルそのもの）
//   { message }    … 知らせ（"python-missing": Inventor で部品を作るための Python が見つからない）
const fromCertutil = (text) => decodeBase64(String(text ?? "").replace(/-----[^-]*-----/g, "").replace(/\s+/g, ""));
function launchedItems(entries) {
  return entries.filter((e) => "name" in e).map((e) => {
    const bytes = fromCertutil(e.data);
    return { name: new TextDecoder("utf-16le").decode(fromCertutil(e.name)).trim(), size: bytes.length, read: async () => bytes };
  });
}
const UNREADABLE = "起動ファイルから受け取れなかったファイルがあります（ほかのアプリが使用中の可能性があります）。";

// ---- 起動 ----------------------------------------------------------------------
setMode("empty");
const launch = window.IPT_VIEWER_LAUNCH ?? [];
$("python-help").hidden = !launch.some((e) => e.message === "python-missing");
const launchedAll = launchedItems(launch);
const launched = launchedAll.filter((item) => item.name); // 名前を読めなかったもの（起動.bat が読めなかったファイル）は除いて知らせる
if (launched.length) await receive(launched); // 開き終えてから起動画面（案内）を出す（開くと起動画面は閉じるため）
if (launched.length < launchedAll.length) showNotice([$("notice").hidden ? "" : $("notice").textContent, UNREADABLE].join(" ").trim());
if (!launched.length || !$("python-help").hidden) openStart();
