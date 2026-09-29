// 起動の構成の評価: リポジトリの最上位の起動ファイル（VBS）→ launcher/起動.bat → アプリ（app/ から作る dist/ のページ）・ビルダー（builder/）。
// 生成物（アプリ）はリポジトリに置かず、起動のたびにソースが新しければ作り直す。
// 起動ファイル・起動.bat の動作そのものは launcher-wine.mjs（Wine で実行する検証。npm run test:launcher）で確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OUT, ROOT, buildPage, isStale, sampleFiles } from "../build.mjs";

const LAUNCHER = path.join(ROOT, "Inventor3Dツール.vbs");
const BAT = path.join(ROOT, "launcher", "起動.bat");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("最上位に起動ファイル、launcher/ に起動処理と準備の手順、builder/ にビルダー。生成物（アプリ）はリポジトリに置かない", () => {
  assert.ok(fs.existsSync(LAUNCHER));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "launcher")).sort(), ["setup.html", "起動.bat"].sort());
  for (const name of ["requirements.txt", "ipt_build/__main__.py", "ipt_build/gui.py", "ipt_build/inventor.py"]) assert.ok(fs.existsSync(path.join(ROOT, "builder", name)), name);
  assert.equal(path.relative(ROOT, OUT).split(path.sep)[0], "dist");
  assert.ok(read(".gitignore").split("\n").includes("dist/"), "dist/ は git に入れない");
});

test("作り直しの判定（--if-stale）: 出力が無い・材料が新しい・材料の一覧が変わったときだけ作る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
  const [a, b, out] = ["a.js", "b.js", "out.html"].map((n) => path.join(dir, n));
  const at = (file, seconds) => fs.utimesSync(file, seconds, seconds);
  fs.writeFileSync(a, "a");
  fs.writeFileSync(b, "b");
  assert.equal(isStale([a, b], out), true, "出力が無い");
  fs.writeFileSync(out, "built");
  fs.writeFileSync(`${out}.inputs`, [a, b].map((f) => path.relative(ROOT, f).split(path.sep).join("/")).join("\n"));
  at(a, 1000); at(b, 1000); at(out, 2000);
  assert.equal(isStale([a, b], out), false, "材料が全て出力より古い");
  at(b, 3000);
  assert.equal(isStale([a, b], out), true, "材料が出力より新しい");
  at(b, 1000);
  assert.equal(isStale([a], out), true, "材料が減った（サンプルを消したなど）");
  fs.rmSync(dir, { recursive: true });
});

test("samples/ipt・iam・stp・html の全ファイルをサンプルとして埋め込む", async () => {
  const { html } = await buildPage();
  const embedded = [...html.matchAll(/<script type="application\/octet-stream" class="sample" data-name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(embedded, sampleFiles().map((s) => s.name.replace(/&/g, "&amp;")));
  for (const ext of [".ipt", ".iam", ".stp", ".html"]) assert.ok(embedded.some((n) => n.endsWith(ext)), ext);
});

test("起動ファイル（VBS）は UTF-16LE（BOM 付き）・CRLF で、launcher/起動.bat を画面を出さずに実行するだけ", () => {
  const bytes = fs.readFileSync(LAUNCHER);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "Windows Script Host が日本語を読めるよう UTF-16（BOM 付き）で保存する");
  const text = bytes.subarray(2).toString("utf16le");
  assert.ok(!/[^\r]\n/.test(text), "改行は CRLF");
  assert.ok(text.includes('"launcher\\起動.bat"'));
  assert.match(text, /\.Run "cmd \/s \/c """ & command & """", 0, False/);
  const code = text.split("\r\n").filter((l) => l.trim() && !l.trim().startsWith("'"));
  assert.ok(code.length <= 20, `VBS は bat を呼ぶだけ（${code.length} 行）`);
});

test("起動.bat は UTF-8（BOM なし）・CRLF で、実行する行は英数字だけ。アプリを作る場所・受け渡しの約束がアプリと一致する", () => {
  const text = fs.readFileSync(BAT, "utf8");
  assert.ok(!text.startsWith("﻿") && !/[^\r]\n/.test(text));
  const code = text.split("\r\n").filter((l) => !/^rem\b/i.test(l));
  assert.deepEqual(code.filter((l) => /[^\x00-\x7f]/.test(l)), [], "日本語は注記（rem）だけ");
  assert.deepEqual(text.split("\r\n").filter((l) => /^rem\b/i.test(l) && /[%^]/.test(l)), [], "注記に % ^ を書かない（bat が解釈する）");
  assert.ok(text.includes(`set "APPFILE=%TOP%${path.relative(ROOT, OUT).split(path.sep).join("\\")}"`), "build.mjs の出力を開く");
  assert.ok(text.includes('node "%TOP%app\\build.mjs" --if-stale'));
  assert.ok(text.includes('set "PAGE=%HERE%setup.html"'));
  assert.ok(text.includes('pushd "%TOP%builder"') && text.includes("-m ipt_build --gui"));
  assert.ok(text.includes("(window.INVENTOR_TOOL_LAUNCH=window.INVENTOR_TOOL_LAUNCH^|^|[]).push({name:`"));
  assert.ok(text.includes('push({message:"python-missing"})') && text.includes('push({message:"%NOTE%"})'));
  const main = read("app/src/main.js");
  assert.ok(main.includes("readLaunch(window.INVENTOR_TOOL_LAUNCH)") && read("app/src/ui/files.js").includes("export function readLaunch"));
  for (const message of ["python-missing", "node-missing", "build-failed"]) {
    assert.ok(main.includes(`"${message}"`), `アプリが ${message} を知らせる`);
    if (message !== "python-missing") assert.ok(text.includes(`set "NOTE=${message}"`), `起動.bat が ${message} を送る`);
  }
});

test("画面の案内に出す起動ファイルの名前（ui/product.js）が、最上位の起動ファイルと一致する", async () => {
  const { LAUNCHER: name, PRODUCT } = await import("../src/ui/product.js");
  assert.equal(name, path.basename(LAUNCHER));
  const page = read("app/index.html");
  assert.ok(page.includes(`起動ファイル（${name}）`) && page.includes(`<title>${PRODUCT}</title>`));
});
