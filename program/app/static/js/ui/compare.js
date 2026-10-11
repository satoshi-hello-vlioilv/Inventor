// 図面の旧版と新版を比べる（画面。案 H: docs/ui.md §27。比べる計算は formats/cad2d/compare.js、重ねて描くのは viewer2d/compare-scene.js）。
// 図面を開いている間、ツールバーの「旧版と比べる」で旧版のファイルを選ぶと、今の図面（新版）と比べ、違いに色を付けて重ねて描く。
// 近い違いをまとめて改訂の雲と番号で囲み（図面の慣習）、欄の「旧版との違い」の一覧も同じ番号の順に並べる（行は何がどう変わったかの値を先に）。
// ツールバーの下の帯で、違いを番号の順に 1 つずつ見る（次の違い N・前 Shift+N。今の違いの雲は太く、一覧の行を囲む）。行を押してもその違いへ寄る。
//
//   const compare = new DrawingCompare({ viewer, open, render, highlight })
//     open(file) → Promise<図面のモデル | null>（旧版を読む。読めなければ null。main.js が裏の計算で読む）
//     render(fit) … 図面を描き直す（main.js の renderSheet。比べている間は compare.scene が描くものを作る）
//     highlight(items) … 図形の強調（scene.items の番号）
//   compare.active … 比べているか。start(file)・stop()・reset()（描き直さずにやめる: 別の図面を開いたとき）
//   compare.scene(drawing, layout, buildOptions, newerName) → 描くもの（比べている間、main.js の renderSheet が呼ぶ）
//   compare.shown() … 描いた後（改訂の雲と番号を図の上と一覧に出す）
//   compare.hover(index) → 指した図形の説明（比べていなければ null）・compare.key(event) → 扱ったか（N・Shift+N・Esc）

import { anchor, compareDrawings } from "../formats/cad2d/compare.js";
import { cloudOutline, compareScene, differenceRegions } from "../viewer2d/compare-scene.js";
import { describeItem, length, typeLabel } from "../viewer2d/describe.js";
import { buildScene } from "../viewer2d/scene.js";
import { mtextLines, singleLine } from "../viewer2d/text.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

export const STATUS_LABEL = { same: "同じ", changed: "変わった", added: "足した", removed: "消した" };
const CHANGE_LABEL = { shape: "形・位置", props: "画層・色・線", text: "文字" };
const ORDER = ["changed", "added", "removed"]; // 一覧の並び（目を向ける順）
const REGION_GAP = 0.02; // 違いのまとまり: 図面の広がりに対する、まとめる距離
const TEXT_MAX = 24; // 文字の違いの行で見せる長さ（これより長い所は … で切る）
const FOCUS = 0.25; // 違いへ寄るとき: 図面の広がりに対する、見せる範囲の下限（周りの形が見えるように）

/** 重ねて描く色（テーマに合わせて CSS から読む。--diff-same・--diff-added・--diff-changed・--diff-removed・--diff-before） */
function palette(element) {
  const css = getComputedStyle(element);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    same: token("--diff-same", "#b5bdc7"), added: token("--diff-added", "#1b7f3f"), changed: token("--diff-changed", "#c27c12"),
    removed: token("--diff-removed", "#c62f26"), before: token("--diff-before", "#e9aaa5"), // 予備は明るいテーマの色（app.css と同じ）
  };
}

/** 項目の図形（新版を先に）と、変わったところの言葉 */
const entityOf = (x) => x.newer ?? x.older;
const changesText = (x) => (x?.changes?.length ? x.changes.map((c) => CHANGE_LABEL[c] ?? c).join("・") : "");

/**
 * 違いを値で言う（図形の説明 viewer2d/describe.js の describeItem を前後で比べ、違う部分だけ「前 → 後」に）。動いた図形は動いた量も。
 * 足した・消した図形は、その図形の説明（画層を除く）
 */
