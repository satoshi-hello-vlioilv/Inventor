// 設定のページ（メインの画面を切り替える。docs/ui.md §20・docs/desktop.md §8）。
//   見出しバーの「設定」で、3D・図面と右の欄の場所を設定のページに切り替える（見ていたものは後ろにそのまま残る）。
//   「戻る」・Esc・もう一度「設定」で元の画面へ。ファイルを開いたときも元の画面へ戻る（main.js の setMode）。
//   ページ = 左の目次（区分。まとまりごと・いまの状態つき）＋ 区分の中身。区分は ./settings/panes.js に並べたもの（足すのはそこだけ）
// 窓（desktop/src/shortcut.rs・update.rs）が状態を答え、操作のたびに役割を確かめる。画面は答えを描くだけ（ここでは守らない）。
// 右下の知らせ（そろえた後の「変わったこと」・入れたときに作ったショートカット・ショートカットの問い）もここ

import { createShortcut, declineShortcut, seenShortcutNotice, shortcutStatus, updateOp, updateStatus } from "../desktop.js";
import { GROUPS, PANES } from "./settings/panes.js";
import { el, noteList } from "./settings/parts.js";

const $ = (id) => document.getElementById(id);
/** 設定を開いている間、触れないようにする元の画面の場所（見えないが、Tab で入らないように） */
const BEHIND = ["stage", "side", "view-tabs", "source"];

let state = { pane: "overview", update: null, shortcut: null, confirm: null, message: null, publishing: null, draft: null };

export const isSettingsOpen = () => !$("settings").hidden;

/** 設定のページを開く（開くたびに窓へ問い合わせ直す: ほかの PC が版を置いた・配った後でも、いまの状態を出す） */
export async function openSettings(pane) {
  if (pane) state.pane = pane;
  if (!isSettingsOpen()) {
    $("settings").hidden = false;
    $("app").classList.add("is-settings");
    $("show-settings").setAttribute("aria-pressed", "true");
    for (const id of BEHIND) $(id)?.setAttribute("inert", "");
    render();
    $("settings-back").focus();
  }
  await refresh();
}

/** 元の画面へ戻る（確かめの途中・知らせは捨てる。次に開いたときは今の状態から） */
export function closeSettings() {
  if (!isSettingsOpen()) return;
  $("settings").hidden = true;
  $("app").classList.remove("is-settings");
  $("show-settings").setAttribute("aria-pressed", "false");
  for (const id of BEHIND) $(id)?.removeAttribute("inert");
  state = { ...state, confirm: null, message: null, draft: null };
}

async function refresh() {
  const [update, shortcut] = await Promise.all([updateStatus().catch((e) => ({ error: e.message })), shortcutStatus().catch((e) => ({ error: e.message }))]);
  state = { ...state, update, shortcut };
  render();
}

/** 区分に渡すもの（窓の答え・途中の状態と、状態を変える手段） */
const context = () => ({
  ...state,
  set(patch) {
    state = { ...state, ...patch };
    render();
  },
  async act(run, done) {
    state = { ...state, confirm: null, message: { tone: "run", text: "しています…" } };
    render();
    try {
      const answer = await run();
      state.message = { tone: "ok", text: typeof done === "function" ? done(answer) : done };
    } catch (error) {
      state.message = { tone: "bad", text: error.message };
    }
    await refresh();
  },
  go(pane) {
    state = { ...state, pane, confirm: null, message: null, draft: null };
    render();
    $("settings-main").scrollTop = 0;
  },
});

const icon = (d) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
};

/** 左の目次: まとまりごとに区分を並べ、区分のいまの状態を添える */
function renderNav(ctx, panes) {
  const lists = GROUPS.map(([key, label]) => {
    const items = panes.filter((p) => p.group === key);
    if (!items.length) return null;
    const group = el("div", "st-nav-group");
    group.append(el("p", "st-nav-label", label));
    for (const p of items) {
      const b = el("button", "st-nav-item");
      b.type = "button";
      b.dataset.pane = p.id;
      if (p.id === state.pane) b.setAttribute("aria-current", "page");
      const text = el("span", "st-nav-text");
      text.append(el("b", "", p.label));
      const badge = p.badge?.(ctx);
      if (badge) {
        const s = el("small", `st-nav-badge is-${badge.tone}`);
        s.append(el("i", `dot ${badge.tone}`), badge.text);
        text.append(s);
      }
      b.append(icon(p.icon), text);
      b.addEventListener("click", () => ctx.go(p.id));
      group.append(b);
    }
    return group;
  });
  $("settings-nav").replaceChildren(...lists.filter(Boolean));
}

