# -*- coding: utf-8 -*-
"""サーバーの生き死に（画面からの知らせ・自動停止）。転写距離・ピッチ解析の lifecycle.py と同じ作り。

    - 画面が開いている間は、数秒ごとに「開いている」と知らせる（/api/heartbeat）
    - 知らせが猶予より長く途切れたら「画面が閉じられた」と判断し、このサーバーだけを止める
    - 再読込・移動なら新しいページがすぐ知らせ直すので、閉じたときと区別できる
    - 明示の終了（/api/shutdown）はすぐ止まる

猶予の使い分け（知らせの本文 {visible, closing}）:
    - 表に出ている       : idle_grace（既定 12 秒）
    - 裏に回っている     : hidden_grace（既定 4 時間）。ブラウザは裏のタブのタイマーを間引き、スリープ中のタブは止める
    - 閉じる・再読込     : idle_grace（再読込なら新しいページがすぐ知らせ直す）
    - PC のスリープ復帰  : 見張りの眠りが大きく延びたら、ブラウザが知らせ直すまでの猶予を与え直す
    - 一度もつながらない : no_client_grace（既定 10 分）。ブラウザが開けなかったとき、見えないサーバーを残し続けない
    - Inventor で作っている間（busy）は止めない（画面を閉じても、作り終えるまで待つ。明示の終了だけは止まる）
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("inventor-3d-tool")


class Lifecycle:
    def __init__(self, idle_grace: float = 12.0, heartbeat_interval: float = 3.0, enabled: bool = True,
                 hidden_grace: float = 4 * 3600.0, no_client_grace: float = 600.0, info_file: Path | None = None,
                 busy: Callable[[], bool] = lambda: False):
        self.idle_grace = float(idle_grace)
        self.hidden_grace = max(float(hidden_grace), self.idle_grace)
        self.no_client_grace = float(no_client_grace)
        self.heartbeat_interval = float(heartbeat_interval)
        self.enabled = bool(enabled)
        self.info_file = Path(info_file) if info_file else None
        self.busy = busy
        self._last_beat = None        # 最後に知らせを受けた時刻
        self._visible = True          # 画面が表に出ているか（最後の知らせの申告）
        self._explicit_stop = False   # 明示の終了
        self._started = time.monotonic()
        self._lock = threading.Lock()

    # ---------- 画面からの知らせ ----------
    def beat(self, visible: bool = True, closing: bool = False):
        with self._lock:
            self._last_beat = time.monotonic()
            self._visible = True if closing else bool(visible)  # 閉じる・再読込は裏に回ったのではない。短い猶予で見届ける

    def request_stop(self):
        with self._lock:
            self._explicit_stop = True

    def _grace(self) -> float:
        return self.idle_grace if self._visible else self.hidden_grace

    def status(self) -> dict:
        with self._lock:
            idle = None if self._last_beat is None else time.monotonic() - self._last_beat
            return {"enabled": self.enabled, "seen_client": self._last_beat is not None,
                    "idle_seconds": None if idle is None else round(idle, 1), "idle_grace": self._grace(),
                    "visible": self._visible, "interval": self.heartbeat_interval}

    # ---------- 判定 ----------
    def _should_shutdown(self) -> str | None:
        """止める理由（止めないなら None）。"""
        with self._lock:
            if self._explicit_stop:
                return "explicit"
            if not self.enabled or self.busy():
                return None
            now = time.monotonic()
            if self._last_beat is None:
                return "no_client" if now - self._started > self.no_client_grace else None
            return "idle_timeout" if now - self._last_beat > self._grace() else None

    def _resumed(self):
        """PC のスリープ復帰など、時間が飛んだとき。ブラウザが知らせ直すまでの猶予を与え直す。"""
        with self._lock:
            if self._last_beat is not None:
                self._last_beat = time.monotonic()

    # ---------- 停止 ----------
    def _cleanup(self):
        """名乗り（server.json）を消す。自分の名乗りだけ（入れ替わりで新しいサーバーが書いたものは消さない）。"""
        if not self.info_file:
            return
        try:
            import json  # noqa: PLC0415

            if json.loads(self.info_file.read_text(encoding="utf-8")).get("pid") == os.getpid():
                self.info_file.unlink()
        except (OSError, ValueError):
            pass

    def _shutdown(self, reason: str):
        log.info("LIFECYCLE_SHUTDOWN reason=%s", reason)
        self._cleanup()
        os._exit(0)  # waitress・Flask のどちらでも、プロセスごと確実に終える

    # ---------- 見張り ----------
    def start_watchdog(self):
        threading.Thread(target=self._loop, name="lifecycle-watchdog", daemon=True).start()
        log.info("LIFECYCLE watchdog started enabled=%s grace=%ss", self.enabled, self.idle_grace)

    def _loop(self):
        tick = 1.0
        while True:
            before = time.monotonic()
            time.sleep(tick)
            if time.monotonic() - before > tick + max(5.0, self.heartbeat_interval):
                log.info("LIFECYCLE resumed after %.0fs gap", time.monotonic() - before)
                self._resumed()
            reason = self._should_shutdown()
            if reason:
                self._shutdown(reason)
