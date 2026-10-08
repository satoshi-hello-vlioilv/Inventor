// Jw_cad の図面（.jww）を読む。中身は MFC の CArchive の保存の並び（リトルエンディアン）:
//   "JwwData." → 版（u32）→ 見出し（メモ・用紙・画層グループ 16 × 画層 16 の状態・名前・色・線種 …）→ 図形の一覧（CObList）→ ブロックの定義の一覧
// 図形は「クラスの印（新しいクラスなら名前）＋ 中身」の並び。座標は用紙の mm（用紙の中心が原点・+Y が上）。角度はラジアン（文字は度）。
// 書き方は ezjww（MIT。Rust の読み手・書き手と、Jw_cad で開いて保存し直した試験の図面）で確かめた。docs/drawing-format.md §8
//
//   readJww(bytes) → { version, memo, paperSize, writeGroup, groups: [{ state, scale, protect, name, layers: [{ state, protect, name }] }],
//                      palette: { pens: [0x00BBGGRR × 10], extended: [257] | null }, lineTypes: Map<番号, 線と間の長さ（用紙の mm）>,
//                      entities: [図形], blockDefs: [{ number, name, entities }], warnings: [] }

export class JwwError extends Error {}

export const isJww = (bytes) => bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 8)) === "JwwData.";

const SJIS = new TextDecoder("shift_jis");
const UTF16 = new TextDecoder("utf-16le");

