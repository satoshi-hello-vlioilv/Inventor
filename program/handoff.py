# -*- coding: utf-8 -*-
"""起動ファイル（Start.vbs）へドロップされたファイルを、開いた画面へ渡す。

    1. 起動の係（launch_guard.py）が、1 回の起動で受け取ったファイルのパスを runtime/launch に 1 件の記録として書く
    2. そのあとで画面を開く（記録を書き終えてから開くので、画面が先に尋ねて空振りすることは無い）
    3. 開いた画面が POST /api/launch で、いちばん古い記録を 1 件受け取る（受け取った記録は消す）

記録は TTL_SECONDS で失効する（画面が開けなかった起動の記録を、次にふつうに開いた画面が受け取らないように）。
Flask に頼らない（起動の係は Flask を読み込まずに書く）。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from settings import HANDOFF_DIR

TTL_SECONDS = 180  # 起動画面が「起動できない」と言うまで（120 秒）より長く


def record(paths, folder: Path = HANDOFF_DIR) -> Path:
    """受け取ったファイルのパスを 1 件の記録にする。名前は書いた時刻から始める（古い順に並ぶ）。"""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{time.time_ns():020d}-{os.getpid()}.json"
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"created": time.time(), "files": [str(p) for p in paths]}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)  # 書きかけを読ませない
    return target


def claim(folder: Path = HANDOFF_DIR, now: float | None = None) -> list[Path] | None:
    """いちばん古い有効な記録のパス（受け取った記録は消す）。無ければ None。失効した記録はここで片付ける。"""
    now = time.time() if now is None else now
    try:
        entries = sorted(Path(folder).glob("*.json"))
    except OSError:
        return None
    for entry in entries:
        try:
            data = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        try:
            entry.unlink()  # 読めない記録も、失効した記録も、受け取った記録も残さない
        except OSError:
            continue  # ほかの画面が同時に受け取った
        if data and now - float(data.get("created", 0)) <= TTL_SECONDS:
            return [Path(p) for p in data.get("files", [])]
    return None
