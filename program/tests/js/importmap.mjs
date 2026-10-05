// Node の評価・調べる道具で、画面と同じ importmap（app/index.html）を使う（node --import でこのファイルを先に読む）。
// "three"・"fzstd" などの名前を、画面が読むのと同じ同梱ファイル（app/static/vendor）へ向ける。npm で入れたものは使わない。
import { register } from "node:module";

register("./importmap-hooks.mjs", import.meta.url);
