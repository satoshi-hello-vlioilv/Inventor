// 変換データの部品の寸法を直す欄（利用者が選んだ案 H: 小さな断面図に札。docs/ui.md §17）。
//   寸法の名前の横に、Inventor で作った部品の中での呼び名の札（名前つきの値 D0_0・参照寸法「参照」・対応なし「—」。案 I: docs/ui.md §21）
//   部品の行を押すと、部品の一覧がこの欄に切り替わる（← で戻る。3D は見えたまま）。
//   寸法は置き場所（全体・外周・穴 n・断面）の見出しで分け、直せる寸法だけを並べる。直せない寸法は理由とともに畳む。
//   行にカーソルを合わせる（欄に入る）と、断面図でその辺が光り、札（「直径 250」）が付く。
//   数を入れて Enter（か欄を離れる）で直す。直せない値は理由をその行の下に出す。取り消し・やり直しは edit/history.js。
//
//   new DimensionEditor({ history, getSpec, commit, onOpen, onClose })
//     getSpec() → いまの変換データ、commit(次の変換データ, 直した部品の番号) … 呼ぶ側が 3D・一覧・作る仕事へ反映する
//   open(部品の番号, 元の変換データ) / close() / refresh()（取り消し・やり直しの後）/ isOpen

import { applyDimension, dimensionsOf, placeOf } from "../convert/dimensions.js";
import { inventorNames } from "../convert/parametric.js";
import { describeSpec } from "../convert/preview.js";
import { sketchMarkup } from "./sketch.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
const fmt = (v) => String(Math.round(v * 1000) / 1000);
const SCALE_NOTE = "（形を保って拡大・縮小）";

/** 見出し（置き場所）と重なる言葉を省いた名前と、添える説明 */
function names(dim, place) {
  if (dim.label.endsWith(SCALE_NOTE)) return { name: dim.label.slice(0, -SCALE_NOTE.length), note: SCALE_NOTE.slice(1, -1) };
  return { name: dim.label.replace(`${place}の縁・`, ""), note: "" };
}

/** 断面図で光らせる所（寸法の at。面取りはループ全体、外形の幅は外周） */
const focusOf = (dim) => (dim.kind === "scale" ? { loop: 0 } : dim.at ? { loop: dim.at.loop, ...(dim.at.seg !== undefined && { seg: dim.at.seg }) } : null);

export class DimensionEditor {
  #index = -1;
  #original = null; // 開いたときの部品（元から変わった寸法の印「← 240」）
  #focus = null; // 光らせる寸法の id
  #error = null; // { id, message, text }（直せなかった値と理由）
  #linked = null; // 直前の直しで一緒に変わった寸法
  #inventor = new Map(); // 寸法の id → Inventor での呼び名（convert/parametric.js の inventorNames）

  constructor({ history, getSpec, commit, onOpen = () => {}, onClose = () => {} }) {
    Object.assign(this, { history, getSpec, commit, onOpen, onClose });
    $("dim-back").addEventListener("click", () => this.close());
    $("dim-undo").addEventListener("click", () => this.history.undo());
    $("dim-redo").addEventListener("click", () => this.history.redo());
  }

  get isOpen() { return this.#index >= 0; }

  /** 部品 index の寸法の欄を開く。original … 開いたファイルの変換データ（元の値を示す） */
  open(index, original) {
    this.#index = index;
    this.#original = original?.parts[index] ?? null;
    this.#focus = null;
    this.#error = null;
    this.#linked = null;
    this.#show(true);
    this.refresh();
    this.onOpen(index);
    $("dim-back").focus({ preventScroll: true }); // 数の欄に入ると、その寸法（場所の無い厚さなど）が光る寸法になるので、欄には入らない
  }

  close() {
    if (!this.isOpen) return;
    this.#index = -1;
    this.#show(false);
    this.onClose();
  }

  #show(on) {
    $("dim-edit").hidden = !on;
    $("parts").hidden = on;
    $("spec-tally").hidden = on;
  }

