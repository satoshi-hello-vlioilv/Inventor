# -*- coding: utf-8 -*-
"""サーバーのプロセス（起動の係 launch_guard.py が、窓を出さずに別のプロセスとして起動する）。

画面が閉じられたら lifecycle.py の見張りがこのプロセスだけを止める。
起動したら名乗り（runtime/server.json: プロセス番号・合言葉）を書く。止める係（local_app.stop）はそれを読んで「終了」を頼む。
Waitress が入っていれば Waitress、無ければ Flask に付いているサーバーで動かす（どちらでも同じに動く）。
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time

import settings

settings.LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(filename=settings.LOG_DIR / "app.log", level=logging.INFO, encoding="utf-8",
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("inventor-3d-tool")


def write_info(app) -> None:
    settings.RUNTIME.mkdir(parents=True, exist_ok=True)
    info = {"app": settings.APP_ID, "pid": os.getpid(), "port": settings.PORT, "token": app.config["TOKEN"],
            "build": app.config["BUILD"], "app_path": str(settings.BASE), "python": sys.executable,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    tmp = settings.SERVER_INFO.with_suffix(".tmp")
    tmp.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, settings.SERVER_INFO)


def main() -> int:
    started = time.perf_counter()
    from app import create_app  # noqa: PLC0415
    from app.lifecycle import Lifecycle  # noqa: PLC0415

    app = create_app()
    cfg = settings.SERVER
    life = Lifecycle(idle_grace=float(cfg["idle_shutdown_seconds"]), heartbeat_interval=float(cfg["heartbeat_interval_seconds"]),
                     hidden_grace=float(cfg["hidden_idle_shutdown_seconds"]), no_client_grace=float(cfg["no_client_shutdown_seconds"]),
                     enabled=bool(cfg["auto_shutdown_on_close"]), info_file=settings.SERVER_INFO)
    app.config["LIFECYCLE"] = life
    write_info(app)
    life.start_watchdog()
    log.info("START pid=%s python=%s base=%s build=%s import=%.2fs", os.getpid(), sys.executable, settings.BASE,
             app.config["BUILD"], time.perf_counter() - started)
    try:
        from waitress import serve  # noqa: PLC0415
    except ImportError:
        log.info("SERVER flask-builtin %s:%s", settings.HOST, settings.PORT)
        app.run(host=settings.HOST, port=settings.PORT, debug=False, use_reloader=False, threaded=True)
    else:
        log.info("SERVER waitress %s:%s", settings.HOST, settings.PORT)
        serve(app, host=settings.HOST, port=settings.PORT, threads=8)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
