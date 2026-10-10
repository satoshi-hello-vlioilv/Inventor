// 設定の区分の並び（目次の順）。区分を足すときは、1 つのファイルに区分を書いてここへ並べるだけ（ページの枠 ui/settings.js は変えない）。
//
// 区分 = {
//   id, label, icon（目次の印。24×24 の SVG の道）, group（GROUPS の鍵）,
//   lead(ctx) → 区分の説明の 1 行,
//   badge(ctx) → { tone: ok | warn | bad | idle, text } | null … 目次に出す、いまの状態（開かずに分かる）,
//   visible?(ctx) → 出すか（役割など、人によって無い区分）,
//   toolbar?(ctx) → [Node] … 区分の主の操作（見出しの下に置き、見出しと一緒に上に留める。区分が長くても見える）,
//   render(ctx) → [Node] … 中身（null は飛ばす）,
// }
// ctx = { update, shortcut（窓の答え）, confirm, draft, publishing, message（区分の中の途中の状態）,
//         set(patch) … 状態を変えて描き直す, act(run, done) … 操作して知らせ、読み直す, go(id) … 区分を移る }

import { overview } from "./overview.js";
import { roles } from "./roles.js";
import { share } from "./share.js";
import { shortcut } from "./shortcut.js";
import { versions } from "./versions.js";

/** 目次のまとまり（この PC のこと → 全ての PC に関わる配布のこと） */
export const GROUPS = [
  ["pc", "この PC"],
  ["share", "配布（版の管理）"],
];

export const PANES = [overview, shortcut, versions, share, roles];
