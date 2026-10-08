// PDF の文字の符号 → 文字（Unicode）と送り幅（ISO 32000-1 の 9.5〜9.10）。
// 字形そのもの（埋め込みの書体）は描かず、画面の書体で描く。位置を合わせるため、送り幅（/Widths・/W）は PDF の値を使う。
//   符号の区切り: 単純な書体は 1 バイト、複合の書体（Type0）は符号化の CMap の範囲（Identity は 2 バイト、Shift_JIS などは 1・2 バイト）
//   文字: /ToUnicode → 符号化（基本の表と /Differences の字形名）→ 符号化の CMap（Unicode・Shift_JIS・EUC・GBK・Big5）の順

import { Lexer, PdfName, PdfOp, PdfStream, PdfString } from "./objects.js";

// ---- 字形名 → 文字 -------------------------------------------------------------------------------------------------
// ASCII の字形名（0x20〜0x7E）
const ASCII_NAMES = ("space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen " +
  "period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K " +
  "L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t " +
  "u v w x y z braceleft bar braceright asciitilde").split(" ");
// Latin-1 の上半分（0xA0〜0xFF）
const LATIN1_NAMES = ("space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft " +
  "logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior " +
  "ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla " +
  "Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply " +
  "Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave " +
  "eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash " +
  "ugrave uacute ucircumflex udieresis yacute thorn ydieresis").split(" ");
// そのほかのよく使う字形名
const OTHER_NAMES = {
  Euro: 0x20ac, quotesinglbase: 0x201a, florin: 0x0192, quotedblbase: 0x201e, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021,
  circumflex: 0x02c6, perthousand: 0x2030, Scaron: 0x0160, guilsinglleft: 0x2039, OE: 0x0152, Zcaron: 0x017d, quoteleft: 0x2018,
  quoteright: 0x2019, quotedblleft: 0x201c, quotedblright: 0x201d, bullet: 0x2022, endash: 0x2013, emdash: 0x2014, tilde: 0x02dc,
  ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, trademark: 0x2122, scaron: 0x0161, guilsinglright: 0x203a, oe: 0x0153, zcaron: 0x017e, Ydieresis: 0x0178, minus: 0x2212, fi: 0xfb01,
  fl: 0xfb02, dotlessi: 0x0131, Lslash: 0x0141, lslash: 0x0142, fraction: 0x2044, ogonek: 0x02db, ring: 0x02da, hungarumlaut: 0x02dd,
  caron: 0x02c7, breve: 0x02d8, dotaccent: 0x02d9, Omega: 0x03a9, Delta: 0x2206, pi: 0x03c0, summation: 0x2211, infinity: 0x221e,
  lessequal: 0x2264, greaterequal: 0x2265, notequal: 0x2260, approxequal: 0x2248, radical: 0x221a, partialdiff: 0x2202, integral: 0x222b,
  product: 0x220f, lozenge: 0x25ca, nbspace: 0x00a0, sfthyphen: 0x00ad, middot: 0x00b7, mu1: 0x00b5, Ohm: 0x2126, diameter: 0x2300,
  alpha: 0x03b1, beta: 0x03b2, gamma: 0x03b3, delta: 0x03b4, epsilon: 0x03b5, theta: 0x03b8, lambda: 0x03bb, sigma: 0x03c3, phi: 0x03c6,
  omega: 0x03c9, Phi: 0x03a6, Sigma: 0x03a3, Theta: 0x0398, arrowright: 0x2192, arrowleft: 0x2190, arrowup: 0x2191, arrowdown: 0x2193,
};
const GLYPHS = new Map();
ASCII_NAMES.forEach((n, i) => GLYPHS.set(n, 0x20 + i));
LATIN1_NAMES.forEach((n, i) => GLYPHS.has(n) || GLYPHS.set(n, 0xa0 + i));
for (const [n, u] of Object.entries(OTHER_NAMES)) GLYPHS.set(n, u);

