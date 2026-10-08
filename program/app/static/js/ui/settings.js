// 設定（右の引き出し）: ショートカット・版の管理（docs/desktop.md §8・docs/ui.md §12）。
//   上から: 要点の 1 行（この PC の版・あなたの役割。案 G）→ ショートカット → 版（開発者・メンテナンス者だけ操作できる）→ 置き場 → 役割（開発者だけ）
//   引き出しは <dialog>（開くと後ろを触れない・Esc で閉じる。サンプルの窓と同じ）
// 窓（desktop/src/shortcut.rs・update.rs）が状態を答え、操作のたびに役割を確かめる。画面は答えを描くだけ（ここでは守らない）。
// 消す・配るなど取り返しにくい操作は、その行の中で確かめてから行う（別の窓を重ねない）。

import { createShortcut, declineShortcut, pickZip, shortcutStatus, updateOp, updateProgress, updateStatus } from "../desktop.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
const button = (label, kind, onClick, title) => {
  const b = el("button", `${kind} st-btn`, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
};
const dot = (tone) => el("i", `dot ${tone}`);
const ROLE_LABEL = { developer: "開発者", maintainer: "メンテナンス者", user: "一般の利用者", unset: "役割が未設定", unknown: "役割が不明（置き場に届かない）" };
const STATE = { ok: ["ok", "あります"], missing: ["warn", "ありません"], other: ["warn", "別の場所の exe を指しています（作り直すと直ります）"] };
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const who = (by) => String(by ?? "").split("@")[0];

let state = { update: null, shortcut: null, confirm: null, message: null, publishing: null, draft: null };

/** 引き出しを開く（開くたびに窓へ問い合わせ直す: ほかの PC が版を置いた・配った後でも、いまの状態を出す） */
export async function openSettings() {
  const dialog = $("settings");
  if (!dialog.open) dialog.showModal();
  await refresh();
}

export function closeSettings() {
  const dialog = $("settings");
  if (dialog.open) dialog.close();
}

async function refresh() {
  const [update, shortcut] = await Promise.all([updateStatus().catch((e) => ({ error: e.message })), shortcutStatus().catch((e) => ({ error: e.message }))]);
  state = { ...state, update, shortcut };
  render();
}

/** 操作して、答えを知らせに出し、状態を読み直す */
async function act(run, done) {
  state = { ...state, confirm: null, message: { tone: "run", text: "しています…" } };
  render();
  try {
    const answer = await run();
    state.message = { tone: "ok", text: typeof done === "function" ? done(answer) : done };
  } catch (error) {
    state.message = { tone: "bad", text: error.message };
  }
  await refresh();
}

function section(title, note, ...children) {
  const s = el("section", "st-section");
  const h = el("h3", "", title);
  if (note) h.append(el("small", "", note));
  s.append(h, ...children);
  return s;
}

function row(name, value, ...actions) {
  const r = el("div", "st-row");
  const v = el("span", "st-val");
  v.append(...(Array.isArray(value) ? value : [value]));
  r.append(el("span", "st-name", name), v, ...actions);
  return r;
}

/** 要点の 1 行: この PC の版が配っている版と同じか・あなたの役割（開いてすぐ読める所に） */
function renderStrip(u) {
  if (!u || u.error) return null;
  const strip = el("p", "st-strip");
  const version = el("span");
  const same = u.release && !u.pending;
  version.append(dot(same || !u.release ? "ok" : "warn"), "この PC は ", el("b", "", u.local ?? "（版が分からない）"),
    !u.release ? "" : same ? "（配っている版と同じ）" : `（配っている版は ${u.release.version}。次に開いたときにそろえます）`);
  const role = el("span");
  role.append("あなたは ", el("b", "", ROLE_LABEL[u.role] ?? u.role), u.user ? `（${u.user}）` : "");
  strip.append(version, role);
  return strip;
}

/** この PC の版で変わったこと（要点の 1 行の下に畳んで。そろえた後の知らせを閉じた後でも読める） */
function renderNews(u) {
  const notes = u?.versions?.find((v) => v.version === u.local)?.notes ?? u?.news?.notes;
  if (!notes) return null;
  const box = el("details", "st-news");
  box.append(el("summary", "", `${u.local} で変わったこと`), noteList(notes));
  return box;
}

function renderShortcut(s) {
  if (!s || s.error) return section("ショートカット", null, el("p", "st-lead", s?.error ?? "読み込んでいます…"));
  if (!s.supported) return section("ショートカット", null, el("p", "st-lead", "ショートカットは Windows で作れます"));
  const rows = s.places.map((p) => {
    const [tone, text] = STATE[p.state] ?? STATE.missing;
    const action = p.state === "ok"
      ? button("作り直す", "quiet", () => act(() => createShortcut(p.place), `${p.label}のショートカットを作り直しました`), p.path)
      : button("作る", "secondary", () => act(() => createShortcut(p.place), `${p.label}にショートカットを作りました`), p.path);
    return row(p.label, [dot(tone), text], action);
  });
  return section("ショートカット", `この PC のアプリ（${s.target}）を開きます`, ...rows);
}

function versionCells(v, u) {
  const tags = [];
  if (u.release?.version === v.version) tags.push(el("span", "tag now", "配っている"));
  else if (u.release?.previous === v.version) tags.push(el("span", "tag", "前に配った"));
  if (u.local === v.version) tags.push(el("span", "tag", "この PC"));
  const name = el("td");
  name.append(el(u.release?.version === v.version ? "b" : "span", "", v.version), ...tags);
  // 変わったことの 1 行目（全文は重ねると出る）。管理できる人は、その横から書く・直す（操作の列は狭いので増やさない）
  const notes = el("div", "st-notes");
  if (v.notes) notes.append(Object.assign(el("span", "", v.notes.split("\n")[0]), { title: v.notes }));
  if (u.canManage && state.confirm?.op !== "notes") {
    const edit = button(v.notes ? "直す" : "変わったことを書く", "st-link", () => { state.confirm = { op: "notes", version: v.version }; render(); },
      "この版で変わったことを書く（そろえた PC に 1 度見せます）");
    notes.append(edit);
  }
  if (notes.childNodes.length) name.append(notes);
  const cells = [name, el("td", "num", when(v.placedAt)), el("td", "", who(v.placedBy)), el("td", "mono", v.source ?? ""), el("td", "num", mb(v.bytes ?? 0))];
  const actions = el("td", "act");
  const isRelease = u.release?.version === v.version;
  const confirming = state.confirm?.version === v.version ? state.confirm.op : null;
  if (u.canManage && !isRelease) {
    if (confirming === "delete") {
      actions.append(el("span", "st-ask", "消しますか？"),
        button("消す", "danger", () => act(() => updateOp("delete", { version: v.version }), `版 ${v.version} を消しました`)),
        button("やめる", "quiet", () => { state.confirm = null; render(); }));
    } else if (confirming === "release") {
      actions.append(el("span", "st-ask", `全ての PC が次の起動で ${v.version} にそろいます`),
        button("配る", "primary", () => act(() => updateOp("release", { version: v.version }), (a) => [`版 ${v.version} を配りました`, ...(a.notes ?? [])].join(" "))),
        button("やめる", "quiet", () => { state.confirm = null; render(); }));
    } else if (confirming !== "notes") {
      actions.append(button("この版を配る", "secondary", () => { state.confirm = { op: "release", version: v.version }; render(); }),
        button("消す", "quiet", () => { state.confirm = { op: "delete", version: v.version }; render(); }));
    }
  }
  const tr = el("tr", isRelease ? "is-now" : "");
  tr.title = `置いた人: ${who(v.placedBy) || "?"}　元の ZIP: ${v.source ?? "?"}`; // 引き出しの幅では、この 2 列を隠す（app.css）
  tr.append(...cells, actions);
  if (confirming !== "notes") return [tr];
  // 変わったことを書く行（その版の下に開く）
  const form = notesForm(v.notes ?? "", "保存", (notes) => act(() => updateOp("notes", { version: v.version, notes }), `版 ${v.version} の変わったことを${notes ? "書きました" : "消しました"}`));
  const cell = Object.assign(el("td"), { colSpan: 6 });
  cell.append(form);
  const edit = el("tr", "st-edit");
  edit.append(cell);
  return [tr, edit];
}

/** 変わったことを書く欄（版を置く前・置いた後で同じ形）。書いた文は、そろえた PC に 1 度だけ見せる */
function notesForm(value, label, onSave) {
  const form = el("div", "st-form");
  const area = Object.assign(el("textarea", "st-input st-area"), { value, maxLength: 2000, placeholder: "例: SXF の図面を開けるようにしました／設定の画面に版の説明を足しました" });
  area.setAttribute("aria-label", "変わったこと");
  const row = el("div", "st-bar");
  row.append(el("span", "st-lead", "そろえた PC に、次に開いたとき 1 度だけ見せます（空でもかまいません）"),
    button(label, "primary", () => onSave(area.value.trim())), button("やめる", "quiet", () => { state.confirm = null; state.draft = null; render(); }));
  form.append(area, row);
  queueMicrotask(() => area.focus());
  return form;
}

function renderVersions(u) {
  if (!u || u.error) return section("版", null, el("p", "st-lead", u?.error ?? "読み込んでいます…"));
  if (!u.reachable) return section("版", null, el("p", "st-lead", u.why ?? "置き場に届きません"));
  const children = [];
  if (u.canManage) {
    const bar = el("div", "st-bar");
    const keep = el("label", "st-keep", "残す版の数 ");
    const input = Object.assign(el("input"), { type: "number", min: "0", value: String(u.policy?.keep ?? 0), title: "版を置いたとき、新しい順にこの数だけ残す（配っている版と前に配った版は残す）" });
    input.addEventListener("change", () => act(() => updateOp("policy", { keep: Math.max(0, Number(input.value) || 0) }), "残す版の数を変えました"));
    keep.append(input, "（0 = 全て）");
    bar.append(button("ZIP から版を置く…", "primary", pick, "GitHub の Code → Download ZIP で落とした ZIP を選ぶ"), keep);
    children.push(bar);
    if (state.draft) {
      // ZIP を選んだ後: 変わったことを書いてから置く（置く物の名前もここで確かめる）
      const box = el("div", "st-form");
      box.append(el("span", "", `置く ZIP: ${state.draft.path.split(/[\\/]/).pop()}`),
        notesForm("", "この ZIP を置く", (notes) => publish(state.draft.path, notes)));
      children.push(box);
    }
    if (state.publishing) children.push(renderPublishing(state.publishing));
  } else {
    children.push(el("p", "st-lead", "版を置く・配る・消すのは、開発者とメンテナンス者だけができます。"));
  }
  const table = el("table");
  const head = el("tr");
  for (const h of ["版", "置いた日時", "置いた人", "元の ZIP", "大きさ", ""]) head.append(el("th", "", h));
  const body = el("tbody");
  body.append(...(u.versions ?? []).flatMap((v) => versionCells(v, u)));
  const thead = el("thead");
  thead.append(head);
  table.append(thead, body);
  children.push((u.versions ?? []).length ? table : el("p", "st-lead", "置き場に版がまだありません。"));
  return section("版", u.canManage ? "取り返しにくい操作は、行の中で確かめてから行います" : null, ...children);
}

function renderPublishing(p) {
  const box = el("div", "st-progress");
  const pct = p.total ? Math.round((100 * (p.done ?? 0)) / p.total) : 0;
  const bar = el("div", "bar");
  bar.append(Object.assign(el("i"), { style: `width: ${pct}%` }));
  const stage = { check: "ZIP の中身を確かめています", copy: `置き場へ写しています ${p.done ?? 0} / ${p.total ?? "?"} ファイル`, finish: "目録を書いて仕上げています" }[p.stage] ?? "準備しています";
  box.append(el("span", "", `${p.source ?? ""}: ${stage}`), bar);
  return box;
}

/** ZIP を選ぶ（置くのは、変わったことを書いて「この ZIP を置く」を押してから） */
async function pick() {
  const path = await pickZip().catch(() => null);
  if (!path) return;
  state = { ...state, draft: { path }, confirm: null };
  render();
}

async function publish(path, notes) {
  state.draft = null;
  state.publishing = { stage: "check", source: path.split(/[\\/]/).pop() };
  render();
  const timer = setInterval(async () => {
    const p = await updateProgress().catch(() => null);
    if (p?.state === "running") {
      state.publishing = p;
      render();
    }
  }, 400);
  await act(() => updateOp("publish", { path, notes }), (a) => `版 ${a.version} を置きました（${a.files} ファイル・${mb(a.bytes)}）${a.pruned?.length ? `。残す数を超えた ${a.pruned.join("・")} を消しました` : ""}。配るときは、その行の「この版を配る」を押します`);
  clearInterval(timer);
  state.publishing = null;
  render();
}

function renderShare(u) {
  if (!u || u.error) return section("置き場", null);
  const place = el("span", "mono", u.dir);
  const reach = el("span", "", u.reachable ? " 届きます" : ` ${u.why ?? "届きません"}`);
  reach.prepend(dot(u.reachable ? "ok" : "warn"));
  const children = [];
  const canEdit = u.canManage || !u.reachable;
  if (state.confirm?.op === "dir") {
    const input = Object.assign(el("input", "st-input"), { value: u.dirSource === "settings" ? u.dir : "", placeholder: u.defaultDir });
    children.push(row("場所", [input], button("保存", "primary", () => act(() => updateOp("settings", { dir: input.value.trim() }), "置き場を変えました")),
      button("やめる", "quiet", () => { state.confirm = null; render(); })));
  } else {
    children.push(row("場所", [place, reach], ...(canEdit ? [button("変える…", "quiet", () => { state.confirm = { op: "dir" }; render(); })] : [])));
  }
  if (u.entry) {
    const copy = button("場所をコピー", "quiet", async () => {
      await navigator.clipboard?.writeText(u.entry.path).catch(() => {});
      state.message = { tone: "ok", text: "新しい PC で開く exe の場所をコピーしました" };
      render();
    });
    children.push(row("新しい PC へ", [el("span", "mono", u.entry.exists ? `${u.entry.path} を開く` : "まだ版を配っていません")], ...(u.entry.exists ? [copy] : [])));
  }
  return section("置き場", "全ての PC が、起動のときにここの配っている版へそろえます", ...children);
}

function renderRoles(u) {
  if (!u?.roles) return null;
  const chips = (names) => {
    const box = el("span", "chips");
    box.append(...(names.length ? names.map((n) => el("span", "chip", n)) : [el("span", "st-lead", "（いません）")]));
    return box;
  };
  const r = u.roles;
  const edit = state.confirm?.op === "roles";
  if (u.role === "unset") {
    return section("役割", "この置き場は、まだ役割が決まっていません",
      row("開発者", [el("span", "st-lead", `最初の 1 人として、自分（${u.user}）を開発者にできます`)],
        button("自分を開発者にする", "primary", () => act(() => updateOp("roles", { developers: [u.user], maintainers: [] }), "あなたを開発者にしました"))));
  }
  if (edit) {
    const dev = Object.assign(el("input", "st-input"), { value: r.developers.join(", ") });
    const maint = Object.assign(el("input", "st-input"), { value: r.maintainers.join(", ") });
    const list = (input) => input.value.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean);
    return section("役割", "Windows のユーザー名を「,」で区切って書きます",
      row("開発者", [dev]), row("メンテナンス者", [maint]),
      row("", [], button("保存", "primary", () => act(() => updateOp("roles", { developers: list(dev), maintainers: list(maint) }), "役割を変えました")),
        button("やめる", "quiet", () => { state.confirm = null; render(); })));
  }
  return section("役割", "開発者だけが変えられます", row("開発者", [chips(r.developers)]),
    row("メンテナンス者", [chips(r.maintainers)], button("変える…", "quiet", () => { state.confirm = { op: "roles" }; render(); })));
}

