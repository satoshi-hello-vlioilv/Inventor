// 設定の区分「ショートカット」: デスクトップ・スタートメニューのショートカットが、この PC のアプリを指しているか。作る・作り直す

import { createShortcut } from "../../desktop.js";
import { block, button, el, pathText, row, status } from "./parts.js";

const STATE = { ok: ["ok", "あります（この PC のアプリを開きます）"], missing: ["warn", "ありません"], other: ["warn", "別の場所の exe を指しています（作り直すと直ります）"] };

export const shortcut = {
  id: "shortcut",
  group: "pc",
  label: "ショートカット",
  icon: "M6 3.5h8l4 4v13H6zM10 15.5l4.5-4.5M11 11h3.5v3.5",
  lead: () => "デスクトップとスタートメニューから、この PC のアプリを開けるようにします",
  badge: (ctx) => {
    const s = ctx.shortcut;
    if (!s?.supported) return null;
    const missing = s.places.filter((p) => p.state !== "ok");
    return missing.length ? { tone: "warn", text: `${missing.map((p) => p.label).join("・")}に無い` } : { tone: "ok", text: "あります" };
  },
  render(ctx) {
    const s = ctx.shortcut;
    if (!s || s.error) return [el("p", "st-lead", s?.error ?? "読み込んでいます…")];
    if (!s.supported) return [el("p", "st-lead", "ショートカットは Windows で作れます")];
    const rows = s.places.map((p) => {
      const [tone, text] = STATE[p.state] ?? STATE.missing;
      const make = () => ctx.act(() => createShortcut(p.place), `${p.label}にショートカットを${p.state === "ok" ? "作り直しました" : "作りました"}`);
      return row(p.label, [status(tone, text), pathText(p.path)],
        p.state === "ok" ? button("作り直す", "quiet", make, p.path) : button("作る", "secondary", make, p.path));
    });
    return [
      block("置き場所", null, ...rows),
      block("開くアプリ", "置き場の入口（Inventor3DTool.exe）から入れたときは、両方に自動で作ります", row("exe", [pathText(s.target)])),
    ];
  },
};
