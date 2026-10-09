// この画面を配る窓（Inventor3DTool.exe。desktop/src/router.rs）とのやりとり:
//   サンプルの一覧・起動で受け取ったファイル（exe へのドロップ・2 つめの起動）・「STEP を作る」「Inventor で作る」。
// 問い合わせは同じ置き場（/api/…）へ送り、窓が答える（ポートは使わない）。
// 依頼には起動ごとの合言葉（<meta name="app-token">）を添える（窓はこの画面からの依頼だけを受け付ける）。
// 受け取ったものは ui/files.js と同じ形 { name, size, read: () => Promise<Uint8Array> } にそろえる（中身は開くときに読む）。

import { LAUNCHER } from "./ui/product.js";

const TOKEN = document.querySelector('meta[name="app-token"]')?.content ?? "";
// 読めなかった理由（利用者に見せる文。次にすることまで）
const REASONS = {
  offline: `アプリの窓に届きません。アプリ（${LAUNCHER}）を開き直してください`,
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
    const answer = await response.json().catch(() => null); // 理由を返す依頼（作れない変換データ・作成中・Python が無い）はそれを使う
    throw new Error(answer?.message ?? REASONS[response.status] ?? `アプリの窓が ${response.status} を返しました`);
  }
  return response;
}

const post = async (path, body) =>
  (await request(path, { method: "POST", ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) })).json();

const remote = ({ name, size, url }) => ({ name, size, read: async () => new Uint8Array(await (await request(url)).arrayBuffer()) });

/** サンプルの一覧（種類の順は窓のまま: ipt → iam → stp → html。種類の中は名前順） */
export async function listSamples() {
  const { samples } = await (await request("/api/samples")).json();
  const kinds = [...new Set(samples.map((s) => s.kind))];
  const byName = (a, b) => a.name.localeCompare(b.name, "ja");
  return kinds.flatMap((kind) => samples.filter((s) => s.kind === kind).sort(byName)).map(remote);
}

/**
 * 起動で受け取ったファイル（まだ渡していない分をまとめて。無ければ空）。
 * @returns {Promise<{ items: object[], parts: object[], missing: string[] }>}
 *   items … 受け取ったファイル、parts … 組立（.iam）と同じフォルダの部品（.ipt。組立が参照する部品を探す置き場に加える）、
 *   missing … 起動してから画面が受け取るまでに見つからなくなったファイルの名前
 */
export async function claimLaunch() {
  const { files, parts, missing } = await (await request("/api/launch", { method: "POST" })).json();
  return { items: files.map(remote), parts: parts.map(remote), missing };
}

/**
 * アプリを開いたまま、exe へファイルがドロップされた（2 つめの起動）ときに呼ぶ。窓が `inventor:launch` を知らせる。
 * @param {(claim: ReturnType<typeof claimLaunch>) => void} callback  受け取りの約束（claimLaunch と同じ答え。誤りの扱いは呼ぶ側が決める）
 */
export function onLaunch(callback) {
  addEventListener("inventor:launch", () => callback(claimLaunch()));
}

/**
 * 「STEP を作る」「Inventor で作る」（desktop/src/jobs.rs）。答えはどれも、いまの状態（state・部品ごとの結果・STEP の結果 step・
 * 保存先 out_dir など）と、ライブラリ（pywin32）が入っているか（ready）・この PC に Inventor があるか（inventor_installed）・
 * 保存先の親フォルダ（root）・Python が見つからないときの理由（python_missing。見つかれば null）。
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

// ---- 設定: ショートカット・版の管理（desktop/src/shortcut.rs・update.rs。docs/desktop.md §8） ----

/** ショートカットの状態 { supported, offer, target, places: [{ place, label, state: ok | missing | other, path }] } */
export const shortcutStatus = async () => (await request("/api/shortcut")).json();
/** 置き場（desktop・start）にショートカットを作る（作り直す）。答えは作った後の状態 */
export const createShortcut = (place) => post("/api/shortcut", { place });
/** 起動のときの「デスクトップに作りますか」に「作らない」と答えた（次からは尋ねない） */
export const declineShortcut = () => post("/api/shortcut/decline");

/** 版の管理の状態（置き場・配る版・版の一覧・役割。置き場に届かなければ reachable: false と理由 why） */
export const updateStatus = async () => (await request("/api/update")).json();
export const updateProgress = async () => (await request("/api/update/progress")).json();
/** 版を置く ZIP を窓のファイルを選ぶ窓で選ぶ（選ばなければ null） */
export const pickZip = async () => (await post("/__desktop/pick-zip")).path ?? null;
// ---- 保存（desktop/src/save.rs）: 画面で作ったファイルを、窓の保存の窓で選んだ場所へ書く ----

/** バイト列 → base64（大きな図面でも引数の数の上限を超えないよう、区切って変える） */
function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * 保存の窓を開いて書く。中身は文字列（UTF-8 で書く）かバイト列（Shift_JIS などは呼ぶ側で符号化する）。
 * @param {{ name: string, title?: string, filter?: { label: string, extensions: string[] }, content: string | Uint8Array }} file
 * @returns {Promise<string | null>} 保存した場所（窓を閉じて選ばなければ null）
 */
export async function saveFile({ name, title, filter, content }) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return (await post("/__desktop/save-file", { name, title, filter, data: base64(bytes) })).path ?? null;
}

/** 版の管理の操作: publish {path}・release {version}・delete {version}・policy {keep}・roles {developers, maintainers}・settings {dir} */
export const updateOp = (op, body) => post(`/api/update/${op}`, body);
