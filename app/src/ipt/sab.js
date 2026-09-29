// SAB 層: Autodesk ShapeManager (ASM) / ACIS のバイナリ形状データを読む。
// 対応する Python 実装: ipt_inspect/sab.py（タグ体系・履歴セクションの扱いの説明もそちらを参照）

const MAGICS = ["ASM BinaryFile4", "ACIS BinaryFile"].map((s) => [...s].map((c) => c.charCodeAt(0)));
const MAGIC_LENGTH = 15;
const HEADER_SIZE = 16; // version, record 数, entity 数, flags（int32 × 4）

export const Tag = Object.freeze({
  CHAR: 0x02, SHORT: 0x03, LONG: 0x04, FLOAT: 0x05, DOUBLE: 0x06,
  STR8: 0x07, STR16: 0x08, STR32: 0x09, TRUE: 0x0a, FALSE: 0x0b,
  REF: 0x0c, IDENT: 0x0d, SUBIDENT: 0x0e, SUB_OPEN: 0x0f, SUB_CLOSE: 0x10,
  TERMINATOR: 0x11, STR32B: 0x12, POSITION: 0x13, VECTOR: 0x14, ENUM: 0x15,
  VECTOR2: 0x16, INT64: 0x17,
});

const NAME_TAGS = new Set([Tag.IDENT, Tag.SUBIDENT]);
const STRING_TAGS = new Set([Tag.STR8, Tag.STR16, Tag.STR32, Tag.STR32B]);
const KERNELS = ["ASM", "ACIS"];
const HISTORY_BEGIN = new Set(KERNELS.map((k) => `Begin-of-${k}-History-Data`));
const HISTORY_END = new Set(KERNELS.map((k) => `End-of-${k}-History-Section`));
const DATA_END = new Set(KERNELS.map((k) => `End-of-${k}-data`));
const utf8 = new TextDecoder("utf-8");

export class SabError extends Error {}

/** 1 レコード。フィールドは型ごとに取り出せる（位置の意味はエンティティ種別で決まる）。 */
export class Entity {
  constructor(index, type, fields) {
    this.index = index;
    this.type = type;
    this.fields = fields;
    const pick = (...tags) => fields.filter(([t]) => tags.includes(t)).map(([, v]) => v);
    this.refs = pick(Tag.REF);
    this.doubles = pick(Tag.DOUBLE);
    this.bools = pick(Tag.TRUE, Tag.FALSE);
    this.positions = pick(Tag.POSITION);
    this.vectors = pick(Tag.VECTOR);
    this.strings = pick(...STRING_TAGS);
  }
}

class Reader {
  constructor(bytes, pos) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  string(length) {
    const value = utf8.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return value;
  }

  token() {
    const { view } = this;
    if (this.pos >= this.bytes.length) throw new SabError("SAB データが終端レコードの前で途切れています");
    const tag = this.bytes[this.pos++];
    const at = this.pos;
    const doubles = (n) => Array.from({ length: n }, (_, i) => view.getFloat64(at + i * 8, true));
    let value = null, size = 0;
    switch (tag) {
      case Tag.CHAR: value = view.getUint8(at); size = 1; break;
      case Tag.SHORT: value = view.getInt16(at, true); size = 2; break;
      case Tag.LONG: case Tag.REF: case Tag.ENUM: value = view.getInt32(at, true); size = 4; break;
      case Tag.FLOAT: value = view.getFloat32(at, true); size = 4; break;
      case Tag.DOUBLE: value = view.getFloat64(at, true); size = 8; break;
      case Tag.POSITION: case Tag.VECTOR: value = doubles(3); size = 24; break;
      case Tag.VECTOR2: value = doubles(2); size = 16; break;
      case Tag.INT64: value = Number(view.getBigInt64(at, true)); size = 8; break;
      case Tag.STR8: case Tag.IDENT: case Tag.SUBIDENT: this.pos += 1; return [tag, this.string(view.getUint8(at))];
      case Tag.STR16: this.pos += 2; return [tag, this.string(view.getUint16(at, true))];
      case Tag.STR32: case Tag.STR32B: this.pos += 4; return [tag, this.string(view.getUint32(at, true))];
      case Tag.TRUE: value = true; break;
      case Tag.FALSE: value = false; break;
      case Tag.SUB_OPEN: case Tag.SUB_CLOSE: case Tag.TERMINATOR: break;
      default: throw new SabError(`未知のタグ 0x${tag.toString(16).padStart(2, "0")} (offset 0x${(at - 1).toString(16)})`);
    }
    this.pos += size;
    return [tag, value];
  }
}

/** バッファ中の SAB ブロック開始位置をすべて返す。 */
export function findBlocks(bytes) {
  const found = [];
  for (let i = 0; i <= bytes.length - MAGIC_LENGTH; i++) {
    if (MAGICS.some((m) => m.every((b, k) => bytes[i + k] === b))) found.push(i);
  }
  return found;
}

function makeEntity(index, record) {
  let split = record.findIndex(([t]) => !NAME_TAGS.has(t));
  if (split < 0) split = record.length;
  const type = record.slice(0, split).map(([, v]) => v).join("-");
  return new Entity(index, type, record.slice(split).filter(([t]) => t !== Tag.TERMINATOR));
}

export function parseSab(bytes, offset) {
  if (!MAGICS.some((m) => m.every((b, k) => bytes[offset + k] === b))) {
    throw new SabError(`offset 0x${offset.toString(16)} は SAB の先頭ではありません`);
  }
  const version = new DataView(bytes.buffer, bytes.byteOffset + offset + MAGIC_LENGTH, 4).getInt32(0, true);
  const reader = new Reader(bytes, offset + MAGIC_LENGTH + HEADER_SIZE);
  const [product, kernel, savedAt, mmPerUnit, resabs, resnor] = Array.from({ length: 6 }, () => reader.token()[1]);

  const entities = [], history = [];
  let record = [], inHistory = false;
  for (;;) {
    const [tag, value] = reader.token();
    record.push([tag, value]);
    if (NAME_TAGS.has(tag) && record.every(([t]) => NAME_TAGS.has(t))) {
      const marker = record.map(([, v]) => v).join("-");
      if (DATA_END.has(marker)) break;
      if (HISTORY_BEGIN.has(marker) || HISTORY_END.has(marker)) {
        inHistory = HISTORY_BEGIN.has(marker);
        record = [];
      }
    } else if (tag === Tag.TERMINATOR) {
      const table = inHistory ? history : entities;
      table.push(makeEntity(table.length, record));
      record = [];
    }
  }

  return {
    offset, end: reader.pos, version, product, kernel, savedAt, mmPerUnit, resabs, resnor, entities, history,
    get: (ref) => (ref >= 0 && ref < entities.length ? entities[ref] : null),
    ofType: (type) => entities.filter((e) => e.type === type),
  };
}
