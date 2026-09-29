"""この PC のアプリへ尋ねる・止める（local_app.py）の評価。転写距離・ピッチ解析の評価と同じ観点。

社内 PC の Windows のプロキシ設定があると、urllib は 127.0.0.1 への問い合わせもプロキシへ送る。
すると動いているアプリが「答えない」ように見え、起動は待ち続け、停止は何も止めずに「止めました」と言ってしまう。
ここでは届かないプロキシを環境変数で与えて同じ状況を作る。
"""
import http.server
import importlib
import json
import os
import threading
import unittest
from unittest import mock

import tests  # noqa: F401
import local_app


class Handler(http.server.BaseHTTPRequestHandler):
    seen = []

    def _answer(self, body: dict):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._answer({"app": local_app.APP_ID, "pid": os.getpid()})

    def do_POST(self):
        Handler.seen.append((self.path, self.headers.get("X-App-Token")))
        self._answer({"status": "stopping"})

    def log_message(self, *a):
        pass


class LocalApp(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        port = self.srv.server_address[1]
        # プロキシの設定は、local_app を読み込む時点で在ること（Windows ではレジストリの設定を読み込むときに読む）
        self.env = mock.patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9",
                                                "no_proxy": "", "NO_PROXY": ""})
        self.env.start()
        importlib.reload(local_app)
        self.patches = [mock.patch.object(local_app, "PORT", port), mock.patch.object(local_app, "URL", f"http://127.0.0.1:{port}/"),
                        mock.patch.object(local_app, "server_info", return_value={"token": "secret"})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()
        importlib.reload(local_app)
        self.srv.shutdown()
        self.srv.server_close()

    def test_asks_this_pc_without_the_proxy(self):
        self.assertIsNotNone(local_app.instance(2), "プロキシ設定があっても、自分の PC のアプリには直接尋ねる")

    def test_requests_carry_the_token_of_the_running_server(self):
        Handler.seen.clear()
        local_app.request_json("/api/shutdown", 2, {})
        self.assertEqual(Handler.seen, [("/api/shutdown", "secret")], "サーバーの名乗り（server.json）の合言葉を添える")

    def test_port_in_use_is_seen_without_http(self):
        self.assertTrue(local_app.in_use())
        self.srv.shutdown()
        self.srv.server_close()
        self.assertTrue(local_app.wait_closed(3), "閉じたポートは「使われていない」")


if __name__ == "__main__":
    unittest.main()
