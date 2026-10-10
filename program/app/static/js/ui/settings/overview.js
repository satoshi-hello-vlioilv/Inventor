// 設定の区分「概要」: この PC の版・あなたの役割・ショートカット・置き場を 1 枚ずつのカードで（押すとその区分へ）。
// その下に、この PC の版で変わったことと、アプリの場所

import { createShortcut } from "../../desktop.js";
import { ROLE_LABEL, ROLE_NOTE, block, button, el, noteList, pathText, row, status } from "./parts.js";

function card(ctx, { title, value, tone, note, pane, actions = [] }) {
  const c = el("article", "st-card");
  const head = el("header");
  head.append(el("span", "st-card-title", title));
  if (pane) head.append(button("詳しく", "st-link", () => ctx.go(pane)));
  c.append(head, el("b", "st-card-value", value), status(tone, note));
  if (actions.length) {
    const a = el("div", "st-card-acts");
    a.append(...actions);
    c.append(a);
  }
  return c;
}

export const overview = {
  id: "overview",
  group: "pc",
  label: "概要",
  icon: "M4 5h7v6H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 13h7v6H4z",
  lead: () => "この PC のアプリの状態と、次にすること",
  badge: (ctx) => {
    const u = ctx.update;
    if (!u || u.error) return null;
    return u.pending ? { tone: "warn", text: `${u.release.version} へそろえる前` } : { tone: "ok", text: u.local ?? "" };
  },
  render(ctx) {
    const u = ctx.update ?? {}, s = ctx.shortcut ?? {};
    const same = u.release && !u.pending;
    const missing = (s.places ?? []).filter((p) => p.state !== "ok");
    const cards = el("div", "st-cards");
    cards.append(
      card(ctx, {
        title: "この PC の版", value: u.local ?? "（分からない）", pane: "versions",
        tone: same || !u.release ? "ok" : "warn",
        note: !u.release ? "配る版はまだ決まっていません" : same ? "配っている版と同じ" : `配っている版は ${u.release.version}。次に開いたときにそろえます`,
      }),
      card(ctx, { title: "あなたの役割", value: ROLE_LABEL[u.role] ?? "（分からない）", tone: u.reachable ? "ok" : "idle", note: ROLE_NOTE[u.role] ?? "", pane: u.roles ? "roles" : null }),
      card(ctx, {
        title: "ショートカット", pane: "shortcut",
        value: !s.supported ? "Windows で作れます" : missing.length ? `${missing.map((p) => p.label).join("・")}に無い` : "デスクトップ・スタートメニュー",
        tone: !s.supported || !missing.length ? "ok" : "warn",
        note: !s.supported ? "" : missing.length ? "作ると、次から 1 回で開けます" : "どちらからでも開けます",
        actions: s.supported && missing.length
          ? [button("作る", "secondary", () => ctx.act(async () => { for (const p of missing) await createShortcut(p.place); }, `${missing.map((p) => p.label).join("・")}にショートカットを作りました`))]
          : [],
      }),
      card(ctx, { title: "置き場", value: u.reachable ? "届きます" : "届きません", tone: u.reachable ? "ok" : "warn", note: u.reachable ? "起動のときに配る版へそろえます" : (u.why ?? ""), pane: "share" }),
    );
    const notes = u.versions?.find((v) => v.version === u.local)?.notes ?? u.news?.notes;
    return [
      cards,
      notes ? block(`${u.local} で変わったこと`, null, noteList(notes)) : null,
      block("この PC のアプリ", "ショートカットはここの exe を指します。設定（保存先・置き場）は版をそろえても残ります",
        row("場所", [pathText(u.app ?? s.target ?? "")]), row("版", [el("span", "", u.local ?? "")])),
    ];
  },
};
