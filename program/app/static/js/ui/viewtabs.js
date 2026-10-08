// 主役の場所のタブ（上の中央）: 同じ場所に重ねた 2 つの表示を切り替える。
//   HTML     … 取り込んだ形（3D）⇄ 元のページ（元のページは隠さず 3D の下に重ねる。隠すと three.js が描かず、取り込めない）
//   3D の PDF … 図面（ページ）⇄ 3D
// 選んだタブは #app の data-view に置き、どちらを上に出すかは CSS が決める。タブが無い表示では帯ごと隠す。

const $ = (id) => document.getElementById(id);

let current = { tabs: [], onSelect: () => {} };

/**
 * タブを出す（null なら隠す）。
 * @param {{ key: string, label: string }[] | null} tabs
 * @param {string} selected
 * @param {(key: string) => void} onSelect 利用者がタブを押したとき（選び直しは selectViewTab で）
 */
export function setViewTabs(tabs, selected, onSelect = () => {}) {
  const bar = $("view-tabs"), list = $("view-tab-list");
  current = { tabs: tabs ?? [], onSelect };
  bar.hidden = !tabs?.length;
  $("app").classList.toggle("has-view-tabs", Boolean(tabs?.length));
  list.replaceChildren(...current.tabs.map(({ key, label }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.view = key;
    button.textContent = label;
    button.addEventListener("click", () => {
      selectViewTab(key);
      current.onSelect(key);
    });
    return button;
  }));
  if (tabs?.length) selectViewTab(selected);
  else delete $("app").dataset.view;
}

/** タブを選ぶ（画面の都合で切り替えるとき: 取り込めたら 3D へ、など） */
export function selectViewTab(key) {
  if (!current.tabs.some((t) => t.key === key)) return;
  $("app").dataset.view = key;
  for (const button of $("view-tab-list").children) button.setAttribute("aria-selected", String(button.dataset.view === key));
}

export const viewTab = () => $("app").dataset.view ?? null;