/** 字形名 → 文字（uniXXXX・uXXXX[XX]・a.sc のような後ろの付け足しも読む）。分からなければ null */
export function glyphToUnicode(name) {
  if (GLYPHS.has(name)) return String.fromCodePoint(GLYPHS.get(name));
  const base = name.split(".")[0].split("_")[0];
  if (base !== name && GLYPHS.has(base)) return String.fromCodePoint(GLYPHS.get(base));
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(base);
  if (m) {
    let s = "";
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return null;
}

// ---- 基本の符号化 --------------------------------------------------------------------------------------------------
const decodeTable = (label) => {
  const d = new TextDecoder(label);
  return Array.from({ length: 256 }, (_, c) => (c < 0x20 ? null : d.decode(Uint8Array.of(c)))); // 制御文字の符号は字形が無い
};
// StandardEncoding（Adobe の標準）: ASCII と違うのは 0x27・0x60 と上半分
const STANDARD = Array(256).fill(null);
ASCII_NAMES.forEach((n, i) => (STANDARD[0x20 + i] = n));
STANDARD[0x27] = "quoteright";
STANDARD[0x60] = "quoteleft";
"exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl"
  .split(" ").forEach((n, i) => (STANDARD[0xa1 + i] = n));
"endash dagger daggerdbl periodcentered".split(" ").forEach((n, i) => (STANDARD[0xb1 + i] = n));
"paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand".split(" ").forEach((n, i) => (STANDARD[0xb6 + i] = n));
STANDARD[0xbf] = "questiondown";
"grave acute circumflex tilde macron breve dotaccent dieresis".split(" ").forEach((n, i) => (STANDARD[0xc1 + i] = n));
Object.assign(STANDARD, { 0xca: "ring", 0xcb: "cedilla", 0xcd: "hungarumlaut", 0xce: "ogonek", 0xcf: "caron", 0xd0: "emdash", 0xe1: "AE",
  0xe3: "ordfeminine", 0xe8: "Lslash", 0xe9: "Oslash", 0xea: "OE", 0xeb: "ordmasculine", 0xf1: "ae", 0xf5: "dotlessi", 0xf8: "lslash",
  0xf9: "oslash", 0xfa: "oe", 0xfb: "germandbls" });

let tables = null;
/** 符号化の名前 → 符号 → 文字 の表 */
function baseTable(name) {
  tables ??= {
    WinAnsiEncoding: decodeTable("windows-1252"),
    MacRomanEncoding: decodeTable("macintosh"),
    StandardEncoding: STANDARD.map((n) => (n ? glyphToUnicode(n) : null)),
    PDFDocEncoding: decodeTable("windows-1252"),
  };
  return tables[name] ?? null;
}

// ---- CMap（文字の対応の表） ----------------------------------------------------------------------------------------
/** CMap のストリームを読む: 符号の範囲（区切り方）・符号 → 文字（ToUnicode）・符号 → CID */
export function parseCMap(bytes) {
  const lexer = new Lexer(bytes);
  const ranges = [], unicode = new Map(), cids = [];
  let usecmap = null;
  const toHex = (s) => (s instanceof PdfString ? s.bytes : null);
  const code = (b) => b.reduce((v, x) => v * 256 + x, 0);
  const text = (b) => {
    if (b.length % 2) return String.fromCharCode(...b);
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  };
  const stack = [];
  for (;;) {
    const t = lexer.next();
    if (t?.mark === "EOF") break;
    if (!(t instanceof PdfOp)) {
      if (t?.mark === "[") {
        const arr = [];
        for (let v = lexer.next(); v?.mark !== "]" && v?.mark !== "EOF"; v = lexer.next()) arr.push(v);
        stack.push(arr);
      } else stack.push(t);
      continue;
    }
    switch (t.op) {
      case "usecmap":
        usecmap = stack.at(-1) instanceof PdfName ? stack.at(-1).name : null;
        break;
      case "endcodespacerange":
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const lo = toHex(stack[i]), hi = toHex(stack[i + 1]);
          if (lo && hi) ranges.push({ bytes: lo.length, lo: code(lo), hi: code(hi) });
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const src = toHex(stack[i]), dst = stack[i + 1];
          if (src) unicode.set(code(src), dst instanceof PdfName ? glyphToUnicode(dst.name) ?? "" : toHex(dst) ? text(toHex(dst)) : "");
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = toHex(stack[i]), hi = toHex(stack[i + 1]), dst = stack[i + 2];
          if (!lo || !hi) continue;
          const a = code(lo), b = Math.min(code(hi), a + 65535);
          if (Array.isArray(dst)) dst.forEach((d, k) => a + k <= b && toHex(d) && unicode.set(a + k, text(toHex(d))));
          else if (toHex(dst)) {
            const base = toHex(dst).slice();
            for (let c = a; c <= b; c++) {
              unicode.set(c, text(base));
              base[base.length - 1]++; // 最後のバイトを 1 ずつ進める
            }
          }
        }
        break;
      case "endcidrange":
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = toHex(stack[i]), hi = toHex(stack[i + 1]);
          if (lo && hi && typeof stack[i + 2] === "number") cids.push({ lo: code(lo), hi: code(hi), cid: stack[i + 2] });
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const c = toHex(stack[i]);
          if (c && typeof stack[i + 1] === "number") cids.push({ lo: code(c), hi: code(c), cid: stack[i + 1] });
        }
        break;
    }
    if (t.op.startsWith("begin") || t.op.startsWith("end") || t.op === "def" || t.op === "usecmap") stack.length = 0;
  }
  return { ranges, unicode, cids, usecmap };
}

