// .iam（Inventor の組立）を読む。部品の形状は参照先の .ipt にあるので、ここで読むのは「どの部品を・どこに置くか」。
//   parseIam(bytes, name) → { references, occurrences, report }
//     references[i]  … { path, file, stem, display }（組立が参照するファイル。Content Center の部品は表示名つき）
//     occurrences[i] … { name, reference（references の番号、特定できなければ null）, matrix（4×4 行優先、mm） }
//   buildIamScene(iam, resolve) … 参照先の .ipt を resolve(reference) で受け取り、組立のシーン（STEP と同じ形）を作る
//
// 形式（docs/iam-format.md。samples の組立と、同じ組立を書き出した STEP との照合で確かめた）
//   UFRxDoc          ファイル参照: 長さ（UInt32、文字数）+ UTF-16LE のパスが並ぶ。先頭は組立自身
//   AmDcSegment      出現名の一覧: [ID UInt32][0x30000002][0][長さ][UTF-16LE の名前「部品名:番号」]
//   AmRxSegment      出現の配置: 印付きの 4×4 行優先行列。印（UInt32）の下位 16 ビット = 値が 1 の成分、
//                    上位 16 ビット = 値が 0 の成分（ビット i ↔ 成分 i）。残りの成分だけが倍精度で並ぶ。単位は cm
//   出現名を ID の順に、配置を並びの順に並べると 1 対 1 に対応する（どちらも作成順）

import { openIpt } from "../ipt/container.js";
import { parseIpt } from "../ipt/index.js";
import { IDENTITY } from "../../core/matrix.js";
import labels from "../../core/labels.json" with { type: "json" };

export { CfbError } from "../ipt/cfb.js";

const CM_TO_MM = 10; // Inventor の内部単位は cm
const NAME_SIGNATURE = 0x30000002;
const CONTENT_CENTER = "Content Center Files";
const utf16 = new TextDecoder("utf-16le");

/** バイト列の中の「長さ（UInt32、文字数）+ UTF-16LE」の文字列を、位置の順に列挙する */
function lengthPrefixedStrings(d, accept, minLength = 2) {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out = [];
  for (let p = 0; p + 4 < d.length; p++) {
    const n = view.getUint32(p, true);
    if (n < minLength || n > 2000 || p + 4 + n * 2 > d.length) continue;
    const s = utf16.decode(d.subarray(p + 4, p + 4 + n * 2));
    if (/[\u0000-\u001f�]/.test(s) || !accept(s)) continue;
    out.push({ at: p, text: s });
    p += 3 + n * 2;
  }
  return out;
}

const baseName = (path) => path.split(/[\\/]/).pop();
const stemOf = (file) => file.replace(/\.[^.]+$/, "");
const IS_DOCUMENT = /\.(ipt|iam|ipn|idw|dwg)$/i;

/** ファイル参照（UFRxDoc）。先頭（組立自身）を除き、Content Center の表示名を添える */
function readReferences(ufrx) {
  if (!ufrx) return [];
  const strings = lengthPrefixedStrings(ufrx, (s) => s.length >= 2);
  const refs = [];
  strings.forEach((s, i) => {
    if (!IS_DOCUMENT.test(s.text)) return;
    if (refs.some((r) => r.path === s.text)) return;
    const file = baseName(s.text);
    // Content Center の部品は「Content Center Files」の直後に表示名（出現名の元になる）がある
    const display = strings[i + 1]?.text === CONTENT_CENTER && strings[i + 2] && !IS_DOCUMENT.test(strings[i + 2].text) ? strings[i + 2].text : null;
    refs.push({ path: s.text, file, stem: stemOf(file), display });
  });
  return refs.slice(1); // 先頭は組立自身のパス
}

