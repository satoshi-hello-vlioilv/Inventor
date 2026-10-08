// PDF のページの中身（内容ストリーム）を実行し、描くもの（パス・文字・画像）を順に受け手に渡す（ISO 32000-1 の 8・9）。
// 座標は全て、受け手の座標（ページの左下を原点、mm。ページの回転も入れた後）にしてから渡す。
//
//   受け手 sink:
//     path({ subpaths, stroke: { color, width, dashes, cap, alpha } | null, fill: { color, rule, alpha } | null, layer, clip })
//       subpaths: [{ points: [x, y, …] の線分と、curves: 3 次ベジェの区間 [i（points の何点目から）, c1x, c1y, c2x, c2y] , closed }]
//     text({ text, origin: [x, y], end: [x, y] | null, height（文字の大きさ em, mm）, angle, oblique, mirror, color, font, layer, clip })
//     image({ matrix: [a, b, c, d, e, f]（画像の単位の正方形 → 受け手の座標）, image, layer, clip })
//     unsupported(種類)
//   色は "#rrggbb"。layer は画層（OCG の辞書）か null。clip は切り取りの外形 { min, max } か null（任意の形の切り取りは外形で近似）

import { drawAnnotation } from "./annotations.js";
import { CMYK, GRAY, RGB, colorSpace, shadingColor } from "./colorspace.js";
import { loadFont } from "./fonts.js";
import { decodeImage } from "./images.js";
import { DICT_END, Lexer, PdfName, PdfOp, PdfStream, PdfString, parseDict, parseValue, pdfName } from "./objects.js";

const MAX_DEPTH = 12; // 入れ子の XObject・Type3 の字形の深さの上限
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** 行列の積 a × b（PDF の [a b c d e f]。点は行ベクトル: [x y 1] × M） */
export const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 0;

/**
 * ページの中身を実行する。
 * @param {import("./file.js").PdfFile} pdf
 * @param {{ dict, resources, contents: Uint8Array[] }} page
 * @param {number[]} base ページの空間 → 受け手の座標 の行列
 */
export function runPage(pdf, page, base, sink, { layers = new Map() } = {}) {
  const interp = new Interpreter(pdf, sink, layers);
  const contents = pdf.value(page.dict, "Contents");
  const streams = Array.isArray(contents) ? contents : contents ? [page.dict.get("Contents")] : [];
  // ページの中身は、ストリームの境目で字句が切れてもよい（つないで 1 つとして読む）
  const parts = streams.map((s) => pdf.bytesOf(s)).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    bytes[at + p.length] = 10;
    at += p.length + 1;
  }
  interp.run(bytes, page.resources, base);
  interp.annotations(page, base);
  return interp;
}

const is3dAnnotation = (subtype) => subtype === "3D" || subtype === "RichMedia";
const appearanceOf = (pdf, annot) => {
  const ap = pdf.value(pdf.value(annot, "AP"), "N");
  return ap instanceof Map && !(ap instanceof PdfStream) ? pdf.value(ap, pdf.name(annot, "AS") ?? "") : ap;
};
const isShown = (pdf, annot, rect) => !(pdf.name(annot, "Subtype") === "Popup" || pdf.value(annot, "F", 0) & (2 | 32) || !rect); // 隠す・画面に出さない
const hasLook = (pdf, ap) => ap instanceof PdfStream && Boolean(pdf.bytesOf(ap)?.length);

/**
 * ページの 3D の注記（ページの中身は実行しない。開いたときに 3D の有無を知るため）。
 * @returns {{ annot: Map, rect: { min, max } | null, subtype, poster: boolean }[]}  poster … 3D を動かす前の絵（見た目）を描くか
 */
export function annotations3d(pdf, page, base) {
  const out = [];
  for (const ref of pdf.value(page.dict, "Annots") ?? []) {
    const annot = pdf.get(ref);
    if (!(annot instanceof Map)) continue;
    const subtype = pdf.name(annot, "Subtype");
    if (!is3dAnnotation(subtype)) continue;
    const rect = pdf.numbers(annot, "Rect");
    out.push({ annot, rect: rect && boundsOfRect(rect, base), subtype, poster: isShown(pdf, annot, rect) && hasLook(pdf, appearanceOf(pdf, annot)) });
  }
  return out;
}

