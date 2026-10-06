// 変換データの受け渡し: 取り込んだ形状・開いた変換データを「作る」（ui/build.js）へ渡し、作る部品の数を行動ドックと段階の帯に出す。
// Inventor の無い PC で取り込んだときのために、変換データ（.inventor.json）として保存・コピーできる（Inventor のある PC で開いて作る）。

import { formatSpec } from "../convert/inventor.js";
import { setBuildSpec } from "./build.js";
import { updateFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
let spec = null, fileName = "";

function note(text) {
  $("save-note").textContent = text;
  $("save-note").hidden = !text;
}

/**
 * 変換データを差し替える（null で「まだ取り込んでいない」）。
 * @param {object | null} next  convert/inventor.js の buildInventorSpec の結果、または開いた変換データ
 * @param {string} sourceName   元のファイル名（保存するファイル名に使う）
 */
export function setSpec(next, sourceName = "") {
  spec = next;
  fileName = `${sourceName.replace(/(\.inventor)?\.[^.]+$/, "")}.inventor.json`;
  const kinds = spec?.parts.length ?? 0;
  const placed = spec?.parts.reduce((n, p) => n + p.instances.length, 0) ?? 0;
  const approx = spec?.parts.filter((p) => p.kind === "mesh").length ?? 0;
  const skipped = spec?.skipped.reduce((n, s) => n + s.count, 0) ?? 0; // 版 2 までの変換データ
  $("convert-summary").textContent = !spec ? "取り込むと、作れる部品の数を表示します"
    : kinds ? `部品 ${kinds} 種類（配置 ${placed} か所）${placed > 1 ? "と組立" : ""}を作ります` +
      `${approx ? `。うち近似の ${approx} 種類は三角形のまま` : ""}${skipped ? `。近似の ${skipped} 個は作りません` : ""}`
      : "作れる形がありません";
  $("save-spec").disabled = $("copy-spec").disabled = !kinds;
  note("");
  updateFlow({ parts: kinds });
  setBuildSpec(kinds ? spec : null);
}

$("save-spec").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([formatSpec(spec)], { type: "application/json" }));
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  note(`${fileName} を保存しました（ダウンロードに現れない場合は「コピー」を使ってください）`);
});

$("copy-spec").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatSpec(spec));
    note(`変換データをコピーしました。テキストエディタに貼り付けて ${fileName} として保存してください`);
  } catch {
    note("コピーできませんでした。このブラウザではクリップボードが使えません");
  }
});
