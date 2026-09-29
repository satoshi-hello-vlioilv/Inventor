// 起動ファイル（Inventor部品ビューア.vbs → アプリ本体\起動.bat）の評価。Windows の代わりに Wine で動かす（手動で実行する検証）。
//   node app/test/launcher-wine.mjs      … 要 wine・Playwright（Chromium）
//
// Wine（9.0）で動かない部分だけを差し替えた「検証用のコピー」を動かす。差し替えは次のとおりで、それ以外は元のまま:
//   VBS … Wine の cscript は UTF-16 の VBS を読めないので、日本語の文字列を UTF-16 のテキストから読む配列にし、
//         MsgBox と shell.Run を記録する関数にする
//   bat … Wine の certutil は何もしない。名前を UTF-16 で書き出す「cmd /u」も動かない。そこで、この 2 つの結果
//         （certutil と同じ形式の Base64）を検証側で用意して写す。ブラウザーの起動（start）は記録する。
//         Python（py・python）は、終了コードを返して呼ばれ方を記録する代わりのコマンド（.cmd）にする。
//         本物は .exe なので、代わりの .cmd を呼んでも元の bat に戻るよう、呼び出しに call を付ける
// 作ったページは Chromium で開き、ビューアがドロップされたファイル・知らせを受け取れることを確かめる。
// Windows でしか確かめられないこと: UTF-16 の VBS の読み込み、certutil・cmd /u の実際の出力、Edge の --app での表示。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { APP_DIR, ROOT } from "../build.mjs";

const DIST = path.dirname(APP_DIR);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
const PREFIX = process.env.WINEPREFIX ?? path.join(WORK, "prefix");
// LANG は UTF-8 にする（日本語のパスを Wine に正しく渡すため）
const env = { ...process.env, WINEPREFIX: PREFIX, WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml=", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const win = (p) => `Z:${p.replace(/\//g, "\\")}`;
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
const read16 = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf16le").replace(/^\uFEFF/, "") : "");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "latin1").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean) : []); // Wine の echo は行末に空白を残す
if (!fs.existsSync(path.join(PREFIX, "system.reg"))) execFileSync("wineboot", ["-i"], { env, stdio: "ignore", timeout: 300000 });

// ---- 検証用のコピーを置く場所（URL・コマンドで特別な意味を持つ文字と日本語を含む）----------------
const dist = path.join(WORK, "配布 #1 (試)", "Inventor部品ビューア");
const app = path.join(dist, "アプリ本体");
fs.mkdirSync(app, { recursive: true });
fs.copyFileSync(path.join(APP_DIR, "ipt-viewer.html"), path.join(app, "ipt-viewer.html"));

// ---- VBS ---------------------------------------------------------------------------
const vbsBytes = fs.readFileSync(path.join(DIST, "Inventor部品ビューア.vbs"));
check("VBS は UTF-16LE（BOM 付き）・CRLF", vbsBytes[0] === 0xff && vbsBytes[1] === 0xfe && !/[^\r]\n/.test(vbsBytes.subarray(2).toString("utf16le")));
const STRINGS = path.join(WORK, "strings.txt");
function vbsForWine(source) {
  const strings = [];
  const body = source.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => {
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
      out += /[^\x00-\x7f]/.test(value) ? `S(${strings.push(value) - 1})` : `"${value.replace(/"/g, '""')}"`;
      i = j + 1;
    }
    return out.trimEnd();
  }).join("\r\n")
    .replace(/^Option Explicit$/m, `Option Explicit\r\nDim S : S = Split(CreateObject("Scripting.FileSystemObject").OpenTextFile(${JSON.stringify(win(STRINGS))}, 1, False, -1).ReadAll, vbLf)`)
    .replace(/\bMsgBox\b/g, "TestMsgBox")
    .replace(/CreateObject\("WScript\.Shell"\)\.Run\b/g, "TestRun");
  fs.writeFileSync(STRINGS, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(strings.join("\n"), "utf16le")]));
  const log = JSON.stringify(win(path.join(WORK, "vbs.log")));
  return `${body}\r\nSub TestLog(text)\r\n  Dim f : Set f = CreateObject("Scripting.FileSystemObject").OpenTextFile(${log}, 8, True, -1)\r\n  f.WriteLine text : f.Close\r\nEnd Sub\r\nFunction TestMsgBox(text, buttons, title)\r\n  TestLog "MSGBOX " & text\r\nEnd Function\r\nSub TestRun(command, style, wait)\r\n  TestLog "RUN style=" & style & " wait=" & wait & " " & command\r\nEnd Sub\r\n`;
}
fs.writeFileSync(path.join(dist, "launcher-test.vbs"), vbsForWine(vbsBytes.subarray(2).toString("utf16le")), "latin1");
function runVbs(args) {
  fs.rmSync(path.join(WORK, "vbs.log"), { force: true });
  try {
    execFileSync("wine", ["cscript", "//nologo", win(path.join(dist, "launcher-test.vbs")), ...args.map(win)], { env, stdio: "pipe", timeout: 120000 });
  } catch (error) {
    if (error.status === null) throw error; // 時間切れなど（終了コードが 0 以外なのは、起動ファイルが見つからない場合の想定どおりの動き）
  }
  return read16(path.join(WORK, "vbs.log")).trim();
}

