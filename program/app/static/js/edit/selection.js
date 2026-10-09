// 選んでいるもの（2D の図形・3D の部品で共用）。中身は見分ける値（2D は scene.items の番号、3D は部品の key）の集まり。
// 変わったときだけ onChange を呼ぶ（強調表示と右の欄の描き直し）。

export class Selection {
  #items = new Set();

  /** @param {{ onChange?: (selection: Selection) => void }} options */
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
  }

  #replace(next) {
    const same = next.size === this.#items.size && [...next].every((id) => this.#items.has(id));
    if (same) return false;
    this.#items = next;
    this.onChange(this);
    return true;
  }

  /** 選び直す（クリック）。空の列で何も選ばない */
  set(ids) { return this.#replace(new Set(ids)); }
  /** 足す（Shift ＋クリック・枠で囲む） */
  add(ids) { return this.#replace(new Set([...this.#items, ...ids])); }
  /** 選んでいれば外し、いなければ足す（Ctrl ＋クリック） */
  toggle(id) {
    const next = new Set(this.#items);
    if (!next.delete(id)) next.add(id);
    return this.#replace(next);
  }
  clear() { return this.#replace(new Set()); }

  has(id) { return this.#items.has(id); }
  get size() { return this.#items.size; }
  /** 選んだ順の列 */
  get items() { return [...this.#items]; }
}
