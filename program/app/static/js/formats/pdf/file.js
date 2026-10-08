// PDF のファイルの構造（ISO 32000-1 の 7.5・7.7）: 相互参照（表・ストリーム・増分の更新・ハイブリッド）・オブジェクトのストリーム・
// 間接オブジェクトの読み出し・ページの木（受け継ぐ値）・ページの番号の名前（/PageLabels）・画層（任意の内容の群 OCG）。
// 相互参照が壊れていれば、ファイルを頭から走査して「n g obj」を集め直す（PDF の読み手が普通にする修理）。

import { decodeStream } from "./filters.js";
import { Lexer, PdfError, PdfName, PdfOp, PdfRef, PdfStream, PdfString, latin1, parseValue } from "./objects.js";

const tail = (bytes, n) => latin1(bytes, Math.max(0, bytes.length - n));

export class PdfFile {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
    const at = head.indexOf("%PDF-");
    if (at < 0) throw new PdfError("PDF ではありません（先頭に %PDF- がありません）。");
    this.version = head.slice(at + 5, at + 8);
    this.entries = new Map(); // 番号 → { offset, gen } | { stream, index }
    this.cache = new Map();
    this.objectStreams = new Map();
    this.repaired = false;
    try {
      this.trailer = this.#readXrefChain();
      if (!this.trailer.has("Root") || !this.#looksValid()) throw new Error("相互参照が合わない");
    } catch {
      this.#reconstruct();
    }
    if (this.trailer.has("Encrypt")) throw new PdfError("暗号化された（パスワードで保護された）PDF は、まだ開けません。保護を外して保存し直してください。");
    this.catalog = this.get(this.trailer.get("Root"));
    if (!(this.catalog instanceof Map)) throw new PdfError("PDF の目次（カタログ）が読めません。");
  }

  // ---- 値 ----------------------------------------------------------------------------------------------------------
  /** 参照なら指す値に（何度でも同じオブジェクトを返す）。参照でなければそのまま */
  get(v) {
    if (!(v instanceof PdfRef)) return v;
    if (this.cache.has(v.num)) return this.cache.get(v.num);
    this.cache.set(v.num, null); // 自分を指す参照の輪を断つ
    let value = null;
    try {
      value = this.#load(v.num);
    } catch {
      value = null;
    }
    this.cache.set(v.num, value);
    return value;
  }

  /** 辞書の値（参照を解く） */
  value(dict, key, fallback = undefined) {
    if (!(dict instanceof Map)) return fallback;
    const v = this.get(dict.get(key));
    return v === undefined || v === null ? fallback : v;
  }

  /** 名前の値 → 文字列 */
  name(dict, key) {
    const v = this.value(dict, key);
    return v instanceof PdfName ? v.name : null;
  }

  /** 数の配列 */
  numbers(dict, key) {
    const v = this.value(dict, key);
    return Array.isArray(v) ? v.map((x) => this.get(x)).map(Number) : null;
  }

  /** ストリームの中身を解く（画像の符号化は解かずに返す） */
  stream(stream) {
    stream = this.get(stream);
    if (!(stream instanceof PdfStream)) return null;
    if (!stream.decoded) stream.decoded = decodeStream(stream.data, stream.dict, (v) => this.get(v));
    return stream.decoded;
  }

  /** ストリームの中身（解いたバイト列）。読めなければ null */
  bytesOf(stream) {
    try {
      return this.stream(stream)?.data ?? null;
    } catch {
      return null;
    }
  }

