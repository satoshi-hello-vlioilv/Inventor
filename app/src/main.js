// アプリの入口: ファイルの読み込み（起動画面・ボタン・ドラッグ＆ドロップ・Ctrl+O・サンプル・起動ファイル）、解析、表示、
// 3D ⇄ パネルの連動。
//   .ipt       … 部品。ブラウザ内で解析して表示する
//   .iam       … 組立。部品の配置を読み、参照先の .ipt（一緒に受け取ったもの・サンプル）を組み立てて表示する
//   .stp/.step … STEP。部品の形状と組立の配置を全て含むので、単独で表示できる（部品 1 つなら部品として表示）
//   .html      … 隔離した iframe で動かし、three.js の形状を取り出して回転体・押し出しとして認識する
// 起動ファイルにドロップされたファイルは、起動.bat がページの複製の末尾に埋め込んで届ける（window.IPT_VIEWER_LAUNCH）。

import { describeAssembly, describeBody } from "./viewer/describe.js";
import { buildInventorSpec, formatSpec } from "./export/inventor.js";
import { buildDisplayMeshes, describeRecognition } from "./extract/describe.js";
import { SourceFrame } from "./extract/frame.js";
import { buildIamScene, parseIam } from "./iam/index.js";
import { CfbError, parseIpt } from "./ipt/index.js";
import { recognizeSnapshot } from "./recognize/index.js";
import { StepError, parseStepFile } from "./step/index.js";
import { renderAsmPanel, renderHeader, renderHtmlPanel, renderIptPanel, setPanelMode } from "./ui/panel.js";
import { VIEWS, Viewer } from "./viewer/viewer.js";

const $ = (id) => document.getElementById(id);
const readout = $("readout");
const readoutChip = readout.querySelector(".chip");
// 何も指していないときの案内。指す単位（部品は面、組立・HTML は部品）に合わせる
const IDLE_TEXT = { ipt: readoutChip.textContent, asm: "部品にカーソルを合わせると、名前と寸法を表示します" };
IDLE_TEXT.html = IDLE_TEXT.asm;
let idleText = IDLE_TEXT.ipt;
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

// ---- 部品・組立 ------------------------------------------------------------------
function explainIpt(error) {
  if (error instanceof CfbError) {
    return "Inventor のファイル形式（OLE2）ではありません。.ipt・.iam・.stp・.html のいずれかを選んでください。";
  }
  if (error instanceof StepError) return `STEP として読めませんでした（${error.message}）。`;
  return `形状データを読み取れませんでした（${error.message}）。動作を確認しているのは Inventor 2026 で保存したファイルです。`;
}

function setThumbnail(png) {
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl = png ? URL.createObjectURL(new Blob([png], { type: "image/png" })) : null;
  return thumbnailUrl;
}

let assembly = null; // 表示中（または部品を開く前）の組立 { scene, header, doc }

/**
 * 部品を表示する（.ipt・STEP の部品・組立の中の部品で共通）。
 * @param {{ bodies, labels }} scene
 * @param {{ header: object, report?: object, properties?: object, fromAssembly?: boolean }} options
 */
function showPart(scene, { header, report = null, properties = {}, fromAssembly = false }) {
  setMode("ipt");
  renderHeader(header);
  $("back-to-assembly").hidden = !fromAssembly;
  const describe = describeBody(scene.bodies[0], scene.labels);
  const { volume = 0 } = viewer?.show(scene) ?? {};
  const rows = renderIptPanel({ report, scene, describe, properties, volume }, rowHandlers((g) => g.faceIds));
  current = { info: describe.faceInfo, rows };
  highlight([]);
}

/** 組立を表示する（.iam・STEP で共通） */
function showAssembly(scene, header) {
  setMode("asm");
  renderHeader(header);
  $("back-to-assembly").hidden = true;
  const { volumes = [] } = viewer?.show(scene) ?? {};
  const describe = describeAssembly(scene, volumes);
  const rows = renderAsmPanel({ describe, scene }, {
    ...rowHandlers((g) => g.ids),
    onClick: (g) => (g.missing ? input.click() : openAssemblyPart(g.index)),
    onMissing: () => input.click(),
  });
  current = { info: describe.info, rows };
  assembly = { ...(assembly ?? {}), scene, header };
  highlight([]);
}

/** 組立の中の部品を 1 つだけ開く（部品と同じ表示。「組立に戻る」で戻る） */
function openAssemblyPart(index) {
  const part = assembly.scene.parts[index];
  if (!part?.bodies?.length) return;
  const density = part.density_g_per_mm3 ? part.density_g_per_mm3 * 1000 : null;
  showPart({ bodies: part.bodies, labels: assembly.scene.labels }, {
    // 見出しはファイル名（組立に記録された保存先の完全なパスは長く、利用者のフォルダ名も含むので出さない）
    header: { eyebrow: `組立の部品（${assembly.header.name}）`, name: part.name, meta: part.file ?? part.number ?? "", isSample: assembly.header.isSample, thumbnailUrl: null },
    properties: { material: part.material, density_g_per_cm3: density },
    fromAssembly: true,
  });
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
    showAlert(`${name}: 表示できる形状（B-rep）が見つかりませんでした。図面（.idw）やプレゼンテーション（.ipn）には対応していません。`);
    return;
  }
  showAlert("");
  assembly = null;
  const kernel = result.scene.source;
  showPart(result.scene, {
    header: { eyebrow: "部品ファイル（ipt）", name, meta: kernel ? `${kernel.kernel} · ${kernel.saved_at}` : "", isSample, thumbnailUrl: setThumbnail(result.thumbnail) },
    report: result.report,
    properties: result.properties,
  });
}