  /** 欄を描き直す（直した・取り消した・やり直した後） */
  refresh() {
    const undo = $("dim-undo"), redo = $("dim-redo");
    undo.disabled = !this.history.canUndo;
    redo.disabled = !this.history.canRedo;
    undo.title = this.history.undoLabel ? `取り消す: ${this.history.undoLabel}（Ctrl+Z）` : "取り消す（Ctrl+Z）";
    redo.title = this.history.redoLabel ? `やり直す: ${this.history.redoLabel}（Ctrl+Y）` : "やり直す（Ctrl+Y）";
    if (!this.isOpen) return;
    const spec = this.getSpec();
    const part = spec.parts[this.#index];
    const group = describeSpec({ ...spec, parts: [part] }).groups[0];
    $("dim-back").textContent = `← 作る部品の一覧（${spec.parts.length} 種類）`;
    $("dim-title").textContent = `${group.label} ${group.main}`;
    $("dim-name").textContent = part.name;
    $("dim-name").title = part.name;
    const dims = dimensionsOf(part);
    const before = new Map(this.#original ? dimensionsOf(this.#original).map((d) => [d.id, d.value]) : []);
    const changed = dims.filter((d) => before.has(d.id) && Math.abs(before.get(d.id) - d.value) > 1e-9);
    $("dim-count").textContent = changed.length ? `元から変えた寸法 ${changed.length}` : "元のまま";
    $("dim-count").dataset.changed = String(changed.length > 0);
    if (part.kind === "mesh") {
      $("dim-groups").replaceChildren(el("li", "dim-empty", "三角形のまま作る部品（近似）なので、寸法は直せません"));
      $("dim-fixed").hidden = true;
      $("dim-sketch").replaceChildren();
      this.#renderLinked();
      return;
    }
    const editable = dims.filter((d) => d.editable), fixed = dims.filter((d) => !d.editable);
    this.#inventor = inventorNames(part);
    if (!this.#focus || !editable.some((d) => d.id === this.#focus)) this.#focus = (editable.find((d) => focusOf(d)) ?? editable[0])?.id ?? null;
    // 置き場所ごとの見出しと行（寸法の一覧の順を保つ）
    const places = [...new Set(editable.map((d) => placeOf(d, part)))];
    $("dim-groups").replaceChildren(...places.map((place) => {
      const li = el("li", "dim-group");
      const list = el("ul");
      list.append(...editable.filter((d) => placeOf(d, part) === place).map((d) => this.#row(d, place, before.get(d.id))));
      li.append(el("h4", null, place), list);
      return li;
    }));
    $("dim-fixed").hidden = !fixed.length;
    $("dim-fixed-summary").textContent = `直せない寸法 ${fixed.length}`;
    $("dim-fixed-list").replaceChildren(...fixed.map((d) => {
      const li = el("li");
      li.title = d.reason;
      li.append(el("span", null, `${placeOf(d, part)} · ${d.label}`), el("b", null, `${fmt(d.value)} ${d.unit}`), el("small", null, d.reason));
      return li;
    }));
    this.#renderSketch();
    this.#renderLinked();
  }

  /** 1 つの寸法の行（名前・数の欄・単位・元の値） */
  #row(dim, place, original) {
    const { name, note } = names(dim, place);
    const li = el("li", "dim-row");
    li.dataset.id = dim.id;
    if (dim.id === this.#focus) li.classList.add("is-focus");
    const label = el("label", "dim-label");
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.id = `dim-${dim.id}`;
    label.htmlFor = input.id;
    label.append(el("span", null, name));
    const inv = this.#inventor.get(dim.id);
    if (inv) {
      // Inventor で作った部品の中での呼び名（名前つきの値・参照寸法・対応なし）
      const tag = el("span", "dim-inv", inv.kind === "param" ? inv.name : inv.kind === "driven" ? "参照" : "—");
      tag.dataset.kind = inv.kind;
      tag.title = inv.kind === "param" ? `Inventor のパラメータ ${inv.name}（パラメータの表でこの値を直すと形が変わります）`
        : inv.kind === "driven" ? "Inventor では参照寸法（向かいの辺から決まるので、直接は直せません）" : inv.note;
      label.append(tag);
    }
    if (note) label.append(el("small", null, note));
    const error = this.#error?.id === dim.id ? this.#error : null;
    input.value = error ? error.text : fmt(dim.value);
    input.setAttribute("aria-invalid", String(Boolean(error)));
    const was = original !== undefined && Math.abs(original - dim.value) > 1e-9;
    if (was) li.classList.add("is-changed");
    const field = el("span", "dim-field");
    field.append(input, el("span", "dim-unit", dim.unit));
    li.append(label, field, el("span", "dim-was", was ? `← ${fmt(original)}` : ""));
    if (error) {
      const message = el("p", "dim-error", error.message);
      message.id = `${input.id}-error`;
      message.setAttribute("role", "alert");
      input.setAttribute("aria-describedby", message.id);
      li.append(message);
    }
    const focus = () => {
      if (this.#focus === dim.id) return;
      this.#focus = dim.id;
      for (const row of $("dim-groups").querySelectorAll(".dim-row")) row.classList.toggle("is-focus", row.dataset.id === dim.id);
      this.#renderSketch();
    };
    li.addEventListener("pointerenter", focus);
    input.addEventListener("focus", focus);
    input.addEventListener("change", () => this.#apply(dim, input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = fmt(dim.value);
        this.#error = null;
        this.refresh();
      }
    });
    return li;
  }

  #renderSketch() {
    const part = this.getSpec().parts[this.#index];
    const dim = dimensionsOf(part).find((d) => d.id === this.#focus);
    const focus = dim && focusOf(dim);
    // 札は「直径 250」。Inventor の名前つきの値なら「直径 250 · D0_0」（図でも、どのパラメータか分かる。案 I: docs/ui.md §21）
    const inv = this.#inventor.get(dim?.id);
    const label = focus ? `${names(dim, placeOf(dim, part)).name} ${fmt(dim.value)}${inv?.kind === "param" ? ` · ${inv.name}` : ""}` : "";
    $("dim-sketch").innerHTML = sketchMarkup(part.sketch.loops, { width: 400, height: 200, focus, label });
  }

  #renderLinked() {
    const box = $("dim-linked");
    box.hidden = !this.#linked?.length;
    box.textContent = this.#linked?.length
      ? `一緒に変わった寸法: ${this.#linked.map((c) => `${c.label.replace(SCALE_NOTE, "")} ${fmt(c.before)} → ${fmt(c.after)}`).join("、")}` : "";
  }

  /** 欄の値で直す（直せなければ理由を出す）。取り消せるように history に入れる */
  #apply(dim, text) {
    const value = Number(String(text).trim().replace(/,/g, ""));
    if (Math.abs(value - dim.value) < 1e-12) {
      this.#error = null;
      this.refresh();
      return;
    }
    const index = this.#index;
    const spec = this.getSpec();
    const before = spec.parts[index];
    let result;
    try {
      if (!String(text).trim() || !Number.isFinite(value)) throw new Error("数を入れてください");
      result = applyDimension(before, dim.id, value);
    } catch (error) {
      this.#error = { id: dim.id, message: error.message, text };
      this.refresh();
      return;
    }
    this.#error = null;
    this.#focus = dim.id;
    const linked = result.changed;
    const put = (part, links) => () => {
      const current = this.getSpec();
      this.#linked = links;
      this.commit({ ...current, parts: current.parts.map((p, i) => (i === index ? part : p)) }, index);
    };
    this.history.run({ label: `${dim.label.replace(SCALE_NOTE, "")}を ${fmt(value)} に`, apply: put(result.part, linked), revert: put(before, null) });
  }
}
