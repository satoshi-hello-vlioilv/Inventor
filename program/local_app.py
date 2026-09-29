# -*- coding: utf-8 -*-
"""この PC で動いているこのアプリ（サーバー）へ尋ねる・止める（起動の係 launch_guard.py と、stop.bat の process_manager.py が使う）。

**この PC の中への問い合わせはプロキシを通さない。**
Python の urllib は Windows のプロキシ設定（レジストリ）を読み、127.0.0.1 への問い合わせまで社内のプロキシへ送ることがある。
すると動いているアプリが「答えない」ように見え、起動は待ち続け、停止は何も止めずに「止めました」と言ってしまう
（転写距離・ピッチ解析で起きたこと。同じ作りをここへ移した）。

**止まったかは「ポートが閉じたか」で確かめる**（HTTP の答えだけで決めない: 答えられない＝止まった、ではない）。
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

from settings import APP_ID, HOST, PORT, SERVER_INFO, URL

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # プロキシを通さない


def server_info(path: Path = SERVER_INFO) -> dict:
    """動いているサーバーの名乗り（プロセス番号・合言葉）。無ければ空。"""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def request_json(path: str, timeout: float = 0.9, data: dict | None = None):
    """→ (status, json)。答えなければ (0, {})。data を渡すと POST（合言葉を添える）。"""
    headers = {"Content-Type": "application/json"}
    body = None
    if data is not None:
        headers["X-App-Token"] = str(server_info().get("token", ""))
        body = json.dumps(data).encode("utf-8")
    try:
        req = urllib.request.Request(URL.rstrip("/") + path, data=body, method="POST" if body is not None else "GET", headers=headers)
        with _OPENER.open(req, timeout=timeout) as r:
            text = r.read().decode("utf-8")
            return r.status, (json.loads(text) if text.strip() else {})
    except Exception:
        return 0, {}


def instance(timeout: float = 0.9):
    """このアプリのサーバー（どのフォルダから動いていても）が答えれば、その答え（/api/instance）。"""
    status, data = request_json("/api/instance", timeout)
    return data if status == 200 and data.get("app") == APP_ID else None


def port_open(timeout: float = 0.5) -> bool:
    """このアプリのポートで何かが待ち受けているか（プロキシと関係の無い TCP の確かめ）。"""
    try:
        with socket.create_connection((HOST, PORT), timeout=timeout):
            return True
    except OSError:
        return False


def in_use() -> bool:
    """ポートがまだ使われているか。つながらなくても、待ち受けているプロセスが居れば使われている
    （固まったサーバーは受け付けの列が埋まると、つなぐ試しに答えなくなる）。"""
    return port_open() or listener_pid() is not None


def wait_closed(seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if not in_use():
            return True
        time.sleep(0.25)
    return not in_use()


def _run(args, timeout=10) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout,
                              creationflags=CREATE_NO_WINDOW).stdout or ""
    except Exception:
        return ""


def listener_pid():
    """このアプリのポートで待ち受けているプロセスの番号（Windows は netstat。PowerShell に頼らない）。"""
    if os.name == "nt":
        for line in _run(["netstat", "-ano", "-p", "TCP"]).splitlines():
            parts = line.split()
            if len(parts) < 5 or not parts[1].endswith(f":{PORT}") or not parts[4].isdigit():
                continue
            # 待ち受け＝相手のアドレスが 0:0（状態の語 LISTENING は表示の言語に頼らないよう、どちらでも可とする）
            if parts[3].upper() == "LISTENING" or parts[2] in ("0.0.0.0:0", "[::]:0"):
                return int(parts[4])
        return None
    m = re.search(r"\d+", _run(["lsof", "-t", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN"]))
    return int(m.group(0)) if m else None


def is_python(pid) -> bool:
    """その番号のプロセスが Python か（このアプリのポートで待ち受けていても、Python でなければ止めない）。"""
    if os.name == "nt":
        out = _run(["tasklist", "/FI", f"PID eq {int(pid)}", "/FO", "CSV", "/NH"])
        return bool(re.match(r'"python[^"]*\.exe"', out.strip(), re.I))
    try:
        return "python" in Path(f"/proc/{int(pid)}/comm").read_text().lower()
    except OSError:
        return False


def kill(pid) -> None:
    if not pid or int(pid) == os.getpid():
        return
    try:
        if os.name == "nt":
            _run(["taskkill", "/PID", str(int(pid)), "/T", "/F"])
        else:
            os.kill(int(pid), 9)
    except Exception:
        pass


def stop(say=lambda m: None, data=None) -> bool:
    """このアプリのサーバーを止める → 止まった（ポートが閉じた）か。
    1) アプリ自身に「終了」を頼む（いちばん穏やか） 2) 名乗ったプロセス番号を止める
    3) それでもポートを掴んでいる Python（答えられない古い版・固まったもの）を止める"""
    data = data if data is not None else instance()
    if data:
        say(f"アプリに終了を頼んでいます（版 {data.get('version') or '前の版'}・プロセス {data.get('pid')}）…")
        request_json("/api/shutdown", 2, {})
        if wait_closed(10):
            return True
        say("終了しないため、プロセスを止めます…")
        kill(data.get("pid"))
        if wait_closed(5):
            return True
    pid = listener_pid()
    if pid and is_python(pid):
        say(f"ポート {PORT} を使っている Python（プロセス {pid}）を止めます…")
        kill(pid)
        return wait_closed(5)
    return not in_use()
