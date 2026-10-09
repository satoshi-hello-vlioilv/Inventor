// .ipt 解析の入口。
//   parseIpt(bytes, name) → { report, scene, thumbnail, properties }
//   report … ファイル構造と形状要約（セグメント・SAB の版と単位・ボディごとの要約）
//   scene  … three.js ビューアに渡す形状データ

import { summarize } from "../acis/brep.js";
import { openIpt } from "./container.js";
import { materialOf } from "./properties.js";
import { findBlocks, parseSab } from "../acis/sab.js";
import { buildScene } from "./scene.js";

export { CfbError } from "./cfb.js";
export { SabError } from "../acis/sab.js";

/** 全セグメント中の SAB ブロックを { segment, doc } で列挙する。 */
export function shapes(ipt) {
  return ipt.segments.flatMap((segment) => findBlocks(segment.data).map((offset) => ({ segment, doc: parseSab(segment.data, offset) })));
}

/**
 * @param {Uint8Array} bytes  .ipt ファイルの中身
 * @param {string} name       ファイル名（表示用）
 */
export function parseIpt(bytes, name) {
  const ipt = openIpt(bytes);
  const found = shapes(ipt);
  const size = ipt.thumbnailSize;
  const report = {
    file: { name, size: ipt.fileSize },
    container: { format: "OLE2 Compound File (MS-CFB)", clsid: ipt.clsid, streams: ipt.streams },
    thumbnail: size ? { format: "png", width: size[0], height: size[1] } : null,
    segments: ipt.segments.map((s) => ({
      name: s.name,
      key: s.key,
      compressed: s.compressed,
      data_stored: s.dataStoredSize,
      data_expanded: s.data.length,
      meta_stored: s.metaStoredSize,
      meta_expanded: s.meta.length,
    })),
    shapes: found.map(({ segment, doc }) => ({
      segment: segment.name,
      offset: doc.offset,
      product: doc.product,
      kernel: doc.kernel,
      saved_at: doc.savedAt,
      mm_per_unit: doc.mmPerUnit,
      entities: doc.entities.length,
      history_records: doc.history.length,
      bodies: summarize(doc),
    })),
  };
  return { report, scene: buildScene(name, found), thumbnail: ipt.thumbnail, properties: materialOf(ipt.streamData) };
}
