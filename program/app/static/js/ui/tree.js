// 親子関係のある一覧を木で表す（組立の構成など。画面の案は 2026-10 の木の比較で利用者が選んだ H: docs/ui.md §16）。
//   ▾ で開閉し、親子を線でつなぐ。目（表示・非表示）はカーソルを合わせた行と、消した行だけに出す（静かに保つ）。
//   親を消すと中も消える（中の行は淡くなる）。行を押すと、組立なら開閉、部品なら handlers.onPick（部品を開くなど）。
//
//   renderTree(ul, nodes, state, handlers) → Map<行の key, 行の要素>
//     nodes … [{ key, name, count, sub, children, ids }]（count … ×n。null なら出さない。ids … 3D の部品の id。強調・消すのに使う）
//     state … { open: Set<key>, hidden: Set<key> }（呼ぶ側が持つ。描き直しても開閉・表示を保つ）
//     handlers … { onEnter(node), onLeave(), onPick(node), onChange() }（onChange: 開閉・表示が変わった。呼ぶ側が描き直す）
//   hiddenIds(nodes, state) → 消えている部品の id（自分か親が消えている行の ids）

const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.1 6.9C3.6 8.6 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1"/></svg>';

const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

export function renderTree(list, nodes, state, handlers) {
  const rows = new Map();
  const items = [];
  const walk = (level, parentHidden, ancestors) => (node, i, siblings) => {
    const branch = node.children.length > 0;
    const open = branch && state.open.has(node.key);
    const hidden = state.hidden.has(node.key);
    const li = el("li", `tree-row${branch ? " is-branch" : ""}${parentHidden ? " is-dim" : ""}${hidden ? " is-hidden" : ""}`);
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", String(level));
    if (branch) li.setAttribute("aria-expanded", String(open));
    li.style.setProperty("--depth", String(level - 1));
    li.dataset.depth = String(level - 1); // 親子の線を引くか（CSS）
    li.dataset.last = String(i === siblings.length - 1);
    li.tabIndex = items.length ? -1 : 0;
    const line = el("div", "tree-line");
    line.append(el("span", "tree-twisty", branch ? (open ? "▾" : "▸") : ""), el("span", branch ? "tree-icon is-branch" : "tree-icon", branch ? "▣" : "◧"),
      el("span", "tree-name", node.name), el("span", "tree-count", node.count == null ? "" : `×${node.count}`)); // 数の無い行（1 つだけ）は出さない
    const eye = el("button", `tree-eye${hidden ? " is-off" : ""}`);
    eye.type = "button";
    eye.innerHTML = hidden ? EYE_OFF : EYE;
    eye.title = hidden ? "表示する" : `消す${branch ? "（中の部品も消える）" : ""}`;
    eye.setAttribute("aria-label", `${node.name}を${hidden ? "表示する" : "消す"}`);
    eye.setAttribute("aria-pressed", String(!hidden));
    eye.addEventListener("click", (event) => {
      event.stopPropagation();
      if (hidden) state.hidden.delete(node.key);
      else state.hidden.add(node.key);
      handlers.onChange();
    });
    line.append(eye);
    li.append(line);
    if (node.sub) li.append(el("div", "tree-sub", node.sub));
    const act = () => {
      if (branch) {
        if (open) state.open.delete(node.key);
        else state.open.add(node.key);
        handlers.onChange();
      } else handlers.onPick?.(node);
    };
    li.addEventListener("click", act);
    li.addEventListener("keydown", (event) => {
      if (event.target !== li) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); act(); }
      if (branch && ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open))) { event.preventDefault(); act(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const all = [...list.querySelectorAll(".tree-row")];
        all[all.indexOf(li) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
    });
    for (const type of ["pointerenter", "focus"]) li.addEventListener(type, () => handlers.onEnter(node));
    for (const type of ["pointerleave", "blur"]) li.addEventListener(type, handlers.onLeave);
    rows.set(node.key, li);
    items.push(li);
    if (open) node.children.forEach(walk(level + 1, parentHidden || hidden, [...ancestors, node]));
  };
  nodes.forEach(walk(1, false, []));
  list.replaceChildren(...items);
  return rows;
}

/** 消えている部品の id（自分か親が消えている行） */
export function hiddenIds(nodes, state) {
  const out = [];
  const walk = (node, off) => {
    const hidden = off || state.hidden.has(node.key);
    if (hidden) out.push(...node.ids);
    else node.children.forEach((c) => walk(c, hidden));
  };
  nodes.forEach((n) => walk(n, false));
  return out;
}
