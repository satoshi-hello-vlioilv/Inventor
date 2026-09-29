// 配布フォルダ（Inventor部品ビューア）の評価: 利用者が迷わない構成か、ビューアが最新か、起動ファイルとの約束が守られているか。
// 起動ファイル（VBS）の動作そのものは launcher-wine.mjs（Wine で実行する検証）で確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { APP_DIR, OUT, ROOT, buildPage, sampleFiles } from "../build.mjs";

const DIST = path.dirname(APP_DIR);
const LAUNCHER = path.join(DIST, "Inventor部品ビューア.vbs");

test("配布フォルダの直下は、起動ファイルと「アプリ本体」フォルダだけ", () => {
  assert.deepEqual(fs.readdirSync(DIST).sort(), ["Inventor部品ビューア.vbs", "アプリ本体"].sort());
});

test("アプリ本体には、起動処理・ビューア・ビルダー・解析ツール・必要な Python パッケージの一覧がある", () => {
  for (const name of ["起動.bat", "ipt-viewer.html", "ipt_build/__main__.py", "ipt_build/gui.py", "ipt_inspect/labels.json", "requirements.txt"]) {
    assert.ok(fs.existsSync(path.join(APP_DIR, name)), name);
  }
});

test("配布フォルダのビューアが、現在のソースから作ったものと一致する（npm run build 忘れの検出）", async () => {
  const { html } = await buildPage();
  assert.ok(fs.readFileSync(OUT, "utf8") === html, "npm run build で作り直してください");
});

test("samples/ipt・samples/html の全ファイルをサンプルとして埋め込む", () => {
  const html = fs.readFileSync(OUT, "utf8");
  const embedded = [...html.matchAll(/<script type="application\/octet-stream" class="sample" data-name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(embedded, sampleFiles().map((s) => s.name.replace(/&/g, "&amp;")));
  assert.ok(embedded.some((n) => n.endsWith(".ipt")) && embedded.some((n) => n.endsWith(".html")));
});

test("起動ファイル（VBS）は UTF-16LE（BOM 付き）・CRLF で、アプリ本体の 起動.bat を画面を出さずに実行するだけ", () => {
  const bytes = fs.readFileSync(LAUNCHER);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "Windows Script Host が日本語を読めるよう UTF-16（BOM 付き）で保存する");
  const text = bytes.subarray(2).toString("utf16le");
  assert.ok(!/[^\r]\n/.test(text), "改行は CRLF");
  assert.ok(text.includes(`"${path.basename(APP_DIR)}\\起動.bat"`));
  assert.match(text, /\.Run "cmd \/s \/c """ & command & """", 0, False/);
  const code = text.split("\r\n").filter((l) => l.trim() && !l.trim().startsWith("'"));
  assert.ok(code.length <= 20, `VBS は bat を呼ぶだけ（${code.length} 行）`);
});

test("起動.bat は UTF-8（BOM なし）・CRLF で、実行する行は英数字だけ。ビューアと同じ受け渡しの約束を使う", () => {
  const text = fs.readFileSync(path.join(APP_DIR, "起動.bat"), "utf8");
  assert.ok(!text.startsWith("\uFEFF") && !/[^\r]\n/.test(text));
  const code = text.split("\r\n").filter((l) => !/^rem\b/i.test(l));
  assert.deepEqual(code.filter((l) => /[^\x00-\x7f]/.test(l)), [], "日本語は注記（rem）だけ");
  assert.deepEqual(text.split("\r\n").filter((l) => /^rem\b/i.test(l) && /[%^]/.test(l)), [], "注記に % ^ を書かない（bat が解釈する）");
  assert.ok(text.includes("(window.IPT_VIEWER_LAUNCH=window.IPT_VIEWER_LAUNCH^|^|[]).push({name:`"));
  assert.ok(text.includes('push({message:"python-missing"})'));
  assert.ok(text.includes("-m ipt_build --gui"));
  const main = fs.readFileSync(path.join(ROOT, "app/src/main.js"), "utf8");
  assert.ok(main.includes("window.IPT_VIEWER_LAUNCH") && main.includes('"python-missing"'));
});