/** 出現名（AmDcSegment）。ID の順に並べる */
function readOccurrenceNames(dc) {
  const view = new DataView(dc.buffer, dc.byteOffset, dc.byteLength);
  const out = [];
  for (let p = 16; p + 4 <= dc.length; p++) {
    if (view.getUint32(p - 12, true) !== NAME_SIGNATURE || view.getUint32(p - 8, true) !== 0) continue;
    const n = view.getUint32(p - 4, true);
    if (n < 1 || n > 1000 || p + n * 2 > dc.length) continue;
    const name = utf16.decode(dc.subarray(p, p + n * 2));
    if (/^[^\u0000-\u001f]+:\d+$/.test(name) && !name.includes("::")) out.push({ id: view.getUint32(p - 16, true), name, at: p });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** 印付きの 4×4 行列を p から読む。{ m, end } または null */
function readMasked(view, p) {
  const ones = view.getUint16(p, true), zeros = view.getUint16(p + 2, true);
  if (ones & zeros) return null;
  const m = new Array(16);
  let q = p + 4;
  for (let i = 0; i < 16; i++) {
    if (ones & (1 << i)) m[i] = 1;
    else if (zeros & (1 << i)) m[i] = 0;
    else {
      if (q + 8 > view.byteLength) return null;
      m[i] = view.getFloat64(q, true);
      q += 8;
    }
  }
  return { m, end: q };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** 剛体変換（直交する回転 + 移動、4 行目が 0 0 0 1）か */
function isRigid(m) {
  if (m.some((v) => !Number.isFinite(v))) return false;
  const rows = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const orthonormal = rows.every((a, i) => rows.every((b, j) => Math.abs(dot3(a, b) - (i === j ? 1 : 0)) < 1e-6));
  const det = dot3(rows[0], [rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1], rows[1][2] * rows[2][0] - rows[1][0] * rows[2][2], rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]]);
  return orthonormal && det > 0 && [m[3], m[7], m[11]].every((t) => Math.abs(t) < 1e6);
}

/** 出現の配置（AmRxSegment）。並びの順。[3][3] が 1・4 行目の残りが 0 の印を持つ剛体変換だけを拾う */
function readPlacements(rx) {
  const view = new DataView(rx.buffer, rx.byteOffset, rx.byteLength);
  const out = [];
  for (let p = 0; p + 4 <= rx.length; p++) {
    const ones = view.getUint16(p, true), zeros = view.getUint16(p + 2, true);
    if (!(ones & 0x8000) || (zeros & 0x7000) !== 0x7000) continue;
    const r = readMasked(view, p);
    if (!r || !isRigid(r.m)) continue;
    const m = r.m.map((v, i) => (i === 3 || i === 7 || i === 11 ? v * CM_TO_MM : v));
    out.push(m);
    p = r.end - 1;
  }
  return out;
}

/** 出現名（「部品名:番号」）の部品名から参照先を探す（ファイル名、Content Center は表示名） */
function referenceOf(name, refs) {
  const stem = name.replace(/:\d+$/, "");
  const i = refs.findIndex((r) => r.stem === stem || r.display === stem);
  return i >= 0 ? i : null;
}

/**
 * @param {Uint8Array} bytes  .iam ファイルの中身
 * @param {string} name       ファイル名（表示用）
 */
export function parseIam(bytes, name) {
  const doc = openIpt(bytes);
  const segment = (n) => doc.segments.find((s) => s.name === n)?.data ?? new Uint8Array();
  const references = readReferences(doc.streamData.get("UFRxDoc"));
  const names = readOccurrenceNames(segment("AmDcSegment"));
  const placements = readPlacements(segment("AmRxSegment"));
  const paired = names.length === placements.length;
  // 対応づけは ID の順（作成順）で行い、並べる順は名前の一覧の順（組立のブラウザーの並び）に戻す
  const occurrences = names
    .map((n, i) => ({ name: n.name, reference: referenceOf(n.name, references), matrix: paired ? placements[i] : null, at: n.at }))
    .sort((a, b) => a.at - b.at)
    .map(({ at, ...o }) => o);
  const report = {
    file: { name, size: bytes.length },
    thumbnail: doc.thumbnailSize ? { format: "png", width: doc.thumbnailSize[0], height: doc.thumbnailSize[1] } : null,
    segments: doc.segments.map((s) => ({ name: s.name, compressed: s.compressed, data_stored: s.dataStoredSize, data_expanded: s.data.length })),
    references: references.length,
    occurrences: occurrences.length,
    placements: placements.length,
    paired,
  };
  return { references, occurrences, report, thumbnail: doc.thumbnail };
}

/**
 * 組立のシーン（STEP と同じ形）。部品の形状は resolve(reference) が返す .ipt（{ name, bytes }）から読む。
 * 見つからない部品は bodies が空で missing: true（一覧で知らせる）。
 * 配置を読めなかった出現（出現と配置の数が合わない）は原点に置く。部品を特定できない出現は置けないので unplaced に挙げる。
 */
export function buildIamScene(iam, fileName, resolve) {
  const parts = iam.references.map((ref) => {
    const found = resolve(ref);
    let bodies = [], error = null, properties = {};
    if (found) {
      try {
        const parsed = parseIpt(found.bytes, found.name);
        bodies = parsed.scene.bodies;
        properties = parsed.properties;
      } catch (e) {
        error = e.message;
      }
    }
    const density = properties.density_g_per_cm3 ? properties.density_g_per_cm3 / 1000 : null; // g/cm³ → g/mm³
    return { id: ref.path, name: ref.stem, file: ref.file, path: ref.path, display: ref.display, missing: !bodies.length, error, bodies, material: properties.material ?? null, density_g_per_mm3: density };
  });
  const instances = iam.occurrences
    .filter((o) => o.reference !== null)
    .map((o, id) => ({ id, part: o.reference, name: o.name, path: [o.name], matrix: o.matrix ?? IDENTITY }));
  return {
    file: fileName,
    units: "mm",
    kind: "assembly",
    source: { format: "iam" },
    labels,
    root: fileName.replace(/\.[^.]+$/, ""),
    parts,
    instances,
    unplaced: iam.occurrences.filter((o) => o.reference === null).map((o) => o.name),
  };
}
