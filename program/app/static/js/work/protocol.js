// 画面（work/pool.js）と Worker（work/worker.js）の間の決まり。
//   CALL                … 引数の中の関数の印 { [CALL]: 番号 }（関数は写せないので、番号で画面の側の関数を指す）
//   encodeCalls(値, fns) … 引数の中の関数を印に置き換えた写し（素の物と配列だけをたどる。型付き配列・Map はそのまま）
//   transferables(値)    … 結果の中の ArrayBuffer（写さずに渡す。同じ物は 1 回だけ）
//   TaskError           … Worker の中の誤り（kind: 元の種類、explained: 仕事が付けた利用者向けの説明）

export const CALL = "__workCall";

const isPlain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

export function encodeCalls(value, fns) {
  if (typeof value === "function") {
    fns.push(value);
    return { [CALL]: fns.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => encodeCalls(v, fns));
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeCalls(v, fns)]));
}

/** 結果の中の ArrayBuffer を集める（素の物・配列・Map・Set をたどる） */
export function transferables(value, out = new Set(), seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return [...out];
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) out.add(value.buffer);
  } else if (value instanceof ArrayBuffer) out.add(value);
  else if (value instanceof Map) for (const [k, v] of value) { transferables(k, out, seen); transferables(v, out, seen); }
  else if (value instanceof Set) for (const v of value) transferables(v, out, seen);
  else if (Array.isArray(value) || isPlain(value)) for (const v of Object.values(value)) transferables(v, out, seen);
  return [...out];
}

export class TaskError extends Error {
  constructor({ kind, message, explained, stack }) {
    super(message);
    this.name = "TaskError";
    this.kind = kind;
    this.explained = explained;
    this.workerStack = stack;
  }
}