// ---- bat ---------------------------------------------------------------------------
const batText = fs.readFileSync(path.join(APP_DIR, "起動.bat"), "utf8");
check("bat は UTF-8（BOM なし）・CRLF、実行する行は英数字だけ", !batText.startsWith("\uFEFF") && !/[^\r]\n/.test(batText)
  && batText.split("\r\n").filter((l) => !/^rem\b/i.test(l)).every((l) => /^[\x00-\x7f]*$/.test(l)));
const replaced = (text, from, to) => {
  assert.ok(text.includes(from), `差し替える行が見つからない: ${from}`);
  return text.replace(from, to);
};
let batForWine = batText;
batForWine = replaced(batForWine, 'cmd /u /c dir /b /a-d "%~1" > "%WORK%\\name.txt" 2>nul\r\ncertutil -f -encode "%WORK%\\name.txt" "%WORK%\\name.b64" >nul',
  'copy /y "%~1.name.cert" "%WORK%\\name.b64" >nul');
for (const ext of ["ipt", "html", "htm"]) {
  batForWine = replaced(batForWine, `if /i "%~x1"==".${ext}" certutil -f -encode "%~1" "%WORK%\\data.b64" >nul`, `if /i "%~x1"==".${ext}" copy /y "%~1.cert" "%WORK%\\data.b64" >nul`);
}
batForWine = batForWine.replace(/start "" /g, 'call "%TEST_START%" ')
  .replace(/^(py -3 -c|python -c|%PY% -m)/gm, "call $1");
fs.writeFileSync(path.join(app, "起動.bat"), batForWine);

