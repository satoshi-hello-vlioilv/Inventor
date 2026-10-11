// 図面の保存の入口（見出しの「保存」と今の形式の札。案 I: docs/ui.md §23）。
//   「保存」… 今の形式で保存する（onSave(形式)）。札（DXF R2013 ▾ など）… 押すと形式のメニュー（向く相手の説明つき）
//   メニュー: ↑↓ で動き、Enter・クリックで選ぶ（選んだ形式は札に出し、この PC に覚える。保存はしない）。Esc・外を押すと閉じる
//
//   new SaveMenu({ onSave })   SAVE_FORMATS … 形式の一覧（main.js が形式ごとに書く関数を選ぶ）

export const SAVE_FORMATS = {
  "dxf-R2013": { label: "DXF R2013", kind: "dxf", version: "R2013", extension: "dxf" },
  "dxf-R2000": { label: "DXF R2000", kind: "dxf", version: "R2000", extension: "dxf" },
  sxf: { label: "SXF", kind: "sxf", extension: "sfc" },
};
const DEFAULT = "dxf-R2013";
const KEY = "inventor3d.saveFormat";
const $ = (id) => document.getElementById(id);

function recall() {
  try {
    const v = localStorage.getItem(KEY);
    return SAVE_FORMATS[v] ? v : DEFAULT;
  } catch {
    return DEFAULT; // 覚えられないブラウザーでは、毎回 DXF R2013 から
  }
}

export class SaveMenu {
  constructor({ onSave }) {
    this.button = $("save");
    this.chip = $("save-format");
    this.menu = $("save-menu");
    this.items = [...this.menu.querySelectorAll("[data-format]")];
    this.#show(recall());
    this.button.addEventListener("click", () => onSave(this.format));
    this.chip.addEventListener("click", () => (this.menu.hidden ? this.open() : this.close()));
    for (const item of this.items) item.addEventListener("click", () => this.choose(item.dataset.format));
    this.menu.addEventListener("keydown", (event) => this.#key(event));
    document.addEventListener("pointerdown", (event) => {
      if (!this.menu.hidden && !this.menu.contains(event.target) && !this.chip.contains(event.target)) this.close(false);
    });
  }

  get format() { return this.chip.dataset.format; }
  get spec() { return SAVE_FORMATS[this.format]; }

  open() {
    this.menu.hidden = false;
    this.chip.setAttribute("aria-expanded", "true");
    (this.items.find((i) => i.dataset.format === this.format) ?? this.items[0]).focus();
  }

  close(refocus = true) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.chip.setAttribute("aria-expanded", "false");
    if (refocus) this.chip.focus();
  }

  /** 形式を選ぶ（札に出して覚える。メニューを閉じて「保存」へ） */
  choose(format) {
    if (!SAVE_FORMATS[format]) return;
    this.#show(format);
    try {
      localStorage.setItem(KEY, format);
    } catch {
      // 覚えられなくても、この画面の間は選んだ形式のまま
    }
    this.close(false);
    this.button.focus();
  }

  #show(format) {
    this.chip.dataset.format = format;
    this.chip.textContent = SAVE_FORMATS[format].label;
    this.button.title = `${SAVE_FORMATS[format].label} で保存（形式は右の札で選ぶ）`;
    for (const item of this.items) item.setAttribute("aria-checked", String(item.dataset.format === format));
  }

  #key(event) {
    const i = this.items.indexOf(document.activeElement);
    if (event.key === "Escape") this.close();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.items[(i + step + this.items.length) % this.items.length].focus();
    } else if (event.key === "Home") this.items[0].focus();
    else if (event.key === "End") this.items.at(-1).focus();
    else if (event.key === "Tab") this.close(false);
    else return;
    event.preventDefault();
    event.stopPropagation(); // Esc で図面の命令まで止めない
  }
}
