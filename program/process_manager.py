# -*- coding: utf-8 -*-
"""アプリ（サーバー）を止める（stop.bat から呼ぶ）。転写距離・ピッチ解析の process_manager.py と同じ作り。

止め方は local_app.stop（起動の係と同じ 1 か所）: 終了を頼む → 名乗ったプロセスを止める → ポートを掴んでいる Python を止める。
そのあと、ポートを開く前に固まったサーバー（起動の途中で止まったもの）も、このアプリの server.py を探して止める。
止まったかは「ポートが閉じたか」で確かめ、止まっていないのに「止めました」とは言わない。
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import local_app
from settings import APP_ID, APP_NAME, SERVER_INFO

CREATE_NO_WINDOW = local_app.CREATE_NO_WINDOW


def say(message: str) -> None:
    print(message, flush=True)


def server_pids() -> list[int]:
    """このアプリの server.py を動かしているプロセスの番号（Windows のみ）。"""
    if os.name != "nt":
        return []
    ps = ("Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | "
          "Where-Object { $_.CommandLine -like '*server.py*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }")
    try:
        out = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], text=True, encoding="utf-8",
                                      errors="replace", timeout=15, creationflags=CREATE_NO_WINDOW)
    except Exception:
        return []
    pids = []
    for line in out.splitlines():
        pid, _, cmd = line.partition("\t")
        if pid.strip().isdigit() and is_ours(cmd):
            pids.append(int(pid))
    return pids


def is_ours(cmd: str) -> bool:
    """コマンドの server.py が**このアプリ**のものか（フォルダの場所は問わない: 前の版を別の場所に置いたものも含む）。
    同じフォルダの settings.py にこのアプリの印（APP_ID）があるものだけ（ほかのアプリは止めない）。"""
    m = re.search(r'"?([^"]*?server\.py)"?', cmd or "", re.I)
    if not m:
        return False
    try:
        return f'APP_ID = "{APP_ID}"' in (Path(m.group(1).strip()).parent / "settings.py").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def stop() -> int:
    running = local_app.in_use()
    local_app.stop(say)
    left = [pid for pid in server_pids() if pid != os.getpid()]
    for pid in left:
        say(f"残っているサーバー（プロセス {pid}）を止めます…")
        local_app.kill(pid)
    local_app.wait_closed(3)
    if local_app.in_use():
        say("止められませんでした。タスク マネージャーの「詳細」で pythonw.exe（python.exe）を終了してください。")
        return 1
    try:
        SERVER_INFO.unlink()
    except OSError:
        pass
    say("止めました。program フォルダを入れ替えられます。" if running or left else f"{APP_NAME}は動いていません。")
    return 0


if __name__ == "__main__":
    raise SystemExit(stop())
