// U3D（ECMA-363）のビット列: 算術符号で圧縮した値と、圧縮しない値を同じ流れから読む。
// 手順は ECMA-363 と、その公式の実装（Intel の U3D ライブラリ。Apache License 2.0。CIFXBitStreamX・IFXHistogramDynamic）に従う。
//   ビットは各バイトの下位から読む。算術符号の状態は 16 ビットの low・high と、保留（underflow）のビット数
//   文脈: 0 = 8 ビットの値（一様な 256 記号）、1〜0x400 = 出現の数を数えて変わる文脈、0x400 を越える = 一様な（文脈 − 0x400）記号

const STATIC_FULL = 0x400;
const MAX_RANGE = STATIC_FULL + 0x3fff;
const ELEPHANT = 0x1fff; // 数えた合計がこれに達したら、数を半分にする（古い出現を忘れる）
const MAX_SYMBOL = 0xffff; // 数える値の上限
const REVERSE8 = Uint8Array.from({ length: 256 }, (_, v) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i);
  return r;
});

/** 出現の数を数えて変わる文脈（記号 0 は「ここに無い値」の印で、数は 1 から始まる） */
class Histogram {
  constructor() {
    this.freq = [1];
    this.total = 1;
  }
  cumulative(symbol) {
    let sum = 0;
    for (let i = 0; i < symbol && i < this.freq.length; i++) sum += this.freq[i];
    return sum;
  }
  /** 累積の数 f を含む記号 */
  symbolOf(f) {
    let sum = 0;
    for (let i = 0; i < this.freq.length; i++) {
      sum += this.freq[i];
      if (f < sum) return i;
    }
    return 0;
  }
  add(symbol) {
    if (symbol > MAX_SYMBOL) return; // これより大きい値は数えない（いつも「ここに無い値」として送られる）
    if (this.total >= ELEPHANT) {
      this.total = 0;
      for (let i = 0; i < this.freq.length; i++) this.total += (this.freq[i] >>= 1);
      this.freq[0] += 1;
      this.total += 1;
    }
    while (this.freq.length <= symbol) this.freq.push(0);
    this.freq[symbol] += 1;
    this.total += 1;
  }
}

export class BitStream {
  /** @param {Uint8Array} bytes ブロックのデータ */
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0; // ビットの位置
    this.low = 0;
    this.high = 0xffff;
    this.underflow = 0;
    this.contexts = new Map();
  }

  #bit(k) {
    return ((this.bytes[k >> 3] ?? 0) >> (k & 7)) & 1;
  }

  /** 記号を 1 つ読む（文脈で確率を決める） */
  #symbol(context) {
    // 符号語: 次の 1 ビット、保留のビットを飛ばした 15 ビット（先に読んだビットが上位）。位置は進めない
    let code = this.#bit(this.pos);
    let at = this.pos + 1 + this.underflow;
    for (let i = 0; i < 15; i++) code = (code << 1) | this.#bit(at++);
    const range = this.high + 1 - this.low;
    let total, cum, freq, value, h = null;
    if (context === 0 || context > STATIC_FULL) {
      total = context === 0 ? 256 : context - STATIC_FULL;
      value = Math.floor((total * (1 + code - this.low) - 1) / range) + 1;
      cum = value - 1;
      freq = 1;
    } else {
      h = this.contexts.get(context);
      if (!h) this.contexts.set(context, (h = new Histogram()));
      total = h.total;
      value = h.symbolOf(Math.floor((total * (1 + code - this.low) - 1) / range));
      cum = h.cumulative(value);
      freq = h.freq[value];
    }
    let high = this.low - 1 + Math.floor((range * (cum + freq)) / total);
    let low = this.low + Math.floor((range * cum) / total);
    h?.add(value);
    // 上位のビットがそろう間、ずらして読み進める
    let bits = 0;
    while ((low & 0x8000) === (high & 0x8000)) {
      low = (low & 0x7fff) << 1;
      high = ((high & 0x7fff) << 1) | 1;
      bits++;
    }
    if (bits > 0) {
      bits += this.underflow;
      this.underflow = 0;
    }
    // low = 01…・high = 10… の間は、2 番目のビットを抜いて保留を数える
    while ((low & 0x4000) && !(high & 0x4000)) {
      low = (low & 0x3fff) << 1;
      high = ((high & 0x3fff) << 1) | 1 | 0x8000;
      this.underflow++;
    }
    this.low = low & 0xffff;
    this.high = high | 0x8000;
    this.pos += bits;
    return value;
  }

  readU8() {
    return REVERSE8[this.#symbol(0) - 1];
  }
  readU16() {
    return this.readU8() | (this.readU8() << 8);
  }
  readU32() {
    return (this.readU16() | (this.readU16() << 16)) >>> 0;
  }
  readI32() {
    return this.readU32() | 0;
  }
  readF32() {
    const v = new DataView(new ArrayBuffer(4));
    v.setUint32(0, this.readU32(), true);
    return v.getFloat32(0, true);
  }
  readF64() {
    const v = new DataView(new ArrayBuffer(8));
    v.setUint32(0, this.readU32(), true);
    v.setUint32(4, this.readU32(), true);
    return v.getFloat64(0, true);
  }
  readString() {
    const n = this.readU16();
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.readU8();
    return new TextDecoder().decode(b);
  }

  /** 圧縮した値（文脈の記号。記号 0 なら、続く圧縮しない値。数える文脈なら、その値を数に入れる） */
  #compressed(context, raw) {
    if (!context || context >= MAX_RANGE) return raw();
    const s = this.#symbol(context);
    if (s) return s - 1;
    const v = raw();
    if (context <= STATIC_FULL) {
      let h = this.contexts.get(context);
      if (!h) this.contexts.set(context, (h = new Histogram()));
      h.add(v + 1);
    }
    return v;
  }
  readCompressedU32(context) {
    return this.#compressed(context, () => this.readU32());
  }
  readCompressedU16(context) {
    return this.#compressed(context, () => this.readU16());
  }
  readCompressedU8(context) {
    return this.#compressed(context, () => this.readU8());
  }
}

export { STATIC_FULL };
