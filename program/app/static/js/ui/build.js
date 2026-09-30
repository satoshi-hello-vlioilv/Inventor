// 「Inventor で作る」: 押すとサーバーが Inventor で部品と組立を作り（program/app/builds.py）、ここに進み具合と部品ごとの照合の結果を出す。
// 1 度に 1 つ。作っている間にほかのファイルを開いてもよい（仕事はサーバーで続き、作っている間はどの変換の節にも状態を出す）。
// 終わった結果は、作り始めたときの形（変換データ）を表示している間だけ出す（ほかの形の結果と取り違えない）。

import { buildStatus, cancelBuild, openBuildFolder, startBuild } from "../server.js";

const $ = (id) => document.getElementById(id);
const RUNNING = new Set(["installing", "connecting", "building", "assembly"]);
const POLL_MS = 800;
const VERDICT = { ok: ["ok", "一致"], mismatch: ["warn", "不一致"], failed: ["bad", "失敗"] };

let spec = null; // 表示中の形の変換データ（作れる部品が無ければ null）
let owner = null; // 作り始めたときの変換データ
let job = { state: "idle" }; // サーバーの仕事の状態（BuildRun.status() に state・message などを足したもの）
let root = ""; // 保存先の親フォルダ
let asking = false; // ライブラリを入れるかを尋ねている
let timer = 0;

/** 期待値との差（相対）を % で表す（表示の桁で 0 になる差は符号を付けない。ビルダーの pct と同じ） */
function pct(value) {
  if (value == null) return "—";
  const text = `${value >= 0 ? "+" : ""}${(value * 100).toFixed(4)}%`;
  return text === "+0.0000%" || text === "-0.0000%" ? "0.0000%" : text;
}

/** 状態の一文と色（run: 進行中・ok: 一致・warn: 不一致・bad: 失敗・wait: 中止） */
function describeJob(j) {
  const total = j.total ?? 0;
  const made = (j.parts ?? []).filter((p) => p.verdict).length;
  switch (j.state) {
    case "installing": return ["run", "Inventor の操作に使うライブラリを入れています（1 分ほど）…"];
    case "connecting": return ["run", "Inventor に接続しています（起動していなければ起動します）…"];
    case "building": return ["run", `部品を作っています（${made} / ${total}）`];
    case "assembly": return ["run", "組立を作っています…"];
    case "done":
      return j.good === total && !j.assembly?.error
        ? ["ok", `すべての部品が期待値と一致しました（${total} / ${total}）`]
        : ["warn", `一致しない部品があります（一致 ${j.good} / ${total}）`];
    case "failed": return ["bad", `作れませんでした: ${j.message}`];
    case "cancelled": return ["wait", j.message];
    default: return ["wait", ""];
  }
}

/** 部品の名前に共通の頭（「元のファイル名_」）。行では省いて、部品を見分ける部分（番号・種類・寸法）を見せる */
function commonPrefix(names) {
  if (names.length < 2) return "";
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.slice(0, prefix.lastIndexOf("_") + 1);
}

/**
 * 部品の行: 結果の札・名前・体積の差（失敗は理由）。作っている間は、まだの部品を「待ち」、いま作っている部品を「作成中」とし、
 * 失敗・中止のあとは結果の出た部品だけを並べる（作らない部品を「待ち」と見せない）
 */
