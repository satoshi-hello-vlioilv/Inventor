// DWG の見出しの変数（仕様書 9 章 AcDb:Header）のうち、表示に要るもの（線種の尺度 $LTSCALE・単位 $INSUNITS など）を読む。
//   readHeader(節, { version, maintenance }) → { ltscale, celtscale, psltscale, lunits, insunits, textsize, dimscale, extmin, extmax, … }
// 変数は決まった順に詰めて並ぶ（版ごとに有る・無いが変わる）。欲しい $INSUNITS は先頭から 289 番目なので、その前の全てを型どおりに読み飛ばす。
// 並び（LAYOUT）は仕様書の表を、ACadSharp（MIT）の DwgHeaderReader の読みと突き合わせて作った。ACadSharp の見本の DWG（R2000〜R2018）と
// 同じ図面の DXF の値で確かめてある（tests/js/dwg-header.test.mjs）。
// 名前を付けた変数には、表示には使わず、並びのずれを確かめるためのもの（範囲・日時など、既定でない値になるもの）も含む。
// 日時は DWG では世界時（DXF の $TDUCREATE。$TDCREATE は地方時）。[ユリウス日, その日のミリ秒]。
// R2007+: 文字列（TV）は節の終わりの「文字列の流れ」、ハンドル（H）は別の流れにあるので、本体の流れからは読まない

import { BitReader, DwgError, R2000, R2004, R2007, R2010, R2013, R2018 } from "./bits.js";
import { checkSentinel } from "./sections.js";

const HEADER_START = [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f];

// 型[@版の条件][*くり返し][:名前]。HM はどの版も本体の流れにあるハンドル（HANDSEED）。条件: 14 = R13〜R14 だけ・15 = R13〜R2000 だけ・2000+ など = その版から・2004- = R2004 より前
const LAYOUT = `
BLL@2013+ BD*4 TV*4 BL*2 BS@14 H@2004- B*2 B@14 B*5 B:psltscale B B@14 B@2004+ B*4 B@14*2 B*2 B@14 B*3 B@14 B*2 BS BS@14 BS
BS:lunits BS*3 BS@14 BS BS@14 BS BS@14 BL@2004+*3 BS*19 BD:ltscale BD:textsize BD*18 BD:celtscale TV 2BL:tducreate 2BL:tduupdate BL@2004+*3
2BL:tdindwg 2BL CMC HM H*3 H@2007+ H*2 BD@2000+ 3BD*3 2RD*2 BD 3BD*3 H H@2000+ BS@2000+ H@2000+ 3BD@2000+*6 3BD 3BD:extmin 3BD:extmax 2RD*2
BD 3BD*3 H H@2000+ BS@2000+ H@2000+ 3BD@2000+*6 TV@2000+*2 B@14*11 RC@14*2 B@14*2 RC@14*3 B@14 RC@14*4 BS@14*6 H@14 BD:dimscale
BD*8 BD@2007+*2 BS@2007+ CMC@2007+ B@2000+*6 BS@2000+*3 BS@2007+ BD*8 TV@14*5 BD@2000+ B@2000+ BS@2000+ B@2000+*4 CMC*3
BS@2000+*11 B@2000+*2 BS@2000+*4 B@2000+ BS@2000+ B@2007+ B@2010+ BD@2010+ TV@2010+ BD@2010+ TV@2010+ H@2000+*5 H@2007+*3
BS@2000+*2 H*9 H@15 H*3 BS@2000+*2 TV@2000+*2 H@2000+*3 H@2004+*2 H@2007+ H@2013+ BL@2000+ BS@2000+:insunits
`.trim().split(/\s+/);

const CONDITION = {
  "": () => true, 14: (v) => v < R2000, 15: (v) => v <= R2000, "2000+": (v) => v >= R2000, "2004+": (v) => v >= R2004,
  "2004-": (v) => v < R2004, "2007+": (v) => v >= R2007, "2010+": (v) => v >= R2010, "2013+": (v) => v >= R2013,
};

/** 型ごとの読み方（R2007+ の文字列とハンドルは別の流れなので読まない） */
const READ = {
  B: (r) => r.bit(), BS: (r) => r.bs(), BL: (r) => r.bl(), BLL: (r) => r.bll(), BD: (r) => r.bd(), RC: (r) => r.byte(), RL: (r) => r.rl(),
  "3BD": (r) => [r.bd(), r.bd(), r.bd()], "2RD": (r) => [r.rd(), r.rd()], "2BL": (r) => [r.bl(), r.bl()], CMC: (r) => r.cmc(),
  TV: (r) => (r.version >= R2007 ? "" : r.text()), H: (r) => (r.version >= R2007 ? 0 : r.handle()),
  HM: (r) => r.handle(), // HANDSEED: どの版も本体の流れにある
};

export function readHeader(data, { version, maintenance = 0 }) {
  if (!data) throw new DwgError("DWG の見出しの変数の節（AcDb:Header）が見つかりません。");
  checkSentinel(data, HEADER_START, "見出しの変数の節");
  const r = new BitReader(data, 16 * 8, { version });
  r.rl(); // 節の大きさ
  if ((version >= R2010 && maintenance > 3) || version >= R2018) r.rl(); // 大きさの上位
  if (version >= R2007) r.rl(); // 本体の流れの大きさ（ビット）
  const out = {};
  for (const item of LAYOUT) {
    const [, type, cond = "", count = "1", name] = /^([0-9A-Z]+)(?:@([0-9+-]+))?(?:\*(\d+))?(?::(\w+))?$/.exec(item) ?? [];
    if (!type || !READ[type] || !CONDITION[cond]) throw new DwgError(`見出しの変数の並びの書き方が分かりません: ${item}`);
    if (!CONDITION[cond](version)) continue;
    for (let i = 0; i < Number(count); i++) {
      const value = READ[type](r);
      if (name) out[name] = value;
    }
  }
  return out;
}
