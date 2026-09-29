// 起動画面（ファイルを開く・サンプル・受け取ったファイル・変換の流れ）。<dialog> で、Esc・背景のクリック・× で閉じる。

const $ = (id) => document.getElementById(id);
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
  button.append(span("sample-kind", ext === "htm" ? "html" : ext), span("sample-name", name.replace(/\.[^.]+$/, "")), span("sample-size", sizeText(size)));
  button.addEventListener("click", onOpen);
  const item = document.createElement("li");
  item.append(button);
  return item;
}

export const startDialog = {
  element: $("start"),
  get isOpen() {
    return this.element.open;
  },
  open() {
    if (!this.element.open) this.element.showModal();
  },
  close() {
    if (this.element.open) this.element.close();
  },

  /** サンプルの一覧 */
  setSamples(samples, onOpen) {
    $("start-samples").hidden = !samples.length;
    $("sample-rows").replaceChildren(...samples.map((item) => fileRow(item, () => onOpen(item))));
  },

  /** 受け取ったファイルの一覧（2 つ以上のとき。表示中のものに印） */
  setReceived(items, shown, onOpen) {
    $("start-received").hidden = items.length < 2;
    $("received-rows").replaceChildren(...items.map((item) => fileRow(item, () => onOpen(item), item === shown)));
  },

  /** Inventor で部品を作るための Python が見つからないときの案内 */
  showPythonHelp(on) {
    $("python-help").hidden = !on;
  },
};

$("show-start").addEventListener("click", () => startDialog.open());
$("start-close").addEventListener("click", () => startDialog.close());
startDialog.element.addEventListener("click", (event) => event.target === startDialog.element && startDialog.close()); // 背景（枠の外）のクリック
