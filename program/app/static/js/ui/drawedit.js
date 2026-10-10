// 図面を直す画面（docs/editing.md §6）。選ぶのは測る道具（ui/measure.js の selection）と同じ。
//   命令（ツールバー）: 動かす・写す（基点 → 先をクリック。X・Y を数で入れて Enter でも）・回す（中心 → 向きをクリック。角度を数で入れても。
//     中心を選ばずに数で回すと、選んだ図形の広がりの中心で回す）・消す（Delete）・取り消し・やり直し（Ctrl+Z・Ctrl+Y）
//   命令の間は図の上の帯（測ると同じ形）に「何をしているか・次にすること・数の欄・やめる」。カーソルの所に、選んだ図形の影を描く。
//     点は測ると同じく、端点・中点・中心・交点に吸い付く。写すは続けて写せる（Esc でやめる）
//   選んだ図形のカード: 画層を選ぶ・文字を直す（1 つの文字の図形を選んだとき）。直せない図形は理由を出す
//   DXF で保存（見出し）: 版（R2013・R2000）を選んで保存の窓へ。書けなかったもの・変えたものを知らせる。
//     直した後（保存していない）は、保存のボタンが主の色になり点が付く（利用者が選んだ案 F。docs/ui.md §22）
//
//   new DrawingEditTool({ viewer, edits, selected, units, notify, onSaved })
//     edits … edit/drawing.js の DrawingEdits・selected() → 選んだ図形（entity の列）・units() → "mm" など・notify(text) … 知らせ

import { EditError, similarity } from "../formats/cad2d/transform.js";
import { length } from "../viewer2d/describe.js";
import { SNAP_LABEL } from "../viewer2d/snap.js";

const $ = (id) => document.getElementById(id);
const COMMANDS = {
  move: { title: "動かす", first: "基点をクリック", second: "移動先をクリック", numbers: "move" },
  copy: { title: "写す", first: "基点をクリック", second: "写す先をクリック", again: "続けて写す先をクリック（やめるは Esc）", numbers: "move" },
  rotate: { title: "回す", first: "回す中心をクリック", second: "向きをクリック（右が 0°・反時計回り）", numbers: "rotate" },
};
const TEXTS = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);
const deg = (rad) => `${String(Number(((rad * 180) / Math.PI).toFixed(2)))}°`;

export class DrawingEditTool {
  #command = null; // "move" | "copy" | "rotate"
  #base = null; // 基点・回す中心 { x, y }

  constructor({ viewer, edits, selected, items, units, notify }) {
    Object.assign(this, { viewer, edits, selected, items, units, notify });
    for (const button of document.querySelectorAll("[data-edit]")) {
      button.addEventListener("click", () => (button.dataset.edit === "remove" ? this.remove() : this.start(button.dataset.edit)));
    }
    $("edit-undo").addEventListener("click", () => this.edits.history.undo());
    $("edit-redo").addEventListener("click", () => this.edits.history.redo());
    $("edit-stop").addEventListener("click", () => this.stop());
    $("edit-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.#applyNumbers();
    });
    $("edit-layer").addEventListener("change", (event) => this.#run(() => this.edits.setLayer(this.selected(), event.target.value)));
    $("edit-text").addEventListener("change", (event) => {
      const [entity] = this.selected();
      if (entity && event.target.value !== entity.text) this.#run(() => this.edits.setText(entity, event.target.value));
    });
  }

