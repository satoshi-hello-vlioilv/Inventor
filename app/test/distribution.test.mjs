// 配布フォルダ（Inventor3Dツール）の評価: 利用者が迷わない構成か、アプリが最新か、起動ファイルとの約束が守られているか。
// 起動ファイル（VBS）の動作そのものは launcher-wine.mjs（Wine で実行する検証）で確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { APP_DIR, OUT, ROOT, buildPage, sampleFiles } from "../build.mjs";

const DIST = path.dirname(APP_DIR);
const LAUNCHER = path.join(DIST, "Inventor3Dツール.vbs");

test("配布フォルダの直下は、起動ファイルと「アプリ本体」フォルダだけ", () => {
  assert.deepEqual(fs.readdirSync(DIST).sort(), ["Inventor3Dツール.vbs", "アプリ本体"].sort());
});

test("アプリ本体は、起動処理・アプリ（HTML）・ビルダー（Python）・その依存の一覧だけ（開発用のファイルを配らない）", () => {
  const files = fs.readdirSync(APP_DIR, { recursive: true }).map((f) => f.split(path.sep).join("/")).filter((f) => !f.includes("__pycache__"));
  const builder = files.filter((f) => f.startsWith("ipt_build/") && f.endsWith(".py"));
  assert.deepEqual(files.filter((f) => !builder.includes(f)).sort(), ["app.html", "ipt_build", "requirements.txt", "起動.bat"].sort());
  for (const name of ["__main__.py", "gui.py", "inventor.py", "spec.py", "verify.py"]) assert.ok(builder.includes(`ipt_build/${name}`), name);
});

test("配布フォルダのアプリが、現在のソース（app/）から作ったものと一致する（npm run build 忘れの検出）", async () => {
  const { html } = await buildPage();
  assert.ok(fs.readFileSync(OUT, "utf8") === html, "npm run build で作り直してください");
});

test("samples/ipt・iam・stp・html の全ファイルをサンプルとして埋め込む", () => {
  const html = fs.readFileSync(OUT, "utf8");
  const embedded = [...html.matchAll(/<script type="application\/octet-stream" class="sample" data-name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(embedded, sampleFiles().map((s) => s.name.replace(/&/g, "&amp;")));
  for (const ext of [".ipt", ".iam", ".stp", ".html"]) assert.ok(embedded.some((n) => n.endsWith(ext)), ext);
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

test("起動.bat は UTF-8（BOM なし）・CRLF で、実行する行は英数字だけ。アプリと同じ受け渡しの約束を使う", () => {
  const text = fs.readFileSync(path.join(APP_DIR, "起動.bat"), "utf8");
  assert.ok(!text.startsWith("\uFEFF") && !/[^\r]\n/.test(text));
  const code = text.split("\r\n").filter((l) => !/^rem\b/i.test(l));
  assert.deepEqual(code.filter((l) => /[^\x00-\x7f]/.test(l)), [], "日本語は注記（rem）だけ");
  assert.deepEqual(text.split("\r\n").filter((l) => /^rem\b/i.test(l) && /[%^]/.test(l)), [], "注記に % ^ を書かない（bat が解釈する）");
  assert.ok(text.includes("(window.INVENTOR_TOOL_LAUNCH=window.INVENTOR_TOOL_LAUNCH^|^|[]).push({name:`"));
  assert.ok(text.includes('push({message:"python-missing"})'));
  assert.ok(text.includes("-m ipt_build --gui"));
  const main = fs.readFileSync(path.join(ROOT, "app/src/main.js"), "utf8");
  const files = fs.readFileSync(path.join(ROOT, "app/src/ui/files.js"), "utf8");
  assert.ok(main.includes("readLaunch(window.INVENTOR_TOOL_LAUNCH)") && main.includes('"python-missing"') && files.includes("export function readLaunch"));
});

test("画面の案内に出す起動ファイルの名前（ui/product.js）が、配布フォルダの起動ファイルと一致する", async () => {
  const { LAUNCHER: name, PRODUCT } = await import("../src/ui/product.js");
  assert.equal(name, path.basename(LAUNCHER));
  const page = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  assert.ok(page.includes(`起動ファイル（${name}）`) && page.includes(`<title>${PRODUCT}</title>`));
});
