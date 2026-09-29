// ファイルの受け付け: 「ファイルを開く」・Ctrl+O・ドラッグ＆ドロップ・起動ファイル（起動.bat がページに埋め込む）。
// 受け取ったものは { name, size, read: () => Promise<Uint8Array> } にそろえる。

export const decodeBase64 = (text) => Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));

/** <input type="file">・ドロップの FileList → 受け取ったもの */
export const fromFiles = (fileList) => [...(fileList ?? [])].map((f) => ({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }));

// ---- 起動ファイルから届いたもの（起動.bat が window.INVENTOR_TOOL_LAUNCH に埋め込む）---------------
//   { name, data } … ドロップされたファイル。certutil の Base64（名前は UTF-16LE の文字列、中身はファイルそのもの）
//   { message }    … 知らせ（"python-missing": Inventor で部品を作るための Python が見つからない、
//                     "node-missing"・"build-failed": ソースからアプリを作り直せず、前に作ったものを開いた）
const fromCertutil = (text) => decodeBase64(String(text ?? "").replace(/-----[^-]*-----/g, "").replace(/\s+/g, ""));

/** @returns {{ items: object[], unreadable: number, messages: string[] }}  名前を読めなかったもの（起動.bat が読めなかったファイル）は数だけ返す */
export function readLaunch(entries = []) {
  const all = entries.filter((e) => "name" in e).map((e) => {
    const bytes = fromCertutil(e.data);
    return { name: new TextDecoder("utf-16le").decode(fromCertutil(e.name)).trim(), size: bytes.length, read: async () => bytes };
  });
  const items = all.filter((item) => item.name);
  return { items, unreadable: all.length - items.length, messages: entries.filter((e) => e.message).map((e) => e.message) };
}

/** 組立が参照する部品（.ipt）の置き場: 受け取ったファイルとサンプル。ファイル名（大文字小文字を区別しない）で探す */
export class PartLibrary {
  #items = new Map();

  add(item) {
    if (/\.ipt$/i.test(item.name)) this.#items.set(item.name.toLowerCase(), item);
  }

  /** @returns {Promise<{ name, bytes } | null>} */
  async find(fileName) {
    const item = this.#items.get(fileName.toLowerCase());
    return item ? { name: item.name, bytes: await item.read() } : null;
  }
}

/**
 * ファイルを受け取る操作をつなぐ。
 * @param {{ input: HTMLInputElement, openers: HTMLElement[], dropzone: HTMLElement, overlay: HTMLElement, isStartOpen: () => boolean }} ui
 * @param {(items: object[]) => void} onReceive
 */
export function acceptFiles({ input, openers, dropzone, overlay, isStartOpen }, onReceive) {
  for (const el of openers) el.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    onReceive(fromFiles(input.files));
    input.value = ""; // 同じファイルを続けて選んでも change が発生するように
  });
  addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      input.click();
    }
  });
  // ドラッグ＆ドロップ（画面のどこでも受け付ける。起動画面が開いていれば、その受け口を強調する）
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  const showDropTarget = (on) => {
    dropzone.classList.toggle("is-over", on && isStartOpen());
    overlay.hidden = !on || isStartOpen();
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
    onReceive(fromFiles(event.dataTransfer.files));
  });
}
