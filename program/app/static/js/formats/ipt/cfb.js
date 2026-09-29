// OLE2 複合ドキュメント（Microsoft Compound File Binary, MS-CFB）の読み取り。
// ファイル内に FAT 形式のミニファイルシステムがあり、ストレージ（フォルダ）とストリーム（ファイル）を持つ。

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_DIFAT_ENTRIES = 109;
const DIR_ENTRY_SIZE = 128;
const NO_STREAM = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export class CfbError extends Error {}

/** 16 バイトの CLSID を olefile と同じ書式（大文字、先頭 3 要素はリトルエンディアン）で文字列化する。 */
export function formatClsid(bytes) {
  if (bytes.every((b) => b === 0)) return "";
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, "0");
  const tail = [...bytes.subarray(8)].map((b) => hex(b, 2));
  return `${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 2).join("")}-${tail.slice(2).join("")}`;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ clsid: string, streams: Map<string, Uint8Array> }}  パスは "/" 区切り、名前順（olefile と同順）
 */
export function readCfb(bytes) {
  if (bytes.length < 512 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new CfbError("OLE2 複合ドキュメントではありません");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset) => view.getUint32(offset, true);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const miniCutoff = u32(0x38);
  const entriesPerSector = sectorSize / 4;
  const sectorOffset = (n) => (n + 1) * sectorSize;
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;

  // FAT の所在（DIFAT）: ヘッダ内 109 件 ＋ DIFAT セクタの連鎖
  const fatSectors = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES; i++) fatSectors.push(u32(0x4c + i * 4));
  for (let s = u32(0x44), guard = 0; s < END_OF_CHAIN && guard <= sectorCount; guard++) {
    const base = sectorOffset(s);
    for (let i = 0; i < entriesPerSector - 1; i++) fatSectors.push(u32(base + i * 4));
    s = u32(base + (entriesPerSector - 1) * 4);
  }
  const fat = [];
  for (const s of fatSectors.slice(0, u32(0x2c))) {
    const base = sectorOffset(s);
    for (let i = 0; i < entriesPerSector; i++) fat.push(u32(base + i * 4));
  }

  const chain = (start, table) => {
    const out = [];
    for (let s = start; s < END_OF_CHAIN; s = table[s]) {
      if (out.length > table.length) throw new CfbError("セクタの連鎖が循環しています");
      out.push(s);
    }
    return out;
  };
  const readChain = (start, size) => {
    const out = new Uint8Array(size);
    let written = 0;
    for (const s of chain(start, fat)) {
      if (written >= size) break;
      const part = bytes.subarray(sectorOffset(s), sectorOffset(s) + Math.min(sectorSize, size - written));
      out.set(part, written);
      written += part.length;
    }
    return out;
  };

  // ディレクトリ
  const dirSectors = chain(u32(0x30), fat);
  const dirBytes = readChain(u32(0x30), dirSectors.length * sectorSize);
  const dirView = new DataView(dirBytes.buffer);
  const entries = [];
  for (let off = 0; off + DIR_ENTRY_SIZE <= dirBytes.length; off += DIR_ENTRY_SIZE) {
    const nameLength = dirView.getUint16(off + 0x40, true);
    const name = String.fromCharCode(
      ...new Uint16Array(dirBytes.buffer.slice(off, off + Math.max(0, nameLength - 2))),
    );
    entries.push({
      name,
      type: dirBytes[off + 0x42],
      left: dirView.getUint32(off + 0x44, true),
      right: dirView.getUint32(off + 0x48, true),
      child: dirView.getUint32(off + 0x4c, true),
      clsid: dirBytes.slice(off + 0x50, off + 0x60),
      start: dirView.getUint32(off + 0x74, true),
      // 512 バイトセクタ（バージョン 3）では上位 32 ビットが未初期化のことがあり、仕様上も無視が推奨されている
      size: dirView.getUint32(off + 0x78, true) + (sectorSize === 512 ? 0 : dirView.getUint32(off + 0x7c, true) * 2 ** 32),
    });
  }
  const root = entries[0];
  if (!root || root.type !== TYPE_ROOT) throw new CfbError("ルートエントリが見つかりません");

  // ミニストリーム（小さいストリームは 64 バイト単位のミニセクタに格納される）
  const miniStream = readChain(root.start, root.size);
  const miniFat = [];
  for (const s of chain(u32(0x3c), fat)) {
    for (let i = 0; i < entriesPerSector; i++) miniFat.push(u32(sectorOffset(s) + i * 4));
  }
  const readMini = (start, size) => {
    const out = new Uint8Array(size);
    let written = 0;
    for (const s of chain(start, miniFat)) {
      if (written >= size) break;
      const part = miniStream.subarray(s * miniSectorSize, s * miniSectorSize + Math.min(miniSectorSize, size - written));
      out.set(part, written);
      written += part.length;
    }
    return out;
  };

  // 子エントリは赤黒木で保持されている。木を辿って列挙し、名前順に並べる。
  const children = (entry) => {
    const out = [];
    const walk = (id) => {
      if (id === NO_STREAM || id >= entries.length || out.length > entries.length) return;
      const e = entries[id];
      walk(e.left);
      out.push(e);
      walk(e.right);
    };
    walk(entry.child);
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const streams = new Map();
  const visit = (storage, prefix) => {
    for (const e of children(storage)) {
      const path = prefix + e.name;
      if (e.type === TYPE_STORAGE) visit(e, path + "/");
      else if (e.type === TYPE_STREAM) {
        streams.set(path, e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
      }
    }
  };
  visit(root, "");
  return { clsid: formatClsid(root.clsid), streams };
}
