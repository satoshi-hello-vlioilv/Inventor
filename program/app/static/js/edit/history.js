// 編集の取り消し・やり直し（2D の図面・3D の変換データで共用）。
// 編集は命令 { label, apply(), revert(), key? } で表し、run で行う。run・undo・redo のたびに onChange を呼ぶ（ボタンの状態・表示の描き直し）。
//   key … 同じものを続けて直す（数の欄に打ち続ける・ドラッグで動かし続ける）とき、merge: true で 1 つの取り消しにまとめるための名前
// 保存した時点を覚え（markSaved）、そこから変わったか（dirty）を答える（閉じる前の確かめ・見出しの「変更あり」に使う）。

export class History {
  #done = [];
  #undone = [];
  #saved = 0; // 保存した時点の「行った数」（取り消しで戻れば、また保存したときと同じ）
  #serial = 0; // 命令の通し番号（保存した時点の命令を見分ける）
  #savedSerial = 0;

  /** @param {{ limit?: number, onChange?: (history: History) => void }} options  limit … 覚える数（古いものから忘れる） */
  constructor({ limit = 200, onChange = () => {} } = {}) {
    this.limit = limit;
    this.onChange = onChange;
  }

  /**
   * 命令を行い、取り消せるように覚える（やり直しの列は消える）。
   * @param {{ label: string, apply: () => void, revert: () => void, key?: string }} command
   * @param {{ merge?: boolean }} options  merge … 直前の命令と key が同じなら 1 つにまとめる（取り消すと、まとめた全てを戻す）
   */
  run(command, { merge = false } = {}) {
    command.apply();
    const last = this.#done.at(-1);
    if (merge && last && command.key !== undefined && last.key === command.key && last.serial !== this.#savedSerial) {
      this.#done[this.#done.length - 1] = { ...command, revert: last.revert, serial: last.serial };
    } else {
      this.#done.push({ ...command, serial: ++this.#serial });
      if (this.#done.length > this.limit) {
        this.#done.shift();
        this.#saved--;
      }
    }
    this.#undone = [];
    this.onChange(this);
  }

  undo() {
    const command = this.#done.pop();
    if (!command) return false;
    command.revert();
    this.#undone.push(command);
    this.onChange(this);
    return true;
  }

  redo() {
    const command = this.#undone.pop();
    if (!command) return false;
    command.apply();
    this.#done.push(command);
    this.onChange(this);
    return true;
  }

  /** 覚えた命令を全て忘れる（別のファイルを開いたとき） */
  clear() {
    this.#done = [];
    this.#undone = [];
    this.#saved = 0;
    this.#savedSerial = 0;
    this.onChange(this);
  }

  /** いまを保存した時点とする */
  markSaved() {
    this.#saved = this.#done.length;
    this.#savedSerial = this.#done.at(-1)?.serial ?? 0;
    this.onChange(this);
  }

  get canUndo() { return this.#done.length > 0; }
  get canRedo() { return this.#undone.length > 0; }
  /** 取り消す・やり直す命令の名前（ボタンの説明に「元に戻す: 長さを 20 に」と出す） */
  get undoLabel() { return this.#done.at(-1)?.label ?? null; }
  get redoLabel() { return this.#undone.at(-1)?.label ?? null; }
  /** 保存した時点から変わったか */
  get dirty() { return this.#done.length !== this.#saved || (this.#done.at(-1)?.serial ?? 0) !== this.#savedSerial; }
}
