// DWG のデータの節のうち、オブジェクトを読む前に要るもの（仕様書 10 章 AcDb:Classes・23 章 AcDb:Handles）。
//   readObjectMap(節) → Map<ハンドル, オブジェクトの位置（バイト）>
//   readClasses(節, 版) → Map<クラス番号, { dxfName, cppName, app, isEntity }>（型の番号 500 以上のオブジェクトの種類）

import { BitReader, DwgError, R2004, R2007, R2010 } from "./bits.js";

/**
 * オブジェクトの地図: 大きさ（RS・上位バイトが先）ごとの区切りの中に、ハンドルの差（MC・符号なし）と位置の差（MC・符号つき）が並ぶ。
 * 区切りの大きさが 2（CRC だけ）で終わり
 */
export function readObjectMap(data) {
  const map = new Map();
  const reader = new BitReader(data, 0);
  for (;;) {
    if (reader.bytePos + 2 > data.length) break;
    const size = (data[reader.bytePos] << 8) | data[reader.bytePos + 1];
    reader.skipBytes(2);
    if (size <= 2) break;
    const end = reader.bytePos + Math.min(size - 2, 2032);
    let handle = 0, offset = 0;
    while (reader.bytePos < end) {
      const step = reader.umc();
      handle += step;
      offset += reader.mc();
      if (step > 0) map.set(handle, offset);
    }
    reader.skipBytes(2); // CRC（上位バイトが先）
  }
  return map;
}

const CLASSES_START = [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a];

/** 決まった 16 バイトの印（番兵）で始まっているか */
export function checkSentinel(data, sentinel, what) {
  if (!sentinel.every((b, i) => data[i] === b)) throw new DwgError(`${what}の始まりの印が見つかりません。`);
}

/** クラスの定義: 番号（BS）・印（BS）・アプリ名・C++ のクラス名・DXF の名前（TV）・ゾンビ（B）・項目の種類（BS。0x1F2 = 図形） */
export function readClasses(data, { version, maintenance, decode }) {
  const classes = new Map();
  if (!data) return classes;
  checkSentinel(data, CLASSES_START, "クラスの節");
  const reader = new BitReader(data, 16 * 8, { version, decode });
  const size = reader.url();
  let end = (16 + 4 + size) * 8; // ビット
  if ((version >= R2010 && maintenance > 3) || version > 1027) reader.rl(); // R2010（保守版 4 以降）・R2018: 高い桁の大きさ
  if (version >= R2007) {
    // R2007+: 文字列は節の終わりの「文字列の流れ」にある
    const from = reader.pos; // 大きさ（ビット）は、それ自身の始まりから数える
    const flagPos = from + reader.url() - 1;
    const strings = reader.at(flagPos);
    end = stringStreamStart(strings, flagPos);
    reader.strings = strings;
    reader.bl(); // 最大のクラス番号
    reader.bit();
  }
  if (version === R2004) {
    reader.bs(); // 最大のクラス番号
    reader.byte();
    reader.byte();
    reader.bit();
  }
  // R2004 までは、終わりをバイトで比べる（最後のクラスのあとの、1 バイトに満たない余りは読まない）
  const more = version >= R2007 ? () => reader.pos < end : () => (reader.pos + 7) >> 3 < end >> 3;
  while (more()) {
    const number = reader.bs();
    reader.bs(); // 代理（プロキシ）の印
    const app = reader.text(), cppName = reader.text(), dxfName = reader.text();
    reader.bit();
    const itemClass = reader.bs();
    if (version >= R2004) {
      reader.bl(); // 数
      reader.bl(); // 作った版
      reader.bl(); // 保守版
      reader.bl();
      reader.bl();
    }
    classes.set(number, { dxfName, cppName, app, isEntity: itemClass === 0x1f2 });
  }
  return classes;
}

/**
 * R2007+ の「文字列の流れ」の始まりの位置（ビット）。flagPos は「流れがある」の 1 ビットの位置（オブジェクトなら、ハンドルの前の最後のビット）。
 * 流れが無ければ -1 を返し、読み手を空にする
 */
export function stringStreamStart(reader, flagPos) {
  reader.pos = flagPos;
  if (!reader.bit()) {
    reader.empty = true;
    return flagPos;
  }
  let at = flagPos - 16;
  reader.pos = at;
  let size = reader.urs();
  if (size & 0x8000) {
    at -= 16;
    reader.pos = at;
    const high = reader.urs();
    size = (size & 0x7fff) | (high << 15);
  }
  const start = at - size;
  reader.pos = start;
  return start;
}
