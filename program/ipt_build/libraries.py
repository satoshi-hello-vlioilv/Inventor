"""Inventor の操作に使う Python のライブラリ（pywin32。requirements.txt）が入っているか。

アプリの窓（desktop/src/jobs.rs）が `python -m ipt_build --libraries` で尋ね、無ければ `python -m pip install -r requirements.txt` で入れる。
入れたあとは、新しい Python のプロセスで作る（pywin32 は読み込みの設定（.pth）を Python の起動時に読むため、
入れたプロセスの中からは使えないことがある）。
"""
from __future__ import annotations

import importlib
import importlib.util

MODULE = "win32com"  # pywin32 が入れるモジュールのうち、Inventor への接続（inventor.connect）が使うもの


def ready() -> bool:
    """入っているか（入れた直後でも正しく答えるよう、探す前に読み込みの控えを捨てる）。"""
    importlib.invalidate_caches()
    return importlib.util.find_spec(MODULE) is not None
