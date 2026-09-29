// 起動ファイル（Inventor部品ビューア.vbs）の評価。Windows の代わりに Wine で VBScript を動かす（手動で実行する検証）。
//   node app/test/launcher-wine.mjs      … 要 wine・xvfb-run・Playwright（Chromium）
//
// Wine の cscript は UTF-16 の VBS を読めず、日本語ロケールも無いので、検証用のコピーを作って動かす:
//   - 日本語を含む文字列リテラルを ChrW(文字コード) の連結に置き換え、コメントを除いて ASCII だけにする（値は同じ）
//   - MsgBox を「決めておいた答えを返し、文面を記録する」関数に置き換える（人がボタンを押さなくても全ての分岐を通せる）
//   - shell.Run も記録するだけにする（ブラウザー・Inventor・Python を起動せずに、組み立てたコマンドを確かめる。
//     Wine の Run は .cmd を直接起動できないため。作ったページは、この検証の中で Chromium で開いて確かめる）
//   - Wine の ExpandEnvironmentStrings は末尾に終端文字（Chr(0)）を付けて返す不具合があるので、それを取り除く
// Windows が UTF-16（BOM 付き）の VBS を読めることは Windows Script Host の仕様で、ここでは確かめられない。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { APP_DIR, LAUNCH_MARKER, ROOT } from "../build.mjs";

const LAUNCHER = path.join(path.dirname(APP_DIR), "Inventor部品ビューア.vbs");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
const PREFIX = process.env.WINEPREFIX ?? path.join(WORK, "prefix");
// LANG は UTF-8 にする（日本語のパスを Wine に正しく渡すため）
const env = { ...process.env, WINEPREFIX: PREFIX, WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml=", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const winPath = (p) => `Z:${p}`;
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);

