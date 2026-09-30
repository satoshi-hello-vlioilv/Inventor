# -*- coding: utf-8 -*-
"""画面の本体（Flask）。画面（templates/index.html）と JavaScript（static/js）を配り、ブラウザだけではできないことを受け持つ:
起動ファイルへドロップされたファイルを渡す・サンプルを配る・Inventor で作る（builds.py）・画面が閉じられたら止まる（lifecycle.py）。

安全のため、次の 2 つを守る（ほかの Web サイトから、この PC のファイルを読ませない）:
    - 宛先の名前（Host）が 127.0.0.1・localhost の依頼だけを受け付ける（名前を 127.0.0.1 に向けて読み取る攻撃を断つ）
    - ファイルを渡す・止めるなどの依頼には、起動ごとの合言葉を求める（画面の <meta name="app-token"> にだけ書く）
"""
from __future__ import annotations

import mimetypes
import re
import secrets

from flask import Flask, abort, request

import app_build
from ipt_build import libraries
import settings

# 返す種類（Content-Type）。Windows ではレジストリの設定で .js が text/plain の PC があり、
# ブラウザがモジュールとして読まない（画面が真っ白になる）。レジストリより後に、ここで決め直す
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
HOST = re.compile(r"(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::\d+)?")
NO_STORE = ("/", "/api/")


def create_app(test_config: dict | None = None) -> Flask:
    for ext, mime in TYPES.items():
        mimetypes.add_type(mime, ext)
    app = Flask(__name__)
    app.config.update(
        TOKEN=secrets.token_urlsafe(24),
        BUILD=app_build.fingerprint(settings.BASE),
        SAMPLES_DIR=settings.BASE / "samples",
        HANDOFF_DIR=settings.HANDOFF_DIR,
        RECEIVED={},  # 画面へ渡したファイル（番号 → パス）。渡したものだけを読めるようにする
        LIFECYCLE=None,
    )
    if test_config:
        app.config.update(test_config)
    app.config.setdefault("INVENTOR_INSTALLED", libraries.inventor_installed)  # この PC に Inventor があるか（評価では差し替える）
    if "BUILDS" not in app.config:
        from .builds import Builds  # noqa: PLC0415

        app.config["BUILDS"] = Builds(settings.output_root())

    @app.before_request
    def only_this_pc():
        m = HOST.fullmatch(request.host.lower())  # 名前（[::1] のような IPv6 を含む）と、あればポート
        if not m or m.group(1) not in LOCAL_HOSTS:
            abort(403)

    @app.after_request
    def cache_policy(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"  # 毎回確かめる（更新した直後に古い JavaScript を使わない。変わっていなければ 304 で速い）
        elif request.path == NO_STORE[0] or request.path.startswith(NO_STORE[1]):
            response.headers["Cache-Control"] = "no-store"
        if request.path in ("/api/health", "/api/instance"):
            response.headers["Access-Control-Allow-Origin"] = "*"  # 起動画面（loading.html）は file:// から尋ねる
        return response

    from .routes import bp  # noqa: PLC0415

    app.register_blueprint(bp)
    return app
