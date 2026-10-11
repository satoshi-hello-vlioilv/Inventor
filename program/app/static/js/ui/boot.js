// 起動の幕（index.html の #boot。案 K: docs/ui.md §24）: 画面が使えるまでの段階（画面 → 受け取ったファイル → 開く）を進め、終わったら消す。
//   bootStep("files" | "open") … その段階を「いま」に、前の段階を「済んだ」にする
//   bootDone() → Promise       … 幕を消す（薄くしてから外す）。消え終わったら解ける（知らせを幕と重ねないため）。読み取りに失敗したときも呼ぶ
// スクリプトが止まったときは、CSS（app.css の .boot）が 20 秒で消す。

const boot = document.getElementById("boot");

export function bootStep(step) {
  if (!boot) return;
  const items = [...boot.querySelectorAll("[data-step]")];
  const at = items.findIndex((li) => li.dataset.step === step);
  items.forEach((li, i) => {
    li.classList.toggle("is-done", i < at);
    li.classList.toggle("is-now", i === at);
  });
}

let done = null;
export function bootDone() {
  if (done) return done;
  if (!boot?.isConnected) return (done = Promise.resolve());
  boot.classList.add("is-done");
  // 消え終わり（transition の長さ。動きを減らす設定で 0 なら、すぐ）
  const ms = Math.max(0, ...getComputedStyle(boot).transitionDuration.split(",").map((t) => parseFloat(t) * (t.trim().endsWith("ms") ? 1 : 1000) || 0));
  return (done = new Promise((resolve) => setTimeout(() => {
    boot.remove();
    resolve();
  }, ms + 20)));
}

// 読み込みの途中で止まった（捕まえていない失敗）: 幕を残さず、画面の知らせを見えるようにする
window.addEventListener("error", bootDone, { once: true });
window.addEventListener("unhandledrejection", bootDone, { once: true });