// 代わりのコマンド（PATH の先頭に置く）: 呼ばれ方を記録し、決めた終了コードを返す
const stubs = path.join(WORK, "stubs");
fs.mkdirSync(stubs);
// 実行したフォルダは、Wine の cmd が日本語を正しく書き出せないので、中で比べて「APP」（アプリ本体）かどうかだけ記録する
const record = (name) => `@echo off\r\nset "HERE=%CD%"\r\nif /i "%CD%\\"=="%TEST_APP%" set "HERE=APP"\r\n>> "${win(path.join(WORK, `${name}.log`))}" echo %HERE%^|%*\r\n`;
fs.writeFileSync(path.join(stubs, "start-rec.cmd"), record("start"));
for (const py of ["py", "python"]) fs.writeFileSync(path.join(stubs, `${py}.cmd`), `${record(py)}exit /b %TEST_PY_CODE%\r\n`);
// 検証の入口: TEMP を空白・かっこを含む場所（Edge で開く）と # を含む場所（既定のブラウザーで開く）にして、起動.bat を呼ぶ。
// 日本語を含むパスは環境変数で渡す（Wine の cmd はバッチファイルを UTF-8 で読めないため、入口は英数字だけにする）。
// % を含む場所は使わない（Wine の cmd は値の中の % を落とす。Windows の cmd では問題ない）
const temps = { edge: path.join(WORK, "tmp a b (1)"), hash: path.join(WORK, "tmp #1") };
for (const t of Object.values(temps)) fs.mkdirSync(t);
const certutil = (bytes) => {
  const b64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\r\n${b64.join("\r\n")}\r\n-----END CERTIFICATE-----\r\n`;
};
const dropped = (file) => {
  const name = path.basename(file);
  fs.writeFileSync(`${file}.name.cert`, certutil(Buffer.from(`${name}\r\n`, "utf16le"))); // cmd /u /c dir /b の出力と同じ
  if (/\.(ipt|html?)$/i.test(name)) fs.writeFileSync(`${file}.cert`, certutil(fs.readFileSync(file)));
  return file;
};
function runBat(args, { python = 0, edge = true, temp = temps.edge } = {}) {
  for (const f of ["start.log", "py.log", "python.log"]) fs.rmSync(path.join(WORK, f), { force: true });
  fs.rmSync(path.join(temp, "ipt-viewer"), { recursive: true, force: true });
  execFileSync("wine", ["reg", edge ? "add" : "delete", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe", ...(edge ? ["/ve", "/d", "C:\\edge\\msedge.exe"] : []), "/f"], { env, stdio: "ignore" });
  const entry = path.join(WORK, "entry.cmd");
  fs.writeFileSync(entry, '@echo off\r\nset "TEMP=%TEST_TEMP%"\r\nset "PATH=%TEST_STUBS%;%PATH%"\r\ncall "%TEST_BAT%" %TEST_ARGS%\r\n');
  execFileSync("wine", ["cmd", "/c", win(entry)], {
    env: {
      ...env, TEST_TEMP: win(temp), TEST_STUBS: win(stubs), TEST_BAT: win(path.join(app, "起動.bat")), TEST_APP: `${win(app)}\\`,
      TEST_ARGS: args.map((a) => `"${win(a)}"`).join(" "), TEST_START: win(path.join(stubs, "start-rec.cmd")), TEST_PY_CODE: String(python),
    },
    stdio: "pipe", timeout: 120000,
  });
  const pages = fs.existsSync(path.join(temp, "ipt-viewer")) ? fs.readdirSync(path.join(temp, "ipt-viewer")).map((d) => path.join(temp, "ipt-viewer", d, "ipt-viewer.html")) : [];
  return { start: lines(path.join(WORK, "start.log")), py: lines(path.join(WORK, "py.log")), python: lines(path.join(WORK, "python.log")), pages };
}

// ---- 1. VBS: bat を「画面を出さずに」実行し、ドロップされたファイルをそのまま渡す -------------
const plate = path.join(WORK, "E_Plate_改_Φ54.5.ipt");
fs.copyFileSync(path.join(ROOT, "samples/ipt/E_Plate_改_Φ54.5.ipt"), plate);
// URL・コマンドで特別な意味を持つ文字を含む名前（% は使わない。Wine の cmd は引数の % を落とす。Windows の cmd では問題ない）
const odd = path.join(WORK, "a#b&c 'd' (1).html");
fs.copyFileSync(path.join(ROOT, "samples/html/LS4_parts_viewer.html"), odd);
let log = runVbs([plate, odd]);
const expectedCommand = `cmd /s /c ""${win(app)}\\起動.bat" "${win(plate)}" "${win(odd)}""`;
check("VBS: 起動.bat を画面を出さずに（style=0）待たずに実行し、ファイルをそのまま渡す", log === `RUN style=0 wait=False ${expectedCommand}`, log);
check("VBS: 引数なしでも同じ（bat だけを実行）", runVbs([]) === `RUN style=0 wait=False cmd /s /c ""${win(app)}\\起動.bat""`);
fs.renameSync(path.join(app, "起動.bat"), path.join(app, "起動.bat.bak"));
log = runVbs([]);
check("VBS: 起動.bat が無ければ理由を示し、何も実行しない", /^MSGBOX 起動に必要なファイルが見つかりません。/.test(log) && !/RUN/.test(log), log.slice(0, 60));
fs.renameSync(path.join(app, "起動.bat.bak"), path.join(app, "起動.bat"));

// ---- 2. bat --------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright"));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
async function openPage(file) {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(e.message));
  await tab.route(/three@([\d.]+)\/(.*)$/, (route) => route.fulfill({ // CDN の代わりに手元の three.js を返す
    path: path.join(ROOT, "node_modules/three", route.request().url().match(/three@[\d.]+\/(.*)$/)[1]),
    contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await tab.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await tab.goto(file.startsWith("file:") ? file : `file://${file}`);
  await tab.waitForTimeout(1500);
  const state = await tab.evaluate(() => ({
    name: document.getElementById("file-name").textContent,
    startOpen: document.getElementById("start").open,
    received: [...document.querySelectorAll("#received-rows .sample-name")].map((e) => e.textContent),
    receivedVisible: !document.getElementById("start-received").hidden,
    notice: document.getElementById("notice").hidden ? "" : document.getElementById("notice").textContent,
    pythonHelp: !document.getElementById("python-help").hidden,
  }));
  await tab.close();
  return { ...state, errors };
}
const appUrl = (page) => `file:///${win(page).replace(/\\/g, "/")}`; // 空白はそのまま（Edge が符号化する）

let r = runBat([]);
check("bat: 引数なし → 一時フォルダの複製を Edge のアプリ画面で 1 つ開く", r.pages.length === 1 && r.start.length === 1
  && r.start[0].endsWith(`|msedge --app="${appUrl(r.pages[0])}" --start-maximized`), `${r.pages.length} / ${r.start.join(" ⏎ ")}`);
check("bat: 複製はビューアそのもの（付け足しなし）", r.pages.length === 1 && fs.readFileSync(r.pages[0]).equals(fs.readFileSync(path.join(app, "ipt-viewer.html"))));
let state = r.pages[0] ? await openPage(appUrl(r.pages[0]).replace("file:///Z:", "file://")) : {};
check("bat: 引数なし → 起動画面が出る（空白を含む URL のまま開ける）", state.startOpen === true && !state.errors.length, JSON.stringify(state));

