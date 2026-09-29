"""Inventor の操作に使う Python のライブラリ（pywin32。requirements.txt）が入っているか、入れる命令。

入れたあとは、新しい Python のプロセスで作る（pywin32 は読み込みの設定（.pth）を Python の起動時に読むため、
入れたプロセスの中からは使えないことがある）。アプリのサーバー（app/builds.py）が使う。
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

REQUIREMENTS = Path(__file__).with_name("requirements.txt")
MODULE = "win32com"  # pywin32 が入れるモジュールのうち、Inventor への接続（inventor.connect）が使うもの


def ready() -> bool:
    """入っているか（入れた直後でも正しく答えるよう、探す前に読み込みの控えを捨てる）。"""
    importlib.invalidate_caches()
    return importlib.util.find_spec(MODULE) is not None


def install_command(python: str = sys.executable) -> list[str]:
    return [python, "-m", "pip", "install", "-r", str(REQUIREMENTS)]