// ---- 検証用コピーを作る -----------------------------------------------------------
// Wine 9.0 の VBScript には ChrW・Unescape・日付計算・ADODB.Stream・MSXML の Base64 が無いので、
//   日本語を含む文字列 → UTF-16 のテキストファイルから読み込んだ配列 S(k)（値は同じ）
//   ReadUtf8・WriteUtf8・ReadBase64（ADODB・MSXML を使う 3 関数）→ FileSystemObject で同じ働きをする代わり
//     （ビューアは UTF-16 の複製 *.u16 を読み、ページは UTF-16 で書き、中身は検証側が用意した *.b64 を読む）
// に置き換える。それ以外（引数の振り分け・確認・コマンドの組み立て・URL・文字の逃がし・一時ファイル）は元のまま。
const STRINGS = path.join(WORK, "strings.txt");
function toAscii(source) {
  const strings = [];
  const lines = source.replace(/^﻿/, "").split(/\r?\n/).map((line) => {
    let out = "", i = 0;
    while (i < line.length) {
      if (line[i] === "'") break; // コメント
      if (line[i] !== '"') { out += line[i++]; continue; }
      let j = i + 1, value = "";
      for (;;) {
        if (line[j] === '"' && line[j + 1] === '"') { value += '"'; j += 2; continue; }
        if (line[j] === '"') break;
        value += line[j++];
      }
      if (/[^\x00-\x7f]/.test(value)) out += `S(${strings.push(value) - 1})`;
      else out += `"${value.replace(/"/g, '""')}"`;
      i = j + 1;
    }
    return out.trimEnd();
  });
  fs.writeFileSync(STRINGS, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(strings.join("\n"), "utf16le")]));
  let text = lines.join("\r\n")
    .replace(/^Const (\w+) = (S\(\d+\))$/gm, "Dim $1 : $1 = $2") // Const には式を書けない
    .replace(/^Option Explicit$/m, `Option Explicit\r\nDim S : S = Split(CreateObject("Scripting.FileSystemObject").OpenTextFile(${JSON.stringify(winPath(STRINGS))}, 1, False, -1).ReadAll, vbLf)`)
    .replace(/\bMsgBox\b/g, "TestMsgBox")
    .replace(/^(Function|Sub) (ReadUtf8|WriteUtf8|ReadBase64)\(/gm, "$1 Original_$2(")
    .replace(/\bshell\.Run\b/g, "TestRun")
    .replace(/\bshell\.ExpandEnvironmentStrings\(/g, "TestExpand(");
  const hooks = `
Dim TestAnswer
Function TestText(path, unicode)
  TestText = CreateObject("Scripting.FileSystemObject").OpenTextFile(path, 1, False, unicode).ReadAll
End Function
Function ReadUtf8(path)
  ReadUtf8 = TestText(path & ".u16", -1)
End Function
Sub WriteUtf8(path, text)
  Dim f : Set f = CreateObject("Scripting.FileSystemObject").CreateTextFile(path, True, True)
  f.Write text : f.Close
End Sub
Function ReadBase64(path)
  ReadBase64 = TestText(path & ".b64", 0)
End Function
Sub TestLog(text)
  Dim f : Set f = CreateObject("Scripting.FileSystemObject").OpenTextFile(${JSON.stringify(winPath(path.join(WORK, "log.txt")))}, 8, True, -1)
  f.WriteLine text : f.Close
End Sub
Function TestMsgBox(text, buttons, title)
  Dim answers : answers = Split(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%TEST_ANSWERS%") & ",1,1,1", ",")
  If IsEmpty(TestAnswer) Then TestAnswer = 0
  If answers(0) = "%TEST_ANSWERS%" Then answers = Split("1,1,1", ",")
  TestLog "MSGBOX " & Replace(text, vbCrLf, " / ")
  TestMsgBox = CInt(answers(TestAnswer))
  TestAnswer = TestAnswer + 1
End Function
Function TestExpand(text)
  TestExpand = Replace(CreateObject("WScript.Shell").ExpandEnvironmentStrings(text), Chr(0), "")
End Function
Dim TestRunIndex
Function TestRun(command, style, wait)
  Dim codes : codes = Split(Replace(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%TEST_RUN_CODE%"), Chr(0), "") & ",0,0,0,0", ",")
  If codes(0) = "%TEST_RUN_CODE%" Then codes = Split("0,0,0,0", ",")
  If IsEmpty(TestRunIndex) Then TestRunIndex = 0
  TestLog "RUN " & command
  TestRun = CInt(codes(TestRunIndex)) ' 画面に出さない実行（RunHidden）の終了コードを、呼ばれた順に返す
  TestRunIndex = TestRunIndex + 1
End Function
`;
  return text + "\r\n" + hooks.replace(/\n/g, "\r\n");
}

const source = fs.readFileSync(LAUNCHER);
assert.deepEqual([...source.subarray(0, 2)], [0xff, 0xfe], "UTF-16LE（BOM 付き）であること");
const text = source.subarray(2).toString("utf16le");
check("起動ファイルは UTF-16LE（BOM 付き）・改行は CRLF", !/[^\r]\n/.test(text));
check("ビューアとの約束（埋め込み位置・変数名）が一致", text.includes(`"${LAUNCH_MARKER}"`) && text.includes("window.IPT_VIEWER_LAUNCH"));

// 起動ファイルと同じ構成（起動ファイル＋アプリ本体）の場所を作り、検証用コピーを置く。
// 置き場所には、URL で特別な意味を持つ文字（空白・#・%）と日本語を含む名前を使う
const dist = path.join(WORK, "配布 #1 100%", "Inventor部品ビューア");
fs.mkdirSync(path.join(dist, "アプリ本体"), { recursive: true });
fs.copyFileSync(path.join(APP_DIR, "ipt-viewer.html"), path.join(dist, "アプリ本体", "ipt-viewer.html"));
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
fs.writeFileSync(path.join(dist, "アプリ本体", "ipt-viewer.html.u16"), utf16(fs.readFileSync(path.join(APP_DIR, "ipt-viewer.html"), "utf8")));
const dropped = (file) => { fs.writeFileSync(`${file}.b64`, fs.readFileSync(file).toString("base64")); return file; };
fs.writeFileSync(path.join(dist, "launcher-test.vbs"), toAscii(text), "latin1");
const fakeBrowser = path.join(WORK, "browser.exe"); // 存在すればよい（起動はせず、コマンドを記録する）
fs.writeFileSync(fakeBrowser, "");

function run(args, extraEnv = {}) {
  fs.rmSync(path.join(WORK, "log.txt"), { force: true });
  execFileSync("wine", ["cscript", "//nologo", winPath(path.join(dist, "launcher-test.vbs")), ...args.map(winPath)], {
    env: { ...env, IPT_VIEWER_BROWSER: winPath(fakeBrowser), ...extraEnv }, stdio: "pipe", timeout: 120000,
  });
  const log = fs.existsSync(path.join(WORK, "log.txt")) ? fs.readFileSync(path.join(WORK, "log.txt"), "utf16le").replace(/^\uFEFF/, "") : "";
  const browser = log.split(/\r?\n/).filter((l) => l.startsWith(`RUN "${winPath(fakeBrowser)}"`)).join("\n");
  return { log, browser, messages: log.split(/\r?\n/).filter((l) => l.startsWith("MSGBOX")) };
}

const tempDir = () => {
  const users = path.join(PREFIX, "drive_c/users");
  const user = fs.readdirSync(users).find((u) => fs.existsSync(path.join(users, u, "Temp")));
  return path.join(users, user, "Temp", "Inventor部品ビューア");
};

// ---- 1. 引数なし → ビューアそのものを開く --------------------------------------------
if (!fs.existsSync(path.join(PREFIX, "system.reg"))) execFileSync("wineboot", ["-i"], { env, stdio: "ignore", timeout: 300000 });
let r = run([]);
check("ダブルクリック → ビューアを --app で開く", /--app="file:\/\/\/Z:.*\/ipt-viewer\.html" --start-maximized$/.test(r.browser) && !r.messages.length, r.log.trim());
const viewerUrl = r.browser.match(/--app="([^"]+)"/)?.[1] ?? "";
check("URL: 空白・#・% は符号化し、日本語はそのまま（元のパスに戻せる）",
  !/[ #]/.test(viewerUrl) && decodeURIComponent(viewerUrl.replace("file:///Z:", "")) === path.join(dist, "アプリ本体", "ipt-viewer.html"), viewerUrl);

// ---- 2. ipt・html をドロップ → 中身を埋め込んだ複製を 1 ファイル 1 ウィンドウで開く ---------
fs.rmSync(tempDir(), { recursive: true, force: true });
const odd = path.join(WORK, "a#b%c&d 'e'.html"); // URL・JS で特別な意味を持つ文字を含む名前
fs.copyFileSync(path.join(ROOT, "samples/html/LS4_parts_viewer.html"), odd);
const plate = path.join(WORK, "E_Plate_改_Φ54.5.ipt");
fs.copyFileSync(path.join(ROOT, "samples/ipt/E_Plate_改_Φ54.5.ipt"), plate);
r = run([dropped(plate), dropped(odd)]);
const pages = fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()).filter((f) => f.endsWith(".html")).sort() : [];
check("2 ファイル → 複製 2 つ・ブラウザー 2 回", pages.length === 2 && r.browser.split("\n").length === 2 && !r.messages.length, `${pages.length} / ${r.log}`);

// 複製をブラウザー（Chromium）で開き、ドロップしたファイルがそのまま開かれることを確かめる
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright"));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const [page, expected] of pages.map((p, i) => [p, [path.basename(plate), path.basename(odd)]])) {
  const file = path.join(tempDir(), page);
  const html = fs.readFileSync(file).subarray(2).toString("utf16le");
  fs.writeFileSync(file, html); // 本物の起動ファイルは UTF-8 で書く（ADODB.Stream）。検証用は UTF-16 なので戻す
  const payload = JSON.parse(html.match(/window\.IPT_VIEWER_LAUNCH=(\[.*?\]);<\/script>/s)[1]);
  const original = fs.readFileSync(payload[0].name.endsWith(".ipt") ? plate : odd);
  check(`埋め込み ${payload[0].name}: 名前と中身がドロップしたファイルと一致`, expected.includes(payload[0].name) && Buffer.from(payload[0].data, "base64").equals(original));
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(e.message));
  await tab.route(/three@([\d.]+)\/(.*)$/, (route) => route.fulfill({ // CDN の代わりに手元の three.js を返す
    path: path.join(ROOT, "node_modules/three", route.request().url().match(/three@[\d.]+\/(.*)$/)[1]),
    contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await tab.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await tab.goto(`file://${path.join(tempDir(), page)}`);
  await tab.waitForFunction(() => document.getElementById("file-name").textContent !== "開いていません", null, { timeout: 15000 }).catch(() => {});
  const state = await tab.evaluate(() => ({ name: document.getElementById("file-name").textContent, startOpen: document.getElementById("start").open }));
  check(`複製を開く → ${payload[0].name} を表示し、起動画面は出さない`, state.name === payload[0].name && !state.startOpen && !errors.length, JSON.stringify({ ...state, errors }));
  await tab.close();
}
{
  const tab = await browser.newPage();
  await tab.route(/three@([\d.]+)\/(.*)$/, (route) => route.fulfill({
    path: path.join(ROOT, "node_modules/three", route.request().url().match(/three@[\d.]+\/(.*)$/)[1]),
    contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" },
  }));
  const opened = await tab.goto(viewerUrl.replace("file:///Z:", "file://")).then(() => true, (e) => e.message.split("\n")[0]);
  await tab.waitForTimeout(800);
  check("その URL をブラウザーで開ける（起動画面が出る）", opened === true && await tab.evaluate(() => document.getElementById("start")?.open === true), opened === true ? "" : opened);
  await tab.close();
}
await browser.close();

// ---- 3. 変換データをドロップ → ビルダー（確認・Python の有無・pywin32 の有無） ------------
const spec = path.join(WORK, "リール.inventor.json");
fs.copyFileSync(path.join(ROOT, "tests/fixtures/builder/finger.inventor.json"), spec);
const cases = [
  { label: "はい（作る）", answers: "6", code: "0", expect: (l) => /RUN cmd \/s \/k "title .* & cd \/d ".*アプリ本体" & py -3 -m ipt_build ".*リール\.inventor\.json""$/m.test(l) && !/--dry-run|pip/.test(l) },
  { label: "いいえ（確かめるだけ）", answers: "7", code: "0", expect: (l) => /ipt_build ".*リール\.inventor\.json" --dry-run"$/m.test(l) && !/win32com/.test(l) },
  { label: "キャンセル", answers: "2", code: "0", expect: (l) => !/RUN/.test(l) },
  { label: "Python が無い → 入れ方を案内", answers: "6", code: "1,1", expect: (l) => /MSGBOX Python（3\.10 以上）が見つかりません/.test(l) && !/cmd \/s \/k/.test(l) },
  { label: "py が無く python がある → python で作る", answers: "6", code: "1,0,0", expect: (l) => /& python -m ipt_build ".*リール\.inventor\.json""$/m.test(l) },
  { label: "pywin32 が無い → 入れるか確認し、入れてから作る", answers: "6,6", code: "0,1", expect: (l) => /MSGBOX Inventor を操作するための Python の部品/.test(l) && /&& py -3 -m pip install -r requirements\.txt & py -3 -m ipt_build/.test(l) },
  { label: "pywin32 が無い → 入れないなら作らない", answers: "6,7", code: "0,1", expect: (l) => /MSGBOX Inventor を操作するための/.test(l) && !/cmd \/s \/k/.test(l) },
];
for (const c of cases) {
  r = run([spec], { TEST_ANSWERS: c.answers, TEST_RUN_CODE: c.code });
  check(`変換データ: ${c.label}`, c.expect(r.log), r.log.trim().split(/\r?\n/).map((l) => l.slice(0, 160)).join(" ⏎ "));
}

// ---- 4. 対応していないファイル・ファイルの多さ -------------------------------------------
const other = path.join(WORK, "memo.txt");
fs.writeFileSync(other, "x");
r = run([other]);
check("対応していないファイル → 名前を示して知らせる", /MSGBOX 次のファイルは開けません.*memo\.txt/.test(r.log) && !/RUN/.test(r.log), r.log.trim());
const many = [1, 2, 3, 4, 5].map((i) => { const f = path.join(WORK, `p${i}.ipt`); fs.copyFileSync(plate, f); return dropped(f); });
r = run(many, { TEST_ANSWERS: "2" });
check("5 ファイル → 開く前に確認し、キャンセルなら開かない", /MSGBOX 5 個のファイルを/.test(r.log) && !/RUN/.test(r.log), r.log.trim());

console.log(results.join("\n"));
process.exitCode = results.some((l) => l.startsWith("FAIL")) ? 1 : 0;
