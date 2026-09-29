@echo off
rem ============================================================
rem  Inventor 3Dツール  診断起動: 起動の段階と、失敗したときの理由（サーバーの出力）をこの窓に出す
rem  - ふだんは Start.vbs を使う（窓が出ない）。起動しないときに、原因を確かめるために使う
rem  - ファイルをこの start.bat にドロップすると、Start.vbs と同じように開く
rem  - このファイルは Shift-JIS（CP932）・CRLF で保存する（コマンドプロンプトがそのまま読める形）
rem ============================================================
setlocal
chcp 932 >nul
title Inventor 3Dツール - 診断起動
set "APPDIR=%~dp0"
set "INVENTOR_TOOL_DIAG=1"
rem program フォルダを作業フォルダにしない（動いているあいだフォルダが「使用中」になり、更新できなくなる）
cd /d "%TEMP%"
echo [1/3] Python を確認しています...
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (where py >nul 2>nul && set "PY=py -3")
if not defined PY goto nopython
%PY% -c "import sys; print('  Python', sys.version.split()[0], sys.executable)"
echo.
echo [2/3] Flask を確認しています...
%PY% -c "import importlib.metadata as m; print('  Flask', m.version('flask'))"
if errorlevel 1 echo   Flask が入っていません。起動すると、入れるかを尋ねます（手で入れるとき: %PY% -m pip install -r "%APPDIR%requirements.txt"）
echo.
echo [3/3] アプリを起動します（このウィンドウに段階を表示します）...
%PY% "%APPDIR%start_app.py" %*
goto tail

:nopython
echo   Python が見つかりません（コマンド python・py が通っていません）。
echo   python.org から Windows 版の Python（3.10 以上）を入れ、最初の画面で「Add python.exe to PATH」にチェックを入れてください。

:tail
echo.
echo 記録: %LOCALAPPDATA%\Inventor3DTool\logs\
pause
endlocal
