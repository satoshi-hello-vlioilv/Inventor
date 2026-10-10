// 2D の図面を直す命令（取り消し・やり直しは edit/history.js）。直すのはレイアウトに直に置かれた図形（scene.items の entity）。
//   const edits = new DrawingEdits({ onChange })   // onChange(edits) … 直した・取り消した・やり直した後（描き直し・ボタンの状態）
//   edits.open(drawing) … 別の図面を開いた（覚えた命令を忘れる）
//   edits.reason(entities) → 直せない理由（無ければ null）。ロックした画層・直せない種類（formats/cad2d/transform.js）
//   edits.move(entities, [dx, dy])・copy(entities, [dx, dy]) → 写した図形・rotate(entities, center, angle)・remove(entities)・
//   setLayer(entities, 画層)・setText(entity, 文字)
//   history … History（undo・redo・dirty・markSaved）
//
// 図形のオブジェクトは差し替えずに中身を入れ替える（選んでいる図形・指している図形が、直した後も同じ図形を指すように）。
// 寸法の見た目は無名のブロック（*D…）にあるので、寸法を動かすときはそのブロックの図形も動かし、写すときはブロックも写す。
// 全ての図形を先に計算してから当てる（1 つでも直せなければ、何も変えない）。

import { EditError, similarity, transformEntity, editableReason } from "../formats/cad2d/transform.js";
import { History } from "./history.js";

const TEXTS = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);

/** オブジェクトの中身を入れ替える（同じオブジェクトのまま） */
function replace(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

export class DrawingEdits {
  drawing = null;

  constructor({ onChange = () => {}, limit } = {}) {
    this.history = new History({ limit, onChange: () => onChange(this) });
  }

  open(drawing) {
    this.drawing = drawing;
    this.history.clear();
  }

  /** 図形の入っているブロック */
  blockOf(entity) {
    for (const block of this.drawing?.blocks.values() ?? []) if (block.entities.includes(entity)) return block;
    return null;
  }

  /** 直せない理由（全ての図形で。最初の 1 つ） */
  reason(entities) {
    if (!entities.length) return "直す図形を選んでください";
    for (const e of entities) {
      const block = this.blockOf(e);
      if (!block || !this.drawing.layouts.some((l) => l.block === block.name)) return "この図形は直せません（ブロックの中・ビューポートの中の図形）";
      const layer = this.drawing.layers.get(e.layer);
      if (layer?.locked) return `画層「${e.layer}」はロックされています`;
      const why = editableReason(e);
      if (why) return why;
    }
    return null;
  }

  #check(entities) {
    const why = this.reason(entities);
    if (why) throw new EditError(why);
  }

  /** 寸法の見た目のブロック（寸法を動かす・写すときに一緒に） */
  #dimensionBlock(e) {
    return e.type === "DIMENSION" ? this.drawing.blocks.get(e.block) ?? null : null;
  }

  /** 図形を変換で動かす命令（移動・回転） */
  #transform(label, entities, m) {
    this.#check(entities);
    const before = entities.map((e) => ({ ...e }));
    const after = entities.map((e) => transformEntity(e, m));
    const blocks = entities.map((e) => this.#dimensionBlock(e)).filter(Boolean);
    const blockBefore = blocks.map((b) => b.entities);
    const blockAfter = blocks.map((b) => b.entities.map((child) => transformEntity(child, m)));
    this.history.run({
      label,
      apply: () => {
        entities.forEach((e, i) => replace(e, after[i]));
        blocks.forEach((b, i) => (b.entities = blockAfter[i]));
      },
      revert: () => {
        entities.forEach((e, i) => replace(e, before[i]));
        blocks.forEach((b, i) => (b.entities = blockBefore[i]));
      },
    });
  }

  move(entities, [dx, dy]) {
    this.#transform(`${entities.length} 個を動かす`, entities, similarity({ move: [dx, dy] }));
  }

  rotate(entities, center, angle) {
    this.#transform(`${entities.length} 個を回す`, entities, similarity({ angle, center }));
  }

  /** 写す（元の図形と同じブロックの最後に足す。寸法は見た目のブロックも写す） → 写した図形 */
  copy(entities, [dx, dy]) {
    this.#check(entities);
    const m = similarity({ move: [dx, dy] });
    const clearHandles = (e) => ({ ...e, handle: "", ...(e.attribs && { attribs: e.attribs.map((a) => ({ ...a, handle: "" })) }) });
    const newBlocks = [];
    const copies = entities.map((e) => {
      const out = clearHandles(transformEntity(e, m));
      const dim = this.#dimensionBlock(e);
      if (dim) {
        const name = this.#freeName("*D");
        newBlocks.push({ ...dim, name, handle: "", entities: dim.entities.map((child) => clearHandles(transformEntity(child, m))) });
        out.block = name;
      }
      return out;
    });
    const owners = entities.map((e) => this.blockOf(e));
    this.history.run({
      label: `${entities.length} 個を写す`,
      apply: () => {
        for (const b of newBlocks) this.drawing.blocks.set(b.name, b);
        copies.forEach((c, i) => owners[i].entities.push(c));
      },
      revert: () => {
        copies.forEach((c, i) => owners[i].entities.splice(owners[i].entities.indexOf(c), 1));
        for (const b of newBlocks) this.drawing.blocks.delete(b.name);
      },
    });
    return copies;
  }

  /** 消す（取り消すと元の順番の場所に戻す） */
  remove(entities) {
    this.#check(entities);
    const places = entities.map((e) => {
      const block = this.blockOf(e);
      return { e, block, index: block.entities.indexOf(e) };
    }).sort((a, b) => a.index - b.index);
    this.history.run({
      label: `${entities.length} 個を消す`,
      apply: () => {
        for (const { e, block } of places) block.entities.splice(block.entities.indexOf(e), 1);
      },
      revert: () => {
        for (const { e, block, index } of places) block.entities.splice(index, 0, e);
      },
    });
  }

  setLayer(entities, layer) {
    this.#check(entities);
    if (!this.drawing.layers.has(layer)) throw new EditError(`画層「${layer}」がありません`);
    this.#replaceEach(`画層を「${layer}」に`, entities, (e) => ({ ...e, layer }));
  }

  setText(entity, text) {
    this.#check([entity]);
    if (!TEXTS.has(entity.type)) throw new EditError("文字の図形ではありません");
    this.#replaceEach(`文字を「${text.length > 12 ? `${text.slice(0, 12)}…` : text}」に`, [entity], (e) => ({ ...e, text }));
  }

  #replaceEach(label, entities, change) {
    const before = entities.map((e) => ({ ...e }));
    const after = entities.map(change);
    this.history.run({
      label,
      apply: () => entities.forEach((e, i) => replace(e, after[i])),
      revert: () => entities.forEach((e, i) => replace(e, before[i])),
    });
  }

  /** 使われていないブロックの名前（*D1・*D2 …） */
  #freeName(prefix) {
    const used = new Set([...this.drawing.blocks.keys()].map((n) => n.toLowerCase()));
    let n = 1;
    while (used.has(`${prefix}${n}`.toLowerCase())) n++;
    return `${prefix}${n}`;
  }
}
