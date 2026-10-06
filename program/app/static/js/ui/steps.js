// 段階の帯（右の欄のいちばん上）: CAD ファイルを作るまでの流れと、いまどこにいるか。HTML と変換データを開いているときだけ出す。
//   HTML     … 取り込む → 単位を確かめる → 作る → 照合する
//   変換データ … 開く → 中身を確かめる → 作る → 照合する
// 段の状態: todo（まだ）・now（次にすること。青）・run（進行中）・done（済み。緑の印）・warn（確かめてほしい。琥珀）・bad（失敗。赤）
// 段を押すと、その段の欄（元のページ・単位・行動ドック・照合の結果）へ移る。

import { flow, onFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
const ICON = {
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v7.5M12 17.6v.4"/></svg>',
  bad: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};
const STATUS_TEXT = { todo: "まだ", now: "次にすること", run: "進行中", done: "済み", warn: "確かめてください", bad: "失敗" };

/** 作る・照合する の段（HTML と変換データで同じ） */
function makeAndCheck(s, ready) {
  const { job, own } = s;
  const running = own && ["installing", "step", "connecting", "building", "assembly"].includes(job.state);
  const finished = own && ["done", "failed", "cancelled"].includes(job.state);
  const make = running ? { status: "run", note: job.inventor && job.total ? `${job.made} / ${job.total}` : "作っています" }
    : finished && job.state !== "cancelled" ? { status: job.state === "failed" ? "bad" : "done", note: job.state === "failed" ? "作れませんでした" : "済み" }
      : ready ? { status: "now", note: "下のボタンで" } : { status: "todo", note: "" };
  const check = finished && job.state === "done"
    ? { status: job.tone === "ok" ? "done" : job.tone === "bad" ? "bad" : "warn", note: !job.inventor ? "STEP" : job.inventorError ? "STEP のみ" : `一致 ${job.good} / ${job.total}` }
    : running ? { status: "todo", note: "作り終えたら" } : { status: "todo", note: "" };
  return [
    { key: "make", label: "作る", target: "dock", ...make },
    { key: "check", label: "照合する", target: "result-card", ...check },
  ];
}

function stepsFor(s) {
  if (s.mode === "html") {
    const captured = s.capture === "ok";
    const capture = { run: { status: "run", note: "取り込み中" }, ok: { status: "done", note: s.revision ? `three.js r${s.revision}` : "済み" },
      bad: { status: "bad", note: "取り込み直す" } }[s.capture] ?? { status: "now", note: "元のページ" };
    const unit = !captured || !s.unit ? { status: "todo", note: "" }
      : s.unit.origin === "guess" ? { status: "warn", note: `推定 ${s.unit.label}` } : { status: "done", note: s.unit.label };
    return [
      { key: "capture", label: "取り込む", target: "source", ...capture },
      { key: "unit", label: "単位を確かめる", target: "unit-card", ...unit },
      ...makeAndCheck(s, captured && s.parts > 0),
    ];
  }
  if (s.mode === "spec") {
    return [
      { key: "open", label: "開く", target: null, status: "done", note: "変換データ" },
      { key: "parts", label: "中身を確かめる", target: "parts", status: s.parts ? "done" : "bad", note: s.parts ? `${s.parts} 種類` : "作れる部品なし" },
      ...makeAndCheck(s, s.parts > 0),
    ];
  }
  return null;
}

/** その段の欄へ移り、操作できるものに注意を向ける */
function go(target) {
  const el = target && $(target);
  if (!el || el.hidden) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (target === "unit-card") {
    el.classList.remove("is-flash");
    void el.offsetWidth; // 続けて押しても光らせ直す
    el.classList.add("is-flash");
    $("unit-select").focus({ preventScroll: true });
  } else if (target === "dock") {
    el.querySelector("[data-next]")?.focus({ preventScroll: true });
  } else if (target === "source") {
    $("capture").focus({ preventScroll: true });
  }
}

function render(s) {
  const steps = stepsFor(s);
  $("steps").hidden = !steps;
  if (!steps) return;
  let previous = null;
  $("step-list").replaceChildren(...steps.map((step, i) => {
    const li = document.createElement("li");
    if (previous) li.dataset.from = previous;
    previous = step.status;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "step";
    button.dataset.status = step.status;
    button.disabled = !step.target;
    button.setAttribute("aria-label", `${i + 1}. ${step.label}（${STATUS_TEXT[step.status]}${step.note ? `・${step.note}` : ""}）`);
    if (step.status === "now") button.setAttribute("aria-current", "step");
    const mark = document.createElement("span");
    mark.className = "step-mark";
    mark.innerHTML = ICON[step.status] ?? `<span>${i + 1}</span>`;
    button.append(mark, Object.assign(document.createElement("span"), { className: "step-label", textContent: step.label }),
      Object.assign(document.createElement("span"), { className: "step-note", textContent: step.note || " " }));
    button.addEventListener("click", () => go(step.target));
    li.append(button);
    return li;
  }));
}

onFlow(render);
render(flow());