export function changeDetail(x, units) {
  const describe = (e) => describeItem({ entity: e, layer: e.layer ?? "0" }, units).split(" · ").slice(1, -1); // 種類と画層を除く
  if (x.status !== "changed") return describe(entityOf(x)).join(" · ");
  const out = [];
  const text = textChange(x.older, x.newer);
  if (text) out.push(text);
  else {
    const [before, after] = [describe(x.older), describe(x.newer)];
    const i = after.findIndex((part, k) => before[k] !== undefined && before[k] !== part); // 最初に違う値（Φ と半径のように重なる値は 1 つで足りる）
    if (i >= 0) out.push(`${before[i]} → ${after[i]}`);
  }
  if ((x.older.layer ?? "0") !== (x.newer.layer ?? "0")) out.push(`画層 ${x.older.layer ?? "0"} → ${x.newer.layer ?? "0"}`);
  const [p, q] = [anchor(x.older), anchor(x.newer)];
  const moved = p && q ? Math.hypot(q[0] - p[0], q[1] - p[1]) : 0;
  if (moved > 1e-9 && !out.length) out.push(`動いた ${length(moved, units)}`);
  return out.join(" · ") || changesText(x);
}

/**
 * 文字の違い: 前後で違う所だけを語の単位で（「調質」を足した・「調質」を消した・「6.0」→「6.6」）。
 * 違う所が語の途中で切れていれば、語の切れ目（空白）まで広げる（「6.0」→「6.6」を「0」→「6」と言わない）
 */
