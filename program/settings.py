# -*- coding: utf-8 -*-
"""このアプリをほかのアプリと区別する値と、置き場（答えはここ 1 か所）。

起動の係（launch_guard.py）・サーバー（server.py）・停止の係（process_manager.py）・画面の本体（app/）が同じ値を使う。
Flask に頼らない（Flask が無い PC でも、起動の係はここを読んで「入っていない」と言える）。

    program/                          アプリの中身（このファイルの置き場）
    %LOCALAPPDATA%\\Inventor3DTool\\    PC ごとの作業場所: logs（記録）・runtime（動いているサーバーの名乗り・受け渡し）・pycache
"""
from __future__ import annotations

import json
import os
from pathlib import Path

APP_ID = "Inventor3DTool"
APP_NAME = "Inventor 3Dツール"
BASE = Path(__file__).resolve().parent

# 作業場所は program フォルダにしない（動いているあいだ program フォルダが「使用中」になり、更新で入れ替えられなくなる）
LOCAL_ROOT = Path(os.environ.get("INVENTOR_TOOL_LOCAL_ROOT") or
                  Path(os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or Path.home()) / APP_ID)
RUNTIME = LOCAL_ROOT / "runtime"
LOG_DIR = LOCAL_ROOT / "logs"
PYCACHE = LOCAL_ROOT / "pycache"
SERVER_INFO = RUNTIME / "server.json"  # 動いているサーバーの名乗り（プロセス番号・合言葉）。サーバー自身が書き、止めるときに消す
HANDOFF_DIR = RUNTIME / "launch"      # 起動ファイルへドロップされたファイルの受け渡し（handoff.py）

CONFIG = Path(os.environ.get("INVENTOR_TOOL_CONFIG") or BASE / "config" / "appsettings.json")

# サーバーの既定（config/appsettings.json の "server" で上書きする）
SERVER_DEFAULTS = {
    "port": 57840,
    "auto_shutdown_on_close": True,       # 画面（タブ・ウィンドウ）を閉じたら止まる
    "heartbeat_interval_seconds": 3,      # 画面が「開いている」と知らせる間隔
    "idle_shutdown_seconds": 12,          # 知らせが途切れてから止まるまで（表に出ている・閉じたとき）
    "hidden_idle_shutdown_seconds": 14400,  # 裏に回っているとき（ブラウザが知らせを間引くので長く待つ）
    "no_client_shutdown_seconds": 600,    # 起動してから一度も画面がつながらないとき（ブラウザが開けなかったなど）
}


def load_config(path: Path = CONFIG) -> dict:
    """設定ファイル（読めなければ空。既定で動く）。"""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


SERVER = {**SERVER_DEFAULTS, **(load_config().get("server") or {})}
HOST = "127.0.0.1"  # この PC の中からだけ受け付ける（設定では変えない）
PORT = int(SERVER["port"])
URL = f"http://{HOST}:{PORT}/"
