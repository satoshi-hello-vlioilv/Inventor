// STEP（ISO 10303-21）のテキストを読む。レコード番号 → エンティティ の表にする（意味づけは brep.js・assembly.js）。
//   値の表し方: 数値 → number / 文字列 → string / 参照 #n → { ref: n } / 列挙 .T. → { enum: "T" }
//              リスト → 配列 / $（なし）→ null / *（派生値）→ undefined / 型付きの値 LENGTH_MEASURE(1.) → { type, args }
//   エンティティ: { id, type, args }。複合エンティティ（(A(…)B(…))）は { id, type: "", parts: [{ type, args }] }

export class StepError extends Error {}

/** 文字列の中の制御記号を復号する（\X2\…\X0\ は UTF-16、\X4\ は UTF-32、\X\hh は ISO 8859-1、\S\c は上位 128 文字）。 */
export function decodeString(raw) {
  let s = raw.replace(/''/g, "'").replace(/[\r\n]/g, ""); // 行の折り返しは文字列の一部ではない
  s = s.replace(/\\X2\\((?:[0-9A-Fa-f]{4})*)\\X0\\/g, (_, h) => decodeHex(h, 4));
  s = s.replace(/\\X4\\((?:[0-9A-Fa-f]{8})*)\\X0\\/g, (_, h) => decodeHex(h, 8));
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
  return s.replace(/\\\\/g, "\\");
}

function decodeHex(hex, width) {
  let out = "";
  for (let i = 0; i < hex.length; i += width) out += String.fromCodePoint(parseInt(hex.slice(i, i + width), 16));
  return out;
}

/** 字句と構文を 1 回の走査で読む。 */
class Reader {
  constructor(text, pos) {
    this.text = text;
    this.pos = pos;
  }

  skip() {
    const t = this.text;
    for (;;) {
      const c = t.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.pos++;
      else if (c === 47 && t.charCodeAt(this.pos + 1) === 42) { // /* … */
        const end = t.indexOf("*/", this.pos + 2);
        if (end < 0) throw new StepError("コメントが閉じていません");
        this.pos = end + 2;
      } else return;
    }
  }

  peek() {
    this.skip();
    return this.text[this.pos];
  }

  expect(ch) {
    if (this.peek() !== ch) throw new StepError(`「${ch}」がありません（位置 ${this.pos}）`);
    this.pos++;
  }

  keyword() {
    this.skip();
    const m = /[A-Za-z_][A-Za-z0-9_-]*/y;
    m.lastIndex = this.pos;
    const r = m.exec(this.text);
    if (!r) throw new StepError(`名前がありません（位置 ${this.pos}）`);
    this.pos = m.lastIndex;
    return r[0].toUpperCase();
  }

  /** 1 つの値 */
  value() {
    const c = this.peek();
    const t = this.text;
    if (c === "(") return this.list();
    if (c === "'") {
      let i = this.pos + 1;
      for (;;) {
        const j = t.indexOf("'", i);
        if (j < 0) throw new StepError("文字列が閉じていません");
        if (t[j + 1] === "'") { i = j + 2; continue; }
        const raw = t.slice(this.pos + 1, j);
        this.pos = j + 1;
        return decodeString(raw);
      }
    }
    if (c === "#") {
      const m = /#(\d+)/y;
      m.lastIndex = this.pos;
      const r = m.exec(t);
      this.pos = m.lastIndex;
      return { ref: Number(r[1]) };
    }
    if (c === ".") {
      const end = t.indexOf(".", this.pos + 1);
      const name = t.slice(this.pos + 1, end);
      this.pos = end + 1;
      return { enum: name };
    }
    if (c === "$") { this.pos++; return null; }
    if (c === "*") { this.pos++; return undefined; }
    if (c === '"') { // バイナリ（16 進）。形状には使われないので文字列のまま持つ
      const end = t.indexOf('"', this.pos + 1);
      const raw = t.slice(this.pos + 1, end);
      this.pos = end + 1;
      return { binary: raw };
    }
    if (c === "-" || c === "+" || (c >= "0" && c <= "9")) {
      const m = /[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?/y;
      m.lastIndex = this.pos;
      const r = m.exec(t);
      this.pos = m.lastIndex;
      return Number(r[0]);
    }
    // 型付きの値 NAME(…)
    const type = this.keyword();
    return { type, args: this.list() };
  }

  list() {
    this.expect("(");
    const out = [];
    if (this.peek() === ")") { this.pos++; return out; }
    for (;;) {
      out.push(this.value());
      const c = this.peek();
      this.pos++;
      if (c === ")") return out;
      if (c !== ",") throw new StepError(`「,」か「)」がありません（位置 ${this.pos - 1}）`);
    }
  }

  /** #n = … ; の右辺 */
  entity(id) {
    if (this.peek() === "(") { // 複合エンティティ
      this.pos++;
      const parts = [];
      while (this.peek() !== ")") parts.push({ type: this.keyword(), args: this.list() });
      this.pos++;
      return { id, type: "", parts };
    }
    return { id, type: this.keyword(), args: this.list() };
  }
}

/** 見出し部（HEADER）の値 */
function readHeader(text) {
  const start = text.indexOf("HEADER;"), end = text.indexOf("ENDSEC;", start);
  const header = {};
  if (start < 0 || end < 0) return header;
  const r = new Reader(text.slice(start + 7, end), 0);
  while (r.peek() !== undefined) {
    const name = r.keyword();
    const args = r.list();
    r.expect(";");
    if (name === "FILE_NAME") {
      const [fileName, timeStamp, author, organization, preprocessor, system] = args;
      Object.assign(header, { name: fileName, time: timeStamp, author: author?.filter(Boolean).join(", ") ?? "", organization: organization?.filter(Boolean).join(", ") ?? "", preprocessor, system });
    } else if (name === "FILE_SCHEMA") header.schema = (args[0] ?? []).join(", ");
    else if (name === "FILE_DESCRIPTION") header.description = (args[0] ?? []).filter(Boolean).join(" ");
  }
  return header;
}

/**
 * @param {string} text  STEP ファイルの中身
 * @returns {{ header: object, records: Map<number, object>, get: (v) => object|null }}
 */
export function parseStep(text) {
  if (!/^\s*ISO-10303-21\s*;/.test(text)) throw new StepError("STEP（ISO-10303-21）のファイルではありません");
  const data = text.indexOf("DATA;");
  if (data < 0) throw new StepError("DATA 部がありません");
  const header = readHeader(text);
  const records = new Map();
  const r = new Reader(text, data + 5);
  for (;;) {
    const c = r.peek();
    if (c === undefined) throw new StepError("DATA 部が閉じていません");
    if (c !== "#") {
      const word = r.keyword();
      if (word === "ENDSEC") break;
      throw new StepError(`DATA 部に想定外の「${word}」があります`);
    }
    const id = r.value().ref;
    r.expect("=");
    records.set(id, r.entity(id));
    r.expect(";");
  }
  return {
    header,
    records,
    /** 参照 { ref } または番号からエンティティを返す */
    get: (v) => records.get(typeof v === "number" ? v : v?.ref) ?? null,
  };
}

/** エンティティ（単純・複合）から、指定した型の引数を取り出す。無ければ null */
export function argsOf(entity, type) {
  if (!entity) return null;
  if (entity.type === type) return entity.args;
  return entity.parts?.find((p) => p.type === type)?.args ?? null;
}

/** エンティティがその型（複合なら構成要素のいずれか）か */
export const isType = (entity, type) => Boolean(entity) && (entity.type === type || Boolean(entity.parts?.some((p) => p.type === type)));