function textChange(a, b) {
  const plain = (e) => (typeof e.text !== "string" ? null : e.type === "MTEXT" ? mtextLines(e.text).join(" ") : singleLine(e.text));
  const [s, t] = [plain(a), plain(b)];
  if (s === null || t === null || s === t) return "";
  let head = 0;
  while (head < s.length && head < t.length && s[head] === t[head]) head++;
  let tail = 0;
  while (tail < s.length - head && tail < t.length - head && s[s.length - 1 - tail] === t[t.length - 1 - tail]) tail++;
  const word = (c) => c !== undefined && !/\s/.test(c);
  while (head > 0 && word(s[head - 1]) && (word(s[head]) || word(t[head]))) head--;
  while (tail > 0 && word(s[s.length - tail]) && (word(s[s.length - tail - 1]) || word(t[t.length - tail - 1]))) tail--;
  const cut = (v) => (v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX)}…` : v);
  const [before, after] = [cut(s.slice(head, s.length - tail).trim()), cut(t.slice(head, t.length - tail).trim())];
  return !before ? `「${after}」を足した` : !after ? `「${before}」を消した` : `「${before}」→「${after}」`;
}

/** 指した図形の説明（重ねた描くものの sides[番号]） */
function statusText(side) {
  if (!side) return null;
  const e = side.compared ? entityOf(side.compared) : null;
  const what = e ? ` · ${typeLabel(e.type)} · 画層 ${e.layer ?? "0"}` : "";
  if (side.side === "older") return `${side.status === "changed" ? "変わる前の形" : "消した図形（旧版だけ）"}${what}`;
  if (side.status === "same") return `旧版と同じ${what}`;
  const detail = side.status === "changed" && changesText(side.compared) ? `（${changesText(side.compared)}）` : "";
  return `${STATUS_LABEL[side.status]}${detail}${what}`;
}

export class DrawingCompare {
  older = null; // { drawing, name }
  step = -1; // 今見ている違いのまとまり（regions の番号。-1 = まだ寄っていない: 全体と全ての雲）
  #overlay = null; // 重ねた描くもの（指した図形の説明に使う）
  #regions = []; // 違いのまとまり（改訂の雲と番号。differenceRegions）

  constructor({ viewer, open, render, highlight }) {
    Object.assign(this, { viewer, open, render, highlight });
    $("compare").addEventListener("click", () => (this.active ? this.stop() : $("compare-input").click()));
    $("compare-input").addEventListener("change", () => {
      const file = $("compare-input").files[0];
      $("compare-input").value = "";
      if (file) this.start(file);
    });
    $("compare-stop").addEventListener("click", () => this.stop());
    $("compare-prev").addEventListener("click", () => this.#go(-1));
    $("compare-next").addEventListener("click", () => this.#go(1));
  }

  get active() {
    return Boolean(this.older);
  }

  /** 旧版を読んで比べ始める */
  async start(file) {
    const model = await this.open(file);
    if (!model) return;
    this.older = { drawing: model.drawing, name: file.name };
    this.step = -1;
    this.#chrome(true);
    this.render(true);
  }

  stop() {
    if (!this.active) return;
    this.reset();
    this.render(true);
  }

  /** 比べるのをやめる（描き直さない。別の図面を開いたとき） */
  reset() {
    this.older = null;
    this.#overlay = null;
    this.newerScene = null;
    this.#regions = [];
    this.step = -1;
    this.#chrome(false);
    this.viewer.setOverlay(null, "marks");
  }

  /** 帯・欄の出し入れ */
  #chrome(on) {
    $("compare-band").hidden = !on;
    $("compare-card").hidden = !on;
    $("compare").setAttribute("aria-pressed", String(on));
    $("app").classList.toggle("is-comparing", on);
  }

  /** 比べている間の描くもの（旧版のレイアウトは、新版と同じ名前のもの。モデル同士・無ければ最初） */
  scene(drawing, layout, options, newerName) {
    const older = this.older.drawing;
    const olderLayout = older.layouts.find((l) => (layout.model ? l.model : l.name === layout.name)) ?? older.layouts[0];
    const olderScene = buildScene(older, olderLayout, { measure: options.measure });
    const newerScene = (this.newerScene = buildScene(drawing, layout, options)); // 欄の図形の内訳は新版で数える
    const result = compareDrawings(older, drawing, { olderLayout, newerLayout: layout });
    this.#overlay = compareScene(olderScene, newerScene, result, palette($("stage")));
    this.#renderPanel(result, newerName, drawing.units.name);
    return this.#overlay;
  }

  /** 描いた後: 違いのまとまり（改訂の雲と番号）を求め、図の上と一覧に出す */
  shown() {
    if (!this.active) return this.viewer.setOverlay(null, "marks");
    const ext = this.#overlay.extents;
    this.span = ext ? Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1]) : 1;
    this.#regions = differenceRegions(this.#overlay, (items) => this.viewer.boundsOf(items), this.span * REGION_GAP);
    if (this.step >= this.#regions.length) this.step = -1;
    this.#mark();
  }

  /** 改訂の雲と番号（今見ている違いは太く）・帯の「何か所 / 何番目」・一覧の番号と並び（番号の順）と今の行 */
  #mark() {
    const n = this.#regions.length;
    $("compare-step-text").textContent = !n ? "違いなし" : this.step >= 0 ? `${this.step + 1} / ${n}` : `違い ${n} か所`;
    $("compare-prev").disabled = $("compare-next").disabled = !n;
    const color = getComputedStyle($("stage")).getPropertyValue("--diff-cloud").trim() || null;
    const lines = [], tags = [];
    this.#regions.forEach((r, k) => {
      const width = k === this.step ? 3.5 : 1.5;
      const pts = cloudOutline(r.box, Math.max(this.span * 0.01, (r.box.max[0] - r.box.min[0] + r.box.max[1] - r.box.min[1]) / 16));
      for (let i = 0; i + 3 < pts.length; i += 2) lines.push({ a: [pts[i], pts[i + 1]], b: [pts[i + 2], pts[i + 3]], color, width });
      tags.push({ x: r.box.max[0], y: r.box.max[1], text: String(r.number), color });
    });
    this.viewer.setOverlay(lines.length ? { lines, tags } : null, "marks");
    const regionOf = new Map(this.#regions.flatMap((r, k) => r.items.map((i) => [this.#overlay.sides[i]?.compared, k])));
    const list = $("compare-list");
    const rows = [...list.querySelectorAll(".diff-row")].map((row) => ({ row, k: regionOf.get(row.compared) ?? Infinity }));
    for (const { row, k } of rows) {
      row.region = k;
      row.querySelector(".diff-no").textContent = Number.isFinite(k) ? String(k + 1) : "";
      row.classList.toggle("is-current", k === this.step);
    }
    list.append(...rows.sort((a, b) => a.k - b.k).map(({ row }) => row.parentElement)); // 番号の順（雲を読む順）。番号の無い行（描いていない図形）は後ろ
    rows.find(({ k }) => k === this.step)?.row.scrollIntoView({ block: "nearest" });
  }

  /** 次・前の違いのまとまりへ（まだ寄っていなければ、次 → 1 番・前 → 最後） */
  #go(delta) {
    const n = this.#regions.length;
    if (n) this.#focus(this.step < 0 ? (delta > 0 ? 0 : n - 1) : (this.step + delta + n) % n);
  }

  /** 違いのまとまり k へ寄る（周りの形も見えるように、図面の広がりの FOCUS 以上を見せる） */
  #focus(k) {
    this.step = k;
    const { min, max } = this.#regions[k].box;
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
    const half = Math.max(Math.max(max[0] - min[0], max[1] - min[1]) * 3, this.span * FOCUS) / 2;
    this.viewer.fit({ min: [c[0] - half, c[1] - half], max: [c[0] + half, c[1] + half] });
    this.#mark();
  }

  hover(index) {
    if (!this.active || index === null) return null;
    return statusText(this.#overlay?.sides[index]);
  }

  /** キー: N で次の違い・Shift+N で前の違い・Esc でやめる。扱ったら true */
  key(event) {
    if (!this.active || event.defaultPrevented || event.target.closest?.("input, select, textarea, dialog, .page-pop") || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "Escape") this.stop();
    else if (event.key === "n" || event.key === "N") this.#go(event.shiftKey ? -1 : 1);
    else return false;
    return true;
  }

  /** 欄の「旧版との違い」: 数と、違いの一覧（押すとその違いのまとまりへ寄る） */
  #renderPanel(result, newerName, units) {
    const { counts } = result;
    $("compare-files").textContent = `${this.older.name} → ${newerName}`;
    $("compare-note").textContent = result.byHandle ? "図形の番号（ハンドル）と中身で突き合わせ" : "中身で突き合わせ（動かした図形は、消した・足したの組）";
    $("compare-counts").replaceChildren(...[...ORDER, "same"].map((status) => {
      const chip = el("span", "tally-chip");
      chip.dataset.diff = status;
      chip.append(el("span", "swatch"), el("span", null, STATUS_LABEL[status]), el("b", "num", String(counts[status])));
      return chip;
    }));
    const differences = result.items.filter((x) => x.status !== "same").sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
    $("compare-list").replaceChildren(...(differences.length ? differences.map((x) => this.#row(x, units)) : [el("li", "empty", "旧版と新版に違いはありません")]));
  }

  /** 違いの行: 番号（雲と同じ）・結果・何がどう変わったか（値）・図形の種類と画層 */
  #row(x, units) {
    const e = entityOf(x);
    const button = el("button", "feature diff-row");
    button.type = "button";
    button.dataset.diff = x.status;
    button.compared = x; // 違いのまとまりの番号を付けるとき（#mark）に引く
    const detail = changeDetail(x, units);
    const where = `画層 ${e.layer ?? "0"}`;
    button.append(el("span", "diff-no"), el("span", "kind", STATUS_LABEL[x.status]), el("span", "sub", detail || typeLabel(e.type)),
      el("span", "dim", detail ? `${typeLabel(e.type)} · ${where}` : where));
    const items = () => (this.#overlay?.sides ?? []).flatMap((s, i) => (s?.compared === x ? [i] : []));
    const enter = () => this.highlight(items());
    button.addEventListener("pointerenter", enter);
    button.addEventListener("focus", enter);
    button.addEventListener("pointerleave", () => this.highlight([]));
    button.addEventListener("blur", () => this.highlight([]));
    button.addEventListener("click", () => Number.isFinite(button.region) && this.#focus(button.region));
    const li = el("li");
    li.append(button);
    return li;
  }
}
