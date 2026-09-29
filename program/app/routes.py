# -*- coding: utf-8 -*-
"""画面と API。

    GET  /                     画面（合言葉を埋め込む）
    GET  /api/health           生きているか
    GET  /api/instance         このアプリか・版・指紋（起動の係と起動画面が確かめる）
    GET  /api/samples          サンプルの一覧（中身は /samples/<種類>/<名前>）
    POST /api/launch           起動ファイルへドロップされたファイル（1 回の起動分）を受け取る   … 合言葉
    GET  /api/files/<番号>      受け取ったファイルの中身                                     … 合言葉
    POST /api/heartbeat        画面が開いていることの知らせ（本文に合言葉）
    POST /api/shutdown         終了                                                     … 合言葉
"""
from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path

from flask import Blueprint, abort, current_app, jsonify, render_template, request, send_file, send_from_directory, url_for

import app_build
import handoff
import settings

from .version import APP_VERSION

bp = Blueprint("main", __name__)

# サンプルの種類（起動画面にこの順で並ぶ）と拡張子
SAMPLE_KINDS = {"ipt": (".ipt",), "iam": (".iam",), "stp": (".stp", ".step"), "html": (".html", ".htm")}


def _token_ok(body: dict | None = None) -> bool:
    sent = request.headers.get("X-App-Token") or (body or {}).get("token") or ""
    return secrets.compare_digest(str(sent), current_app.config["TOKEN"])


def _require_token(body: dict | None = None) -> None:
    if not _token_ok(body):
        abort(403)


@bp.get("/")
def index():
    return render_template("index.html", token=current_app.config["TOKEN"])


@bp.get("/api/health")
def health():
    return jsonify(status="ok")


_DISK_BUILD = {"at": 0.0, "value": ""}


def _disk_build() -> str:
    """いまのディスクの指紋（2 秒だけ覚える。起動画面が何度も尋ねるため）。"""
    now = time.monotonic()
    if now - _DISK_BUILD["at"] > 2:
        _DISK_BUILD.update(at=now, value=app_build.fingerprint(settings.BASE))
    return _DISK_BUILD["value"]


@bp.get("/api/instance")
def instance():
    build = current_app.config["BUILD"]
    return jsonify(app=settings.APP_ID, name=settings.APP_NAME, version=APP_VERSION, build=build,
                   stale=_disk_build() != build,  # 起動したあとにファイルが入れ替わった（このサーバーは古い）
                   app_path=str(settings.BASE), pid=os.getpid(), python=sys.executable, status="ready")


# ---- サンプル ------------------------------------------------------------------------
@bp.get("/api/samples")
def samples():
    folder = Path(current_app.config["SAMPLES_DIR"])
    items = []
    for kind, exts in SAMPLE_KINDS.items():
        try:
            files = sorted(p for p in (folder / kind).iterdir() if p.is_file() and p.suffix.lower() in exts)
        except OSError:
            continue
        items += [{"kind": kind, "name": p.name, "size": p.stat().st_size, "url": url_for("main.sample", kind=kind, name=p.name)}
                  for p in files]
    return jsonify(samples=items)


@bp.get("/samples/<kind>/<path:name>")
def sample(kind: str, name: str):
    if kind not in SAMPLE_KINDS:
        abort(404)
    return send_from_directory(Path(current_app.config["SAMPLES_DIR"]) / kind, name)


# ---- 起動ファイルから受け取ったファイル ---------------------------------------------------
def _entry(path: Path) -> dict:
    """画面へ渡す 1 件（名前・大きさ・中身の在りか）。渡したものだけを番号で読めるようにする。"""
    key = secrets.token_hex(8)
    current_app.config["RECEIVED"][key] = path
    return {"name": path.name, "size": path.stat().st_size, "url": url_for("main.received", key=key)}


def _companions(assembly: Path) -> list[Path]:
    """組立（.iam）と同じフォルダの部品（.ipt）。組立が参照する部品を、画面がファイル名で探す置き場に加える。"""
    try:
        return sorted(p for p in assembly.parent.iterdir() if p.suffix.lower() == ".ipt" and p.is_file())
    except OSError:
        return []


@bp.post("/api/launch")
def launch():
    _require_token()
    paths = handoff.claim(current_app.config["HANDOFF_DIR"]) or []
    files, parts, missing = [], [], []
    for path in paths:
        if path.is_dir():
            continue  # フォルダは開かない
        if not path.is_file():
            missing.append(path.name)  # 起動してから画面が開くまでに、消された・移された
            continue
        files.append(_entry(path))
        if path.suffix.lower() == ".iam":
            parts += [p for p in _companions(path) if p not in paths and p not in parts]
    return jsonify(files=files, parts=[_entry(p) for p in parts], missing=missing)


@bp.get("/api/files/<key>")
def received(key: str):
    _require_token()
    path = current_app.config["RECEIVED"].get(key)
    if path is None or not Path(path).is_file():
        abort(404)
    return send_file(path, mimetype="application/octet-stream", conditional=False)


# ---- 生き死に ---------------------------------------------------------------------------
@bp.post("/api/heartbeat")
def heartbeat():
    body = request.get_json(silent=True, force=True) or {}  # sendBeacon は Content-Type を付けないことがある
    _require_token(body)
    life = current_app.config.get("LIFECYCLE")
    if not life:
        return jsonify(enabled=False)
    life.beat(visible=body.get("visible", True) is not False, closing=bool(body.get("closing")))
    return jsonify(life.status())


@bp.post("/api/shutdown")
def shutdown():
    _require_token(request.get_json(silent=True, force=True))
    life = current_app.config.get("LIFECYCLE")
    if not life:
        return jsonify(status="no-lifecycle")
    life.request_stop()
    return jsonify(status="stopping")