class Reader {
  constructor(bytes, at = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = at;
  }
  #need(n) {
    if (this.at + n > this.bytes.length) throw new JwwError("ファイルが途中で切れています。");
  }
  skip(n) {
    this.#need(n);
    this.at += n;
  }
  u8() {
    this.#need(1);
    return this.bytes[this.at++];
  }
  u16() {
    this.#need(2);
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32() {
    this.#need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  f64() {
    this.#need(8);
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  /** MFC の CString: 長さ（u8・0xFF なら u16・0xFFFF なら u32）と CP932 のバイト。0xFF 0xFFFE の印があれば UTF-16LE */
  string() {
    let unicode = false;
    let n = this.u8();
    if (n === 0xff) {
      n = this.u16();
      if (n === 0xfffe) {
        unicode = true;
        n = this.u8();
        if (n === 0xff) n = this.u16();
      }
      if (n === 0xffff) n = this.u32();
    }
    const size = unicode ? n * 2 : n;
    this.#need(size);
    const bytes = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return (unicode ? UTF16 : SJIS).decode(bytes);
  }
  /** CArchive の数（u16。0xFFFF なら続く u32） */
  count() {
    const w = this.u16();
    return w === 0xffff ? this.u32() : w;
  }
}

export function readJww(bytes) {
  if (!isJww(bytes)) throw new JwwError("Jw_cad の図面（JwwData.）ではありません。");
  const r = new Reader(bytes, 8);
  const doc = { version: r.u32(), warnings: [] };
  doc.memo = r.string();
  doc.paperSize = r.u32();
  doc.writeGroup = r.u32();
  doc.groups = Array.from({ length: 16 }, () => {
    const g = { state: r.u32(), writeLayer: r.u32(), scale: r.f64(), protect: r.u32() };
    g.layers = Array.from({ length: 16 }, () => ({ state: r.u32(), protect: r.u32(), name: "" }));
    return g;
  });
  doc.palette = null;
  doc.lineTypes = new Map();
  try {
    readNamesAndSettings(r, doc);
  } catch {
    doc.warnings.push("画層の名前・色・線種の設定を読めませんでした（既定の名前・色で表示します）");
  }
  doc.groups.forEach((g, i) => {
    g.name ||= `Group${hex(i)}`;
    g.layers.forEach((l, j) => (l.name ||= `${hex(i)}-${hex(j)}`));
  });

  const start = doc.version === 700 ? headerEnd700(bytes) : findEntityList(bytes, doc.version);
  if (start === null) throw new JwwError("図形の一覧が見つかりませんでした。");
  const e = new Reader(bytes, start);
  const archive = { classes: new Map(), next: 1 };
  doc.entities = readList(e, doc.version, archive, doc.warnings);
  doc.blockDefs = [];
  try {
    if (e.at < bytes.length) doc.blockDefs = readBlockDefs(e, doc.version, archive, doc.warnings);
  } catch (error) {
    doc.warnings.push(`ブロックの定義を読めませんでした（${error.message}）`);
  }
  return doc;
}

const hex = (i) => i.toString(16).toUpperCase();

/** 見出しの、画層の名前と、画面の色・線種（版 300 以降の並び） */
function readNamesAndSettings(r, doc) {
  if (doc.version < 300) throw new JwwError("古い版");
  r.skip((14 + 5 + 1 + 1) * 4); // 予備・寸法の設定・最大の線の幅
  r.skip(16 + 8 + 4 + 4 + 8 + 16 + 16); // 印刷の原点・倍率・設定、目盛り
  for (const g of doc.groups) for (const l of g.layers) l.name = r.string();
  for (const g of doc.groups) g.name = r.string();
  // 日影・天空図・2.5D・画面の倍率と原点・拡大の記憶・予備・文字の背景・複線の間隔
  r.skip(8 + 8 + 4 + 8 + 16 + 4 + 8 + 16 + 8 + 16 + 224 + 56 + 80 + 8);
  const pens = Array.from({ length: 10 }, () => {
    const color = r.u32() & 0xffffff;
    r.u32(); // 画面の線の幅
    return color;
  });
  doc.palette = { pens, extended: null };
  // 線種: 印刷の色・幅・点の半径（10 × 16 バイト）→ 標準の線種 2〜9 → 乱線 11〜15 → 倍長の線種 16〜19
  r.skip(160);
  const pattern = (number) => {
    const bits = r.u32(), unit = r.u32();
    r.u32(); // 画面のピッチ
    const printerPitch = r.u32();
    doc.lineTypes.set(number, dashesOf(bits, unit, printerPitch / 32));
  };
  for (let i = 0; i < 8; i++) pattern(2 + i);
  r.skip(5 * 20);
  for (let i = 0; i < 4; i++) pattern(16 + i);
  if (doc.version < 420) return;
  r.skip(44 + 20 + 40 + 32 + 8);
  doc.palette.extended = Array.from({ length: 257 }, () => {
    const color = r.u32() & 0xffffff;
    r.u32();
    return color;
  });
  // SXF の線種 30〜62: 色の名前（257）の後に、模様と名前・線と間の長さ（mm）
  for (let i = 0; i < 257; i++) {
    r.string();
    r.skip(16);
  }
  const patterns = Array.from({ length: 33 }, () => [r.u32(), r.u32(), r.u32(), r.u32()]);
  for (let i = 0; i < 33; i++) {
    r.string();
    const n = r.u32();
    const lengths = Array.from({ length: 10 }, () => r.f64());
    if (n > 10 || lengths.some((v) => !Number.isFinite(v) || v < 0)) throw new JwwError("SXF の線種");
    const segments = n ? lengths.slice(0, n) : dashesOf(patterns[i][0], patterns[i][1], patterns[i][3] / 32);
    doc.lineTypes.set(30 + i, segments);
  }
}

/** ビットの模様（下位 unit ビットが 1 周期。1 = 線・0 = すき間）→ 線と間の長さ（線から始める。全て線なら []） */
function dashesOf(bits, unit, mmPerBit) {
  if (!(unit >= 1 && unit <= 32)) return [];
  const on = (i) => (bits >>> (i % unit)) & 1;
  const first = Array.from({ length: unit }, (_, i) => i).find((i) => on(i) && !on(i + unit - 1)); // 線の始まり
  if (first === undefined) return [];
  const runs = [];
  for (let i = 0; i < unit; ) {
    const v = on(first + i);
    let n = 0;
    while (i < unit && on(first + i) === v) (i++, n++);
    runs.push(n * mmPerBit);
  }
  return runs;
}

/** 版 700 の見出しの終わり（全ての欄を順にたどる） */
function headerEnd700(bytes) {
  const r = new Reader(bytes, 12);
  r.string();
  r.skip(8 + 16 * 148 + 84 + 72);
  for (let i = 0; i < 272; i++) r.string();
  r.skip(28 + 16 + 4 + 24 + 24 + 8 * 28 + 56 + 80 + 8 + 10 * 8 + 10 * 16 + 8 * 16 + 5 * 20 + 4 * 16 + 44 + 20 + 40 + 32 + 8 + 257 * 8);
  for (let i = 0; i < 257; i++) {
    r.string();
    r.skip(16);
  }
  r.skip(33 * 16);
  for (let i = 0; i < 33; i++) {
    r.string();
    r.skip(4 + 10 * 8);
  }
  r.skip(10 * 28 + 32 + 16 + 4 + 48);
  return r.at;
}

/** ほかの版: 最初の図形のクラスの印（0xFFFF・版の番号・"CData…"）を探し、その前の数から読む */
function findEntityList(bytes, version) {
  let fallback = null;
  for (let i = 100; i + 20 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xff) continue;
    const schema = bytes[i + 2] | (bytes[i + 3] << 8), len = bytes[i + 4] | (bytes[i + 5] << 8);
    if (len < 8 || len > 32 || String.fromCharCode(...bytes.subarray(i + 6, i + 11)) !== "CData") continue;
    // 数が 65535 以上なら 0xFFFF と u32 の数（6 バイト）
    let at = i - 2;
    if (i >= 6 && bytes[i - 6] === 0xff && bytes[i - 5] === 0xff) {
      const n = new DataView(bytes.buffer, bytes.byteOffset + i - 4, 4).getUint32(0, true);
      if (n >= 0xffff && n * 20 <= bytes.length) at = i - 6;
    }
    if (schema === (version & 0xffff)) return at;
    fallback ??= at;
  }
  return fallback;
}

