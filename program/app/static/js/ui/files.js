// ファイルの受け付け: 「ファイルを開く」・Ctrl+O・ドラッグ＆ドロップ。exe（Inventor3DTool.exe）へドロップされたものは desktop.js が受け取る。
// 受け取ったものは { name, size, read: () => Promise<Uint8Array> } にそろえる。

/** <input type="file">・ドロップの FileList → 受け取ったもの */
export const fromFiles = (fileList) => [...(fileList ?? [])].map((f) => ({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }));

/** 組立が参照する部品（.ipt）の置き場: 受け取ったファイル・組立と同じフォルダの部品・サンプル。ファイル名（大文字小文字を区別しない）で探す */
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
 * @param {{ input: HTMLInputElement, openers: HTMLElement[], dropzone: HTMLElement, overlay: HTMLElement, isDropzoneShown: () => boolean }} ui
 *   dropzone … 始め方の受け口（見えているときはそこを強調し、見えていなければ画面全体に案内を出す）
 * @param {(items: object[]) => void} onReceive
 */
export function acceptFiles({ input, openers, dropzone, overlay, isDropzoneShown }, onReceive) {
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
  // ドラッグ＆ドロップ（画面のどこでも受け付ける。始め方が見えていれば、その受け口を強調する）
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  const showDropTarget = (on) => {
    dropzone.classList.toggle("is-over", on && isDropzoneShown());
    overlay.hidden = !on || isDropzoneShown();
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
