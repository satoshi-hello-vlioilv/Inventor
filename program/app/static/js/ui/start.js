// サンプル・受け取ったファイルの窓（<dialog>。Esc・背景のクリック・× で閉じる）。見出しバーの「サンプル・受け取ったファイル」、
// 始め方の「サンプルで試す」、見出しバーの「受け取った n 件」から開く。サンプルは種類ごとにまとめて並べる。

const $ = (id) => document.getElementById(id);
const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const span = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });
const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "").replace(/^htm$/, "html").replace(/^step$/, "stp");
// サンプルの種類（置き場の名前。図面の置き場 dwg には .dxf・.pdf・.jww も入る）
const kindOf = (name) => extOf(name).replace(/^(dxf|pdf|jww)$/, "dwg");
// 種類の見出し（サンプルの置き場 samples/<種類> と同じ並び）: [種類, 見出し, 説明, 札（無ければ種類）]
const KINDS = [
  ["ipt", "部品", "Inventor の部品"],
  ["iam", "組立", "部品の .ipt はサンプルから探して組み立てます"],
  ["stp", "STEP", "部品と組立の配置をすべて含む"],
  ["dwg", "図面", "2D の図面。画層・レイアウトを切り替えて見る（PDF の 3D も）", "dwg・dxf・pdf・jww"],
  ["html", "three.js の HTML", "取り込んで STEP・Inventor の部品にできます"],
];

/** 一覧の 1 行（種類・名前・大きさ）。種類ごとにまとめた一覧では、種類は見出しに出す（kind: false） */
function fileRow({ name, size }, onOpen, { current = false, kind = true } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sample-row";
  button.title = name;
  if (current) button.setAttribute("aria-current", "true");
  if (kind) button.append(span("sample-kind", extOf(name)));
  button.append(span("sample-name", name.replace(/\.[^.]+$/, "")), span("sample-size", sizeText(size)));
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

  /** サンプルの一覧（種類ごと） */
  setSamples(samples, onOpen) {
    $("start-samples").hidden = !samples.length;
    $("sample-groups").replaceChildren(...KINDS.map(([kind, label, note, chip = kind]) => {
      const items = samples.filter((s) => kindOf(s.name) === kind);
      if (!items.length) return "";
      const section = document.createElement("section");
      const h = document.createElement("h3");
      h.append(label, span("sample-kind", chip), Object.assign(document.createElement("small"), { textContent: `${items.length} 件・${note}` }));
      const list = Object.assign(document.createElement("ul"), { className: "sample-rows" });
      list.append(...items.map((item) => fileRow(item, () => onOpen(item), { kind: false })));
      section.append(h, list);
      return section;
    }));
  },

  /** 受け取ったファイルの一覧（2 つ以上のとき。表示中のものに印）。見出しバーに件数を出し、押すとこの窓を開く */
  setReceived(items, shown, onOpen) {
    $("start-received").hidden = items.length < 2;
    $("received-rows").replaceChildren(...items.map((item) => fileRow(item, () => onOpen(item), { current: item === shown })));
    $("received-switch").hidden = items.length < 2;
    $("received-switch").textContent = `受け取った ${items.length} 件`;
  },
};

for (const id of ["show-start", "welcome-samples", "received-switch"]) $(id).addEventListener("click", () => startDialog.open());
$("start-close").addEventListener("click", () => startDialog.close());
startDialog.element.addEventListener("click", (event) => event.target === startDialog.element && startDialog.close()); // 背景（枠の外）のクリック