// 名前の決まった CMap（符号化の名前 → 区切り方と、文字への戻し方）
const PREDEFINED = [
  [/^Identity-[HV]$/, { ranges: [{ bytes: 2, lo: 0, hi: 0xffff }], decoder: null, identity: true }],
  [/UCS2-[HV]$/, { ranges: [{ bytes: 2, lo: 0, hi: 0xffff }], decoder: "utf-16be" }],
  [/UTF16-[HV]$/, { ranges: [{ bytes: 2, lo: 0, hi: 0xd7ff }, { bytes: 4, lo: 0xd800dc00, hi: 0xdbffdfff }, { bytes: 2, lo: 0xe000, hi: 0xffff }], decoder: "utf-16be" }],
  [/RKSJ-[HV]$/, { ranges: [{ bytes: 1, lo: 0, hi: 0x80 }, { bytes: 1, lo: 0xa0, hi: 0xdf }, { bytes: 2, lo: 0x8140, hi: 0x9ffc }, { bytes: 2, lo: 0xe040, hi: 0xfcfc }], decoder: "shift_jis" }],
  [/EUC-[HV]$/, { ranges: [{ bytes: 1, lo: 0, hi: 0x80 }, { bytes: 2, lo: 0x8ea0, hi: 0x8edf }, { bytes: 2, lo: 0xa1a1, hi: 0xfefe }], decoder: "euc-jp" }],
  // H・V: JIS X 0208 の 2 バイト（区点の各バイトに 0x80 を足すと EUC-JP）
  [/^[HV]$/, { ranges: [{ bytes: 2, lo: 0x2121, hi: 0x7e7e }], decoder: "euc-jp", offset: 0x80 }],
  [/^GB.*-[HV]$/, { ranges: [{ bytes: 1, lo: 0, hi: 0x80 }, { bytes: 2, lo: 0x8140, hi: 0xfefe }], decoder: "gbk" }],
  [/^(B5|ETen|HKscs).*-[HV]$/, { ranges: [{ bytes: 1, lo: 0, hi: 0x80 }, { bytes: 2, lo: 0x8140, hi: 0xfefe }], decoder: "big5" }],
  [/^KSC.*-[HV]$/, { ranges: [{ bytes: 1, lo: 0, hi: 0x80 }, { bytes: 2, lo: 0x8141, hi: 0xfefe }], decoder: "euc-kr" }],
];

// ---- 書体 ----------------------------------------------------------------------------------------------------------
/**
 * 書体の辞書 → 符号を文字と送り幅に戻すもの。
 * @returns {{ name, family, weight, italic, type, vertical, widthsKnown, capHeight, matrix, decode: (bytes) => [{ code, text, width, space }] }}
 *   width は文字の空間の単位（1000 で文字の大きさ 1）。Type3 は字形の空間を /FontMatrix で掛けて同じ単位にする
 */
export function loadFont(pdf, dict) {
  const type = pdf.name(dict, "Subtype") ?? "Type1";
  const baseFont = pdf.name(dict, "BaseFont") ?? "";
  const name = baseFont.replace(/^[A-Z]{6}\+/, ""); // 部分の埋め込みの印（ABCDEF+）を除く
  const toUnicode = streamCMap(pdf, pdf.get(dict.get("ToUnicode")));
  if (type === "Type0") return compositeFont(pdf, dict, name, toUnicode);
  return simpleFont(pdf, dict, type, name, toUnicode);
}

