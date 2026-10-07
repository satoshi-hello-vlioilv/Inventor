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
