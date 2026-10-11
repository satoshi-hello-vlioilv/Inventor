// 起動の幕（index.html の #boot。案 K: docs/ui.md §24）: 画面が使えるまでの段階（画面 → 受け取ったファイル → 開く）を進め、終わったら消す。
//   bootStep("files" | "open") … その段階を「いま」に、前の段階を「済んだ」にする
//   bootDone()                 … 幕を消す（薄くしてから外す）。読み取りに失敗したときも呼ぶ（画面に知らせが出る）
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

export function bootDone() {
  if (!boot?.isConnected) return;
  boot.classList.add("is-done");
  setTimeout(() => boot.remove(), 300);
}

// 読み込みの途中で止まった（捕まえていない失敗）: 幕を残さず、画面の知らせを見えるようにする
window.addEventListener("error", bootDone, { once: true });
window.addEventListener("unhandledrejection", bootDone, { once: true });
