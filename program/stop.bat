@echo off
rem ============================================================
rem  Inventor 3Dツール  停止（明示的に止めたいとき・program フォルダを入れ替える前）
rem  - ふだんは画面（ウィンドウ・タブ）を閉じると、十数秒で自動で止まります
rem  - まずアプリに「終了」を頼み、止まらなければプロセスを止めます（process_manager.py）
rem  - このファイルは Shift-JIS（CP932）・CRLF で保存する（コマンドプロンプトがそのまま読める形）
rem ============================================================
setlocal
chcp 932 >nul
title Inventor 3Dツール - 停止
set "APPDIR=%~dp0"
rem program フォルダを作業フォルダにしない（止めたあとにフォルダを入れ替えられるように）
cd /d "%TEMP%"
echo Inventor 3Dツールを止めています...
echo.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto nopython
%PY% "%APPDIR%process_manager.py"
goto tail

:nopython
echo Python が見つかりません。タスク マネージャーの「詳細」で pythonw.exe を終了してください。

:tail
echo.
pause
endlocal
