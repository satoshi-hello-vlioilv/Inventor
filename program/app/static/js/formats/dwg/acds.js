// R2013+ の DWG の「AcDs」の節（AcDb:AcDsPrototype_1b。立体などの大きなデータの置き場）から、3D ソリッドの ACIS のデータを取り出す。
//   readAcDs(節のバイト列) → Map<ハンドル（図形のハンドル）, ACIS のデータ>
// R2013 からは 3DSOLID・REGION・BODY・面のオブジェクトの中に形が無く、ここにハンドルで引ける形で置く。
// 作りは ACadSharp（MIT）の DwgPrototype1bReader に従い、使う部分（ファイルの見出し・区画の目録・データの目録・データ）だけを読む:
//   ファイルの見出し（int32 × 14）→ 区画の目録（区画ごとに位置 u64・大きさ u32）
//   データの目録（区画・区画の中の位置・型の番号）→ 区画ごとに、データの見出し（大きさ・ハンドル u64・位置）とデータ
//   大きなデータ（印 0xbb106bb1）は複数の区画のページに分けて置く
// 型の目録（どのデータが ACIS か）は読まず、データの頭の印（"ACIS BinaryFile"・"ASM BinaryFile"）で見分ける。

const SEGMENT_HEADER = 48; // 区画の見出し: 印 2・名前 6・番号・blob か・大きさ・…・データの位置（16 バイト単位）・… 8
const BLOB = 0xbb106bb1;
const SIGNATURES = ["ACIS BinaryFile", "ASM BinaryFile"].map((s) => Uint8Array.from(s, (c) => c.charCodeAt(0)));

export function readAcDs(bytes) {
  const out = new Map();
  if (!bytes || bytes.length < 56) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  const u64 = (at) => Number(view.getBigUint64(at, true));
  const header = Array.from({ length: 14 }, (_, i) => view.getInt32(4 * i, true));
  const [segmentIndexOffset, , segmentCount, , dataIndexSegment] = header.slice(6, 11);
  // 区画の目録
  const segments = [];
  for (let i = 0, at = segmentIndexOffset + SEGMENT_HEADER; i < segmentCount; i++, at += 12) segments.push({ offset: u64(at), size: u32(at + 8) });
  const segment = (i) => {
    const s = segments[i];
    if (!s || s.offset + SEGMENT_HEADER > bytes.length) throw new Error(`AcDs の区画 ${i} がありません`);
    return { ...s, total: u32(s.offset + 16), objectData: view.getInt32(s.offset + 36, true) };
  };
  // データの目録: [区画, 区画の中の位置]
  const index = segment(dataIndexSegment);
  const entries = [];
  const count = view.getInt32(index.offset + SEGMENT_HEADER, true);
  for (let i = 0, at = index.offset + SEGMENT_HEADER + 8; i < count; i++, at += 12) {
    const seg = u32(at);
    if (seg) entries.push({ segment: seg, local: u32(at + 4) });
  }
  for (const seg of new Set(entries.map((e) => e.segment))) {
    const s = segment(seg);
    const headerEnd = s.offset + SEGMENT_HEADER;
    const heads = entries.filter((e) => e.segment === seg).map((e) => {
      const at = headerEnd + e.local;
      return { handle: u64(at + 8), local: u32(at + 16) };
    });
    const dataStart = s.offset + s.objectData * 16;
    // データの並びは目録の順と限らないので、残りの大きさは「位置が次に大きいデータ」までで測る
    const locals = [...new Set(heads.map((h) => h.local))].sort((a, b) => a - b);
    heads.forEach((h) => {
      const at = dataStart + h.local;
      const next = locals.find((l) => l > h.local);
      const room = (next ?? s.total - s.objectData * 16) - h.local;
      const size = u32(at);
      let data = null;
      if (size + 4 <= room) data = bytes.subarray(at + 4, at + 4 + size);
      else if (size === BLOB) data = blob(at + 4);
      if (data && SIGNATURES.some((sig) => sig.every((b, k) => data[k] === b))) out.set(h.handle, data);
    });
  }
  return out;

  /** 複数のページに分けたデータをつなぐ */
  function blob(at) {
    const total = u64(at), pages = u32(at + 8);
    const out = new Uint8Array(total);
    let filled = 0;
    for (let p = 0, ref = at + 32; p < pages; p++, ref += 8) {
      const s = segment(u32(ref));
      const pageAt = s.offset + SEGMENT_HEADER;
      const start = u64(pageAt + 8), size = u64(pageAt + 24);
      out.set(bytes.subarray(pageAt + 32, pageAt + 32 + size), start);
      filled += size;
    }
    return filled >= total ? out : null;
  }
}