function render() {
  const { update: u, shortcut: s, message } = state;
  const body = $("settings-body");
  const parts = [renderStrip(u), renderNews(u)].filter(Boolean);
  if (message) {
    const m = el("p", `st-message is-${message.tone}`, message.text);
    m.setAttribute("role", message.tone === "bad" ? "alert" : "status");
    parts.push(m);
  }
  parts.push(renderShortcut(s), renderVersions(u), renderShare(u));
  const roles = renderRoles(u);
  if (roles) parts.push(roles);
  body.replaceChildren(...parts);
}

/** 変わったことの文（1 行に 1 つ。頭の「・」「-」は外す） */
const noteLines = (text) => String(text ?? "").split("\n").map((l) => l.replace(/^\s*[・\-*]\s*/, "").trim()).filter(Boolean);
const noteList = (text, list = el("ul")) => {
  list.replaceChildren(...noteLines(text).map((l) => el("li", "", l)));
  return list;
};

/** 起動でそろえた後: その版で変わったことを右下に 1 度だけ出す（閉じたら窓に「見た」と伝える。設定ではいつでも読める） */
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

/** 起動のとき: デスクトップにショートカットが無ければ、作るかを尋ねる（「作らない」は覚える。設定からはいつでも作れる） */
export async function offerShortcut() {
  const s = await shortcutStatus().catch(() => null);
  if (!s?.offer) return;
  const box = $("shortcut-offer");
  box.hidden = false;
  const finish = () => { box.hidden = true; };
  $("shortcut-offer-make").onclick = async () => {
    try {
      await createShortcut("desktop");
      $("shortcut-offer-text").textContent = "デスクトップにショートカットを作りました。";
      setTimeout(finish, 2500);
    } catch (error) {
      $("shortcut-offer-text").textContent = error.message;
    }
  };
  $("shortcut-offer-no").onclick = async () => {
    await declineShortcut().catch(() => {});
    finish();
  };
}

/** 引き出しの開け閉め（見出しバーの「設定」・✕・背景のクリック。Esc は <dialog> が閉じる） */
export function initSettings() {
  const dialog = $("settings");
  $("show-settings").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  dialog.addEventListener("click", (event) => event.target === dialog && closeSettings());
  // 閉じたら、確かめの途中・知らせを捨てる（次に開いたときは今の状態から）
  dialog.addEventListener("close", () => { state = { ...state, confirm: null, message: null, draft: null }; });
}