r = runBat([], { temp: temps.hash });
check("bat: 一時フォルダのパスに # がある → 既定のブラウザーで開く（URL では # 以降が別の意味になるため）", r.pages.length === 1 && r.start.length === 1 && r.start[0].endsWith(`|"${win(r.pages[0])}"`), `${r.pages.length} / ${r.start.join(" ⏎ ")}`);

r = runBat([], { edge: false });
check("bat: Edge が無ければ既定のブラウザーで開く", r.pages.length === 1 && r.start.length === 1 && r.start[0].endsWith(`|"${win(r.pages[0])}"`), `${r.pages.length} / ${r.start.join(" ⏎ ")}`);

const memo = path.join(WORK, "memo.txt");
fs.writeFileSync(memo, "x");
const folder = path.join(WORK, "フォルダ");
fs.mkdirSync(folder, { recursive: true });
r = runBat([dropped(plate), dropped(odd), dropped(memo), folder]);
check("bat: .ipt・.html・対応外・フォルダをドロップ → ページ 1 つ・ブラウザー 1 回", r.pages.length === 1 && r.start.length === 1 && !r.py.length, `${r.pages.length} / ${r.start.length}`);
const payload = r.pages[0] ? fs.readFileSync(r.pages[0], "latin1").slice(fs.statSync(path.join(app, "ipt-viewer.html")).size) : "";
check("bat: ビューアの末尾に 3 つ（フォルダは除く）を付け足す。対応外は中身を送らない", (payload.match(/\.push\(\{name:`/g) ?? []).length === 3
  && /-----END CERTIFICATE-----\r\n`,data:`\r\n`\}\);<\/script>\r\n$/.test(payload), payload.slice(-120));
state = r.pages[0] ? await openPage(r.pages[0]) : {};
check("ビューア: 最初の .ipt を開き、起動画面は出さない", state.name === "E_Plate_改_Φ54.5.ipt" && state.startOpen === false && !state.errors.length, JSON.stringify(state));
check("ビューア: 2 つを「受け取ったファイル」に並べる（名前は特別な文字もそのまま）", state.receivedVisible && JSON.stringify(state.received) === JSON.stringify(["E_Plate_改_Φ54.5", "a#b&c 'd' (1)"]), JSON.stringify(state.received));
check("ビューア: 対応外を知らせる", /2 件を受け取り/.test(state.notice) && /memo\.txt は開けません/.test(state.notice), state.notice);

// 読めないファイル（certutil が失敗した場合）: 検証側の Base64 を用意しないことで再現する。前のファイルの結果が混ざらないこと
const locked = path.join(WORK, "locked.ipt");
fs.copyFileSync(plate, locked);
r = runBat([dropped(plate), locked]);
state = r.pages[0] ? await openPage(r.pages[0]) : {};
check("読めなかったファイル → 前のファイルの内容を混ぜず、ビューアが「受け取れなかった」と知らせる",
  JSON.stringify(state.received) === '["E_Plate_改_Φ54.5"]' && !state.receivedVisible && state.name === "E_Plate_改_Φ54.5.ipt"
  && /受け取れなかったファイルがあります/.test(state.notice), JSON.stringify(state));

const spec = path.join(WORK, "reel (2).inventor.json");
fs.copyFileSync(path.join(ROOT, "tests/fixtures/builder/finger.inventor.json"), spec);
r = runBat([spec], { python: 0 });
check("bat: 変換データ → アプリ本体で py -3 -m ipt_build --gui を実行（ビューアは開かない）", r.py.length === 2 && r.py[1] === `APP|-3 -m ipt_build --gui "${win(spec)}"` && !r.start.length && !r.pages.length, r.py.join(" ⏎ "));
check("bat: Python の確認は 3.10 以上", r.py[0]?.endsWith(`|-3 -c "import sys; sys.exit(sys.version_info < (3, 10))"`), r.py[0]);

r = runBat([spec], { python: 1 });
check("bat: Python が無い → ビューアで案内（py・python の順に探す）", r.py.length === 1 && r.python.length === 1 && r.pages.length === 1 && r.start.length === 1, `${r.py.length}/${r.python.length}/${r.pages.length}`);
state = r.pages[0] ? await openPage(r.pages[0]) : {};
check("ビューア: 「Python が必要です」を起動画面に出す", state.pythonHelp && state.startOpen && !state.errors.length, JSON.stringify(state));

r = runBat([spec, dropped(plate)], { python: 0 });
check("bat: 変換データと .ipt を一緒に → 部品を作り、ビューアでも開く", r.py.length === 2 && r.pages.length === 1 && r.start.length === 1);
await browser.close();

console.log(results.join("\n"));
process.exitCode = results.some((l) => l.startsWith("FAIL")) ? 1 : 0;
