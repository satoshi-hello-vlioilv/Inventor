// 変換の節: 取り込んだ形状の Inventor 用の変換データ（.inventor.json）を保存・コピーし、ビルダーの使い方を示す。

import { formatSpec } from "../convert/inventor.js";

const $ = (id) => document.getElementById(id);
let spec = null, fileName = "";

function reportDone(text) {
  const summary = $("convert-summary");
  summary.textContent = text;
  summary.classList.add("is-done");
}

/**
 * 変換データを差し替える（null で「まだ取り込んでいない」）。
 * @param {object | null} next  convert/inventor.js の buildInventorSpec の結果
 * @param {string} sourceName   元のファイル名（保存するファイル名に使う）
 */
export function setSpec(next, sourceName = "") {
  spec = next;
  fileName = `${sourceName.replace(/\.[^.]+$/, "")}.inventor.json`;
  const kinds = spec?.parts.length ?? 0;
  const placed = spec?.parts.reduce((n, p) => n + p.instances.length, 0) ?? 0;
  const skipped = spec?.skipped.reduce((n, s) => n + s.count, 0) ?? 0;
  const summary = $("convert-summary");
  summary.classList.remove("is-done");
  summary.textContent = !spec ? "取り込むと、変換できる部品の数を表示します"
    : kinds ? `部品 ${kinds} 種類・配置 ${placed} か所を変換します${skipped ? `（近似の ${skipped} 個は変換しません）` : ""}`
      : "正確に認識できた部品がないため、変換できません";
  $("save-spec").disabled = $("copy-spec").disabled = !kinds;
  $("build-command").textContent = `python -m ipt_build ${spec ? fileName : "変換データ.json"}`;
}

$("save-spec").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([formatSpec(spec)], { type: "application/json" }));
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  reportDone(`${fileName} を保存しました（ダウンロードに現れない場合は「コピー」を使ってください）`);
});

$("copy-spec").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatSpec(spec));
    reportDone(`変換データをコピーしました。テキストエディタに貼り付けて ${fileName} として保存してください`);
  } catch {
    reportDone("コピーできませんでした。このブラウザではクリップボードが使えません");
  }
});
