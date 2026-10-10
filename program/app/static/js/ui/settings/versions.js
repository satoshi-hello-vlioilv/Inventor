// 設定の区分「版」: 置き場の版の一覧（配っている版・前に配った版・この PC の版）と、版を置く・配る・消す・変わったことを書く。
// 置く・配る・消すは開発者とメンテナンス者だけ（窓が操作のたびに役割を確かめる。画面は答えを描くだけ）。
// 消す・配るなど取り返しにくい操作は、その行の中で確かめてから行う（別の窓を重ねない）

import { pickZip, updateOp, updateProgress } from "../../desktop.js";
import { block, button, el, mb, noteLines, when, who } from "./parts.js";

const ZIP_HINT = "GitHub の Releases の配る ZIP（Inventor3DTool-版.zip。軽い）か、Code → Download ZIP の ZIP";

function tags(v, u) {
  const out = [];
  if (u.release?.version === v.version) out.push(el("span", "tag now", "配っている"));
  else if (u.release?.previous === v.version) out.push(el("span", "tag", "前に配った"));
  if (u.local === v.version) out.push(el("span", "tag", "この PC"));
  return out;
}

/** 変わったことを書く欄（版を置く前・置いた後で同じ形）。書いた文は、そろえた PC に 1 度だけ見せる */
function notesForm(ctx, value, label, onSave) {
  const form = el("div", "st-form");
  const area = Object.assign(el("textarea", "st-input st-area"), { value, maxLength: 2000, placeholder: "例: SXF の図面を開けるようにしました／設定の画面を大きくしました" });
  area.setAttribute("aria-label", "変わったこと");
  const bar = el("div", "st-bar");
  bar.append(el("span", "st-lead", "そろえた PC に、次に開いたとき 1 度だけ見せます（1 行に 1 つ。空でもかまいません）"),
    button(label, "primary", () => onSave(area.value.trim())), button("やめる", "quiet", () => ctx.set({ confirm: null, draft: null })));
  form.append(area, bar);
  queueMicrotask(() => area.focus());
  return form;
}

function versionRows(ctx, v) {
  const u = ctx.update;
  const isRelease = u.release?.version === v.version;
  const confirming = ctx.confirm?.version === v.version ? ctx.confirm.op : null;
  const name = el("td", "st-ver");
  name.append(el(isRelease ? "b" : "span", "", v.version), ...tags(v, u));
  const lines = noteLines(v.notes);
  const notes = el("td", "st-vnotes");
  if (lines.length) {
    const list = el("ul");
    list.append(...lines.slice(0, 3).map((l) => el("li", "", l)));
    if (lines.length > 3) list.append(el("li", "st-more", `ほか ${lines.length - 3} 件`));
    list.title = v.notes;
    notes.append(list);
  }
  if (u.canManage && confirming !== "notes") {
    notes.append(button(v.notes ? "直す" : "変わったことを書く", "st-link", () => ctx.set({ confirm: { op: "notes", version: v.version } }),
      "この版で変わったことを書く（そろえた PC に 1 度見せます）"));
  }
  const actions = el("td", "act");
  if (u.canManage && !isRelease) {
    const cancel = button("やめる", "quiet", () => ctx.set({ confirm: null }));
    if (confirming === "delete") {
      actions.append(el("span", "st-ask", "消しますか？"), button("消す", "danger", () => ctx.act(() => updateOp("delete", { version: v.version }), `版 ${v.version} を消しました`)), cancel);
    } else if (confirming === "release") {
      actions.append(el("span", "st-ask", `全ての PC が次の起動で ${v.version} にそろいます`),
        button("配る", "primary", () => ctx.act(() => updateOp("release", { version: v.version }), (a) => [`版 ${v.version} を配りました`, ...(a.notes ?? [])].join(" "))), cancel);
    } else if (confirming !== "notes") {
      actions.append(button("この版を配る", "secondary", () => ctx.set({ confirm: { op: "release", version: v.version } })),
        button("消す", "quiet", () => ctx.set({ confirm: { op: "delete", version: v.version } })));
    }
  }
  const tr = el("tr", isRelease ? "is-now" : "");
  tr.append(name, notes, el("td", "num", when(v.placedAt)), el("td", "", who(v.placedBy)), el("td", "mono", v.source ?? ""), el("td", "num", mb(v.bytes ?? 0)), actions);
  if (confirming !== "notes") return [tr];
  const cell = Object.assign(el("td"), { colSpan: 7 });
  cell.append(notesForm(ctx, v.notes ?? "", "保存", (text) => ctx.act(() => updateOp("notes", { version: v.version, notes: text }), `版 ${v.version} の変わったことを${text ? "書きました" : "消しました"}`)));
  const edit = el("tr", "st-edit");
  edit.append(cell);
  return [tr, edit];
}

