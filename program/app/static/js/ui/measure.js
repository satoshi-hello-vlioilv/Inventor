// 2D の図面で選ぶ・測る（利用者が選んだ案 G: docs/ui.md §19）。
//   ふだん: 図形を押すと選ぶ（強調が残る）。性質は欄のカード「選んだ図形」（viewer2d/describe.js の itemDetails）。何も無い所を押すと外す
//   測る（ツールバーの「測る」か M）: 図の上の帯に「いま何をしているか・次にすること・やめる」。カーソルの近くの吸い付く点
//     （端点・中点・中心・四分点・交点。viewer2d/snap.js）に印と名前。1 点目からカーソルまでの点線とその場の距離。
//     2 点目を押すと結果をカード「測った結果」（距離・横・縦・角度）に出し、図に線と札を残す。続けて次を測れる
//   Esc: 1 点目を取り消す → 測るのをやめる → 選んだ図形と測った線を消す（の順に 1 つ）
//
//   new MeasureTool({ viewer, context, readout })
//     context() → { scene, units（"mm" など）, scaleOf(item の番号) → 画層の縮尺 } | null（図面を見ていない）
//     readout(text | null) … 下の読み出し（測っている間は、指した点の種類と座標・1 点目からの距離。null で元に戻す）
//   hover(at) → 測っている間は true（呼ぶ側は図形の強調をしない）・click(hit)・key(event) → 扱ったか
//   reset() … 別の図面・レイアウト・表示へ（選ぶ・測るを全て消す）・refresh() … 同じレイアウトを描き直した後（画層の切り替え）

import { Selection } from "../edit/selection.js";
import { itemDetails, length, typeLabel } from "../viewer2d/describe.js";
import { SNAP_LABEL, measure } from "../viewer2d/snap.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
const deg = (v) => `${String(Number(v.toFixed(2)))}°`;
const labelOf = (p) => SNAP_LABEL[p.kind] ?? "指した所";
const SAME_PX = 4;
const coords =(p) => `${length(p.x)}, ${length(p.y)}`;

export class MeasureTool {
  #active = false;
  #first = null; // 1 点目（吸い付いた点 { x, y, kind, item }）
  #done = null; // 測った結果 { a, b, m }
  #picked = []; // 選んだ図形の entity（描き直して scene.items の番号が変わっても、同じ図形を選び直す）

