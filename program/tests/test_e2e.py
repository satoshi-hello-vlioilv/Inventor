"""通しの評価: 本物の起動の係とサーバー（別のプロセス）で、ドロップ → 起動 → 画面が受け取る → 2 度目の起動 → 停止 を確かめる。
ブラウザーの代わりに、画面と同じ問い合わせ（合言葉つき）をこの評価から送る（ブラウザーは開かない）。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import tests
import launch_guard
import local_app
import settings


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        folder = self.tmp / "組立 #1"
        folder.mkdir()
        samples = tests.ROOT / "samples"
        self.iam = Path(shutil.copy(next((samples / "iam").glob("*.iam")), folder))
        self.parts = [Path(shutil.copy(p, folder)) for p in sorted((samples / "ipt").glob("*.ipt"))[:2]]
        self.pages, self.told, self.servers = [], [], []

        def spawn():
            self.servers.append(launch_guard._spawn_server())  # 本物のサーバー（終わるのを見届けるために控える）
            return self.servers[-1]

        self.env = launch_guard.Env(open_page=lambda url: self.pages.append(url) or "test", tell=self.told.append,
                                    ask=lambda text: self.fail(f"尋ねないはず: {text}"), spawn_server=spawn)

    def tearDown(self):
        local_app.stop()
        for proc in self.servers:
            proc.wait(10)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def get(self, path: str, token: str | None = None, method: str = "GET") -> bytes:
        req = launch_guard.local_app.urllib.request.Request(settings.URL.rstrip("/") + path, method=method,
                                                            data=b"" if method == "POST" else None,
                                                            headers={"X-App-Token": token} if token else {})
        with local_app._OPENER.open(req, timeout=5) as r:
            return r.read()

    def test_drop_open_receive_reuse_stop(self):
        self.assertEqual(launch_guard.main([str(self.iam)], self.env), 0, self.told)
        self.assertEqual(len(self.pages), 1)
        info = local_app.server_info()
        self.assertEqual(info["port"], settings.PORT)
        page = self.get("/").decode("utf-8")
        self.assertIn(f'content="{info["token"]}"', page, "画面に埋め込まれた合言葉は、サーバーの名乗りと同じ")

        got = json.loads(self.get("/api/launch", info["token"], "POST"))
        self.assertEqual([f["name"] for f in got["files"]], [self.iam.name])
        self.assertEqual([p["name"] for p in got["parts"]], [p.name for p in self.parts])
        self.assertEqual(self.get(got["files"][0]["url"], info["token"]), self.iam.read_bytes())

        self.assertEqual(launch_guard.main([], self.env), 0, "2 度目の起動")
        self.assertEqual(local_app.server_info()["pid"], info["pid"], "動いているサーバーをそのまま使う")
        self.assertEqual(len(self.pages), 2, "画面は起動のたびに開く")
        self.assertEqual(len(self.servers), 1)

        self.assertTrue(local_app.stop(), "終了を頼んで止まる")
        self.assertFalse(local_app.port_open())
        self.assertFalse(settings.SERVER_INFO.exists(), "止まったサーバーの名乗りは残さない")
        self.assertEqual(self.told, [])


if __name__ == "__main__":
    unittest.main()
