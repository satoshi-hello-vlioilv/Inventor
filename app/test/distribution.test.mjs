// 配布フォルダ（Inventor部品ビューア）の評価: 利用者が迷わない構成か、ビューアが最新か、起動ファイルとの約束が守られているか。
// 起動ファイル（VBS）の動作そのものは launcher-wine.mjs（Wine で実行する検証）で確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { APP_DIR, LAUNCH_MARKER, OUT, ROOT, buildPage, sampleFiles } from "../build.mjs";

const DIST = path.dirname(APP_DIR);
const LAUNCHER = path.join(DIST, "Inventor部品ビューア.vbs");

test("配布フォルダの直下は、起動ファイルと「アプリ本体」フォルダだけ", () => {
  assert.deepEqual(fs.readdirSync(DIST).sort(), ["Inventor部品ビューア.vbs", "アプリ本体"].sort());
});

test("アプリ本体には、ビューア・ビルダー・解析ツール・必要な Python パッケージの一覧がある", () => {
  for (const name of ["ipt-viewer.html", "ipt_build/__main__.py", "ipt_inspect/labels.json", "requirements.txt"]) {
    assert.ok(fs.existsSync(path.join(APP_DIR, name)), name);
  }
});

test("配布フォルダのビューアが、現在のソースから作ったものと一致する（npm run build 忘れの検出）", async () => {
  const { html } = await buildPage();
  assert.ok(fs.readFileSync(OUT, "utf8") === html, "npm run build で作り直してください");
});

test("起動ファイルがファイルを差し込む位置が 1 か所だけあり、アプリの処理より前にある", () => {
  const html = fs.readFileSync(OUT, "utf8");
  assert.equal(html.split(LAUNCH_MARKER).length - 1, 1);
  assert.ok(html.indexOf(LAUNCH_MARKER) < html.indexOf('<script type="module">'));
});

test("samples/ipt・samples/html の全ファイルをサンプルとして埋め込む", () => {
  const html = fs.readFileSync(OUT, "utf8");
  const embedded = [...html.matchAll(/<script type="application\/octet-stream" class="sample" data-name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(embedded, sampleFiles().map((s) => s.name.replace(/&/g, "&amp;")));
  assert.ok(embedded.some((n) => n.endsWith(".ipt")) && embedded.some((n) => n.endsWith(".html")));
});

test("起動ファイルは UTF-16LE（BOM 付き）・CRLF で、ビューアと同じ約束（差し込み位置・変数名・フォルダ名）を使う", () => {
  const bytes = fs.readFileSync(LAUNCHER);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "Windows Script Host が日本語を読めるよう UTF-16（BOM 付き）で保存する");
  const text = bytes.subarray(2).toString("utf16le");
  assert.ok(!/[^\r]\n/.test(text), "改行は CRLF");
  assert.ok(text.includes(`Const LAUNCH_MARKER = "${LAUNCH_MARKER}"`));
  assert.ok(text.includes("window.IPT_VIEWER_LAUNCH="));
  assert.ok(text.includes(`Const APP_FOLDER = "${path.basename(APP_DIR)}"`));
  assert.ok(text.includes(`Const VIEWER_FILE = "${path.basename(OUT)}"`));
  assert.ok(fs.readFileSync(path.join(ROOT, "app/src/main.js"), "utf8").includes("window.IPT_VIEWER_LAUNCH"));
});