function render() {
  if (!isSettingsOpen()) return;
  const ctx = context();
  const panes = PANES.filter((p) => !p.visible || p.visible(ctx));
  if (!panes.some((p) => p.id === state.pane)) state.pane = panes[0].id;
  const pane = panes.find((p) => p.id === state.pane);
  renderNav(ctx, panes);
  $("settings-title").textContent = pane.label;
  $("settings-lead").textContent = pane.lead?.(ctx) ?? "";
  const tools = (pane.toolbar?.(ctx) ?? []).filter(Boolean);
  $("settings-tools").replaceChildren(...tools);
  $("settings-tools").hidden = !tools.length;
  const m = $("settings-message");
  m.hidden = !state.message;
  if (state.message) {
    m.className = `st-message is-${state.message.tone}`;
    m.textContent = state.message.text;
    m.setAttribute("role", state.message.tone === "bad" ? "alert" : "status");
  }
  const body = el("div", "st-pane");
  body.dataset.pane = pane.id;
  body.append(...pane.render(ctx).filter(Boolean));
  $("settings-body").replaceChildren(body);
}

/** 起動でそろえた後: その版で変わったことを右下に 1 度だけ出す（閉じたら窓に「見た」と伝える。設定の概要ではいつでも読める） */
export async function showNews() {
  const news = (await updateStatus().catch(() => null))?.news;
  if (!news?.notes) return;
  const head = $("news-head");
  head.replaceChildren(el("b", "", news.version), " にそろえました ", el("small", "", `（${news.from} から）`));
  noteList(news.notes, $("news-list"));
  $("news").hidden = false;
  $("news-close").onclick = async () => {
    $("news").hidden = true;
    await updateOp("seen", {}).catch(() => {});
  };
}

/**
 * 起動のとき（右下）: 置き場の入口から入れてショートカットを作ったなら、それを 1 度知らせる。
 * そうでなく、デスクトップにショートカットが無ければ、作るかを尋ねる（「作らない」は覚える。設定からはいつでも作れる）
 */
export async function offerShortcut() {
  const s = await shortcutStatus().catch(() => null);
  if (!s) return;
  const box = $("shortcut-offer");
  const text = $("shortcut-offer-text");
  const finish = () => { box.hidden = true; };
  if (s.made?.length) {
    text.textContent = `${s.made.join("と")}に、このアプリのショートカットを作りました。次からは、そこから開けます。`;
    $("shortcut-offer-make").hidden = true;
    $("shortcut-offer-no").textContent = "閉じる";
    $("shortcut-offer-no").title = "";
    $("shortcut-offer-no").onclick = async () => {
      finish();
      await seenShortcutNotice().catch(() => {});
    };
    box.hidden = false;
    return;
  }
  if (!s.offer) return;
  box.hidden = false;
  $("shortcut-offer-make").onclick = async () => {
    try {
      await createShortcut("desktop");
      text.textContent = "デスクトップにショートカットを作りました。";
      setTimeout(finish, 2500);
    } catch (error) {
      text.textContent = error.message;
    }
  };
  $("shortcut-offer-no").onclick = async () => {
    await declineShortcut().catch(() => {});
    finish();
  };
}

/** 開け閉め: 見出しバーの「設定」（押すたびに切り替え）・「戻る」・Esc（入力の欄の外で） */
export function initSettings() {
  $("show-settings").addEventListener("click", () => (isSettingsOpen() ? closeSettings() : openSettings()));
  $("settings-back").addEventListener("click", closeSettings);
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isSettingsOpen() || event.defaultPrevented || event.target.closest?.("input, textarea, select, dialog")) return;
    event.preventDefault();
    if (state.confirm || state.draft) context().set({ confirm: null, draft: null }); // 確かめ・書く途中なら、それをやめる
    else closeSettings();
  });
}
