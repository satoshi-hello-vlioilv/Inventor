// 図面の文字の書式を解いて、表示する文字にする（DOM に依存しない）。
//   TEXT・ATTRIB … %% の符号: %%c ⌀・%%d °・%%p ±・%%% %・%%u %%o（下線・上線の切り替え。線は引かない）・%%nnn（文字番号）
//   MTEXT        … \P 改行・\~ 空白・{ } のまとまり・\f…; \H…; \C…; などの書式（解いて捨てる）・\S…; 積み重ね（a/b にする）

const PERCENT = { c: "⌀", d: "°", p: "±", "%": "%", u: "", o: "", k: "" };

/** %% の符号を文字にする（TEXT と MTEXT の両方で使う） */
export function percentCodes(s) {
  if (!s.includes("%%")) return s;
  return s.replace(/%%(\d{3}|[cdpuok%])/gi, (_, code) => (/^\d/.test(code) ? String.fromCharCode(Number(code)) : PERCENT[code.toLowerCase()]));
}

/** TEXT・ATTRIB・ATTDEF の文字 */
export const singleLine = (s) => percentCodes(String(s ?? ""));

// 引数を ; まで持つ書式の符号（解いて捨てる）
const WITH_ARGUMENT = new Set(["f", "F", "H", "W", "Q", "T", "A", "C", "c", "p"]);
// 引数の無い切り替え（下線・上線・取り消し線など。捨てる）
const TOGGLES = new Set(["L", "l", "O", "o", "K", "k", "X"]);

/** MTEXT の文字 → 行の並び（書式を捨て、\P と改行で区切る） */
export function mtextLines(s) {
  s = String(s ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "}") continue;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const code = s[++i];
    if (code === undefined) break;
    if (code === "P" || code === "N") out += "\n";
    else if (code === "~") out += " ";
    else if (code === "\\" || code === "{" || code === "}") out += code;
    else if (code === "S") {
      // 積み重ね: \S上^下; \S上/下; \S上#下; → 上/下
      const end = s.indexOf(";", i);
      const body = s.slice(i + 1, end < 0 ? s.length : end);
      out += body.replace(/[\^#]/, "/").replace(/^\s+|\s+$/g, "");
      i = end < 0 ? s.length : end;
    } else if (WITH_ARGUMENT.has(code)) {
      const end = s.indexOf(";", i);
      i = end < 0 ? s.length : end;
    } else if (!TOGGLES.has(code)) out += code; // 知らない符号は文字として残す
  }
  return percentCodes(out).split(/\r\n|\n|\r/);
}

// ---- 行の並べ方（描く側 viewer2d.js と、書き出し formats/cad2d/to-sxf.js で共通） --------------------------------------
export const CAP_HEIGHT = 0.72; // フォントの大きさ（em）に対する大文字の高さ（図面の文字の高さ = 大文字の高さ）
export const DESCENT = 0.25; // TEXT の「下」揃え: 基線から下の部分（大文字の高さに対する比）

/**
 * 行の基線の位置（文字の置く点から、文字の上向きに測った長さ ÷ 文字の高さ）。1 行目の基線から、行の間隔ずつ下へ。
 * t … 描く文字（viewer2d/scene.js の texts の 1 つ。valign・mtext・lineSpacing）・n … 行の数（折り返した後）
 */
export function baselineOffsets(t, n) {
  const lineHeight = t.mtext ? (5 / 3) * (t.lineSpacing || 1) : 1.6;
  const block = 1 + lineHeight * (n - 1);
  const first = t.valign === "top" ? -1 : t.valign === "middle" ? block / 2 - 1 : t.valign === "bottom" ? lineHeight * (n - 1) + (t.mtext ? 0 : DESCENT) : 0;
  return Array.from({ length: n }, (_, i) => first - lineHeight * i);
}

/** MTEXT の折り返し（幅 width を越える行を、語か文字の切れ目で折る）。measure(文字列) → 幅 */
export function wrapLines(lines, width, measure) {
  const out = [];
  for (const line of lines) {
    if (measure(line) <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const token of line.match(/[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+|\s+/g) ?? []) {
      const next = current + token;
      if (current && measure(next) > width) {
        out.push(current.trimEnd());
        current = token.trimStart();
      } else current = next;
    }
    out.push(current);
  }
  return out;
}

/** 文字の幅の見積もり（画面のフォントで測れないとき。高さ h（大文字の高さ）の文字: 全角 1 em・半角 0.55 em） */
export function estimateTextWidth(s, h) {
  return [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 1 : 0.55), 0) * (h / CAP_HEIGHT);
}