function streamCMap(pdf, v) {
  if (!(v instanceof PdfStream)) return null;
  const bytes = pdf.bytesOf(v);
  return bytes ? parseCMap(bytes) : null;
}

/** 書体の見た目の手がかり（画面の書体を選ぶ） */
function styleOf(pdf, name, descriptor) {
  const flags = pdf.value(descriptor, "Flags", 0);
  const lower = name.toLowerCase();
  const family = flags & 1 || /courier|mono|consol|ocr/.test(lower) ? "monospace"
    : flags & 2 || /times|serif|mincho|ming|song|batang|明朝/.test(lower) ? "serif" : "sans-serif";
  const weight = (pdf.value(descriptor, "FontWeight", 0) >= 600 || flags & 0x40000 || /bold|black|heavy|semibold|w[6-9]\b/.test(lower)) ? 700 : 400;
  const italic = Boolean(flags & 0x40) || /italic|oblique/.test(lower) || Math.abs(pdf.value(descriptor, "ItalicAngle", 0)) > 1;
  const cap = pdf.value(descriptor, "CapHeight", 0);
  return { family, weight, italic, capHeight: cap > 100 && cap < 1200 ? cap / 1000 : 0.72 };
}

function simpleFont(pdf, dict, type, name, toUnicode) {
  const descriptor = pdf.value(dict, "FontDescriptor");
  const style = styleOf(pdf, name, descriptor);
  // 符号 → 文字: 基本の表（無ければ、記号の書体でなければ StandardEncoding）と /Differences
  const encoding = pdf.get(dict.get("Encoding"));
  const symbolic = Boolean(pdf.value(descriptor, "Flags", 0) & 4) && !(pdf.value(descriptor, "Flags", 0) & 32);
  let table = (baseTable(encoding instanceof PdfName ? encoding.name : pdf.name(encoding, "BaseEncoding")) ??
    (symbolic || type === "TrueType" || type === "Type3" ? baseTable("WinAnsiEncoding") : baseTable("StandardEncoding"))).slice();
  const names = Array(256).fill(null);
  const differences = encoding instanceof Map ? pdf.value(encoding, "Differences") : null;
  if (Array.isArray(differences)) {
    let code = 0;
    for (const d of differences.map((x) => pdf.get(x))) {
      if (typeof d === "number") code = d;
      else if (d instanceof PdfName && code < 256) {
        names[code] = d.name;
        table[code] = glyphToUnicode(d.name) ?? table[code];
        code++;
      }
    }
  }
  if (/symbol|dingbat|wingding/i.test(name) && !differences && !toUnicode) table = table.map((c, i) => (i >= 0x20 ? String.fromCharCode(i) : c));
  // 送り幅
  const first = pdf.value(dict, "FirstChar", 0);
  const widths = (pdf.value(dict, "Widths") ?? []).map((w) => Number(pdf.get(w)) || 0);
  const missing = pdf.value(descriptor, "MissingWidth", 0);
  let matrix = [0.001, 0, 0, 0.001, 0, 0];
  if (type === "Type3") matrix = (pdf.numbers(dict, "FontMatrix") ?? matrix);
  const unitsPerText = type === "Type3" ? matrix[0] * 1000 : 1; // Type3: 字形の空間 → 1000 で 1 の単位
  const standardWidth = standard14Width(name);
  const widthsKnown = widths.length > 0 || standardWidth !== null;
  return {
    name, ...style, type, vertical: false, widthsKnown, matrix,
    charProcs: type === "Type3" ? pdf.value(dict, "CharProcs") : null, glyphNames: names, resources: pdf.value(dict, "Resources"),
    decode(bytes) {
      const out = [];
      for (const code of bytes) {
        const w = widths[code - first];
        const width = (w !== undefined ? w : standardWidth ?? missing) * unitsPerText;
        const text = toUnicode?.unicode.get(code) ?? table[code] ?? "";
        out.push({ code, text, width, space: code === 32 });
      }
      return out;
    },
  };
}

/** 埋め込まれていない標準の 14 書体の送り幅（Courier は全て 600。ほかは文字ごとに違うので、分からない = null） */
function standard14Width(name) {
  return /^Courier/i.test(name) ? 600 : null;
}