  get active() { return this.#command !== null; }

  /** 命令を始める（選んでいる図形が直せなければ、理由を知らせて始めない） */
  start(command) {
    const why = this.edits.reason(this.selected());
    if (why) {
      this.notify(why);
      return;
    }
    this.#command = command;
    this.#base = null;
    const c = COMMANDS[command];
    $("edit-title").textContent = c.title;
    $("edit-move-inputs").hidden = c.numbers !== "move";
    $("edit-rotate-inputs").hidden = c.numbers !== "rotate";
    for (const id of ["edit-dx", "edit-dy", "edit-angle"]) $(id).value = "";
    $("edit-band").hidden = false;
    for (const b of document.querySelectorAll("[data-edit]")) b.setAttribute("aria-pressed", String(b.dataset.edit === command));
    this.#step();
  }

  stop() {
    this.#command = null;
    this.#base = null;
    $("edit-band").hidden = true;
    for (const b of document.querySelectorAll("[data-edit]")) b.setAttribute("aria-pressed", "false");
    this.viewer.setGhost(null);
    this.viewer.setOverlay(null);
  }

  remove() {
    this.#run(() => this.edits.remove(this.selected()));
  }

  /** カーソルの所: 吸い付く点と、選んだ図形の影（命令の間だけ。扱ったら true） */
  hover(at) {
    if (!this.#command) return false;
    const p = at && this.#point(at);
    if (!p) return true;
    const m = this.#base && this.#transform(p);
    this.viewer.setGhost(m ? { items: this.items(), m } : null);
    const snap = p.kind ? { x: p.x, y: p.y, kind: p.kind, label: SNAP_LABEL[p.kind] } : null;
    const lines = this.#base ? [{ a: [this.#base.x, this.#base.y], b: [p.x, p.y], dashed: true }] : [];
    const tags = this.#base ? [{ x: p.x, y: p.y, text: this.#describe(p) }] : [];
    this.viewer.setOverlay({ lines, points: this.#base ? [[this.#base.x, this.#base.y]] : [], tags, snap });
    return true;
  }

  click(hit) {
    if (!this.#command) return false;
    const p = this.#point(hit);
    if (!this.#base) {
      this.#base = p;
      this.#step();
      return true;
    }
    const m = this.#transform(p);
    if (this.#command === "rotate") this.#run(() => this.edits.rotate(this.selected(), [this.#base.x, this.#base.y], Math.atan2(p.y - this.#base.y, p.x - this.#base.x)));
    else this.#run(() => this.edits[this.#command](this.selected(), [m.e, m.f]));
    if (this.#command === "copy") this.#step(true);
    else this.stop();
    return true;
  }

  /** Esc: 基点を取り消す → 命令をやめる。Delete: 消す。命令の間は数の欄の Enter も（form） */
  key(event) {
    if (event.key === "Escape" && this.#command) {
      if (this.#base && this.#command !== "copy") {
        this.#base = null;
        this.viewer.setGhost(null);
        this.#step();
      } else this.stop();
      return true;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !event.target.closest?.("input, select, textarea") && this.selected().length) {
      this.remove();
      return true;
    }
    return false;
  }

  /** 選んだ図形が変わった・直した後: カードの画層・文字と、ボタンの状態 */
  refresh() {
    const entities = this.selected();
    const why = entities.length ? this.edits.reason(entities) : null;
    for (const b of document.querySelectorAll("[data-edit]")) b.disabled = !entities.length || Boolean(why);
    const h = this.edits.history;
    $("edit-undo").disabled = !h.canUndo;
    $("edit-redo").disabled = !h.canRedo;
    $("edit-undo").title = h.undoLabel ? `取り消す: ${h.undoLabel}（Ctrl+Z）` : "取り消す（Ctrl+Z）";
    $("edit-redo").title = h.redoLabel ? `やり直す: ${h.redoLabel}（Ctrl+Y）` : "やり直す（Ctrl+Y）";
    // 直した後（保存していない）は、保存のボタンを主の色に（案 F。docs/ui.md §22）
    $("save-dxf-group").classList.toggle("is-dirty", h.dirty);
    $("save-dxf-dirty").hidden = !h.dirty;
    $("selection-edit").hidden = !entities.length;
    if (!entities.length) return;
    $("edit-reason").hidden = !why;
    $("edit-reason").textContent = why ?? "";
    const select = $("edit-layer");
    const layers = [...this.edits.drawing.layers.keys()];
    const current = new Set(entities.map((e) => e.layer));
    select.replaceChildren(...(current.size > 1 ? [new Option(`（${current.size} つの画層）`, "", true, true)] : []),
      ...layers.map((name) => new Option(name, name, false, current.size === 1 && current.has(name))));
    select.disabled = Boolean(why);
    const text = entities.length === 1 && TEXTS.has(entities[0].type) ? entities[0] : null;
    $("edit-text-row").hidden = !text;
    if (text && document.activeElement !== $("edit-text")) $("edit-text").value = text.text ?? "";
    $("edit-text").disabled = Boolean(why);
  }

  #point(at) {
    return this.viewer.snapAt(at.px, at.py) ?? { x: at.x, y: at.y, kind: null };
  }

  /** 基点からカーソルまでの変換（動かす・写す: 平行移動、回す: 中心のまわりの回転） */
  #transform(p) {
    if (this.#command === "rotate") return similarity({ angle: Math.atan2(p.y - this.#base.y, p.x - this.#base.x), center: [this.#base.x, this.#base.y] });
    return similarity({ move: [p.x - this.#base.x, p.y - this.#base.y] });
  }

  #describe(p) {
    if (this.#command === "rotate") return deg(Math.atan2(p.y - this.#base.y, p.x - this.#base.x));
    const units = this.units();
    return `${length(p.x - this.#base.x, units)}, ${length(p.y - this.#base.y, units)}`;
  }

  #step(again = false) {
    const c = COMMANDS[this.#command];
    $("edit-step").textContent = again ? c.again : this.#base ? c.second : c.first;
  }

  /** 数の欄で直す（動かす・写す: X・Y だけずらす。回す: 角度。中心は選んだ中心か、選んだ図形の広がりの中心） */
  #applyNumbers() {
    const num = (id) => Number($(id).value || 0);
    if (this.#command === "rotate") {
      const center = this.#base ? [this.#base.x, this.#base.y] : this.#center();
      this.#run(() => this.edits.rotate(this.selected(), center, (num("edit-angle") * Math.PI) / 180));
      this.stop();
    } else if (this.#command) {
      this.#run(() => this.edits[this.#command](this.selected(), [num("edit-dx"), num("edit-dy")]));
      if (this.#command === "move") this.stop();
    }
  }

  /** 選んだ図形の広がりの中心（描いた結果の外形から） */
  #center() {
    const box = this.viewer.boundsOf(this.items());
    return box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2] : [0, 0];
  }

  #run(action) {
    try {
      action();
      this.notify("");
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      this.notify(error.message);
    }
  }
}