function resultRows(j) {
  const running = RUNNING.has(j.state);
  const parts = (j.parts ?? []).filter((p) => running || j.state === "done" || p.verdict);
  const prefix = commonPrefix((j.parts ?? []).map((p) => p.name));
  const current = j.state === "building" ? parts.findIndex((p) => !p.verdict) : -1;
  const rows = parts.map((p, i) => {
    const [tone, label] = VERDICT[p.verdict] ?? (i === current ? ["run", "作成中"] : ["wait", "待ち"]);
    const li = document.createElement("li");
    const chip = Object.assign(document.createElement("span"), { className: "verdict", textContent: label });
    chip.dataset.tone = tone;
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: p.name.slice(prefix.length) || p.name });
    const diff = Object.assign(document.createElement("span"), { className: "diff", textContent: p.verdict && p.verdict !== "failed" ? `体積 ${pct(p.volume_diff)}` : "" });
    li.title = [p.name, p.verdict && p.verdict !== "failed" ? `体積の差 ${pct(p.volume_diff)} · 表面積の差 ${pct(p.area_diff)}` : null, p.extent || null, `配置 ${p.instances} か所`]
      .filter(Boolean).join("\n");
    li.append(chip, name, diff);
    if (p.error) li.append(Object.assign(document.createElement("span"), { className: "error", textContent: p.error }));
    return li;
  });
  if (j.assembly) {
    const li = document.createElement("li");
    const done = j.state === "done";
    const [tone, label] = j.assembly.error ? ["bad", "失敗"] : done ? ["ok", "組立"] : j.state === "assembly" ? ["run", "作成中"] : ["wait", "待ち"];
    const chip = Object.assign(document.createElement("span"), { className: "verdict", textContent: label });
    chip.dataset.tone = tone;
    li.append(chip, Object.assign(document.createElement("span"), { className: "name", textContent: j.assembly.file }),
      Object.assign(document.createElement("span"), { className: "diff", textContent: done && !j.assembly.error ? `配置 ${j.assembly.placed} か所` : "" }));
    if (j.assembly.error) li.append(Object.assign(document.createElement("span"), { className: "error", textContent: j.assembly.error }));
    rows.push(li);
  }
  return rows;
}

function render() {
  const running = RUNNING.has(job.state);
  const shown = running || (job.state !== "idle" && owner !== null && owner === spec);
  const button = $("build");
  button.disabled = !spec || running || asking;
  button.title = running ? `「${job.name}」を作っています` : !spec ? "作れる部品がありません" : "";
  $("build-dest").textContent = shown && job.out_dir ? `保存先: ${job.out_dir}` : root ? `保存先: ${root}（この中に、部品（.ipt）と組立（.iam）をまとめた新しいフォルダを作ります）` : "";
  $("build-ask").hidden = !asking;
  $("build-status").hidden = !shown;
  if (!shown) return;
  const [tone, text] = describeJob(job);
  const state = $("build-state");
  state.dataset.tone = tone;
  state.textContent = running && owner !== spec && job.name ? `「${job.name}」: ${text}` : text;
  const made = (job.parts ?? []).filter((p) => p.verdict).length;
  $("build-bar").hidden = !running;
  $("build-bar").firstElementChild.style.width = `${(100 * made) / Math.max(job.total ?? 1, 1)}%`;
  $("build-detail").hidden = !job.detail;
  $("build-detail").textContent = job.detail ?? "";
  $("build-results").replaceChildren(...resultRows(job));
  $("build-cancel").hidden = !running;
  $("build-open").hidden = running || !job.out_dir;
}

/** サーバーの状態を読み直し、作っている間は続けて読む */
async function refresh() {
  clearTimeout(timer);
  try {
    const answer = await buildStatus();
    root = answer.root ?? root;
    job = answer;
  } catch (error) {
    console.warn(error); // サーバーが止まったときは、生存の知らせ（server.js keepAlive）が知らせる
    return;
  }
  render();
  if (RUNNING.has(job.state)) timer = setTimeout(refresh, POLL_MS);
}

async function start(install) {
  asking = false;
  render();
  try {
    const answer = await startBuild(spec, install);
    root = answer.root ?? root;
    if (answer.needs_install) {
      asking = true;
    } else {
      owner = spec;
      job = answer;
      timer = setTimeout(refresh, POLL_MS);
    }
  } catch (error) {
    owner = spec;
    job = { state: "failed", message: error.message };
  }
  render();
}

/** 表示中の形の変換データを差し替える（作れる部品が無ければ null） */
export function setBuildSpec(next) {
  spec = next;
  asking = false;
  render();
}

/** 起動したとき: 保存先と、作っている途中の仕事（画面を開き直したときなど）を読む */
export const initBuild = () => refresh();

$("build").addEventListener("click", () => start(false));
$("build-install").addEventListener("click", () => start(true));
$("build-ask-no").addEventListener("click", () => {
  asking = false;
  render();
});
$("build-cancel").addEventListener("click", async () => {
  $("build-cancel").disabled = true;
  try {
    job = await cancelBuild();
  } finally {
    $("build-cancel").disabled = false;
    await refresh();
  }
});
$("build-open").addEventListener("click", () => openBuildFolder().catch((error) => console.warn(error)));
