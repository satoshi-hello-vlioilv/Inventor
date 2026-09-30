// このページを配るローカルサーバー（program/app/routes.py）とのやりとり:
//   サンプルの一覧・起動ファイル（Start.vbs）へドロップされたファイル・「Inventor で作る」・
//   「画面が開いている」の知らせ（途切れるとサーバーが止まる）。
// 依頼には起動ごとの合言葉（<meta name="app-token">）を添える（サーバーはこの画面からの依頼だけを受け付ける）。
// 受け取ったものは ui/files.js と同じ形 { name, size, read: () => Promise<Uint8Array> } にそろえる（中身は開くときに読む）。

import { LAUNCHER } from "./ui/product.js";

const TOKEN = document.querySelector('meta[name="app-token"]')?.content ?? "";
const REOPEN = `起動ファイル（${LAUNCHER}）で開き直してください`;
// 読めなかった理由（利用者に見せる文。次にすることまで）
const REASONS = {
  offline: `アプリのサーバーに届きません。${REOPEN}`,
  403: `アプリのサーバーが起動し直したため、この画面からの依頼を受け付けません。${REOPEN}`,
  404: "ファイルが見つかりません（移動・削除された可能性があります）",
};

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options, headers: { "X-App-Token": TOKEN, ...options.headers } });
  } catch {
    throw new Error(REASONS.offline);
  }
  if (!response.ok) {
    const answer = await response.json().catch(() => null); // 理由を返す依頼（作れない変換データ・作成中）はそれを使う
    throw new Error(answer?.message ?? REASONS[response.status] ?? `アプリのサーバーが ${response.status} を返しました`);
  }
  return response;
}

const post = async (path, body) =>
  (await request(path, { method: "POST", ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) })).json();

const remote = ({ name, size, url }) => ({ name, size, read: async () => new Uint8Array(await (await request(url)).arrayBuffer()) });

/** サンプルの一覧（種類の順はサーバーのまま: ipt → iam → stp → html。種類の中は名前順） */
export async function listSamples() {
  const { samples } = await (await request("/api/samples")).json();
  const kinds = [...new Set(samples.map((s) => s.kind))];
  const byName = (a, b) => a.name.localeCompare(b.name, "ja");
  return kinds.flatMap((kind) => samples.filter((s) => s.kind === kind).sort(byName)).map(remote);
}

/**
 * 起動ファイルへドロップされたファイル（この画面が受け取る 1 回分。無ければ空）。
 * @returns {Promise<{ items: object[], parts: object[], missing: string[] }>}
 *   items … ドロップされたファイル、parts … 組立（.iam）と同じフォルダの部品（.ipt。組立が参照する部品を探す置き場に加える）、
 *   missing … 起動してから画面が開くまでに見つからなくなったファイルの名前
 */
export async function claimLaunch() {
  const { files, parts, missing } = await (await request("/api/launch", { method: "POST" })).json();
  return { items: files.map(remote), parts: parts.map(remote), missing };
}

/**
 * 「STEP を作る」「Inventor で作る」（program/app/builds.py）。答えはどれも、いまの状態（state・部品ごとの結果・STEP の結果 step・
 * 保存先 out_dir など）と、ライブラリ（pywin32）が入っているか（ready）・この PC に Inventor があるか（inventor_installed）・
 * 保存先の親フォルダ（root）。
 */
export const buildStatus = async () => (await request("/api/build")).json();
/**
 * 作り始める。target: "inventor"（STEP と .ipt・.iam）か "step"（STEP だけ。Inventor を使わない）。
 * Inventor で作るときライブラリが無ければ、始めずに needs_install を返す（install: true で、入れてから作る）
 */
export const startBuild = (spec, { install = false, target = "inventor" } = {}) => post("/api/build", { spec, install, target });
export const cancelBuild = () => post("/api/build/cancel");
/** 保存先をエクスプローラーで開く */
export const openBuildFolder = () => post("/api/build/open");

/**
 * 画面が開いていることを知らせ続ける（サーバーは知らせが途切れると止まる: 閉じたら止まる）。
 * 裏に回る・閉じる瞬間はタイマーが当てにならないので sendBeacon で送る（sendBeacon は見出しを付けられないので、合言葉は本文に入れる）。
 * @param {{ onLost?: () => void }} options  続けて届かなかったとき（サーバーが止まった）に 1 度だけ呼ぶ
 */
export function keepAlive({ onLost } = {}) {
  let interval = 3000, failures = 0, lost = false, timer = 0;
  const body = (extra = {}) => JSON.stringify({ token: TOKEN, visible: document.visibilityState === "visible", ...extra });
  const beacon = (extra) => navigator.sendBeacon("/api/heartbeat", new Blob([body(extra)], { type: "application/json" }));
  async function beat() {
    try {
      const status = await (await request("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: body() })).json();
      interval = Math.max(1000, (status.interval ?? 3) * 1000);
      failures = 0;
    } catch {
      if (++failures >= 3 && !lost) {
        lost = true;
        onLost?.();
      }
    }
    timer = setTimeout(beat, interval);
  }
  document.addEventListener("visibilitychange", () => beacon());
  addEventListener("pagehide", () => beacon({ closing: true }));
  addEventListener("pageshow", (event) => {
    if (event.persisted) {
      clearTimeout(timer); // 戻る・進むのキャッシュから戻ったとき。止めていた知らせを再開する
      beat();
    }
  });
  beat();
}
