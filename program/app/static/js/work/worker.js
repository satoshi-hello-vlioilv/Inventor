// 裏で計算する Worker の入口（work/pool.js が作る。仕事の表は work/tasks.js）。
// 画面から { id, name, args } を受け取り、仕事を動かして { id, result } か { id, error } を返す。途中で { id, progress } を送る。
// 引数の中の関数（印 { [CALL]: 番号 }）は、呼ばれたら { id, call, callId, args } で画面に頼み、{ reply: callId, value | error } を待つ。

import { CALL, transferables } from "./protocol.js";
import { TASKS } from "./tasks.js";

const PROGRESS_MS = 50; // 進み具合を送る間隔の下限（細かく送りすぎて画面の流れを詰まらせない）
const replies = new Map();
let nextCall = 0;

/** 引数の中の関数の印を、画面に頼む関数に戻す */
function decode(value, id) {
  if (Array.isArray(value)) return value.map((v) => decode(v, id));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (CALL in value) {
    const fn = value[CALL];
    return (...args) => new Promise((resolve, reject) => {
      const callId = nextCall++;
      replies.set(callId, { resolve, reject });
      self.postMessage({ id, call: fn, callId, args });
    });
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, id)]));
}

self.onmessage = async ({ data }) => {
  if ("reply" in data) {
    const pending = replies.get(data.reply);
    replies.delete(data.reply);
    if (data.error) pending?.reject(new Error(data.error));
    else pending?.resolve(data.value);
    return;
  }
  if (data.warm) return void Promise.all(Object.values(TASKS).map((t) => t.module())).catch(() => {}); // 先に読んでおく（最初の仕事を待たせない）
  const { id, name, args } = data;
  const task = TASKS[name];
  let last = 0;
  const progress = (p) => {
    const now = performance.now();
    if (now - last < PROGRESS_MS && p.done !== p.total) return;
    last = now;
    self.postMessage({ id, progress: p });
  };
  let module = null;
  try {
    module = await task.module();
    const result = await task.run(module, decode(args, id), progress);
    self.postMessage({ id, result }, transferables(result));
  } catch (error) {
    const explained = module && task.explain ? await Promise.resolve(task.explain(module, error)).catch(() => undefined) : undefined;
    self.postMessage({ id, error: { kind: error?.constructor?.name ?? "Error", message: error?.message ?? String(error), explained, stack: error?.stack } });
  }
};