/** CArchive のオブジェクトの印: 新しいクラス・読んだクラス（番号）・空 */
function readClass(r, archive) {
  const w = r.u16();
  if (w === 0xffff) {
    r.u16(); // クラスの版
    const n = r.u16();
    const name = String.fromCharCode(...r.bytes.subarray(r.at, r.at + n));
    r.skip(n);
    archive.classes.set(archive.next++, name);
    return name;
  }
  const tag = w === 0x7fff ? r.u32() : ((w & 0x8000) << 16) | (w & 0x7fff);
  if (tag & 0x80000000) {
    const pid = tag & 0x7fffffff;
    if (!pid) return null;
    const name = archive.classes.get(pid);
    if (!name) throw new JwwError(`知らないクラスの番号 ${pid}`);
    return name;
  }
  if (!tag) return null;
  throw new JwwError(`オブジェクトの参照 ${tag} は読めません`);
}

/** 図形の一覧（CObList）。途中で読めなくなったら、そこまでを返して知らせる */
function readList(r, version, archive, warnings) {
  const n = r.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    try {
      const name = readClass(r, archive);
      if (!name) continue;
      const entity = readEntity(r, name, version);
      archive.next++; // オブジェクトにも番号が振られる
      out.push(entity);
    } catch (error) {
      warnings.push(`図形 ${n} 個のうち ${out.length} 個まで読みました（${error.message}）`);
      break;
    }
  }
  return out;
}

function base(r, version) {
  return {
    group: r.u32(), penStyle: r.u8(), penColor: r.u16(), penWidth: version >= 351 ? r.u16() : 0,
    layer: r.u16(), layerGroup: r.u16(), flag: r.u16(),
  };
}

const line = (r, version) => ({ kind: "line", ...base(r, version), a: [r.f64(), r.f64()], b: [r.f64(), r.f64()] });

function point(r, version) {
  const p = { kind: "point", ...base(r, version), p: [r.f64(), r.f64()], temporary: r.u32() !== 0 };
  if (p.penStyle === 100) Object.assign(p, { code: r.u32(), angle: r.f64(), scale: r.f64() });
  return p;
}

const text = (r, version) => ({
  kind: "text", ...base(r, version), start: [r.f64(), r.f64()], end: [r.f64(), r.f64()], textType: r.u32(),
  size: [r.f64(), r.f64()], spacing: r.f64(), angle: r.f64(), font: r.string(), text: r.string(),
});

function readEntity(r, name, version) {
  switch (name) {
    case "CDataSen": return line(r, version);
    case "CDataEnko": return {
      kind: "arc", ...base(r, version), center: [r.f64(), r.f64()], radius: r.f64(), start: r.f64(), sweep: r.f64(),
      tilt: r.f64(), flatness: r.f64(), full: r.u32() !== 0,
    };
    case "CDataTen": return point(r, version);
    case "CDataMoji": return text(r, version);
    case "CDataSolid": {
      const b = base(r, version);
      const v = Array.from({ length: 8 }, () => r.f64());
      const rgb = b.penColor === 10 ? r.u32() & 0xffffff : null;
      if (b.penStyle >= 101) {
        return { kind: "circleSolid", ...b, center: [v[0], v[1]], radius: v[2], flatness: v[3], tilt: v[4], start: v[5], sweep: v[6], mode: v[7], rgb };
      }
      // 多角形の周りの順は、保存の順（点 1 → 点 4 → 点 2 → 点 3）のまま。三角形は最後の点が重なる
      return { kind: "solid", ...b, points: [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]], rgb };
    }
    case "CDataBlock": return {
      kind: "block", ...base(r, version), p: [r.f64(), r.f64()], scale: [r.f64(), r.f64()], rotation: r.f64(), number: r.u32(),
    };
    case "CDataSunpou": {
      const d = { kind: "dimension", ...base(r, version), line: line(r, version), text: text(r, version), aux: [], points: [] };
      if (version >= 420) {
        d.sxfMode = r.u16();
        for (let i = 0; i < 2; i++) d.aux.push(line(r, version));
        for (let i = 0; i < 4; i++) d.points.push(point(r, version));
      }
      return d;
    }
    default: throw new JwwError(`知らない図形 ${name}`);
  }
}

/** ブロックの定義の一覧（CObList）。定義ごとに、名前と図形の一覧 */
function readBlockDefs(r, version, archive, warnings) {
  const n = r.count();
  const out = [];
  for (let i = 0; i < n && i < 10000; i++) {
    const name = readClass(r, archive);
    if (name === null) continue;
    archive.next++; // 定義そのものの番号（中の図形より先に振られる）
    const b = base(r, version);
    const def = { ...b, number: r.u32(), referenced: r.u32() !== 0 };
    r.skip(4); // 作った日時
    def.name = r.string();
    def.entities = readList(r, version, archive, warnings);
    out.push(def);
  }
  return out;
}

/** 用紙の番号 → [幅, 高さ]（mm。8〜14 は Jw_cad の拡大の用紙） */
export const PAPER_SIZES = {
  0: ["A0", 1189, 841], 1: ["A1", 841, 594], 2: ["A2", 594, 420], 3: ["A3", 420, 297], 4: ["A4", 297, 210],
  8: ["2A", 1682, 1189], 9: ["3A", 2378, 1682], 10: ["4A", 3364, 2378], 11: ["5A", 4756, 3364],
  12: ["10m", 10000, 7073], 13: ["50m", 50000, 35366], 14: ["100m", 100000, 70732],
};
