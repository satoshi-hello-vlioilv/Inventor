// 画面の流れの状態（1 か所）。部品ごとの画面（main.js・units.js・convert.js・build.js）がそれぞれ知っていることを知らせ、
// 段階の帯（steps.js）と行動ドック（build.js）がそれを見て表示を決める。お互いを直接は呼ばない（依存を一方向にする）。
//   mode     … empty・ipt・asm・html・spec（表示しているもの）
//   capture  … none・run・ok・bad（HTML の取り込み）。revision は three.js の版
//   unit     … { origin: guess・remembered・chosen, label: "1 mm" }（HTML のシーンの単位）
//   parts    … 作れる部品の種類の数（変換データ）
//   job      … 作る仕事の要約 { state, tone, made, total, good, inventor, name }、own … 表示中の形から作った仕事か

const state = { mode: "empty", capture: "none", revision: null, unit: null, parts: 0, job: { state: "idle" }, own: false };
const listeners = new Set();

/** いまの状態（読むだけ。変えるときは updateFlow） */
export const flow = () => state;

/** 知っていることを知らせる（変わったものだけでよい）。聞いている表示を描き直す */
export function updateFlow(partial) {
  Object.assign(state, partial);
  for (const listener of listeners) listener(state);
}

/** 状態が変わったら呼ぶ */
export function onFlow(listener) {
  listeners.add(listener);
}

// ---- 次に押すべきもの（主の行動）は画面に 1 つだけ。持ち主ごとに候補を受け、優先の順で 1 つに data-next を付ける ----
const PRIORITY = ["build", "view"]; // 作る仕事（尋ねる・結果を開く・作る）→ 表示ごとの行動（開く・取り込む・部品を加える）
const candidates = new Map();

/**
 * 主の行動の候補を知らせる（無ければ null）。
 * @param {"build" | "view"} owner
 * @param {HTMLElement | null} element
 */
export function setNext(owner, element) {
  candidates.set(owner, element);
  const chosen = PRIORITY.map((o) => candidates.get(o)).find((el) => el && !el.hidden && !el.disabled) ?? null;
  for (const el of document.querySelectorAll("[data-next]")) if (el !== chosen) delete el.dataset.next;
  if (chosen) chosen.dataset.next = "";
}
