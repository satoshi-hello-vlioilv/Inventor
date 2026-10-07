// DWG のビット列の読み取り（Open Design Specification for .dwg files の 2 章「BIT CODES AND DATA DEFINITIONS」）。
// DWG のオブジェクトは 1 ビット単位で詰めて書かれる。位置はビットで持つ（バイトの境目に揃っていないことが多い）。
//   B・BB・3B・BS・BL・BLL・BD・DD・RC・RS・RL・RD・MC・MS・H・T/TU/TV・BE・BT・CMC・ENC・OT
// 版で変わる読み方（R2000 の BE・BT、R2004 の CMC・ENC、R2007 の文字列、R2010 の OT）は version（1015 など）で切り替える。

export class DwgError extends Error {}

export const R13 = 1012, R14 = 1014, R2000 = 1015, R2004 = 1018, R2007 = 1021, R2010 = 1024, R2013 = 1027, R2018 = 1032;

const scratch = new DataView(new ArrayBuffer(8));

export class BitReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} bit 読み始めの位置（ビット）
   * @param {{ version: number, decode?: (bytes: Uint8Array) => string }} options decode は R2004 までの文字列の文字コード
   */
  constructor(bytes, bit = 0, { version = R2000, decode = latin1 } = {}) {
    this.bytes = bytes;
    this.pos = bit;
    this.version = version;
    this.decode = decode;
    this.strings = null; // R2007+: この読み手の文字列を読む別の読み手（オブジェクトの「文字列の流れ」）
  }

  /** 同じバイト列を別の位置から読む読み手 */
  at(bit) {
    const reader = new BitReader(this.bytes, bit, { version: this.version, decode: this.decode });
    reader.strings = this.strings;
    reader.base = this.base;
    return reader;
  }

  get bytePos() {
    return this.pos >> 3;
  }

  #need(bits) {
    if (this.pos + bits > this.bytes.length * 8) throw new DwgError(`データの終わりを越えて読もうとしました（${this.pos} + ${bits} ビット）`);
  }

  bit() {
    this.#need(1);
    const value = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return value;
  }

  /** BB: 2 ビット */
  bb() {
    return (this.bit() << 1) | this.bit();
  }

  /** 3B: 0 が来るか 3 ビット読むまで続く（R2010+ のオブジェクトの型など） */
  b3() {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.bit();
      value = (value << 1) | b;
      if (!b) break;
    }
    return value;
  }

  /** RC: 1 バイト（ビットの位置は揃っていなくてよい） */
  byte() {
    this.#need(8);
    const i = this.pos >> 3, shift = this.pos & 7;
    this.pos += 8;
    if (!shift) return this.bytes[i];
    return ((this.bytes[i] << shift) | (this.bytes[i + 1] >> (8 - shift))) & 0xff;
  }

  /** n バイト（コピー） */
  read(n) {
    if (!(this.pos & 7)) {
      this.#need(n * 8);
      const start = this.pos >> 3;
      this.pos += n * 8;
      return this.bytes.slice(start, start + n);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.byte();
    return out;
  }

  skipBytes(n) {
    this.#need(n * 8);
    this.pos += n * 8;
  }

  /** RS: 2 バイトの符号付き整数（リトルエンディアン） */
  rs() {
    const lo = this.byte();
    return (((this.byte() << 8) | lo) << 16) >> 16;
  }

  /** RS（符号なし） */
  urs() {
    const lo = this.byte();
    return (this.byte() << 8) | lo;
  }

  /** RL: 4 バイトの符号付き整数 */
  rl() {
    const b0 = this.byte(), b1 = this.byte(), b2 = this.byte(), b3 = this.byte();
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }

  /** RL（符号なし） */
  url() {
    return this.rl() >>> 0;
  }

  /** RD: 8 バイトの倍精度 */
  rd() {
    for (let i = 0; i < 8; i++) scratch.setUint8(i, this.byte());
    return scratch.getFloat64(0, true);
  }

  /** BS: 00 = 2 バイト、01 = 1 バイト（符号なし）、10 = 0、11 = 256 */
  bs() {
    switch (this.bb()) {
      case 0: return this.rs();
      case 1: return this.byte();
      case 2: return 0;
      default: return 256;
    }
  }

  /** BL: 00 = 4 バイト、01 = 1 バイト、10 = 0 */
  bl() {
    switch (this.bb()) {
      case 0: return this.rl();
      case 1: return this.byte();
      case 2: return 0;
      default: throw new DwgError("BL の符号 11 は使われません");
    }
  }

  /** BLL: 長さ（3 ビット）のあとに、その数のバイト（R2010+。仕様書は 3B と書くが、実際は 3 ビットで固定） */
  bll() {
    const n = (this.bb() << 1) | this.bit();
    let value = 0;
    for (let i = 0; i < n; i++) value += this.byte() * 2 ** (8 * i);
    return value;
  }

  /** BD: 00 = 倍精度、01 = 1.0、10 = 0.0 */
  bd() {
    switch (this.bb()) {
      case 0: return this.rd();
      case 1: return 1;
      case 2: return 0;
      default: throw new DwgError("BD の符号 11 は使われません");
    }
  }

  /** DD: 前の値を既定として、変わったバイトだけを持つ倍精度 */
  dd(def) {
    const code = this.bb();
    if (code === 0) return def;
    if (code === 3) return this.rd();
    scratch.setFloat64(0, def, true);
    if (code === 2) {
      scratch.setUint8(4, this.byte());
      scratch.setUint8(5, this.byte());
    }
    for (let i = 0; i < 4; i++) scratch.setUint8(i, this.byte());
    return scratch.getFloat64(0, true);
  }

  /** 2RD・2BD・3BD・3RD */
  rd2() {
    return [this.rd(), this.rd()];
  }

  bd2() {
    return [this.bd(), this.bd()];
  }

  bd3() {
    return [this.bd(), this.bd(), this.bd()];
  }

  rd3() {
    return [this.rd(), this.rd(), this.rd()];
  }

  /** 2DD: 既定の点からの差分で持つ 2D の点 */
  dd2(def) {
    return [this.dd(def[0]), this.dd(def[1])];
  }

  /** BE: 押し出し方向（R2000+ は 1 ビットで既定の (0,0,1) を表せる） */
  be() {
    if (this.version >= R2000 && this.bit()) return [0, 0, 1];
    return this.bd3();
  }

  /** BT: 厚み（R2000+ は 1 ビットで 0 を表せる） */
  bt() {
    if (this.version >= R2000 && this.bit()) return 0;
    return this.bd();
  }

  /** MC: 可変長の整数（上位ビットが 1 なら続く。最後のバイトの 0x40 は負の印） */
  mc() {
    let value = 0, shift = 0;
    for (;;) {
      const b = this.byte();
      if (b & 0x80) {
        value += (b & 0x7f) * 2 ** shift;
        shift += 7;
        continue;
      }
      const negative = b & 0x40;
      value += (b & 0x3f) * 2 ** shift;
      return negative ? -value : value;
    }
  }

  /** MC（符号なし。0x40 を符号に使わない） */
  umc() {
    let value = 0, shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
      shift += 7;
    }
  }

  /** MS: 2 バイト単位の可変長の整数（オブジェクトの大きさ） */
  ms() {
    let value = 0, shift = 0;
    for (;;) {
      const w = this.urs();
      value += (w & 0x7fff) * 2 ** shift;
      if (!(w & 0x8000)) return value;
      shift += 15;
    }
  }

  /**
   * H: ハンドルの参照。|符号 4 ビット|バイト数 4 ビット|ハンドル（上位バイトが先）|
   * 符号 2〜5 はそのまま、6 = 基準 +1、8 = 基準 −1、A = 基準 + 値、C = 基準 − 値。
   * 基準 ref は、既定で読んでいるオブジェクトのハンドル（base。readObject が置く）
   */
  handle(ref = this.base ?? 0) {
    const head = this.byte();
    const code = head >> 4, n = head & 15;
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 256 + this.byte();
    switch (code) {
      case 6: return ref + 1;
      case 8: return ref - 1;
      case 0xa: return ref + value;
      case 0xc: return ref - value;
      default:
        if (code > 5) throw new DwgError(`ハンドルの参照の符号 ${code} が分かりません`);
        return value;
    }
  }

  /** OT: オブジェクトの型（R2010+ は BB と 1〜2 バイト） */
  ot() {
    if (this.version < R2010) return this.bs();
    switch (this.bb()) {
      case 0: return this.byte();
      case 1: return 0x1f0 + this.byte();
      default: return this.urs();
    }
  }

  /** TV: 文字列（R2007+ は UTF-16 で「文字列の流れ」から、それより前は BS の長さとバイト列） */
  text() {
    if (this.version >= R2007) {
      const source = this.strings;
      if (!source) return "";
      return source.#utf16(source.bs());
    }
    const n = this.bs();
    if (n <= 0) return "";
    return this.decode(this.read(n)).replace(/\0+$/, "");
  }

  /** TU: UTF-16 の文字列（BS の文字数のあと） */
  textUnicode() {
    return this.#utf16(this.bs());
  }

  #utf16(n) {
    if (n <= 0) return "";
    const units = new Array(n);
    for (let i = 0; i < n; i++) units[i] = this.urs();
    let end = n;
    while (end > 0 && units[end - 1] === 0) end--;
    return String.fromCharCode(...units.slice(0, end));
  }

  /** CMC: 色（R2004+ は色番号・RGB・色の名前） */
  cmc() {
    const index = this.bs();
    if (this.version < R2004) return { index };
    const rgb = this.bl() >>> 0;
    const flags = this.byte();
    if (flags & 1) this.text();
    if (flags & 2) this.text();
    return colorFromRgb(index, rgb);
  }

  /** ENC: 図形の色（R2004+ は大きさの上位ビットで RGB・透明度・色見本帳を表す）。
   *  色見本帳の色（0x4000。0x8000 も立つ）は、RGB を図形に持たず、ハンドルの先の DBCOLOR に持つ（book = true。色番号は近い色の番号） */
  enc() {
    if (this.version < R2004) return { color: { index: this.bs() }, book: false };
    const size = this.bs();
    if (!size) return { color: { index: 0 }, book: false };
    const flags = size & 0xff00;
    const book = Boolean(flags & 0x4000);
    const color = { index: size & 0xfff };
    if (flags & 0x8000 && !book) color.rgb = (this.bl() >>> 0) & 0xffffff;
    if (flags & 0x2000) this.bl(); // 透明度
    return { color, book };
  }
}

/** CMC の RGB の値から色。上位バイト 0xC0 = BYLAYER、最下位ビットが 1（0xC1・0xC3）= 色番号（下位バイト）、0xC2 = RGB */
export function colorFromRgb(index, rgb) {
  const kind = rgb >>> 24;
  if (kind === 0xc0) return { index: 256 };
  if (!kind) return { index };
  if (kind & 1) return { index: rgb & 0xff };
  return { index, rgb: rgb & 0xffffff };
}

const latin1Decoder = new TextDecoder("windows-1252");
export const latin1 = (bytes) => latin1Decoder.decode(bytes);
