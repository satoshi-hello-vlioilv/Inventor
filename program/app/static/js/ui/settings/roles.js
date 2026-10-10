// 設定の区分「役割」: 版を管理できる人（開発者・メンテナンス者。Windows のユーザー名）。変えられるのは開発者だけ。
// 置き場にまだ役割が無ければ、最初の 1 人が自分を開発者にできる。開発者と、役割が未設定のときだけ出す

import { updateOp } from "../../desktop.js";
import { block, button, el, row } from "./parts.js";

const chips = (names) => {
  const box = el("span", "chips");
  box.append(...(names.length ? names.map((n) => el("span", "chip", n)) : [el("span", "st-lead", "（いません）")]));
  return box;
};

export const roles = {
  id: "roles",
  group: "share",
  label: "役割",
  icon: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5",
  visible: (ctx) => Boolean(ctx.update?.roles),
  lead: () => "版を置く・配る・消すことができる人（Windows のユーザー名）",
  badge: (ctx) => (ctx.update?.role === "unset" ? { tone: "warn", text: "まだ決まっていない" } : { tone: "ok", text: `開発者 ${ctx.update.roles.developers.length}・メンテナンス者 ${ctx.update.roles.maintainers.length}` }),
  render(ctx) {
    const u = ctx.update, r = u.roles;
    if (u.role === "unset") {
      return [block("開発者", "この置き場は、まだ役割が決まっていません",
        row("開発者", [el("span", "st-lead", `最初の 1 人として、自分（${u.user}）を開発者にできます`)],
          button("自分を開発者にする", "primary", () => ctx.act(() => updateOp("roles", { developers: [u.user], maintainers: [] }), "あなたを開発者にしました"))))];
    }
    if (ctx.confirm?.op === "roles") {
      const dev = Object.assign(el("input", "st-input"), { value: r.developers.join(", ") });
      const maint = Object.assign(el("input", "st-input"), { value: r.maintainers.join(", ") });
      dev.setAttribute("aria-label", "開発者");
      maint.setAttribute("aria-label", "メンテナンス者");
      const list = (input) => input.value.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean);
      return [block("役割を変える", "Windows のユーザー名を「,」で区切って書きます。開発者は 1 人以上",
        row("開発者", [dev]), row("メンテナンス者", [maint]),
        row("", [], button("保存", "primary", () => ctx.act(() => updateOp("roles", { developers: list(dev), maintainers: list(maint) }), "役割を変えました")),
          button("やめる", "quiet", () => ctx.set({ confirm: null }))))];
    }
    return [block("いまの役割", "開発者だけが変えられます",
      row("開発者", [chips(r.developers)], el("span", "st-lead", "版の管理と役割の変更")),
      row("メンテナンス者", [chips(r.maintainers)], el("span", "st-lead", "版の管理")),
      row("", [], button("変える…", "secondary", () => ctx.set({ confirm: { op: "roles" } }))))];
  },
};