function loadStep(bytes, name, isSample = false) {
  let result;
  try {
    result = parseStepFile(new TextDecoder().decode(bytes), name);
  } catch (error) {
    console.warn(error);
    showAlert(`${name}: ${explainIpt(error)}`);
    return;
  }
  const { scene } = result;
  if (!scene.parts.length) {
    showAlert(`${name}: 表示できる形状（ソリッド）が見つかりませんでした。`);
    return;
  }
  showAlert("");
  setThumbnail(null);
  const src = scene.source;
  const meta = [src.system, src.time?.slice(0, 10)].filter(Boolean).join(" · ");
  const single = scene.instances.length <= 1 && scene.parts.length === 1;
  if (single) {
    assembly = null;
    const part = scene.parts[0];
    showPart({ bodies: part.bodies, labels: scene.labels }, {
      header: { eyebrow: "STEP（部品）", name, meta, isSample, thumbnailUrl: null },
      properties: { material: part.material, density_g_per_cm3: part.density_g_per_mm3 ? part.density_g_per_mm3 * 1000 : null },
    });
    return;
  }
  assembly = { doc: null };
  showAssembly(scene, { eyebrow: "STEP（組立）", name, meta, isSample, thumbnailUrl: null });
}

/** 組立の参照先の .ipt を、受け取ったファイルとサンプルから探す（ファイル名で照合） */
async function resolveParts(iam) {
  const found = new Map();
  for (const ref of iam.references) {
    const item = library.get(ref.file.toLowerCase());
    if (item) found.set(ref.path, { name: item.name, bytes: await item.read() });
  }
  return (ref) => found.get(ref.path) ?? null;
}

async function loadIam(bytes, name, isSample = false) {
  let iam;
  try {
    iam = parseIam(bytes, name);
  } catch (error) {
    console.warn(error);
    showAlert(`${name}: ${explainIpt(error)}`);
    return;
  }
  const scene = buildIamScene(iam, name, await resolveParts(iam));
  showAlert(iam.report.paired ? "" : `${name}: 部品の配置を読み取れませんでした（出現 ${iam.occurrences.length} に対し配置 ${iam.report.placements}）。部品は原点に置いて表示します。`);
  const header = { eyebrow: "組立ファイル（iam）", name, meta: `部品の参照 ${iam.references.length} 件`, isSample, thumbnailUrl: setThumbnail(iam.thumbnail) };
  assembly = { doc: { bytes, name, isSample } };
  showAssembly(scene, header);
}

/** 表示中の組立が参照していて、まだ見つかっていない部品のファイル名（小文字） */
function missingFiles() {
  return new Set((assembly?.scene?.parts ?? []).filter((p) => p.missing && p.file).map((p) => p.file.toLowerCase()));
}

$("back-to-assembly").addEventListener("click", () => assembly && showAssembly(assembly.scene, assembly.header));

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

// ---- ファイルの受け付け --------------------------------------------------------
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const head = (bytes) => new TextDecoder().decode(bytes.subarray(0, 2048));
const isOle2 = (bytes) => OLE2.every((b, i) => bytes[i] === b);
const isHtml = (name, bytes) => /\.html?$/i.test(name) || (!isOle2(bytes) && /<html|<!doctype|<script/i.test(head(bytes)));
const isStep = (name, bytes) => /\.(stp|step)$/i.test(name) || (!isOle2(bytes) && /^\s*ISO-10303-21\s*;/.test(head(bytes)));

async function load(bytes, name, isSample = false) {
  closeStart();
  showNotice("");
  if (isHtml(name, bytes)) loadHtml(new TextDecoder().decode(bytes), name, isSample);
  else if (isStep(name, bytes)) loadStep(bytes, name, isSample);
  else if (/\.iam$/i.test(name)) await loadIam(bytes, name, isSample);
  else loadIpt(bytes, name, isSample);
}

// 組立が参照する部品を探す場所: 受け取ったファイル（ドロップ・選択・起動ファイル）とサンプル。ファイル名（小文字）→ 読み出し
const library = new Map();
const addToLibrary = (item) => /\.ipt$/i.test(item.name) && library.set(item.name.toLowerCase(), item);

const VIEWABLE = /\.(ipt|iam|stp|step|html?)$/i;
// 2 つ以上受け取ったとき最初に開く順（組立 → STEP → そのほか）
const OPEN_FIRST = [/\.iam$/i, /\.(stp|step)$/i];
const openOrder = (items) => [...items].sort((a, b) => rank(a) - rank(b));
const rank = (item) => {
  const i = OPEN_FIRST.findIndex((re) => re.test(item.name));
  return i < 0 ? OPEN_FIRST.length : i;
};
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
  items.forEach(addToLibrary);
  // 組立を表示中に、見つからなかった部品だけを受け取ったら、組立に加える（開き直さない）
  const missing = missingFiles();
  if (assembly?.doc && items.length && items.every((i) => missing.has(i.name.toLowerCase()))) {
    const { bytes, name, isSample } = assembly.doc;
    await loadIam(bytes, name, isSample);
    showNotice(`${items.map((i) => i.name).join("、")} を組立に加えました。`);
    return;
  }
  items = openOrder(items);
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
for (const node of samples) addToLibrary({ name: node.dataset.name, size: Number(node.dataset.size), read: async () => decodeBase64(node.textContent) });
$("start-samples").hidden = !samples.length;
$("sample-rows").replaceChildren(
  ...samples.map((node) => fileRow({ name: node.dataset.name, size: Number(node.dataset.size) }, async () => {
    await load(decodeBase64(node.textContent), node.dataset.name, true);
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
