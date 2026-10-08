// PDF の値と字句（ISO 32000-1 の 7.2・7.3）。ファイルの値（辞書・配列・名前・文字列・数・参照・ストリーム）と、
// 内容ストリームの演算子を、同じ字句の読み手で読む。
//
//   値: 数（number）・真偽（boolean）・null・名前（PdfName。同じ名前は同じもの）・文字列（PdfString。バイト列のまま）・
//       配列（Array）・辞書（Map<名前の文字列, 値>）・参照（PdfRef）・ストリーム（PdfStream: 辞書と、符号化されたままのバイト列）
//   演算子（内容ストリーム）・キーワード（obj・R など）は PdfOp

/** 読めない PDF（利用者に見せる説明を持つ） */
export class PdfError extends Error {}

export class PdfName {
  constructor(name) {
    this.name = name;
  }
  toString() {
    return this.name;
  }
}
const NAMES = new Map();
/** 名前（同じ綴りは同じオブジェクト） */
export function pdfName(name) {
  let n = NAMES.get(name);
  if (!n) NAMES.set(name, (n = new PdfName(name)));
  return n;
}

export class PdfRef {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

export class PdfString {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
  }
  /** 文字の文字列（UTF-16BE の BOM・UTF-8 の BOM・それ以外は PDFDocEncoding） */
  text() {
    return textString(this.bytes);
  }
}

export class PdfStream {
  /** @param {Map} dict @param {Uint8Array} data 符号化されたままの中身 */
  constructor(dict, data) {
    this.dict = dict;
    this.data = data;
  }
}

export class PdfOp {
  constructor(op) {
    this.op = op;
  }
}
const OPS = new Map();
const pdfOp = (op) => {
  let o = OPS.get(op);
  if (!o) OPS.set(op, (o = new PdfOp(op)));
  return o;
};

// 区切り（字句の境目）: 空白 0・9・10・12・13・32 と ( ) < > [ ] { } / %
const WHITE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const isRegular = (c) => !WHITE[c] && !DELIM[c];
const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) HEX["0123456789abcdef".charCodeAt(i)] = HEX["0123456789ABCDEF".charCodeAt(i)] = i;

// 字句の印（配列・辞書の始め・終わり）
export const ARRAY_START = { mark: "[" }, ARRAY_END = { mark: "]" }, DICT_START = { mark: "<<" }, DICT_END = { mark: ">>" };
const BRACE_START = { mark: "{" }, BRACE_END = { mark: "}" };
export const EOF = { mark: "EOF" };

/** 字句の読み手 */
export class Lexer {
  /** @param {Uint8Array} bytes */
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  skipSpace() {
    const b = this.bytes;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WHITE[c]) this.pos++;
      else if (c === 0x25) { // % 注記: 行の終わりまで
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** 次の字句（数・名前・文字列・印・演算子） */
  next() {
    this.skipSpace();
    if (this.pos >= this.end) return EOF;
    const b = this.bytes;
    const c = b[this.pos];
    switch (c) {
      case 0x2f: return this.#name(); // /
      case 0x28: return this.#literal(); // (
      case 0x5b: this.pos++; return ARRAY_START;
      case 0x5d: this.pos++; return ARRAY_END;
      case 0x7b: this.pos++; return BRACE_START;
      case 0x7d: this.pos++; return BRACE_END;
      case 0x3c: // < または <<
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return DICT_START;
        }
        return this.#hex();
      case 0x3e: // >>（単独の > は読み飛ばす）
        this.pos += b[this.pos + 1] === 0x3e ? 2 : 1;
        return DICT_END;
      case 0x29: // 対の無い ) は読み飛ばす
        this.pos++;
        return this.next();
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return this.#number();
    const start = this.pos;
    while (this.pos < this.end && isRegular(b[this.pos])) this.pos++;
    if (this.pos === start) {
      this.pos++; // 読めない 1 バイト
      return this.next();
    }
    return pdfOp(latin1(b, start, this.pos));
  }

  #number() {
    const b = this.bytes;
    const start = this.pos;
    let sign = 1, value = 0, frac = 0, scale = 1, digits = 0;
    // 符号（"--5"・"+-5" のような崩れも読む）
    while (b[this.pos] === 0x2b || b[this.pos] === 0x2d) {
      if (b[this.pos] === 0x2d) sign = -sign;
      this.pos++;
    }
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (c >= 0x30 && c <= 0x39) {
        if (frac) {
          scale /= 10;
          value += (c - 0x30) * scale;
        } else value = value * 10 + (c - 0x30);
        digits++;
        this.pos++;
      } else if (c === 0x2e && !frac) {
        frac = 1;
        this.pos++;
      } else if (c === 0x2d && digits) this.pos++; // "5-" のような崩れ: 読み飛ばす
      else break;
    }
    if (!digits && this.pos === start + 1 && !isRegular(b[this.pos] ?? 32)) return 0;
    if (!digits && isRegular(b[this.pos] ?? 32)) {
      // 数でなかった（"-a" など）: 演算子として読む
      while (this.pos < this.end && isRegular(b[this.pos])) this.pos++;
      return pdfOp(latin1(b, start, this.pos));
    }
    return sign * value;
  }

  #name() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    while (this.pos < this.end && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && HEX[b[this.pos + 1]] >= 0 && HEX[b[this.pos + 2]] >= 0) { // #xx
        out.push(HEX[b[this.pos + 1]] * 16 + HEX[b[this.pos + 2]]);
        this.pos += 3;
      } else {
        out.push(c);
        this.pos++;
      }
    }
    return pdfName(String.fromCharCode(...out));
  }

  #literal() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < this.end) {
      let c = b[this.pos++];
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        if (--depth === 0) break;
      } else if (c === 0x5c) { // \
        c = b[this.pos++];
        switch (c) {
          case 0x6e: c = 10; break; // n
          case 0x72: c = 13; break; // r
          case 0x74: c = 9; break; // t
          case 0x62: c = 8; break; // b
          case 0x66: c = 12; break; // f
          case 0x0d: // 行の続き（\ と行の終わり）
            if (b[this.pos] === 0x0a) this.pos++;
            continue;
          case 0x0a: continue;
          default:
            if (c >= 0x30 && c <= 0x37) { // 8 進 1〜3 桁
              let v = c - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
              c = v & 0xff;
            }
        }
      } else if (c === 0x0d) { // 逃がしの無い行の終わりは LF 1 つ
        if (b[this.pos] === 0x0a) this.pos++;
        c = 0x0a;
      }
      out.push(c);
    }
    return new PdfString(Uint8Array.from(out));
  }

  #hex() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    let hi = -1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = HEX[c];
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return new PdfString(Uint8Array.from(out));
  }
}

