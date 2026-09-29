// アプリの入口: ファイルの読み込み（ボタン・ドラッグ＆ドロップ・Ctrl+O）、解析、表示、3D ⇄ パネルの連動。

import { CfbError, parseIpt } from "./ipt/index.js";
import { renderPanel } from "./ui/panel.js";
import { describeBody } from "./viewer/describe.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
const IDLE_TEXT = readoutChip.textContent;

let current = null; // { describe, rows }
let thumbnailUrl = null;

// ---- 強調表示（3D ⇄ パネルの双方向） -----------------------------------------
function highlight(faceIds, text, groupKey) {
  viewer?.highlight(faceIds);
  readoutChip.textContent = text ?? IDLE_TEXT;
  readout.classList.toggle("is-live", Boolean(text));
  for (const [key, row] of current?.rows ?? []) row.classList.toggle("is-active", key === groupKey);
}

function onFaceHover(faceId) {
  const info = faceId === null ? null : current?.describe.faceInfo.get(faceId);
  if (info) highlight([faceId], info.text, info.group);
  else highlight([]);
}

let viewer = null;
try {
  viewer = new Viewer({ stage: $("stage"), canvas: $("view"), gizmo: $("gizmo") }, { onHover: onFaceHover });
} catch {
  const note = document.createElement("p");
  note.className = "message";
  note.textContent = "この環境では 3D 表示（WebGL）が使えません。ブラウザのハードウェアアクセラレーション設定を確認してください。";
  $("stage").append(note);
}

// ---- 読み込み ------------------------------------------------------------------
function showAlert(message) {
  const alert = $("alert");
  alert.textContent = message;
  alert.hidden = !message;
}

function explain(error) {
  if (error instanceof CfbError) {
    return "Inventor のファイル形式（OLE2）ではありません。拡張子 .ipt の部品ファイルを選んでください。";
  }
  return `形状データを読み取れませんでした（${error.message}）。動作を確認しているのは Inventor 2026 で保存した部品ファイルです。`;
}

function load(bytes, name, isSample = false) {
  let result;
  try {
    result = parseIpt(bytes, name);
  } catch (error) {
    console.warn(error); // 想定内の入力エラー。利用者には alert で説明する
    showAlert(`${name}: ${explain(error)}`);
    return;
  }
  if (!result.scene.bodies.length) {
    showAlert(`${name}: 表示できる形状（B-rep）が見つかりませんでした。アセンブリ（.iam）や図面（.idw）には対応していません。`);
    return;
  }
  showAlert("");
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl = result.thumbnail ? URL.createObjectURL(new Blob([result.thumbnail], { type: "image/png" })) : null;
  const describe = describeBody(result.scene.bodies[0], result.scene.labels);
  const rows = renderPanel(
    { report: result.report, scene: result.scene, describe, thumbnailUrl, isSample },
    { onEnter: (g) => highlight(g.faceIds, g.text, g.key), onLeave: () => highlight([]) },
  );
  current = { describe, rows };
  viewer?.show(result.scene);
  highlight([]);
}

async function openFile(file) {
  if (!file) return;
  const button = $("open");
  button.disabled = true;
  button.textContent = "読み込み中…";
  try {
    load(new Uint8Array(await file.arrayBuffer()), file.name);
  } finally {
    button.disabled = false;
    button.textContent = "ipt ファイルを開く";
  }
}

const input = $("file-input");
$("open").addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  openFile(input.files[0]);
  input.value = ""; // 同じファイルを続けて選んでも change が発生するように
});
addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    input.click();
  }
});

// ドラッグ＆ドロップ（画面のどこでも受け付ける）
const overlay = $("drop-overlay");
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  overlay.hidden = false;
});
addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) overlay.hidden = true;
});
addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  overlay.hidden = true;
  openFile(event.dataTransfer.files[0]);
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

// ---- 起動時はサンプルを表示 ------------------------------------------------------
const sample = $("sample-ipt");
if (sample) load(Uint8Array.from(atob(sample.textContent.trim()), (c) => c.charCodeAt(0)), sample.dataset.name, true);