  // ---- 相互参照 ----------------------------------------------------------------------------------------------------
  #readXrefChain() {
    const end = tail(this.bytes, 4096);
    const at = end.lastIndexOf("startxref");
    if (at < 0) throw new Error("startxref が無い");
    let offset = parseInt(end.slice(at + 9).trim(), 10);
    let trailer = null;
    const seen = new Set();
    while (Number.isFinite(offset) && !seen.has(offset)) {
      seen.add(offset);
      const t = this.#readXref(offset);
      if (!trailer) trailer = t;
      const stm = t.get("XRefStm"); // ハイブリッド: 表に無い番号をストリームから
      if (typeof stm === "number" && !seen.has(stm)) {
        seen.add(stm);
        this.#readXref(stm);
      }
      offset = t.get("Prev");
    }
    if (!trailer) throw new Error("相互参照が無い");
    return trailer;
  }

  /** offset の相互参照（表かストリーム）を読み、まだ無い番号を足して、その trailer の辞書を返す */
  #readXref(offset) {
    const lexer = new Lexer(this.bytes, offset);
    const first = lexer.next();
    if (first instanceof PdfOp && first.op === "xref") return this.#readTable(lexer);
    // 相互参照のストリーム（PDF 1.5+）
    lexer.pos = offset;
    const obj = this.#parseIndirect(lexer);
    if (!(obj instanceof PdfStream)) throw new Error("相互参照のストリームでない");
    const dict = obj.dict;
    const data = decodeStream(obj.data, dict, (v) => this.get(v)).data;
    const w = dict.get("W").map(Number);
    const size = dict.get("Size") ?? 0;
    const index = dict.get("Index") ?? [0, size];
    const rowLength = w[0] + w[1] + w[2];
    let row = 0;
    const field = (at, width) => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + data[at + i];
      return v;
    };
    for (let k = 0; k + 1 < index.length; k += 2) {
      for (let i = 0; i < index[k + 1]; i++, row++) {
        const at = row * rowLength;
        if (at + rowLength > data.length) break;
        const type = w[0] ? field(at, w[0]) : 1;
        const a = field(at + w[0], w[1]), b = field(at + w[0] + w[1], w[2]);
        const num = index[k] + i;
        if (this.entries.has(num)) continue;
        if (type === 1) this.entries.set(num, { offset: a, gen: b });
        else if (type === 2) this.entries.set(num, { stream: a, index: b });
        else this.entries.set(num, { free: true });
      }
    }
    return dict;
  }

  #readTable(lexer) {
    for (;;) {
      const start = lexer.next();
      if (start instanceof PdfOp && start.op === "trailer") break;
      const count = lexer.next();
      if (typeof start !== "number" || typeof count !== "number") throw new Error("相互参照の表が崩れている");
      for (let i = 0; i < count; i++) {
        const offset = lexer.next(), gen = lexer.next(), kind = lexer.next();
        const num = start + i;
        if (this.entries.has(num)) continue;
        if (kind instanceof PdfOp && kind.op === "n") this.entries.set(num, { offset, gen });
        else this.entries.set(num, { free: true });
      }
    }
    const trailer = parseValue(lexer);
    if (!(trailer instanceof Map)) throw new Error("trailer が無い");
    return trailer;
  }

  /** 相互参照の位置が「n g obj」を指しているか（いくつかを確かめる） */
  #looksValid() {
    let checked = 0;
    for (const [num, e] of this.entries) {
      if (e.offset === undefined || e.offset === 0) continue;
      const lexer = new Lexer(this.bytes, e.offset);
      if (lexer.next() !== num) return false;
      if (++checked >= 5) break;
    }
    return true;
  }

  /** 相互参照を使わず、ファイルを走査して作り直す */
  #reconstruct() {
    this.repaired = true;
    this.entries.clear();
    this.cache.clear();
    const text = latin1(this.bytes);
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) this.entries.set(Number(m[1]), { offset: m.index, gen: Number(m[2]) }); // 後のもの（更新）で上書き
    // trailer: 最後の trailer の辞書。無ければ相互参照のストリームの辞書
    let trailer = new Map();
    for (let at = text.lastIndexOf("trailer"); at >= 0; at = text.lastIndexOf("trailer", at - 1)) {
      const t = parseValue(new Lexer(this.bytes, at + 7));
      if (t instanceof Map && t.has("Root")) {
        trailer = t;
        break;
      }
    }
    // オブジェクトのストリームの中身も番号に加える
    for (const [num, e] of [...this.entries]) {
      if (e.offset === undefined) continue;
      try {
        const obj = this.#parseIndirect(new Lexer(this.bytes, e.offset));
        if (!(obj instanceof PdfStream)) continue;
        const type = obj.dict.get("Type")?.name;
        if (type === "XRef" && !trailer.has("Root")) trailer = obj.dict;
        if (type === "ObjStm") {
          for (const [n, index] of this.#objectStreamIndex(num, obj)) if (!this.entries.has(n) || this.entries.get(n).stream !== undefined) this.entries.set(n, { stream: num, index });
        }
      } catch {
        // 読めないオブジェクトは飛ばす
      }
    }
    if (!trailer.has("Root")) {
      for (const [num] of this.entries) {
        const v = this.get(new PdfRef(num, 0));
        if (v instanceof Map && v.get("Type")?.name === "Catalog") {
          trailer.set("Root", new PdfRef(num, 0));
          break;
        }
      }
    }
    if (!trailer.has("Root")) throw new PdfError("PDF の構造が壊れていて、ページを見つけられません。");
    this.trailer = trailer;
  }

  // ---- 間接オブジェクト --------------------------------------------------------------------------------------------
  #load(num) {
    const e = this.entries.get(num);
    if (!e || e.free) return null;
    if (e.stream !== undefined) return this.#fromObjectStream(e.stream, e.index, num);
    return this.#parseIndirect(new Lexer(this.bytes, e.offset));
  }

  /** 「n g obj 値 [stream … endstream] endobj」を読む */
  #parseIndirect(lexer) {
    const num = lexer.next(), gen = lexer.next(), kw = lexer.next();
    if (typeof num !== "number" || typeof gen !== "number" || !(kw instanceof PdfOp && kw.op === "obj")) throw new Error("間接オブジェクトでない");
    const value = parseValue(lexer);
    if (!(value instanceof Map)) return value;
    const save = lexer.pos;
    const next = lexer.next();
    if (!(next instanceof PdfOp && next.op === "stream")) {
      lexer.pos = save;
      return value;
    }
    // stream の後の行の終わり（CRLF か LF。CR だけの崩れも許す）
    let start = lexer.pos;
    if (this.bytes[start] === 0x0d) start++;
    if (this.bytes[start] === 0x0a) start++;
    let length = this.get(value.get("Length"));
    const endsAt = (pos) => /^\s*endstream/.test(latin1(this.bytes, pos, Math.min(this.bytes.length, pos + 32)));
    if (!(typeof length === "number" && length >= 0 && start + length <= this.bytes.length && endsAt(start + length))) {
      // 長さが合わない: endstream を探す
      const text = latin1(this.bytes, start, Math.min(this.bytes.length, start + (typeof length === "number" ? length + 65536 : 1 << 26)));
      let at = text.indexOf("endstream");
      if (at < 0) at = text.length;
      length = at;
      while (length > 0 && (this.bytes[start + length - 1] === 0x0a || this.bytes[start + length - 1] === 0x0d)) length--;
    }
    return new PdfStream(value, this.bytes.subarray(start, start + length));
  }

  /** オブジェクトのストリーム: [[番号, その中の何番目か]] */
  #objectStreamIndex(num, stream) {
    const n = this.get(stream.dict.get("N")) ?? 0;
    const data = decodeStream(stream.data, stream.dict, (v) => this.get(v)).data;
    const lexer = new Lexer(data);
    const out = [];
    for (let i = 0; i < n; i++) {
      const objNum = lexer.next(), offset = lexer.next();
      if (typeof objNum !== "number" || typeof offset !== "number") break;
      out.push([objNum, i]);
    }
    return out;
  }

  #fromObjectStream(streamNum, index, num) {
    let os = this.objectStreams.get(streamNum);
    if (!os) {
      const stream = this.get(new PdfRef(streamNum, 0));
      if (!(stream instanceof PdfStream)) return null;
      const data = decodeStream(stream.data, stream.dict, (v) => this.get(v)).data;
      const n = this.get(stream.dict.get("N")) ?? 0, first = this.get(stream.dict.get("First")) ?? 0;
      const lexer = new Lexer(data);
      const offsets = new Map();
      const order = [];
      for (let i = 0; i < n; i++) {
        const objNum = lexer.next(), offset = lexer.next();
        if (typeof objNum !== "number" || typeof offset !== "number") break;
        offsets.set(objNum, first + offset);
        order.push(first + offset);
      }
      os = { data, offsets, order };
      this.objectStreams.set(streamNum, os);
    }
    const at = os.offsets.get(num) ?? os.order[index];
    if (at === undefined) return null;
    return parseValue(new Lexer(os.data, at));
  }

  // ---- ページ ------------------------------------------------------------------------------------------------------
  /** ページの並び: [{ dict, resources, mediaBox, cropBox, rotate, label }]（受け継ぐ値を解いたもの） */
  pages() {
    const out = [];
    const seen = new Set();
    const walk = (node, inherited) => {
      node = this.get(node);
      if (!(node instanceof Map) || seen.has(node)) return;
      seen.add(node);
      const own = {
        resources: this.value(node, "Resources") ?? inherited.resources,
        mediaBox: this.numbers(node, "MediaBox") ?? inherited.mediaBox,
        cropBox: this.numbers(node, "CropBox") ?? inherited.cropBox,
        rotate: this.value(node, "Rotate") ?? inherited.rotate,
      };
      const kids = this.value(node, "Kids");
      if (Array.isArray(kids) && this.name(node, "Type") !== "Page") for (const k of kids) walk(k, own);
      else out.push({ dict: node, ...own });
    };
    walk(this.catalog.get("Pages"), { resources: null, mediaBox: [0, 0, 612, 792], cropBox: null, rotate: 0 });
    const labels = this.#pageLabels(out.length);
    out.forEach((p, i) => (p.label = labels[i]));
    return out;
  }

  /** ページの番号の名前（/PageLabels の数の木。無ければ 1, 2, …） */
  #pageLabels(count) {
    const out = Array.from({ length: count }, (_, i) => String(i + 1));
    const root = this.value(this.catalog, "PageLabels");
    if (!(root instanceof Map)) return out;
    const nums = [];
    const walk = (node, depth = 0) => {
      node = this.get(node);
      if (!(node instanceof Map) || depth > 32) return;
      const pairs = this.value(node, "Nums");
      if (Array.isArray(pairs)) for (let i = 0; i + 1 < pairs.length; i += 2) nums.push([this.get(pairs[i]), this.get(pairs[i + 1])]);
      for (const kid of this.value(node, "Kids") ?? []) walk(kid, depth + 1);
    };
    walk(root);
    nums.sort((a, b) => a[0] - b[0]);
    nums.forEach(([start, label], k) => {
      if (!(label instanceof Map)) return;
      const end = k + 1 < nums.length ? nums[k + 1][0] : count;
      const style = this.name(label, "S");
      const prefix = this.value(label, "P") instanceof PdfString ? this.value(label, "P").text() : "";
      const first = this.value(label, "St") ?? 1;
      for (let i = start; i < Math.min(end, count); i++) out[i] = prefix + formatLabel(style, first + i - start);
    });
    return out;
  }

  // ---- 画層（任意の内容） ------------------------------------------------------------------------------------------
  /** 画層: Map<OCG の辞書, { name, on }>（並びは /Order に従う。/D の既定の見え方） */
  layers() {
    const props = this.value(this.catalog, "OCProperties");
    const out = new Map();
    if (!(props instanceof Map)) return out;
    const config = this.value(props, "D");
    const off = new Set((this.value(config, "OFF") ?? []).map((r) => this.get(r)));
    const on = new Set((this.value(config, "ON") ?? []).map((r) => this.get(r)));
    const baseOff = this.name(config, "BaseState") === "OFF";
    const add = (ref) => {
      const ocg = this.get(ref);
      if (!(ocg instanceof Map) || out.has(ocg)) return;
      const name = this.value(ocg, "Name");
      out.set(ocg, { name: name instanceof PdfString ? name.text() : `画層 ${out.size + 1}`, on: baseOff ? on.has(ocg) : !off.has(ocg) });
    };
    // /Order の順（入れ子は平らに）→ 残りは /OCGs の順
    const order = (list, depth = 0) => {
      for (const item of this.get(list) ?? []) {
        const v = this.get(item);
        if (Array.isArray(v) && depth < 16) order(v, depth + 1);
        else if (v instanceof Map) add(item);
      }
    };
    if (config) order(this.value(config, "Order") ?? []);
    for (const ref of this.value(props, "OCGs") ?? []) add(ref);
    return out;
  }
}

/** ページの番号の書き方（D = 1, 2・R = I, II・r = i, ii・A = A..Z, AA・a） */
function formatLabel(style, n) {
  switch (style) {
    case "D": return String(n);
    case "R": return roman(n);
    case "r": return roman(n).toLowerCase();
    case "A": return letters(n);
    case "a": return letters(n).toLowerCase();
    default: return "";
  }
}
function roman(n) {
  const table = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of table) while (n >= v) (s += r), (n -= v);
  return s;
}
const letters = (n) => String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
