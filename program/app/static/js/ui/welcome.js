// 始め方（何も開いていないときの 3D の場所。案 K: docs/ui.md §24）: できることの 4 列と、この PC の状態（版・Inventor・Python）。
//   renderUses(FORMATS) … できることの 4 列（形式は formats/open.js の並びから。並びに無い形式は出さない）
//   showEnvironment()   … 版と、作るのに要る物（Inventor・Python）があるかを 1 行に（窓に届かなければ出さない）

import { buildStatus, updateStatus } from "../desktop.js";

const $ = (id) => document.getElementById(id);
const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

// できること: [名前, 一言, 形式（拡張子）, アイコン]
const USES = [
  ["部品・組立", "形・寸法・部品表", [".ipt", ".iam"], svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>')],
  ["STEP", "配置をそのまま", [".stp"], svg('<path d="M4 6h7v7H4zM13 11h7v7h-7z"/><path d="M11 9.5h4.5V11"/>')],
  ["2D の図面", "測る・直して保存", [".dwg", ".dxf", ".pdf", ".jww", ".sfc", ".p21"],
    svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="10" cy="12" r="3.5"/><path d="M14.5 16.5h4"/>')],
  ["CAD にする", "STEP・Inventor に", [".html"], svg('<path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5"/><path d="M13.5 5 10.5 19"/>')],
];

/** できることの 4 列（FORMATS: formats/open.js の [名前, 拡張子…] の並び） */
export function renderUses(formats) {
  const known = new Set(formats.map(([name]) => name));
  $("welcome-uses").replaceChildren(...USES.map(([name, note, exts, icon]) => {
    const li = document.createElement("li");
    li.innerHTML = icon;
    li.append(Object.assign(document.createElement("b"), { textContent: name }), Object.assign(document.createElement("small"), { textContent: note }),
      Object.assign(document.createElement("code"), { textContent: exts.filter((e) => known.has(e)).join(" ") }));
    return li;
  }));
}

/** 版と、この PC で作るのに要る物の状態（緑 = 使える・琥珀 = 足りない・灰 = 無いが見るのには要らない） */
export async function showEnvironment() {
  const [update, build] = await Promise.all([updateStatus().catch(() => null), buildStatus().catch(() => null)]);
  const items = [];
  const item = (tone, text) => {
    const span = Object.assign(document.createElement("span"), { className: tone ? `is-${tone}` : "" });
    span.append(document.createElement("i"), text);
    items.push(span);
  };
  if (update?.local) {
    item("ok", `版 ${update.local}`);
    $("welcome-version").textContent = update.local;
    $("welcome-version").hidden = false;
  }
  if (build) {
    item(build.inventor_installed ? "ok" : "", build.inventor_installed ? "Inventor で作れます" : "Inventor の無い PC（見る・STEP を作るのは使えます）");
    item(build.python_missing ? "warn" : "ok", build.python_missing ? "Python がありません（作るのに要ります）" : "Python があります");
  }
  $("welcome-env").replaceChildren(...items);
  $("welcome-env").hidden = !items.length;
}
