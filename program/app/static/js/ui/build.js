// 「CAD ファイルを作る」: 押すと窓（Inventor3DTool.exe）が Python の作る係を動かし（desktop/src/jobs.rs）、進み具合と結果を出す。
//   Inventor で作る … STEP（.stp）と、Inventor で部品（.ipt）・組立（.iam）。部品ごとに体積・表面積を照合する
//   STEP を作る     … STEP（.stp）だけ。Inventor もライブラリも使わない
// 出す場所: 行動ドック（右の欄の下端。次にすること・進み具合・中止・保存先を開く）と「照合の結果」の欄（帯と部品ごとの行）。
// この PC に Inventor が無ければ STEP を主のボタンにして勧める（Inventor のボタンも押せる）。Python が見つからなければ、押す前に理由を出す。
// 1 度に 1 つ。作っている間にほかのファイルを開いてもよい（仕事は窓で続き、どの表示でもドックに状態を出す）。
// 終わった結果は、作り始めたときの形（変換データ）を表示している間だけ出す（ほかの形の結果と取り違えない）。

import { buildStatus, cancelBuild, openBuildFolder, startBuild } from "../desktop.js";
import { flow, onFlow, setNext, updateFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
const RUNNING = new Set(["installing", "step", "connecting", "building", "assembly"]);
const POLL_MS = 800;
const VERDICT = { ok: ["ok", "一致"], mismatch: ["warn", "不一致"], failed: ["bad", "失敗"] };

let spec = null; // 表示中の形の変換データ（作れる部品が無ければ null）
let owner = null; // 作り始めたときの変換データ
let job = { state: "idle" }; // 窓の仕事の状態（BuildRun.status() に state・message などを足したもの）
let root = ""; // 保存先の親フォルダ
let inventorHere = true; // この PC に Inventor があるか（分かるまでは、ある前提）
let pythonMissing = null; // Python が見つからない理由（見つかれば null）
let asking = false; // ライブラリを入れるかを尋ねている

let timer = 0;

/** 期待値との差（相対）を % で表す（表示の桁で 0 になる差は符号を付けない。ビルダーの pct と同じ） */
function pct(value) {
  if (value == null) return "—";
  const text = `${value >= 0 ? "+" : ""}${(value * 100).toFixed(4)}%`;
  return text === "+0.0000%" || text === "-0.0000%" ? "0.0000%" : text;
}

/** STEP の結果の一言: 「部品 3 種類・配置 459 か所の組立。うち 1 種類は三角形の面」 */
function stepSummary(step) {
  const faceted = step.parts.filter((p) => p.how === "faceted").length;
  return `部品 ${step.parts.length} 種類${step.assembly ? `・配置 ${step.placed} か所の組立` : ""}${faceted ? `。うち ${faceted} 種類は三角形の面` : ""}`;
}

const madeCount = (j) => (j.parts ?? []).filter((p) => p.verdict).length;

/** 状態の一文と色（run: 進行中・ok: できた・warn: 一部だけ・bad: 失敗・wait: 中止） */
function describeJob(j) {
  const total = j.total ?? 0;
  switch (j.state) {
    case "installing": return ["run", "Inventor の操作に使うライブラリを入れています（1 分ほど）…"];
    case "step": return ["run", "STEP を書いています…"];
    case "connecting": return ["run", "Inventor に接続しています（起動していなければ起動します）…"];
    case "building": return ["run", `部品を作っています（${madeCount(j)} / ${total}）`];
    case "assembly": return ["run", "組立を作っています…"];
    case "done": {
      if (j.step?.error) return ["bad", j.step.error];
      if (!j.inventor) return ["ok", `STEP を作りました（${stepSummary(j.step)}）`];
      if (j.inventor_error) return ["warn", `STEP はできました。Inventor では作れませんでした: ${j.inventor_error}`];
      return j.good === total && !j.assembly?.error
        ? ["ok", `すべての部品が期待値と一致しました（${total} / ${total}）`]
        : ["warn", `一致しない部品があります（一致 ${j.good} / ${total}）`];
    }
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

const node = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });

/** 結果の 1 行: 札（色と文字）・名前・差、必要なら理由 */
function row(tone, label, name, diff = "", error = null, title = "") {
  const li = document.createElement("li");
  const chip = node("span", "verdict", label);
  chip.dataset.tone = tone;
  li.append(chip, node("span", "name", name), node("span", "diff", diff));
  if (error) li.append(node("span", "error", error));
  li.title = title;
  return li;
}

/**
 * 結果の行: STEP の行、部品ごとの行（Inventor で作るとき。まだの部品は「待ち」、作っている部品は「作成中」。
 * 失敗・中止のあとは結果の出た部品だけ）、組立の行
 */
function resultRows(j) {
  const rows = [];
  if (j.step) {
    const faceted = j.step.parts?.filter((p) => p.how === "faceted") ?? [];
    rows.push(j.step.error ? row("bad", "失敗", "STEP", "", j.step.error)
      : row("ok", "STEP", j.step.file, faceted.length ? `三角形 ${faceted.length}` : "厳密",
        null, [stepSummary(j.step), ...faceted.map((p) => p.note).filter(Boolean)].join("\n")));
  }
  if (!j.inventor) return rows;
  const running = RUNNING.has(j.state);
  const parts = (j.parts ?? []).filter((p) => running || (j.state === "done" && !j.inventor_error) || p.verdict);
  const prefix = commonPrefix((j.parts ?? []).map((p) => p.name));
  const current = j.state === "building" ? parts.findIndex((p) => !p.verdict) : -1;
  parts.forEach((p, i) => {
    const [tone, label] = VERDICT[p.verdict] ?? (i === current ? ["run", "作成中"] : ["wait", "待ち"]);
    const measured = p.verdict && p.verdict !== "failed";
    rows.push(row(tone, label, p.name.slice(prefix.length) || p.name, measured ? `体積 ${pct(p.volume_diff)}` : "", p.error,
      [p.name, measured ? `体積の差 ${pct(p.volume_diff)} · 表面積の差 ${pct(p.area_diff)}` : null, p.extent || null, `配置 ${p.instances} か所`]
        .filter(Boolean).join("\n")));
  });
  if (j.assembly) {
    const done = j.state === "done";
    const [tone, label] = j.assembly.error ? ["bad", "失敗"] : done ? ["ok", "組立"] : j.state === "assembly" ? ["run", "作成中"] : ["wait", "待ち"];
    rows.push(row(tone, label, j.assembly.file, done && !j.assembly.error ? `配置 ${j.assembly.placed} か所` : "", j.assembly.error));
  }
  return rows;
}

/** 照合の要約: 帯（一致・不一致・失敗・作成中・待ちの割合）と、それぞれの数 */
function renderSummary(j) {
  const counts = { ok: 0, warn: 0, bad: 0, run: 0, wait: 0 };
  if (j.inventor) {
    const current = j.state === "building" ? (j.parts ?? []).findIndex((p) => !p.verdict) : -1;
    (j.parts ?? []).forEach((p, i) => counts[VERDICT[p.verdict]?.[0] ?? (i === current ? "run" : "wait")]++);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const box = $("build-summary");
  box.hidden = !total;
  if (!total) return;
  const bar = node("div", "verdict-bar");
  bar.setAttribute("role", "img");
  const legend = node("p", "verdict-legend");
  const names = { ok: "一致", warn: "不一致", bad: "失敗", run: "作成中", wait: "待ち" };
  for (const [tone, n] of Object.entries(counts)) {
    if (!n) continue;
    const seg = node("span", `is-${tone}`);
    seg.style.width = `${(100 * n) / total}%`;
    bar.append(seg);
    const item = node("span", "");
    item.dataset.tone = tone;
    item.append(node("i", ""), node("span", "", names[tone]), node("b", "", String(n)));
    legend.append(item);
  }
  bar.setAttribute("aria-label", [...legend.children].map((c) => c.textContent).join("・"));
  box.replaceChildren(bar, legend);
}

/** この PC で勧める作り方を主（塗り）のボタンにする（again: 作り終えた後。「作り直す」として控えめに並べる）。Inventor が無ければ STEP を勧め、理由を添える */
function renderChoices(again) {
  const [inventor, step] = [$("build"), $("build-step")];
  for (const button of [inventor, step]) {
    button.disabled = !spec || asking;
    button.title = !spec ? "作れる部品がありません" : "";
  }
  inventor.className = !again && inventorHere ? "primary" : "secondary";
  step.className = !again && !inventorHere ? "primary" : "secondary";
  $("build-actions").classList.toggle("is-again", again);
  const hint = pythonMissing ?? (inventorHere ? "" : "この PC には Inventor が見つかりません。STEP は Inventor なしで作れます（Inventor で開けば .ipt・.iam になります）");
  $("build-hint").hidden = !hint || !spec || again;
  $("build-hint").textContent = hint;
  return again ? null : inventorHere ? inventor : step;
}

function render() {
  const { mode } = flow();
  const running = RUNNING.has(job.state);
  const own = owner !== null && owner === spec;
  const finished = !running && job.state !== "idle" && own;
  const convert = mode === "html" || mode === "spec";
  $("dock-build").hidden = !(convert || running);
  $("result-card").hidden = !(convert && own && job.state !== "idle" && (job.step || job.inventor || job.detail));

  const [tone, text] = running || finished ? describeJob(job) : ["wait", ""];
  $("dock").dataset.tone = running || finished ? tone : spec ? "run" : "wait";
  $("build-state").textContent = running && !own && job.name ? `「${job.name}」: ${text}` : text;
  $("convert-summary").hidden = running || finished || asking;
  $("build-bar").hidden = !running;
  $("build-bar").firstElementChild.style.width = `${job.inventor ? (100 * madeCount(job)) / Math.max(job.total ?? 1, 1) : 35}%`;
  $("build-ask").hidden = !asking;
  $("build-cancel").hidden = !running;
  $("build-open").hidden = running || !finished || !job.out_dir;
  $("build-actions").hidden = running || asking || !convert;
  const choice = renderChoices(finished && Boolean(job.out_dir)); // 何もできずに終わったら（保存先なし）、作るボタンがそのまま次にすること
  $("build-dest").textContent = (running || finished) && job.out_dir ? `保存先: ${job.out_dir}` : root ? `保存先: ${root}（この中に新しいフォルダを作ります）` : "";
  $("build-dest").title = $("build-dest").textContent;

  $("build-detail").hidden = !own || !job.detail;
  $("build-detail").textContent = own ? job.detail ?? "" : "";
  $("build-results").replaceChildren(...(own ? resultRows(job) : []));
  renderSummary(own ? job : {});

  // 次にすること: 尋ねている → 入れて作る、終わった → 保存先を開く、作れる → 勧める作り方（作っている間は無し。中止は副）
  const next = asking ? $("build-install") : finished && job.out_dir ? $("build-open") : !running && convert ? choice : null;
  setNext("build", next);
}

/** 作る仕事の要約を流れに知らせる（段階の帯が「作る」「照合する」の段に使う） */
function publish() {
  const own = owner !== null && owner === spec;
  const [tone] = describeJob(job);
  updateFlow({
    own,
    job: { state: job.state, tone, made: madeCount(job), total: job.total ?? 0, good: job.good ?? 0, inventor: Boolean(job.inventor),
      inventorError: Boolean(job.inventor_error), name: job.name },
  });
}

/** 窓の状態を読み直し、作っている間は続けて読む */
async function refresh() {
  clearTimeout(timer);
  try {
    const answer = await buildStatus();
    root = answer.root ?? root;
    inventorHere = answer.inventor_installed ?? inventorHere;
    pythonMissing = answer.python_missing ?? null;
    job = answer;
  } catch (error) {
    console.warn(error); // 窓に届かない（作り始め・中止の答えが理由を出す）
    return;
  }
  publish();
  if (RUNNING.has(job.state)) timer = setTimeout(refresh, POLL_MS);
}

async function start(target, install = false) {
  asking = false;
  render();
  try {
    const answer = await startBuild(spec, { install, target });
    root = answer.root ?? root;
    pythonMissing = answer.python_missing ?? null;
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
  publish();
  render();
}

/** 表示中の形の変換データを差し替える（作れる部品が無ければ null） */
export function setBuildSpec(next) {
  spec = next;
  asking = false;
  publish();
}

/** 起動したとき: 保存先・この PC に Inventor があるか・作っている途中の仕事（画面を開き直したときなど）を読む */
export const initBuild = () => refresh();

onFlow(render); // 表示の切り替え・仕事の進み具合で描き直す

$("build").addEventListener("click", () => start("inventor"));
$("build-step").addEventListener("click", () => start("step"));
$("build-install").addEventListener("click", () => start("inventor", true));
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
