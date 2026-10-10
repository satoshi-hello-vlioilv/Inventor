// 文字列 → Shift_JIS（Windows の CP932）のバイト列。ブラウザの TextEncoder は UTF-8 しか書けないので、
// TextDecoder("shift_jis") で全ての 2 バイトの符号を一度だけ読み、逆引きの表を作る（同じ文字に符号が幾つかあれば、小さい方）。
//   encodeShiftJis(文字列, 表せない文字 → 代わりの ASCII の文字列) → { bytes, unmapped（表せなかった文字の数）}

let table = null;

function reverseTable() {
  if (table) return table;
  table = new Map();
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  const put = (bytes) => {
    let c;
    try {
      c = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    if ([...c].length === 1 && c !== "�" && !table.has(c)) table.set(c, bytes);
  };
  for (let b = 0xa1; b <= 0xdf; b++) put([b]); // 半角カタカナ
  for (const lead of [...range(0x81, 0x9f), ...range(0xe0, 0xfc)]) for (const trail of [...range(0x40, 0x7e), ...range(0x80, 0xfc)]) put([lead, trail]);
  return table;
}
function* range(a, b) {
  for (let i = a; i <= b; i++) yield i;
}

export function encodeShiftJis(text, fallback = () => "?") {
  const map = reverseTable();
  const out = [];
  let unmapped = 0;
  for (const c of text) {
    const code = c.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (map.has(c)) out.push(...map.get(c));
    else {
      unmapped++;
      for (const ch of fallback(c)) out.push(ch.charCodeAt(0) & 0x7f);
    }
  }
  return { bytes: Uint8Array.from(out), unmapped };
}
