// 重い計算を裏（Worker）で動かし、画面を止めない（仕事の表は work/tasks.js、決まりは work/protocol.js）。
//   runTask(名前, 引数, { onProgress, signal }) → Promise<結果>
//     onProgress({ stage, done?, total? }) … 進み具合（待つ間の表示に使う）
//     signal（AbortSignal）               … 取りやめ。動いている Worker は止めて捨てる（次の仕事は新しい Worker で）
//   warmUp()                              … 最初の仕事の前に Worker を用意しておく（モジュールの読み込みを先に済ませる）
// Worker が使えない環境（作れない・モジュールを読めない）では、同じ表の仕事を画面の流れで動かす（結果は同じ。画面は止まる）。
// Worker は 2 つまで（3D の形を作っている間にも、別のファイルを読める）。空いた Worker は使い回す。

import { CALL, TaskError, encodeCalls } from "./protocol.js";
import { TASKS } from "./tasks.js";

const MAX_WORKERS = 2;
const slots = []; // { worker, job: 動かしている仕事 | null, proven: 1 度でも答えたか }
const queue = []; // まだ Worker に渡していない仕事
const WorkerClass = globalThis.Worker; // 読んだときの Worker（試験では、Node の worker_threads で同じ形の物を入れる）
let broken = typeof WorkerClass !== "function"; // Worker が使えない: 画面の流れで動かす
let nextId = 0;

const abortError = () => Object.assign(new Error("取りやめました"), { name: "AbortError" });
export const isAbort = (error) => error?.name === "AbortError";

export function runTask(name, args = [], { onProgress = () => {}, signal } = {}) {
  if (!TASKS[name]) return Promise.reject(new Error(`知らない仕事です: ${name}`));
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const job = { id: nextId++, name, args, onProgress, signal, resolve, reject, fns: [] };
    signal?.addEventListener("abort", () => cancel(job), { once: true });
    if (broken) runHere(job);
    else {
      queue.push(job);
      pump();
    }
  });
}

export function warmUp() {
  if (!broken && !slots.length) spawn()?.worker.postMessage({ warm: true });
}

/** 画面の流れで動かす（Worker が使えないとき）。表示を 1 度描いてから計算する（待つ間の表示が出るように） */
async function runHere(job) {
  await new Promise((r) => setTimeout(r, 30));
  if (job.done) return;
  const task = TASKS[job.name];
  let module = null;
  try {
    module = await task.module();
    const result = await task.run(module, job.args, job.onProgress);
    settle(job, () => job.resolve(result));
  } catch (error) {
    const explained = module && task.explain ? await task.explain(module, error) : undefined;
    settle(job, () => job.reject(explained ? Object.assign(error, { explained }) : error));
  }
}

function settle(job, fn) {
  if (job.done) return;
  job.done = true;
  fn();
}

function spawn() {
  let worker;
  try {
    worker = new WorkerClass(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (error) {
    console.warn("Worker を作れません。画面の流れで計算します", error);
    fallBack();
    return null;
  }
  const slot = { worker, job: null, proven: false };
  worker.onmessage = ({ data }) => receive(slot, data);
  worker.onerror = (event) => crash(slot, event);
  slots.push(slot);
  return slot;
}

/** Worker が使えないと分かった: 待っている仕事も、動かしていた仕事も、画面の流れでやり直す */
function fallBack() {
  broken = true;
  const jobs = [...slots.map((s) => s.job).filter(Boolean), ...queue.splice(0)];
  for (const s of slots.splice(0)) s.worker.terminate();
  jobs.forEach((job) => runHere(job));
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) ?? (slots.length < MAX_WORKERS ? spawn() : null);
    if (!slot) return;
    const job = queue.shift();
    slot.job = job;
    slot.worker.postMessage({ id: job.id, name: job.name, args: encodeCalls(job.args, job.fns) });
  }
}

function receive(slot, data) {
  const job = slot.job;
  if (!job || data.id !== job.id) return;
  slot.proven = true;
  if ("progress" in data) return void job.onProgress(data.progress);
  if ("call" in data) return void answer(slot, job, data);
  slot.job = null;
  if ("error" in data) settle(job, () => job.reject(new TaskError(data.error)));
  else settle(job, () => job.resolve(data.result));
  pump();
}

/** Worker の中の仕事が、引数の関数（例: 組立の部品を探す）を呼んだ: 画面の側で動かして答える */
async function answer(slot, job, { call, callId, args }) {
  try {
    const value = await job.fns[call](...args);
    slot.worker.postMessage({ reply: callId, value });
  } catch (error) {
    slot.worker.postMessage({ reply: callId, error: error?.message ?? String(error) });
  }
}

/** Worker が落ちた。1 度も答えていなければ、この環境では Worker が使えない（モジュールを読めないなど） */
function crash(slot, event) {
  event.preventDefault?.();
  if (!slot.proven) {
    console.warn("Worker を動かせません。画面の流れで計算します", event.message ?? event);
    fallBack();
    return;
  }
  discard(slot);
  if (slot.job) settle(slot.job, () => slot.job.reject(new Error(event.message || "裏の計算が止まりました")));
  pump();
}

function discard(slot) {
  slot.worker.terminate();
  slots.splice(slots.indexOf(slot), 1);
}

/** 取りやめ: 待っていれば外し、動いていれば Worker ごと止める（計算の途中では止められないため） */
function cancel(job) {
  if (job.done) return;
  const waiting = queue.indexOf(job);
  if (waiting >= 0) queue.splice(waiting, 1);
  const slot = slots.find((s) => s.job === job);
  if (slot) {
    discard(slot);
    pump();
  }
  settle(job, () => job.reject(abortError()));
}
