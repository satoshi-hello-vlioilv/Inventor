// PDF の色空間と関数（ISO 32000-1 の 8.6・7.10）。色の成分 → "#rrggbb"。
//   色空間: DeviceGray・RGB・CMYK・Cal*・Lab・ICCBased（成分の数で近似）・Indexed・Separation・DeviceN（関数で別の色空間へ）・Pattern
//   関数: 0 標本・2 指数・3 つなぎ・4 PostScript の計算

import { Lexer, PdfName, PdfOp, PdfStream, PdfString } from "./objects.js";

export const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");

// ---- 色空間 --------------------------------------------------------------------------------------------------------
export const GRAY = { n: 1, initial: [0], rgb: ([g = 0]) => hex(g, g, g) };
export const RGB = { n: 3, initial: [0, 0, 0], rgb: ([r = 0, g = 0, b = 0]) => hex(r, g, b) };
export const CMYK = { n: 4, initial: [0, 0, 0, 1], rgb: ([c = 0, m = 0, y = 0, k = 0]) => hex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)) };
/** 成分の数で決まる色（注記の /C など: 1 灰・3 RGB・4 CMYK）→ "#rrggbb" */
export const colorSpaceColor = (c) => (c.length === 1 ? GRAY : c.length === 4 ? CMYK : RGB).rgb(c);
export const rgbOf = (hexColor) => [1, 3, 5].map((i) => parseInt(hexColor.slice(i, i + 2), 16) / 255);

/** 色空間（名前・配列）→ { n, initial, rgb(成分) → "#rrggbb", base? }。分からない色空間は成分の数で近似する */
export function colorSpace(pdf, v, resources, depth = 0) {
  v = pdf.get(v);
  if (depth > 8) return GRAY;
  if (v instanceof PdfName) {
    switch (v.name) {
      case "DeviceGray": case "G": case "CalGray": return GRAY;
      case "DeviceRGB": case "RGB": case "CalRGB": return RGB;
      case "DeviceCMYK": case "CMYK": return CMYK;
      case "Pattern": return { n: 0, initial: [], rgb: () => "#c0c0c0", base: null };
    }
    const named = pdf.value(pdf.value(resources, "ColorSpace"), v.name);
    return named ? colorSpace(pdf, named, resources, depth + 1) : GRAY;
  }
  if (!Array.isArray(v) || !v.length) return GRAY;
  const kind = pdf.get(v[0])?.name;
  switch (kind) {
    case "CalGray": return GRAY;
    case "CalRGB": return RGB;
    case "Lab": return { n: 3, initial: [0, 0, 0], rgb: lab };
    case "ICCBased": {
      const n = pdf.value(pdf.get(v[1])?.dict, "N", 3);
      return n === 1 ? GRAY : n === 4 ? CMYK : RGB;
    }
    case "Indexed": case "I": {
      const base = colorSpace(pdf, v[1], resources, depth + 1);
      const hival = Number(pdf.get(v[2])) || 0;
      const lookup = pdf.get(v[3]);
      const table = lookup instanceof PdfString ? lookup.bytes : lookup instanceof PdfStream ? pdf.bytesOf(lookup) ?? new Uint8Array(0) : new Uint8Array(0);
      const colors = Array.from({ length: hival + 1 }, (_, i) => base.rgb(Array.from({ length: base.n }, (_, k) => (table[i * base.n + k] ?? 0) / 255)));
      return { n: 1, initial: [0], rgb: ([i = 0]) => colors[Math.max(0, Math.min(hival, Math.round(i)))] ?? "#000000", indexed: { base, table, hival } };
    }
    case "Separation": case "DeviceN": {
      const names = pdf.get(v[1]);
      const n = kind === "Separation" ? 1 : Array.isArray(names) ? names.length : 1;
      const alt = colorSpace(pdf, v[2], resources, depth + 1);
      const fn = makeFunction(pdf, v[3]);
      const none = kind === "Separation" && names?.name === "None";
      return {
        n, initial: Array(n).fill(1),
        rgb: (comps) => {
          if (none) return "#ffffff";
          const out = fn ? fn(comps.slice(0, n)) : null;
          if (out) return alt.rgb(out);
          const t = comps[0] ?? 1; // 関数が読めない: 濃さを灰色に
          return hex(1 - t, 1 - t, 1 - t);
        },
      };
    }
    case "Pattern": {
      const base = v[1] ? colorSpace(pdf, v[1], resources, depth + 1) : null;
      return { n: base?.n ?? 0, initial: base?.initial ?? [], rgb: (c) => (base ? base.rgb(c) : "#c0c0c0"), base };
    }
    default: return kind ? colorSpace(pdf, v[0], resources, depth + 1) : GRAY;
  }
}