function progress(p) {
  const box = el("div", "st-progress");
  const pct = p.total ? Math.round((100 * (p.done ?? 0)) / p.total) : 0;
  const bar = el("div", "bar");
  bar.append(Object.assign(el("i"), { style: `width: ${pct}%` }));
  const stage = { check: "ZIP の中身を確かめています", copy: `置き場へ写しています ${p.done ?? 0} / ${p.total ?? "?"} ファイル`, finish: "目録を書いて仕上げています" }[p.stage] ?? "準備しています";
  box.append(el("span", "", `${p.source ?? ""}: ${stage}`), bar);
  return box;
}

/** ZIP を選ぶ（置くのは、変わったことを書いて「この ZIP を置く」を押してから） */
async function pick(ctx) {
  const path = await pickZip().catch(() => null);
  if (path) ctx.set({ draft: { path }, confirm: null });
}

async function publish(ctx, path, notes) {
  ctx.set({ draft: null, publishing: { stage: "check", source: path.split(/[\\/]/).pop() } });
  const timer = setInterval(async () => {
    const p = await updateProgress().catch(() => null);
    if (p?.state === "running") ctx.set({ publishing: p });
  }, 400);
  await ctx.act(() => updateOp("publish", { path, notes }), (a) => `版 ${a.version} を置きました（${a.files} ファイル・${mb(a.bytes)}）${a.pruned?.length ? `。残す数を超えた ${a.pruned.join("・")} を消しました` : ""}。配るときは、その行の「この版を配る」を押します`);
  clearInterval(timer);
  ctx.set({ publishing: null });
}

export const versions = {
  id: "versions",
  group: "share",
  label: "版",
  icon: "M5 4.5h14v4H5zM5 10.5h14v4H5zM5 16.5h14v3H5z",
  lead: (ctx) => (ctx.update?.canManage
    ? "置き場に置いた版と、配っている版。全ての PC が、起動のときに配っている版へそろえます"
    : "置き場に置いた版と、配っている版（置く・配る・消すのは、開発者とメンテナンス者だけができます）"),
  badge: (ctx) => {
    const u = ctx.update;
    if (!u?.reachable) return u && !u.error ? { tone: "warn", text: "置き場に届かない" } : null;
    return u.release ? { tone: "ok", text: `${u.release.version} を配っている` } : { tone: "warn", text: "まだ配っていない" };
  },
  render(ctx) {
    const u = ctx.update;
    if (!u || u.error) return [el("p", "st-lead", u?.error ?? "読み込んでいます…")];
    if (!u.reachable) return [el("p", "st-lead", u.why ?? "置き場に届きません")];
    const out = [];
    if (u.canManage) {
      const bar = el("div", "st-bar");
      const keep = el("label", "st-keep", "残す版の数 ");
      const input = Object.assign(el("input"), { type: "number", min: "0", value: String(u.policy?.keep ?? 0), title: "版を置いたとき、新しい順にこの数だけ残す（配っている版と前に配った版は残す）" });
      input.addEventListener("change", () => ctx.act(() => updateOp("policy", { keep: Math.max(0, Number(input.value) || 0) }), "残す版の数を変えました"));
      keep.append(input, "（0 = 全て）");
      bar.append(button("ZIP から版を置く…", "primary", () => pick(ctx), ZIP_HINT), el("span", "st-lead", ZIP_HINT), keep);
      out.push(bar);
      if (ctx.draft) {
        const box = el("div", "st-form");
        box.append(el("span", "", `置く ZIP: ${ctx.draft.path.split(/[\\/]/).pop()}`),
          notesForm(ctx, "", "この ZIP を置く", (notes) => publish(ctx, ctx.draft.path, notes)));
        out.push(box);
      }
      if (ctx.publishing) out.push(progress(ctx.publishing));
    }
    const list = u.versions ?? [];
    if (!list.length) return [...out, el("p", "st-lead", "置き場に版がまだありません。")];
    const table = el("table", "st-table");
    const head = el("tr");
    for (const h of ["版", "変わったこと", "置いた日時", "置いた人", "元の ZIP", "大きさ", ""]) head.append(el("th", "", h));
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    body.append(...list.flatMap((v) => versionRows(ctx, v)));
    table.append(thead, body);
    const wrap = el("div", "st-table-wrap");
    wrap.append(table);
    return [...out, block(null, null, wrap)];
  },
};