/** バイト列の一部 → 文字列（1 バイト 1 文字） */
export function latin1(bytes, start = 0, end = bytes.length) {
  let s = "";
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  return s;
}

/**
 * 値を 1 つ読む（ファイルの値。refs = true なら「数 数 R」を参照にする）。
 * 内容ストリームでは演算子（PdfOp）もそのまま返す。
 */
export function parseValue(lexer, refs = true, token = lexer.next()) {
  if (typeof token === "number") {
    if (!refs || !Number.isInteger(token) || token < 0) return token;
    // 「数 数 R」か（先を見て、違えば戻す）
    const save = lexer.pos;
    const gen = lexer.next();
    if (typeof gen === "number" && Number.isInteger(gen) && gen >= 0) {
      const r = lexer.next();
      if (r instanceof PdfOp && r.op === "R") return new PdfRef(token, gen);
    }
    lexer.pos = save;
    return token;
  }
  if (token === ARRAY_START) {
    const out = [];
    for (;;) {
      const t = lexer.next();
      if (t === ARRAY_END || t === EOF) return out;
      if (t === DICT_END) continue;
      out.push(parseValue(lexer, refs, t));
    }
  }
  if (token === DICT_START) return parseDict(lexer, refs);
  if (token instanceof PdfOp) {
    switch (token.op) {
      case "true": return true;
      case "false": return false;
      case "null": return null;
    }
  }
  return token;
}

/** 辞書（<< の後から >> まで） */
export function parseDict(lexer, refs = true) {
  const dict = new Map();
  for (;;) {
    const t = lexer.next();
    if (t === DICT_END || t === EOF) return dict;
    if (!(t instanceof PdfName)) continue; // 崩れた辞書: 名前でない値は読み飛ばす
    const v = lexer.next();
    if (v === DICT_END || v === EOF) return dict; // 値の無い最後の名前
    dict.set(t.name, parseValue(lexer, refs, v));
  }
}

// ---- 文字の文字列 ---------------------------------------------------------------------------------------------------
// PDFDocEncoding の 0x18〜0x1F・0x80〜0xAD（Latin-1 と違う所だけ。ISO 32000-1 の付録 D）
const PDF_DOC = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
};
const utf16 = new TextDecoder("utf-16be");
const utf8 = new TextDecoder("utf-8");

/** 文字の文字列のバイト列 → 文字列 */
export function textString(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16.decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8.decode(bytes.subarray(3));
  let s = "";
  for (const c of bytes) s += String.fromCharCode(PDF_DOC[c] ?? c);
  return s;
}