function lab([l = 0, a = 0, b = 0]) {
  // L*a*b*（D50）→ sRGB の近似
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [x, y, z] = [0.9642 * f(fx), f(fy), 0.8249 * f(fz)];
  const lin = [3.1339 * x - 1.6169 * y - 0.4906 * z, -0.9788 * x + 1.9161 * y + 0.0335 * z, 0.0719 * x - 0.229 * y + 1.4052 * z];
  const g = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return hex(...lin.map(g));
}

/** グラデーションの中ほどの色 */
export function shadingColor(pdf, shading, resources) {
  shading = pdf.get(shading);
  const dict = shading instanceof PdfStream ? shading.dict : shading;
  if (!(dict instanceof Map)) return null;
  const space = colorSpace(pdf, dict.get("ColorSpace"), resources);
  const fn = makeFunction(pdf, dict.get("Function"));
  const domain = pdf.numbers(dict, "Domain") ?? [0, 1];
  const out = fn ? fn([(domain[0] + domain[1]) / 2]) : null;
  return out ? space.rgb(out) : null;
}

// ---- 関数（7.10: 0 標本・2 指数・3 つなぎ・4 PostScript の計算） -----------------------------------------------------
export function makeFunction(pdf, v, depth = 0) {
  v = pdf.get(v);
  if (Array.isArray(v)) {
    const fns = v.map((f) => makeFunction(pdf, f, depth + 1));
    return fns.every(Boolean) ? (x) => fns.map((f) => f(x)[0]) : null;
  }
  const dict = v instanceof PdfStream ? v.dict : v;
  if (!(dict instanceof Map) || depth > 8) return null;
  const type = pdf.value(dict, "FunctionType");
  const domain = pdf.numbers(dict, "Domain") ?? [0, 1];
  const range = pdf.numbers(dict, "Range");
  const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const clipOut = (out) => (range ? out.map((y, i) => clip(y, range[2 * i] ?? -Infinity, range[2 * i + 1] ?? Infinity)) : out);
  switch (type) {
    case 2: {
      const c0 = pdf.numbers(dict, "C0") ?? [0], c1 = pdf.numbers(dict, "C1") ?? [1], e = pdf.value(dict, "N", 1);
      return ([x = 0]) => {
        const t = clip(x, domain[0], domain[1]) ** e;
        return clipOut(c0.map((a, i) => a + t * (c1[i] - a)));
      };
    }
    case 3: {
      const fns = (pdf.value(dict, "Functions") ?? []).map((f) => makeFunction(pdf, f, depth + 1));
      const bounds = pdf.numbers(dict, "Bounds") ?? [], encode = pdf.numbers(dict, "Encode") ?? [];
      return ([x = 0]) => {
        x = clip(x, domain[0], domain[1]);
        let k = bounds.findIndex((b) => x < b);
        if (k < 0) k = fns.length - 1;
        const lo = k === 0 ? domain[0] : bounds[k - 1], hi = k === bounds.length ? domain[1] : bounds[k];
        const e0 = encode[2 * k] ?? 0, e1 = encode[2 * k + 1] ?? 1;
        const t = hi > lo ? e0 + ((x - lo) / (hi - lo)) * (e1 - e0) : e0;
        return clipOut(fns[k]?.([t]) ?? [0]);
      };
    }
    case 0: {
      if (!(v instanceof PdfStream)) return null;
      const data = pdf.bytesOf(v);
      const size = pdf.numbers(dict, "Size") ?? [2], bps = pdf.value(dict, "BitsPerSample", 8);
      const encode = pdf.numbers(dict, "Encode") ?? [0, size[0] - 1], decode = pdf.numbers(dict, "Decode") ?? range ?? [0, 1];
      const n = (range?.length ?? 2) / 2;
      const sample = (i, j) => {
        const bit = (i * n + j) * bps;
        let value = 0;
        for (let k = 0; k < bps; k++) value = value * 2 + ((data?.[(bit + k) >> 3] >> (7 - ((bit + k) & 7))) & 1);
        return value / (2 ** bps - 1);
      };
      return ([x = 0]) => {
        // 1 入力だけ（2 入力以上は最初の入力で近似）
        x = clip(x, domain[0], domain[1]);
        const e = encode[0] + ((x - domain[0]) / ((domain[1] - domain[0]) || 1)) * (encode[1] - encode[0]);
        const i0 = clip(Math.floor(e), 0, size[0] - 1), i1 = clip(i0 + 1, 0, size[0] - 1), f = e - i0;
        return clipOut(Array.from({ length: n }, (_, j) => {
          const s = sample(i0, j) * (1 - f) + sample(i1, j) * f;
          return decode[2 * j] + s * (decode[2 * j + 1] - decode[2 * j]);
        }));
      };
    }
    case 4: {
      if (!(v instanceof PdfStream)) return null;
      const program = postscript(pdf.bytesOf(v) ?? new Uint8Array(0));
      return (x) => {
        const stack = x.slice();
        try {
          runPostscript(program, stack);
        } catch {
          return null;
        }
        return clipOut(stack.slice(-((range?.length ?? 2) / 2)));
      };
    }
  }
  return null;
}

