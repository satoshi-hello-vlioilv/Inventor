# -*- coding: utf-8 -*-
"""このアプリをほかのアプリと区別する値と、置き場（答えはここ 1 か所）。

起動の係（launch_guard.py）・サーバー（server.py）・停止の係（process_manager.py）・画面の本体（app/）が同じ値を使う。
Flask に頼らない（Flask が無い PC でも、起動の係はここを読んで「入っていない」と言える）。

    program/                          アプリの中身（このファイルの置き場）
    %LOCALAPPDATA%\\Inventor3DTool\\    PC ごとの作業場所: logs（記録）・runtime（動いているサーバーの名乗り・受け渡し）・pycache
    ドキュメント\\Inventor 3Dツール\\   「Inventor で作る」の保存先（config/appsettings.json の build.output_dir で変えられる）
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


_CONFIG = load_config()
SERVER = {**SERVER_DEFAULTS, **(_CONFIG.get("server") or {})}
HOST = "127.0.0.1"  # この PC の中からだけ受け付ける（設定では変えない）
PORT = int(SERVER["port"])
URL = f"http://{HOST}:{PORT}/"
BUILD = {"output_dir": "", **(_CONFIG.get("build") or {})}  # output_dir: 空なら ドキュメント\Inventor 3Dツール


def documents_dir() -> Path:
    """この PC の「ドキュメント」（OneDrive などへ移してあれば、移した先）。"""
    if os.name == "nt":
        import ctypes  # noqa: PLC0415

        buffer = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) == 0 and buffer.value:  # 5 = CSIDL_PERSONAL
            return Path(buffer.value)
    return Path.home() / "Documents"


def output_root() -> Path:
    """「Inventor で作る」の保存先（この下に「<名前>_ipt」を作る）。"""
    configured = str(BUILD["output_dir"]).strip()
    return Path(os.path.expandvars(configured)) if configured else documents_dir() / APP_NAME


def child_env() -> dict:
    """このアプリが起こす Python のプロセス（サーバー・部品を作る係）の環境。
    program を import でき、.pyc を program フォルダに作らず、同じ作業場所を使う。"""
    env = os.environ.copy()
    env["INVENTOR_TOOL_LOCAL_ROOT"] = str(LOCAL_ROOT)
    env["PYTHONPYCACHEPREFIX"] = str(PYCACHE)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(BASE), env.get("PYTHONPATH")]))
    return env