  constructor({ viewer, context, readout, onSelect = () => {} }) {
    this.viewer = viewer;
    this.context = context;
    this.readout = readout;
    this.onSelect = onSelect;
    // 選んでいるもの（edit/selection.js。2D は scene.items の番号）。変わったら強調とカードを描き直す
    this.selection = new Selection({ onChange: (selection) => {
      const items = this.context()?.scene.items ?? [];
      this.#picked = selection.items.map((i) => items[i]?.entity);
      this.viewer.select(selection.items);
      this.#renderCards();
      this.onSelect();
    } });
    $("measure").addEventListener("click", () => this.toggle(!this.#active));
    $("measure-stop").addEventListener("click", () => this.toggle(false));
  }

  get active() { return this.#active; }

  toggle(on) {
    if (on && !this.context()) return;
    this.#active = on;
    this.#first = null;
    $("measure").setAttribute("aria-pressed", String(on));
    $("measure-band").hidden = !on;
    this.readout(null); // 指していた図形の強調・読み出しを消す（測っている間は点の印だけ）
    this.#step();
    this.#draw();
  }

  reset() {
    this.#done = null;
    this.toggle(false);
    this.selection.clear();
    this.viewer.select(null);
    this.#renderCards();
  }

  /** 同じレイアウトを描き直した後: 選んだ図形を選び直し、印を描き直す（画層の切り替えで隠れた図形は外す。測った線は残す） */
  refresh() {
    const items = this.context()?.scene.items ?? [];
    const picked = this.#picked;
    this.selection.set(picked.map((entity) => items.findIndex((it) => it.entity === entity)).filter((i) => i >= 0 && this.viewer.index?.has(i)));
    this.viewer.select(this.selection.items); // 描き直しで強調が消えるので、番号が同じでも付け直す
    this.#draw();
    this.#renderCards();
  }

  hover(at) {
    if (!this.#active) return false;
    const p = at ? this.viewer.snapAt(at.px, at.py) ?? { x: at.x, y: at.y, kind: null } : null;
    this.#draw(p);
    const units = this.context()?.units ?? "";
    const from = this.#first && p ? ` · 1 点目から ${length(this.#measure(this.#first, p).distance, units)}` : "";
    this.readout(p?.kind ? `${SNAP_LABEL[p.kind]} · ${coords(p)}${from}` : null);
    return true;
  }

  click(hit) {
    const ctx = this.context();
    if (!ctx) return;
    if (!this.#active) {
      // Shift ＋押す: 足す・Ctrl ＋押す: 選ぶ・外すを切り替え・ただ押す: 選び直す（何も無い所で外す）
      if (hit.item !== null && hit.shiftKey) this.selection.add([hit.item]);
      else if (hit.item !== null && (hit.ctrlKey || hit.metaKey)) this.selection.toggle(hit.item);
      else if (!hit.shiftKey && !hit.ctrlKey) this.selection.set(hit.item === null ? [] : [hit.item]);
      return;
    }
    const p = this.viewer.snapAt(hit.px, hit.py) ?? { x: hit.x, y: hit.y, kind: null, item: hit.item };
    // 1 点目と同じ所（ダブルクリックで全体表示するときの 2 回目など）は 2 点目にしない
    if (this.#first && this.#screenDistance(this.#first, p) < SAME_PX) return;
    if (!this.#first) {
      this.#first = p;
      this.#done = null;
    } else {
      this.#done = { a: this.#first, b: p, m: this.#measure(this.#first, p) };
      this.#first = null;
    }
    this.#step();
    this.#draw(p);
    this.#renderCards();
  }

  key(event) {
    if (event.defaultPrevented || event.target.closest?.("input, select, textarea, dialog, .page-pop") || event.ctrlKey || event.metaKey || event.altKey || !this.context()) return false;
    if (event.key === "m" || event.key === "M") this.toggle(!this.#active);
    else if (event.key === "Escape") {
      if (this.#active && this.#first) {
        this.#first = null;
        this.#step();
        this.#draw();
      } else if (this.#active) this.toggle(false);
      else if (this.selection.size || this.#done) this.reset();
      else return false;
    } else return false;
    return true;
  }

  #screenDistance(a, b) {
    const [ax, ay] = this.viewer.toScreen(a.x, a.y), [bx, by] = this.viewer.toScreen(b.x, b.y);
    return Math.hypot(bx - ax, by - ay);
  }

  /** 2 点の間（両方の図形の画層の縮尺が同じなら実寸。違えば図面の長さ） */
  #measure(a, b) {
    const ctx = this.context();
    const ka = a.item === null || a.item === undefined ? 1 : ctx.scaleOf(a.item), kb = b.item === null || b.item === undefined ? 1 : ctx.scaleOf(b.item);
    return { ...measure(a, b, ka === kb ? ka : 1), scale: ka === kb ? ka : 1, mixed: ka !== kb };
  }

  #step() {
    $("measure-step").textContent = this.#first ? "2 点目をクリック" : this.#done ? "次の 1 点目をクリック（続けて測れる）" : "1 点目をクリック";
  }

  /** 図の上の印: 測った線（実線）と札・1 点目からカーソルまで（点線）とその場の距離・吸い付いた点の印 */
  #draw(cursor = null) {
    const units = this.context()?.units ?? "";
    const lines = [], points = [], tags = [];
    if (this.#done) {
      const { a, b, m } = this.#done;
      lines.push({ a: [a.x, a.y], b: [b.x, b.y] });
      points.push([a.x, a.y], [b.x, b.y]);
      tags.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: length(m.distance, units) });
    }
    if (this.#first) {
      points.push([this.#first.x, this.#first.y]);
      if (cursor) {
        lines.push({ a: [this.#first.x, this.#first.y], b: [cursor.x, cursor.y], dashed: true });
        tags.push({ x: cursor.x, y: cursor.y, text: length(this.#measure(this.#first, cursor).distance, units) });
      }
    }
    const snap = this.#active && cursor?.kind ? { x: cursor.x, y: cursor.y, kind: cursor.kind, label: SNAP_LABEL[cursor.kind] } : null;
    this.viewer.setOverlay(lines.length || points.length || snap ? { lines, points, tags, snap } : null);
  }

  #renderCards() {
    const ctx = this.context();
    const units = ctx?.units ?? "";
    const list = (id, rows) => $(id).replaceChildren(...rows.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));
    $("measure-card").hidden = !this.#done;
    if (this.#done) {
      const { a, b, m } = this.#done;
      $("measure-note").textContent = `${labelOf(a)} → ${labelOf(b)}`;
      list("measure-result", [["距離", length(m.distance, units)], ["横（X）", length(m.dx, units)], ["縦（Y）", length(m.dy, units)], ["角度", deg(m.angle)],
        ...(m.scale !== 1 ? [["縮尺", `実寸（画層の縮尺 1:${String(Number(m.scale.toFixed(4)))}）`]] : []),
        ...(m.mixed ? [["縮尺", "縮尺の違う画層をまたぐので、図面の長さ"]] : [])]);
    }
    const chosen = this.selection.items;
    $("selection-card").hidden = !chosen.length;
    $("selection-note").textContent = chosen.length > 1 ? `${chosen.length} 個・Esc で外す` : "Esc で外す";
    if (chosen.length === 1) list("selection-info", itemDetails(ctx.scene.items[chosen[0]], units, ctx.scaleOf(chosen[0])));
    else if (chosen.length > 1) {
      // 複数: 種類ごとの数と画層
      const count = (key) => [...chosen.reduce((m, i) => m.set(key(ctx.scene.items[i]), (m.get(key(ctx.scene.items[i])) ?? 0) + 1), new Map())]
        .map(([k, n]) => `${k} ${n}`).join("・");
      list("selection-info", [["種類", count((it) => typeLabel(it.type))], ["画層", count((it) => it.layer)]]);
    }
  }
}