/** PostScript の計算の関数 → 命令の木（{ … } の入れ子） */
function postscript(bytes) {
  const lexer = new Lexer(bytes);
  const read = () => {
    const out = [];
    for (;;) {
      const t = lexer.next();
      if (t?.mark === "EOF" || t?.mark === "}") return out;
      if (t?.mark === "{") out.push(read());
      else out.push(t instanceof PdfOp ? t.op : t);
    }
  };
  const t = lexer.next();
  return t?.mark === "{" ? read() : [];
}

function runPostscript(program, s) {
  for (let i = 0; i < program.length; i++) {
    const t = program[i];
    if (typeof t === "number") { s.push(t); continue; }
    if (Array.isArray(t)) {
      // if・ifelse は後ろの命令が使う
      if (program[i + 1] === "if") { if (s.pop()) runPostscript(t, s); i++; }
      else if (Array.isArray(program[i + 1]) && program[i + 2] === "ifelse") { runPostscript(s.pop() ? t : program[i + 1], s); i += 2; }
      continue;
    }
    const b = () => s.pop(), a2 = () => { const y = s.pop(), x = s.pop(); return [x, y]; };
    switch (t) {
      case "add": { const [x, y] = a2(); s.push(x + y); break; }
      case "sub": { const [x, y] = a2(); s.push(x - y); break; }
      case "mul": { const [x, y] = a2(); s.push(x * y); break; }
      case "div": { const [x, y] = a2(); s.push(y ? x / y : 0); break; }
      case "idiv": { const [x, y] = a2(); s.push(y ? Math.trunc(x / y) : 0); break; }
      case "mod": { const [x, y] = a2(); s.push(y ? x % y : 0); break; }
      case "neg": s.push(-b()); break;
      case "abs": s.push(Math.abs(b())); break;
      case "ceiling": s.push(Math.ceil(b())); break;
      case "floor": s.push(Math.floor(b())); break;
      case "round": s.push(Math.round(b())); break;
      case "truncate": s.push(Math.trunc(b())); break;
      case "sqrt": s.push(Math.sqrt(b())); break;
      case "sin": s.push(Math.sin((b() * Math.PI) / 180)); break;
      case "cos": s.push(Math.cos((b() * Math.PI) / 180)); break;
      case "atan": { const [x, y] = a2(); s.push(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360); break; }
      case "exp": { const [x, y] = a2(); s.push(x ** y); break; }
      case "ln": s.push(Math.log(b())); break;
      case "log": s.push(Math.log10(b())); break;
      case "cvi": s.push(Math.trunc(b())); break;
      case "cvr": break;
      case "dup": s.push(s.at(-1)); break;
      case "pop": s.pop(); break;
      case "exch": { const [x, y] = a2(); s.push(y, x); break; }
      case "copy": { const n = b(); s.push(...s.slice(s.length - n)); break; }
      case "index": { const n = b(); s.push(s[s.length - 1 - n]); break; }
      case "roll": {
        const j = b(), n = b();
        if (n > 0) {
          const part = s.splice(s.length - n, n);
          const k = ((j % n) + n) % n;
          s.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      case "eq": { const [x, y] = a2(); s.push(x === y); break; }
      case "ne": { const [x, y] = a2(); s.push(x !== y); break; }
      case "gt": { const [x, y] = a2(); s.push(x > y); break; }
      case "ge": { const [x, y] = a2(); s.push(x >= y); break; }
      case "lt": { const [x, y] = a2(); s.push(x < y); break; }
      case "le": { const [x, y] = a2(); s.push(x <= y); break; }
      case "and": { const [x, y] = a2(); s.push(typeof x === "boolean" ? x && y : x & y); break; }
      case "or": { const [x, y] = a2(); s.push(typeof x === "boolean" ? x || y : x | y); break; }
      case "xor": { const [x, y] = a2(); s.push(typeof x === "boolean" ? x !== y : x ^ y); break; }
      case "not": { const x = b(); s.push(typeof x === "boolean" ? !x : ~x); break; }
      case "true": s.push(true); break;
      case "false": s.push(false); break;
      default: throw new Error(`PostScript の命令 ${t}`);
    }
  }
}