class Interpreter {
  constructor(pdf, sink, layers) {
    this.pdf = pdf;
    this.sink = sink;
    this.layers = layers; // OCG の辞書 → 画層
    this.fonts = new Map();
    this.depth = 0;
  }

  // ---- 状態 --------------------------------------------------------------------------------------------------------
  #initialState(ctm) {
    return {
      ctm, clip: null,
      strokeColor: "#000000", fillColor: "#000000", strokeSpace: GRAY, fillSpace: GRAY, strokeAlpha: 1, fillAlpha: 1,
      width: 1, dashes: [], phase: 0, cap: 0, join: 0,
      font: null, size: 0, charSpace: 0, wordSpace: 0, scaleH: 1, leading: 0, rise: 0, render: 0,
      fillPattern: null,
    };
  }

  /**
   * 内容ストリームを実行する（ページ・フォームの XObject・注記の見た目）。
   * state: 始めの状態（フォームは呼んだ側の状態を受け継ぐ）。省けば既定の状態
   */
  run(bytes, resources, ctm, { layer = null, state = null } = {}) {
    if (this.depth > MAX_DEPTH) return;
    this.depth++;
    const saved = { state: this.state, stack: this.stack, resources: this.resources, path: this.path, mc: this.mc, text: this.text };
    this.state = state ? { ...state, ctm, dashes: state.dashes.slice() } : this.#initialState(ctm);
    this.stack = [];
    this.resources = resources;
    this.path = [];
    this.mc = layer ? [layer] : []; // 印の付いた内容の入れ子（画層。画層でない印は null）
    this.text = { tm: IDENTITY, tlm: IDENTITY };
    try {
      this.#execute(bytes);
    } finally {
      Object.assign(this, saved);
      this.depth--;
    }
  }

  get layer() {
    for (let i = this.mc.length - 1; i >= 0; i--) if (this.mc[i]) return this.mc[i];
    return null;
  }

  #execute(bytes) {
    const lexer = new Lexer(bytes);
    const operands = [];
    for (;;) {
      const t = lexer.next();
      if (t?.mark === "EOF") break;
      if (t instanceof PdfOp) {
        if (t.op === "BI") {
          this.#inlineImage(lexer);
          operands.length = 0;
          continue;
        }
        try {
          this.#op(t.op, operands);
        } catch {
          this.sink.unsupported("読めない命令");
        }
        operands.length = 0;
      } else if (operands.push(parseValue(lexer, false, t)) > 4096) operands.length = 0; // 命令の無い値の並び（壊れた中身）
    }
  }

  // ---- 命令 --------------------------------------------------------------------------------------------------------
  #op(op, a) {
    const s = this.state;
    const n = (i) => (typeof a[i] === "number" ? a[i] : 0);
    switch (op) {
      // 状態
      case "q": this.stack.push({ ...s, dashes: s.dashes.slice() }); if (this.stack.length > 256) this.stack.shift(); return;
      case "Q": if (this.stack.length) this.state = this.stack.pop(); return;
      case "cm": s.ctm = multiply(a.slice(0, 6).map((v) => Number(v) || 0), s.ctm); return;
      case "w": s.width = n(0); return;
      case "J": s.cap = n(0); return;
      case "j": s.join = n(0); return;
      case "M": return;
      case "d": s.dashes = Array.isArray(a[0]) ? a[0].map(Number) : []; s.phase = n(1); return;
      case "ri": case "i": return;
      case "gs": return this.#extGState(a[0]);
      // パスを作る
      case "m": this.path.push({ points: [...apply(s.ctm, n(0), n(1))], curves: [], closed: false }); return;
      case "l": this.#current().points.push(...apply(s.ctm, n(0), n(1))); return;
      case "c": return this.#curve(apply(s.ctm, n(0), n(1)), apply(s.ctm, n(2), n(3)), apply(s.ctm, n(4), n(5)));
      case "v": { const p = this.#current().points; return this.#curve([p.at(-2), p.at(-1)], apply(s.ctm, n(0), n(1)), apply(s.ctm, n(2), n(3))); }
      case "y": { const end = apply(s.ctm, n(2), n(3)); return this.#curve(apply(s.ctm, n(0), n(1)), end, end); }
      case "h": if (this.path.length) this.path.at(-1).closed = true; return;
      case "re": {
        const [x, y, w, h] = [n(0), n(1), n(2), n(3)];
        this.path.push({ points: [...apply(s.ctm, x, y), ...apply(s.ctm, x + w, y), ...apply(s.ctm, x + w, y + h), ...apply(s.ctm, x, y + h)], curves: [], closed: true });
        return;
      }
      // パスを描く
      case "S": return this.#paint(true, null);
      case "s": this.#op("h", a); return this.#paint(true, null);
      case "f": case "F": return this.#paint(false, "nonzero");
      case "f*": return this.#paint(false, "evenodd");
      case "B": return this.#paint(true, "nonzero");
      case "B*": return this.#paint(true, "evenodd");
      case "b": this.#op("h", a); return this.#paint(true, "nonzero");
      case "b*": this.#op("h", a); return this.#paint(true, "evenodd");
      case "n": return this.#paint(false, null);
      case "W": case "W*": this.clipPending = true; return;
      // 色
      case "G": s.strokeSpace = GRAY; s.strokeColor = GRAY.rgb([n(0)]); return;
      case "g": s.fillSpace = GRAY; s.fillColor = GRAY.rgb([n(0)]); s.fillPattern = null; return;
      case "RG": s.strokeSpace = RGB; s.strokeColor = RGB.rgb([n(0), n(1), n(2)]); return;
      case "rg": s.fillSpace = RGB; s.fillColor = RGB.rgb([n(0), n(1), n(2)]); s.fillPattern = null; return;
      case "K": s.strokeSpace = CMYK; s.strokeColor = CMYK.rgb([n(0), n(1), n(2), n(3)]); return;
      case "k": s.fillSpace = CMYK; s.fillColor = CMYK.rgb([n(0), n(1), n(2), n(3)]); s.fillPattern = null; return;
      case "CS": s.strokeSpace = this.#colorSpace(a[0]); s.strokeColor = s.strokeSpace.rgb(s.strokeSpace.initial); return;
      case "cs": s.fillSpace = this.#colorSpace(a[0]); s.fillColor = s.fillSpace.rgb(s.fillSpace.initial); s.fillPattern = null; return;
      case "SC": case "SCN": return this.#setColor(a, true);
      case "sc": case "scn": return this.#setColor(a, false);
      case "sh": return this.#shading(a[0]);
      // XObject
      case "Do": return this.#xobject(a[0]);
      // 印の付いた内容（画層）
      case "BMC": this.mc.push(null); return;
      case "BDC": this.mc.push(this.#markedLayer(a[0], a[1])); return;
      case "EMC": this.mc.pop(); return;
      case "MP": case "DP": return;
      // 文字
      case "BT": this.text = { tm: IDENTITY, tlm: IDENTITY }; return;
      case "ET": return;
      case "Tc": s.charSpace = n(0); return;
      case "Tw": s.wordSpace = n(0); return;
      case "Tz": s.scaleH = n(0) / 100; return;
      case "TL": s.leading = n(0); return;
      case "Ts": s.rise = n(0); return;
      case "Tr": s.render = n(0); return;
      case "Tf": s.font = this.#font(a[0]); s.size = n(1); return;
      case "Td": return this.#moveText(n(0), n(1));
      case "TD": s.leading = -n(1); return this.#moveText(n(0), n(1));
      case "Tm": this.text.tm = this.text.tlm = a.slice(0, 6).map((v) => Number(v) || 0); return;
      case "T*": return this.#moveText(0, -s.leading);
      case "Tj": return this.#show([a[0]]);
      case "TJ": return this.#show(Array.isArray(a[0]) ? a[0] : []);
      case "'": this.#moveText(0, -s.leading); return this.#show([a[0]]);
      case "\"": s.wordSpace = n(0); s.charSpace = n(1); this.#moveText(0, -s.leading); return this.#show([a[2]]);
      case "d0": case "d1": return;
      case "BX": case "EX": return;
    }
  }

  #current() {
    if (!this.path.length) this.path.push({ points: [0, 0], curves: [], closed: false });
    return this.path.at(-1);
  }

  #curve(c1, c2, end) {
    const sub = this.#current();
    sub.curves.push([sub.points.length / 2 - 1, c1[0], c1[1], c2[0], c2[1]]);
    sub.points.push(end[0], end[1]);
  }

  #paint(stroke, fill) {
    const s = this.state;
    const subpaths = this.path.filter((p) => p.points.length >= 4 || (p.closed && p.points.length >= 2));
    if (this.clipPending) {
      this.clipPending = false;
      s.clip = intersect(s.clip, bounds(this.path));
    }
    this.path = [];
    if (!subpaths.length || (!stroke && !fill)) return;
    const scale = scaleOf(s.ctm);
    this.sink.path({
      subpaths, layer: this.layer, clip: s.clip,
      stroke: stroke ? { color: s.strokeColor, width: s.width * scale, dashes: s.dashes.map((d) => d * scale), cap: s.cap, alpha: s.strokeAlpha } : null,
      fill: fill ? { color: s.fillPattern ?? s.fillColor, rule: fill, alpha: s.fillAlpha } : null,
    });
  }

  // ---- 色 ----------------------------------------------------------------------------------------------------------
  #colorSpace(v) {
    return colorSpace(this.pdf, v, this.resources);
  }

  #setColor(a, stroke) {
    const s = this.state;
    const space = stroke ? s.strokeSpace : s.fillSpace;
    const last = a.at(-1);
    if (last instanceof PdfName) {
      // 模様: 色の値がある（色の無い模様）ならその色、無ければ模様の代わりの色
      const comps = a.slice(0, -1).filter((v) => typeof v === "number");
      const color = comps.length && space.base ? space.base.rgb(comps) : this.#patternColor(last.name);
      if (stroke) s.strokeColor = color;
      else {
        s.fillColor = color;
        s.fillPattern = color;
      }
      return;
    }
    const color = space.rgb(a.filter((v) => typeof v === "number"));
    if (stroke) s.strokeColor = color;
    else {
      s.fillColor = color;
      s.fillPattern = null;
    }
  }

  /** 模様の代わりの色（グラデーションは中ほどの色、繰り返しの模様は薄い灰色。どちらも近似） */
  #patternColor(name) {
    const pattern = this.pdf.value(this.pdf.value(this.resources, "Pattern"), name);
    const dict = pattern instanceof PdfStream ? pattern.dict : pattern;
    this.sink.unsupported("模様の塗り（近似）");
    if (this.pdf.value(dict, "PatternType") === 2) return shadingColor(this.pdf, this.pdf.value(dict, "Shading"), this.resources) ?? "#c0c0c0";
    return "#c0c0c0";
  }

  #shading(name) {
    // グラデーションで塗る（切り取りの外形を中ほどの色で塗る近似。切り取りが無ければ描かない）
    this.sink.unsupported("グラデーション（近似）");
    const s = this.state;
    if (!s.clip || !(name instanceof PdfName)) return;
    const shading = this.pdf.value(this.pdf.value(this.resources, "Shading"), name.name);
    const color = shadingColor(this.pdf, shading, this.resources);
    if (!color) return;
    const { min, max } = s.clip;
    this.sink.path({
      subpaths: [{ points: [min[0], min[1], max[0], min[1], max[0], max[1], min[0], max[1]], curves: [], closed: true }],
      stroke: null, fill: { color, rule: "nonzero", alpha: s.fillAlpha }, layer: this.layer, clip: s.clip,
    });
  }

  #extGState(name) {
    const gs = name instanceof PdfName ? this.pdf.value(this.pdf.value(this.resources, "ExtGState"), name.name) : null;
    if (!(gs instanceof Map)) return;
    const s = this.state, pdf = this.pdf;
    for (const key of gs.keys()) {
      const v = pdf.get(gs.get(key));
      switch (key) {
        case "LW": s.width = Number(v) || 0; break;
        case "LC": s.cap = Number(v) || 0; break;
        case "LJ": s.join = Number(v) || 0; break;
        case "D": if (Array.isArray(v)) { s.dashes = (pdf.get(v[0]) ?? []).map((x) => Number(pdf.get(x))); s.phase = Number(pdf.get(v[1])) || 0; } break;
        case "CA": s.strokeAlpha = Number(v) ?? 1; break;
        case "ca": s.fillAlpha = Number(v) ?? 1; break;
        case "Font": if (Array.isArray(v)) { s.font = this.#fontFromDict(pdf.get(v[0])); s.size = Number(pdf.get(v[1])) || 0; } break;
      }
    }
  }

  // ---- 画層（任意の内容） ----------------------------------------------------------------------------------------
  /** BDC の印の値 → 画層（/OC の印で、OCG か OCMD を指すときだけ。それ以外は null） */
  #markedLayer(tag, props) {
    if (!(tag instanceof PdfName) || tag.name !== "OC") return null;
    const dict = props instanceof PdfName ? this.pdf.value(this.pdf.value(this.resources, "Properties"), props.name) : this.pdf.get(props);
    return this.#ocLayer(dict);
  }

  /** OCG・OCMD → 画層の鍵（OCMD は含む OCG の最初のもの） */
  #ocLayer(dict) {
    dict = this.pdf.get(dict);
    if (!(dict instanceof Map)) return null;
    if (this.pdf.name(dict, "Type") === "OCMD") {
      const ocgs = this.pdf.get(dict.get("OCGs"));
      const first = this.pdf.get(Array.isArray(ocgs) ? ocgs[0] : ocgs);
      return first instanceof Map && this.layers.has(first) ? first : null;
    }
    return this.layers.has(dict) ? dict : null;
  }

  // ---- XObject・画像 ----------------------------------------------------------------------------------------------
  #xobject(name) {
    if (!(name instanceof PdfName)) return;
    const xobj = this.pdf.value(this.pdf.value(this.resources, "XObject"), name.name);
    if (!(xobj instanceof PdfStream)) return;
    const type = this.pdf.name(xobj.dict, "Subtype");
    const oc = xobj.dict.has("OC") ? this.#ocLayer(xobj.dict.get("OC")) : null;
    if (type === "Image") return this.#image(xobj.dict, () => this.pdf.stream(xobj), oc);
    if (type === "Form") return this.#form(xobj, this.state, oc);
  }

  /** フォームの XObject を実行する（/Matrix を掛け、/BBox で切る。色・線の太さなどは state から受け継ぐ） */
  #form(xobj, state, oc = null) {
    const bytes = this.pdf.bytesOf(xobj);
    if (!bytes) return;
    const matrix = this.pdf.numbers(xobj.dict, "Matrix") ?? IDENTITY;
    const m = multiply(matrix, state.ctm);
    const bbox = this.pdf.numbers(xobj.dict, "BBox");
    const clip = bbox ? intersect(state.clip, boundsOfRect(bbox, m)) : state.clip;
    const resources = this.pdf.value(xobj.dict, "Resources") ?? this.resources;
    this.run(bytes, resources, m, { layer: oc ?? this.layer, state: { ...state, clip } });
  }

  #image(dict, data, oc) {
    const s = this.state;
    let image;
    try {
      image = decodeImage(this.pdf, dict, data(), { fillColor: s.fillColor, resources: this.resources });
    } catch {
      image = null;
    }
    if (!image) {
      this.sink.unsupported("読めない画像");
      return;
    }
    if (image.unsupported) this.sink.unsupported(image.unsupported);
    this.sink.image({ matrix: s.ctm, image, layer: oc ?? this.layer, clip: s.clip });
  }

  #inlineImage(lexer) {
    const dict = parseDict(new InlineLexer(lexer), false);
    // ID の後の 1 バイトの空白から、EI（前後が空白）の手前までが画像
    const bytes = lexer.bytes;
    let start = lexer.pos;
    if (bytes[start] === 0x20 || bytes[start] === 0x0a || bytes[start] === 0x0d) start++;
    let end = start;
    for (let i = start; i + 2 < lexer.end; i++) {
      if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 && (i === start || isSpace(bytes[i - 1])) && (i + 2 >= lexer.end || isSpace(bytes[i + 2]))) {
        end = i;
        break;
      }
    }
    lexer.pos = end + 2;
    const full = new Map();
    const ABBR = { W: "Width", H: "Height", BPC: "BitsPerComponent", CS: "ColorSpace", D: "Decode", DP: "DecodeParms", F: "Filter", IM: "ImageMask", I: "Interpolate" };
    for (const [k, v] of dict) full.set(ABBR[k] ?? k, v);
    const cs = full.get("ColorSpace");
    if (cs instanceof PdfName) {
      const short = { G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed" }[cs.name];
      if (short) full.set("ColorSpace", pdfName(short));
    }
    const raw = bytes.subarray(start, Math.max(start, end - (isSpace(bytes[end - 1]) ? 1 : 0)));
    const stream = new PdfStream(full, raw);
    this.#image(full, () => this.pdf.stream(stream), null);
  }

  // ---- 文字 --------------------------------------------------------------------------------------------------------
  #font(name) {
    if (!(name instanceof PdfName)) return null;
    return this.#fontFromDict(this.pdf.value(this.pdf.value(this.resources, "Font"), name.name));
  }

  #fontFromDict(dict) {
    if (!(dict instanceof Map)) return null;
    if (!this.fonts.has(dict)) {
      let font = null;
      try {
        font = loadFont(this.pdf, dict);
      } catch {
        font = null;
      }
      this.fonts.set(dict, font);
    }
    return this.fonts.get(dict);
  }

  #moveText(tx, ty) {
    this.text.tlm = this.text.tm = multiply([1, 0, 0, 1, tx, ty], this.text.tlm);
  }

  /** 文字を出す（Tj・TJ）。1 つの命令の文字を 1 つの文字の図形にまとめ、PDF の送り幅で始めと終わりを決める */
  #show(items) {
    const s = this.state, font = s.font;
    if (!font) return;
    const th = s.scaleH;
    let text = "", advance = 0;
    // 文字の並びを出す（送り幅の位置 from から、いまの位置まで）
    const flushAt = (from) => {
      if (text.trim() && s.render !== 3 && s.render !== 7) this.#emitText(text, multiply([1, 0, 0, 1, from, 0], this.text.tm), advance - from);
      text = "";
    };
    const start = this.text.tm;
    let runStart = 0; // いまの文字の並びの始め（送り幅の位置）
    for (const item of items) {
      if (typeof item === "number") {
        const shift = (-item / 1000) * s.size * th;
        if (Math.abs(item) > 600 && !font.vertical) {
          // 大きなすき間（目次の点線の代わり・表の欄の間など）: そこで文字を分ける（1 つに引き伸ばさない）
          flushAt(runStart);
          advance += shift;
          runStart = advance;
          continue;
        }
        advance += shift;
        if (item < -200 && text && !text.endsWith(" ")) text += " "; // 語の区切り
        continue;
      }
      if (!(item instanceof PdfString)) continue;
      for (const g of font.decode(item.bytes)) {
        if (font.vertical) {
          // 縦書き: 1 文字ずつ下へ（送り幅は既定の 1000）
          this.#emitText(g.text, multiply([1, 0, 0, 1, 0, -advance], start), null);
          advance += s.size + s.charSpace;
          continue;
        }
        text += g.text;
        advance += ((g.width / 1000) * s.size + s.charSpace + (g.space ? s.wordSpace : 0)) * th;
      }
    }
    if (!font.vertical) flushAt(runStart);
    // 文字の行列を送る
    this.text.tm = multiply(font.vertical ? [1, 0, 0, 1, 0, -advance] : [1, 0, 0, 1, advance, 0], start);
  }

  #emitText(text, tm, advance) {
    const s = this.state, font = s.font;
    const m = multiply(tm, s.ctm);
    const origin = apply(m, 0, s.rise);
    const end = advance !== null && font.widthsKnown && advance > 0 ? apply(m, advance, s.rise) : null;
    // 文字の向き（基線）と高さ（大きさ × 縦の拡大。基線に垂直な成分）
    const along = [m[0] * s.scaleH, m[1] * s.scaleH], up = [m[2] * s.size, m[3] * s.size];
    const angle = Math.atan2(along[1], along[0]);
    const len = Math.hypot(along[0], along[1]) || 1;
    const ux = along[0] / len, uy = along[1] / len;
    const cross = ux * up[1] - uy * up[0]; // 基線に垂直な高さ（符号は鏡映）
    const height = Math.abs(cross);
    if (!(height > 0)) return;
    const shear = ux * up[0] + uy * up[1]; // 基線の向きの成分（斜体）
    this.sink.text({
      text, origin, end, height, angle, oblique: Math.atan2(shear, height), mirror: cross < 0,
      color: s.render === 1 || s.render === 5 ? s.strokeColor : s.fillColor, font, layer: this.layer, clip: s.clip,
    });
  }

  // ---- 注記 --------------------------------------------------------------------------------------------------------
  /** 注記の見た目（/AP の /N）をページの上に描く（3D の注記は、見た目があれば 3D を動かす前の絵として描く）*/
  annotations(page, base) {
    const pdf = this.pdf;
    for (const ref of pdf.value(page.dict, "Annots") ?? []) {
      const annot = pdf.get(ref);
      if (!(annot instanceof Map)) continue;
      const subtype = pdf.name(annot, "Subtype");
      const rect = pdf.numbers(annot, "Rect");
      if (!isShown(pdf, annot, rect)) continue;
      const ap = appearanceOf(pdf, annot);
      const oc = annot.has("OC") ? this.#ocLayer(annot.get("OC")) : null;
      if (!hasLook(pdf, ap)) {
        // 見た目が無い: 注記の種類から作る（朱書きの注記・フォームの欄など）。3D の注記は、読む側が 3D の場所を示す
        if (!is3dAnnotation(subtype) && !drawAnnotation(pdf, annot, subtype, base, this.sink, oc) && subtype !== "Link") {
          this.sink.unsupported(`見た目の無い注記（${subtype}）`);
        }
        continue;
      }
      // 見た目の /BBox を /Matrix で変換した外形を、注記の /Rect に合わせる（12.5.5）
      const matrix = pdf.numbers(ap.dict, "Matrix") ?? IDENTITY;
      const bbox = pdf.numbers(ap.dict, "BBox") ?? [0, 0, 1, 1];
      const box = boundsOfRect(bbox, matrix);
      const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      const sx = (x1 - x0) / ((box.max[0] - box.min[0]) || 1), sy = (y1 - y0) / ((box.max[1] - box.min[1]) || 1);
      const fit = [sx, 0, 0, sy, x0 - box.min[0] * sx, y0 - box.min[1] * sy];
      this.resources = null;
      this.mc = [];
      this.#form(ap, this.#initialState(multiply(fit, base)), oc);
    }
  }
}

/** 内側の字句の読み手（インラインの画像の辞書: ID で終わる） */
class InlineLexer {
  constructor(lexer) {
    this.lexer = lexer;
  }
  next() {
    const t = this.lexer.next();
    if (t instanceof PdfOp && t.op === "ID") return DICT_END;
    return t;
  }
  get pos() {
    return this.lexer.pos;
  }
  set pos(v) {
    this.lexer.pos = v;
  }
}
const isSpace = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x00 || c === 0x0c;

// ---- 外形 ----------------------------------------------------------------------------------------------------------
function bounds(subpaths) {
  let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of subpaths) {
    for (let i = 0; i < p.points.length; i += 2) {
      min = [Math.min(min[0], p.points[i]), Math.min(min[1], p.points[i + 1])];
      max = [Math.max(max[0], p.points[i]), Math.max(max[1], p.points[i + 1])];
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
}

/** 長方形 [x0 y0 x1 y1] を行列で写した外形 */
export function boundsOfRect(r, m) {
  const pts = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[2], r[3]), apply(m, r[0], r[3])];
  return { min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] };
}

function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const min = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1])], max = [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1])];
  return { min, max: [Math.max(min[0], max[0]), Math.max(min[1], max[1])] };
}
