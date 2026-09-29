# -*- coding: utf-8 -*-
"""このアプリのプログラムの指紋（起動の係とサーバーの両方が使う。Flask に頼らない小さな部品）。

新しいファイルに入れ替えた（git pull した）のに、前から動いていた古いサーバーがそのまま使われると、古いサーバーが覚えている
古い画面に、ディスクの新しい JavaScript が読み込まれて画面が止まることがある。そこで:
    - サーバーは起動したときの指紋を覚え、/api/instance で「自分の指紋」と「いまのディスクと違うか（stale）」を答える
    - 起動の係（launch_guard.py）は、動いているサーバーの指紋がディスクと違えば止めて起動し直す
    - 起動画面（loading.html）は、stale のサーバーには進まない
指紋 = 版（app/version.py）＋ program 直下の .py と app/ の下のファイルの名前・大きさ・更新時刻。
（転写距離・ピッチ解析の app_build.py と同じ考え方）
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent


def app_version(base: Path = BASE) -> str:
    try:
        m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', (Path(base) / "app" / "version.py").read_text(encoding="utf-8"))
        return m.group(1) if m else ""
    except OSError:
        return ""


def _files(base: Path):
    yield from (p for p in base.glob("*.py"))
    for dirpath, dirnames, filenames in os.walk(base / "app"):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        yield from (Path(dirpath) / name for name in filenames)


def fingerprint(base: Path = BASE) -> str:
    """版＋プログラムのファイルの名前・大きさ・更新時刻の要約（12 桁）。ファイルが 1 つでも変われば変わる。"""
    base = Path(base)
    items = []
    for p in _files(base):
        try:
            st = p.stat()
        except OSError:
            continue
        items.append(f"{p.relative_to(base).as_posix()}|{st.st_size}|{st.st_mtime_ns}")
    h = hashlib.sha1(app_version(base).encode("utf-8"))
    for it in sorted(items):
        h.update(it.encode("utf-8"))
    return f"{app_version(base)}-{h.hexdigest()[:12]}"
