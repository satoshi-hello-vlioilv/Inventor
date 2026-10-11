// 待つ間の表示（裏の計算 work/pool.js を待つ間。案 H: docs/ui.md §25）。主役の場所だけを淡く覆い、横長のカードに出す。体感の待ち時間を減らす:
//   ・0.4 秒より早く終わる仕事には出さない（ちらつかせない）。出したら 0.5 秒は消さない（瞬きに見せない）
//   ・何をしているか（段階）と、数えられれば進み具合（輪と %・何個中の何個）を出す。数えられなければ、輪の短い弧が回る。
//     経過の秒数と、残りの見込みも出す
//   ・取りやめられる仕事は「取りやめる」を出す（Esc でも）
//   waitFor(run, { title, detail, cancel }) → run の結果
//     run(onProgress) → Promise。onProgress({ stage, done?, total? }) を表示に渡す
//     title … 何を待っているか（見出し）。detail … ファイルの名前など。cancel … 取りやめる関数（無ければボタンを出さない）

const SHOW_AFTER_MS = 400;
const MIN_SHOW_MS = 500;
const ESTIMATE_AFTER_MS = 1500; // 残りの見込みは、進み具合が落ち着いてから出す

const $ = (id) => document.getElementById(id);
let active = null; // 表示中の待ち { token, shownAt }

const seconds = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

/** 待つ間の表示を出して run を待つ */
export async function waitFor(run, { title, detail = "", cancel = null } = {}) {
  const token = {};
  const started = performance.now();
  let latest = { stage: "" };
  let shownAt = null;
  const draw = () => {
    if (active?.token !== token) return;
    const elapsed = performance.now() - started;
    const { stage, done, total } = latest;
    const counted = Number.isFinite(total) && total > 0;
    const ratio = counted ? Math.min(1, done / total) : null;
    $("waiting-stage").textContent = stage || title;
    $("waiting-count").textContent = counted ? `${done.toLocaleString("ja-JP")} / ${total.toLocaleString("ja-JP")}` : "";
    const ring = $("waiting-ring");
    ring.classList.toggle("is-indeterminate", ratio === null);
    ring.style.setProperty("--ratio", ratio ?? 0);
    $("waiting-percent").textContent = ratio === null ? "" : `${Math.floor(ratio * 100)}%`;
    const remain = ratio > 0.05 && ratio < 1 && elapsed > ESTIMATE_AFTER_MS ? (elapsed / ratio) * (1 - ratio) : null;
    $("waiting-time").textContent = `${seconds(elapsed)} 秒${remain === null ? "" : ` · 残り およそ ${Math.max(1, Math.round(remain / 1000))} 秒`}`;
  };
  const show = () => {
    active = { token };
    shownAt = performance.now();
    $("waiting-title").textContent = title;
    $("waiting-detail").textContent = detail;
    $("waiting-detail").hidden = !detail;
    $("waiting-cancel").hidden = !cancel;
    $("waiting-cancel").onclick = cancel;
    draw();
    $("waiting").hidden = false;
  };
  const timer = setTimeout(show, SHOW_AFTER_MS);
  const ticker = setInterval(draw, 200);
  const onKey = (event) => {
    if (event.key === "Escape" && cancel && active?.token === token) {
      event.preventDefault();
      cancel();
    }
  };
  addEventListener("keydown", onKey, true);
  try {
    return await run((p) => {
      latest = p;
      draw();
    });
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    removeEventListener("keydown", onKey, true);
    if (shownAt !== null) {
      const wait = Math.max(0, MIN_SHOW_MS - (performance.now() - shownAt));
      setTimeout(() => {
        if (active?.token !== token) return;
        active = null;
        $("waiting").hidden = true;
      }, wait);
    }
  }
}