function compositeFont(pdf, dict, name, toUnicode) {
  const descendant = pdf.get((pdf.value(dict, "DescendantFonts") ?? [])[0]);
  const descriptor = pdf.value(descendant, "FontDescriptor");
  const style = styleOf(pdf, name, descriptor);
  // 符号化の CMap: 名前（決まったもの）か、ストリーム
  const encoding = pdf.get(dict.get("Encoding"));
  let ranges = null, decoder = null, identity = false, cidRanges = [], offset = 0;
  const encName = encoding instanceof PdfName ? encoding.name : encoding instanceof PdfStream ? pdf.name(encoding.dict, "CMapName") : null;
  if (encoding instanceof PdfStream) {
    const cmap = streamCMap(pdf, encoding);
    ranges = cmap?.ranges.length ? cmap.ranges : null;
    cidRanges = cmap?.cids ?? [];
    const parent = cmap?.usecmap && PREDEFINED.find(([re]) => re.test(cmap.usecmap))?.[1];
    if (parent) {
      ranges ??= parent.ranges;
      decoder = parent.decoder;
      identity = parent.identity ?? false;
    }
  }
  const predefined = encName && PREDEFINED.find(([re]) => re.test(encName))?.[1];
  if (predefined) {
    ranges ??= predefined.ranges;
    decoder ??= predefined.decoder;
    identity ||= predefined.identity ?? false;
    offset = predefined.offset ?? 0;
  }
  ranges ??= toUnicode?.ranges.length ? toUnicode.ranges : [{ bytes: 2, lo: 0, hi: 0xffff }];
  if (encoding instanceof PdfStream && !predefined) identity ||= /Identity/.test(encName ?? "");
  const textDecoder = decoder ? new TextDecoder(decoder) : null;
  const vertical = /-V$/.test(encName ?? "");
  // CID → 送り幅（/W: c [w1 w2 …] か c_first c_last w）
  const dw = pdf.value(descendant, "DW", 1000);
  const w = new Map();
  const list = (pdf.value(descendant, "W") ?? []).map((x) => pdf.get(x));
  for (let i = 0; i < list.length;) {
    const c = list[i];
    if (Array.isArray(list[i + 1])) {
      list[i + 1].map((x) => pdf.get(x)).forEach((v, k) => w.set(c + k, v));
      i += 2;
    } else {
      for (let k = c; k <= list[i + 1] && k - c < 65536; k++) w.set(k, list[i + 2]);
      i += 3;
    }
  }
  const cidOf = (code) => {
    if (identity) return code;
    for (const r of cidRanges) if (code >= r.lo && code <= r.hi) return r.cid + code - r.lo;
    return null;
  };
  return {
    name, ...style, type: "Type0", vertical, widthsKnown: identity || cidRanges.length > 0, matrix: [0.001, 0, 0, 0.001, 0, 0],
    decode(bytes) {
      const out = [];
      for (let i = 0; i < bytes.length;) {
        // 範囲に合う最も短い長さで区切る（合わなければ 1 バイト）
        let n = 0, code = 0;
        for (let len = 1; len <= 4 && i + len <= bytes.length && !n; len++) {
          const c = bytes.subarray(i, i + len).reduce((v, x) => v * 256 + x, 0);
          if (ranges.some((r) => r.bytes === len && c >= r.lo && c <= r.hi)) {
            n = len;
            code = c;
          }
        }
        if (!n) {
          n = Math.min(ranges[0]?.bytes ?? 1, bytes.length - i);
          code = bytes.subarray(i, i + n).reduce((v, x) => v * 256 + x, 0);
        }
        const raw = bytes.subarray(i, i + n);
        i += n;
        const cid = cidOf(code);
        let text = toUnicode?.unicode.get(code);
        if (text === undefined && textDecoder) text = textDecoder.decode(offset ? raw.map((b) => b + offset) : raw);
        text ??= "";
        // 送り幅: CID が分かれば /W、分からなければ（Shift_JIS などの決まった CMap）半角 500・全角 /DW
        const width = cid !== null ? w.get(cid) ?? dw : /^[\x20-\x7e｡-ﾟ]$/.test(text) ? 500 : dw;
        out.push({ code, text, width, space: n === 1 && code === 32 });
      }
      return out;
    },
  };
}

