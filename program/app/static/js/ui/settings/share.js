// 設定の区分「置き場」: 版を置く共有のフォルダ（Box Drive）の場所・届くか・新しい PC の入口・置き場の形（最上位は exe と versions だけ）。
// 2.4.0 までの古い形（最上位の release.json など）が残っていれば、片付けるかを出す（管理できる人だけ）

import { updateOp } from "../../desktop.js";
import { block, button, el, pathText, row, status } from "./parts.js";

/** 置き場の形（木）。最上位は入口の exe と versions だけ */
function tree(u) {
  const lines = [
    ["Inventor3DTool.exe", "新しい PC の入口（配っている版の exe）"],
    ["versions\\", ""],
    ["  release.json", `配る版${u.release ? `（いまは ${u.release.version}）` : ""}`],
    ["  roles.json・policy.json", "役割・残す版の数"],
    ...(u.versions ?? []).slice(0, 3).map((v) => [`  ${v.version}\\`, `版の中身・目録・変わったこと${u.release?.version === v.version ? "（配っている）" : ""}`]),
    ...((u.versions ?? []).length > 3 ? [["  …", `ほか ${u.versions.length - 3} 版`]] : []),
  ];
  const pre = el("div", "st-tree");
  for (const [name, note] of lines) {
    const line = el("div");
    line.append(el("span", "mono", name), note ? el("span", "st-lead", note) : "");
    pre.append(line);
  }
  return pre;
}

export const share = {
  id: "share",
  group: "share",
  label: "置き場",
  icon: "M3.5 7.5v10.5a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5h-7l-2-2.5H5a1.5 1.5 0 0 0-1.5 1.5z",
  lead: () => "版を置く共有のフォルダ。全ての PC が、起動のときにここの配っている版へそろえます",
  badge: (ctx) => {
    const u = ctx.update;
    if (!u || u.error) return null;
    if (!u.reachable) return { tone: "warn", text: "届かない" };
    return u.legacy?.length ? { tone: "warn", text: "古い形が残っている" } : { tone: "ok", text: "届きます" };
  },
  render(ctx) {
    const u = ctx.update;
    if (!u || u.error) return [el("p", "st-lead", u?.error ?? "読み込んでいます…")];
    const canEdit = u.canManage || !u.reachable; // 届かないときは誰でも直せる（届かない置き場からは役割も読めない）
    const reach = status(u.reachable ? "ok" : "warn", u.reachable ? "届きます" : (u.why ?? "届きません"));
    const out = [];
    if (ctx.confirm?.op === "dir") {
      const input = Object.assign(el("input", "st-input"), { value: u.dirSource === "settings" ? u.dir : "", placeholder: u.defaultDir });
      input.setAttribute("aria-label", "置き場の場所");
      out.push(block("場所", "空にすると既定の場所に戻ります", row("場所", [input],
        button("保存", "primary", () => ctx.act(() => updateOp("settings", { dir: input.value.trim() }), "置き場を変えました")),
        button("やめる", "quiet", () => ctx.set({ confirm: null })))));
    } else {
      out.push(block("場所", u.dirSource === "default" ? "既定の場所" : "この PC で決めた場所",
        row("場所", [pathText(u.dir), reach], ...(canEdit ? [button("変える…", "quiet", () => ctx.set({ confirm: { op: "dir" } }))] : []))));
    }
    if (u.entry) {
      const copy = button("場所をコピー", "quiet", async () => {
        await navigator.clipboard?.writeText(u.entry.path).catch(() => {});
        ctx.set({ message: { tone: "ok", text: "新しい PC で開く exe の場所をコピーしました" } });
      });
      out.push(block("新しい PC へ", "この exe を開くと、この PC にアプリを写し、デスクトップとスタートメニューにショートカットを作って開きます",
        row("入口", [u.entry.exists ? pathText(u.entry.path) : el("span", "st-lead", "まだ版を配っていません")], ...(u.entry.exists ? [copy] : []))));
    }
    if (u.reachable) out.push(block("置き場の形", "最上位は入口の exe と versions フォルダだけ。管理のファイルと版は versions の中", tree(u)));
    if (u.legacy?.length) {
      const note = el("p", "st-lead", `最上位に古い形（2.4.0 まで）の ${u.legacy.join("・")} が残っています。2.4.0 までの PC はこれを読んでそろえるので、`
        + "全ての PC が 2.5.0 以上になってから片付けてください（それまでは、ここで配った版を最上位にも書きます）。");
      out.push(block("古い形の片付け", null, note,
        u.canManage ? button("versions の中へ片付ける", "secondary", () => ctx.act(() => updateOp("tidy", {}), (a) => `${(a.tidied ?? []).join("・") || "なし"} を片付けました`)) : null));
    }
    return out;
  },
};
