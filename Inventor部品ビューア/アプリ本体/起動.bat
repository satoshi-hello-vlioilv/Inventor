@echo off
rem ===========================================================================
rem Inventor 部品ビューア の起動処理
rem   Inventor部品ビューア.vbs が、黒い画面を出さずにこのファイルを実行する。
rem   VBScript が使えない環境では、このファイルを直接ダブルクリック・ドロップしてもよい（黒い画面が出るだけ）。
rem
rem   引数なし                ビューアを開く
rem   .ipt .html .htm         ビューアで開く（まとめて 1 つのウィンドウ。2 つ以上は起動画面の一覧から切り替える）
rem   .json（変換データ）     Python で Inventor の部品を作る（確認はダイアログ、進み具合と結果は HTML のページ）
rem   それ以外                ビューアで「開けない」と知らせる
rem
rem ブラウザーのページは、ファイルをパスから直接は読めない。そこで、ビューアの複製を一時フォルダに作り、
rem その末尾に「ファイルの名前と中身を Base64（certutil）にした script」を付け足して開く。
rem 実行する命令は英数字だけで書く（Windows の文字コードの設定に左右されないため）。日本語は注記だけ。
rem ===========================================================================
setlocal
set "APP=%~dp0"
set "ROOT=%TEMP%\ipt-viewer"
set "PAGE="
set "SHOW="
if "%~1"=="" set "SHOW=1"
call :cleanup

:next
if "%~1"=="" goto open
if /i "%~x1"==".json" (call :build "%~1") else (call :add "%~1")
shift
goto next

:open
if not defined SHOW exit /b 0
if not defined PAGE call :begin
rem Edge のアプリ画面（アドレスバーの無いウィンドウ）で開く。URL は「file:///」とパスの「\」を「/」にしたもの
rem （空白は Edge が符号化する）。Edge が無いとき、パスに # がある（URL では意味が変わる）ときは既定のブラウザーで開く
call :edge
if errorlevel 1 goto open_default
if not "%PAGE:#=%"=="%PAGE%" goto open_default
start "" msedge --app="file:///%PAGE:\=/%" --start-maximized
exit /b 0
:open_default
start "" "%PAGE%"
exit /b 0

rem ---- 一時フォルダにビューアの複製を作る -----------------------------------------
:begin
set "WORK=%ROOT%\%RANDOM%%RANDOM%"
if exist "%WORK%" goto begin
mkdir "%WORK%"
set "PAGE=%WORK%\ipt-viewer.html"
copy /b "%APP%ipt-viewer.html" "%PAGE%" >nul
rem 付け足す script の部品。名前と中身の Base64 は、この間に挟む（JavaScript の複数行の文字列として読む）
> "%WORK%\open.txt" echo ^<script^>(window.IPT_VIEWER_LAUNCH=window.IPT_VIEWER_LAUNCH^|^|[]).push({name:`
> "%WORK%\data.txt" echo `,data:`
> "%WORK%\close.txt" echo `});^</script^>
exit /b 0

rem ---- ドロップされたファイルを 1 つ付け足す --------------------------------------
:add
if exist "%~1\*" exit /b 0
set "SHOW=1"
if not defined PAGE call :begin
rem 名前は cmd /u で UTF-16 の文字として書き出してから Base64 にする（どんな文字の名前でも崩れない）。
rem 前のファイルの結果が残らないよう、先に空にする（読めなければ空のまま送り、ビューアが「受け取れなかった」と知らせる）
type nul > "%WORK%\name.b64"
cmd /u /c dir /b /a-d "%~1" > "%WORK%\name.txt" 2>nul
certutil -f -encode "%WORK%\name.txt" "%WORK%\name.b64" >nul
rem 中身はビューアで開けるもの（.ipt .html .htm）だけ送る。それ以外は名前だけ送り、ビューアが「開けない」と知らせる
type nul > "%WORK%\data.b64"
if /i "%~x1"==".ipt" certutil -f -encode "%~1" "%WORK%\data.b64" >nul
if /i "%~x1"==".html" certutil -f -encode "%~1" "%WORK%\data.b64" >nul
if /i "%~x1"==".htm" certutil -f -encode "%~1" "%WORK%\data.b64" >nul
copy /b "%PAGE%" + "%WORK%\open.txt" + "%WORK%\name.b64" + "%WORK%\data.txt" + "%WORK%\data.b64" + "%WORK%\close.txt" "%WORK%\next.html" >nul
move /y "%WORK%\next.html" "%PAGE%" >nul
exit /b 0

rem ---- 変換データ: Python で Inventor の部品を作る ----------------------------------
:build
call :python
if not defined PY goto no_python
pushd "%APP%"
%PY% -m ipt_build --gui "%~1"
popd
exit /b 0

:no_python
set "SHOW=1"
if not defined PAGE call :begin
>> "%PAGE%" echo ^<script^>(window.IPT_VIEWER_LAUNCH=window.IPT_VIEWER_LAUNCH^|^|[]).push({message:"python-missing"});^</script^>
exit /b 0

rem ---- Python（3.10 以上）を探す: py ランチャー、python の順 ----------------------
:python
set "PY="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY exit /b 0
python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 set "PY=python"
exit /b 0

rem ---- Microsoft Edge があるか（アドレスバーの無いアプリ画面で開くため）------------
:edge
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>&1
if not errorlevel 1 exit /b 0
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>&1
if not errorlevel 1 exit /b 0
exit /b 1

rem ---- 1 日以上前の一時フォルダを消す ----------------------------------------------
:cleanup
if not exist "%ROOT%" exit /b 0
forfiles /p "%ROOT%" /d -1 /c "cmd /c if @isdir==TRUE rmdir /s /q @path" >nul 2>&1
exit /b 0
