"""画面の本体（Flask、app/）の評価。

ブラウザはこのサーバーから画面と JavaScript を読む。まとめて 1 つにする作業（ビルド）が無くなったので、
「読み込む先がすべて在ること」「ブラウザがモジュールとして読める種類で返すこと」をここで確かめる。
あわせて、この PC のファイルをほかの Web サイトに読ませないための守り（宛先の名前・合言葉）と、
起動ファイルから受け取ったファイルの受け渡しを確かめる。
"""
import json
import mimetypes
import re
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import tests  # noqa: F401 — program フォルダを探索先に入れ、作業場所を評価用にする
import handoff
from app import create_app, routes
from app.lifecycle import Lifecycle

STATIC = tests.ROOT / "app" / "static"
TEMPLATE = tests.ROOT / "app" / "templates" / "index.html"
IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']""", re.M)


def importmap() -> dict:
    return json.loads(re.search(r'<script type="importmap">(.*?)</script>', TEMPLATE.read_text(encoding="utf-8"), re.S).group(1))["imports"]


class Modules(unittest.TestCase):
    """画面の JavaScript が読み込む先（ビルドが無いので、欠けていればブラウザで初めて分かる。ここで先に見つける）。"""

    def test_every_import_resolves(self):
        imports = importmap()
        checked = 0
        for file in sorted(STATIC.rglob("*")):
            if file.suffix not in (".js", ".mjs"):
                continue
            for spec in IMPORT.findall(file.read_text(encoding="utf-8")):
                checked += 1
                if spec.startswith("."):
                    self.assertTrue((file.parent / spec).resolve().is_file(), f"{file.relative_to(STATIC)}: {spec} が無い")
                else:
                    self.assertTrue(any(spec == k or (k.endswith("/") and spec.startswith(k)) for k in imports),
                                    f"{file.relative_to(STATIC)}: {spec} は importmap に無い")
        self.assertGreater(checked, 60, "読み込みの書き方を見落としていないか")

    def test_importmap_points_to_bundled_files(self):
        for key, target in importmap().items():
            self.assertTrue(target.startswith("/static/vendor/"), f"{key} はインターネットから読まない（同梱を使う）")
            path = tests.ROOT / "app" / target.lstrip("/")
            self.assertTrue(path.is_dir() if key.endswith("/") else path.is_file(), f"{key} → {target} が無い")

    def test_bundled_three_is_the_documented_version(self):
        text = (STATIC / "vendor" / "three" / "three.module.min.js").read_text(encoding="utf-8")
        revision = re.search(r'const \w+="(\d+)"', text).group(1)  # 最初の定数が REVISION（縮めた版では名前が消える）
        self.assertIn(f"| 0.{revision}.0 |", (STATIC / "vendor" / "README.md").read_text(encoding="utf-8"))


class Serving(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.c = self.app.test_client()
        self.token = self.app.config["TOKEN"]

    def test_page_carries_the_token_and_its_files(self):
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        page = r.get_data(as_text=True)
        self.assertIn(f'<meta name="app-token" content="{self.token}">', page)
        for url in re.findall(r'(?:src|href)="(/static/[^"]+)"', page):
            with self.c.get(url) as r:
                self.assertEqual(r.status_code, 200, url)

    def test_modules_are_served_as_javascript(self):
        """Windows のレジストリで .js が text/plain の PC でも、モジュールとして読める種類で返す。"""
        mimetypes.add_type("text/plain", ".js")  # レジストリから読んだ値を再現する
        self.c = create_app().test_client()
        for path, mime in (("js/main.js", "text/javascript"), ("vendor/fzstd/index.mjs", "text/javascript"),
                           ("js/core/labels.json", "application/json"), ("css/app.css", "text/css")):
            with self.c.get(f"/static/{path}") as r:
                self.assertEqual((r.status_code, r.mimetype), (200, mime), path)
                self.assertEqual(r.headers["Cache-Control"], "no-cache", "更新した直後に古い JavaScript を使わない")

    def test_only_this_pc_by_name(self):
        """宛先の名前が 127.0.0.1・localhost 以外の依頼は断る（ほかのサイトの名前を 127.0.0.1 に向けて読み取らせない）。"""
        for host in ("127.0.0.1:57840", "localhost", "localhost:8000", "[::1]:57840", "[::1]", "LOCALHOST:57840"):
            self.assertEqual(self.c.get("/api/health", headers={"Host": host}).status_code, 200, host)
        for host in ("evil.example", "evil.example:57840", "127.0.0.1.evil.example", "[::1].evil.example", "[::2]:57840"):
            self.assertEqual(self.c.get("/", headers={"Host": host}).status_code, 403, host)

    def test_token_is_required(self):
        for method, path in (("post", "/api/launch"), ("get", "/api/files/0123"), ("post", "/api/heartbeat"), ("post", "/api/shutdown")):
            self.assertEqual(getattr(self.c, method)(path).status_code, 403, path)
            self.assertEqual(getattr(self.c, method)(path, headers={"X-App-Token": "x" + self.token}).status_code, 403, path)

    def test_instance_answers_the_loading_page(self):
        r = self.c.get("/api/instance")
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*", "起動画面は file:// から尋ねる")
        self.assertEqual((r.json["app"], r.json["stale"]), ("Inventor3DTool", False))
        routes._DISK_BUILD["at"] = 0
        with mock.patch("app_build.fingerprint", return_value="changed"):
            self.assertTrue(self.c.get("/api/instance").json["stale"], "ファイルが入れ替わったら古いと答える")
        routes._DISK_BUILD["at"] = 0


class Samples(unittest.TestCase):
    def setUp(self):
        self.c = create_app().test_client()

    def test_lists_every_sample_by_kind(self):
        items = self.c.get("/api/samples").json["samples"]
        kinds = [i["kind"] for i in items]
        self.assertEqual(sorted(set(kinds), key=kinds.index), ["ipt", "iam", "stp", "html"])
        on_disk = sorted(p.name for k, exts in routes.SAMPLE_KINDS.items() for p in (tests.ROOT / "samples" / k).iterdir()
                         if p.suffix.lower() in exts)
        self.assertEqual(sorted(i["name"] for i in items), on_disk)
        first = items[0]
        with self.c.get(first["url"]) as r:
            self.assertEqual(len(r.data), first["size"])

    def test_cannot_leave_the_samples_folder(self):
        for url in ("/samples/ipt/../../settings.py", "/samples/ipt/..%2F..%2Fsettings.py", "/samples/other/x.ipt"):
            self.assertEqual(self.c.get(url).status_code, 404, url)


class Launch(unittest.TestCase):
    """起動ファイルへドロップされたファイル → 開いた画面（handoff.py・POST /api/launch）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.handoff = self.tmp / "launch"
        self.app = create_app({"HANDOFF_DIR": self.handoff})
        self.c = self.app.test_client()
        self.h = {"X-App-Token": self.app.config["TOKEN"]}
        folder = self.tmp / "組立 #1"
        folder.mkdir()
        samples = tests.ROOT / "samples"
        self.iam = shutil.copy(next((samples / "iam").glob("*.iam")), folder)
        self.parts = [shutil.copy(p, folder) for p in sorted((samples / "ipt").glob("*.ipt"))[:3]]
        (folder / "メモ.txt").write_text("x", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dropped_files_and_the_assembly_parts(self):
        dropped_part = Path(self.parts[0])
        handoff.record([Path(self.iam), dropped_part, self.tmp / "消えた.stp", self.tmp], self.handoff)
        got = self.c.post("/api/launch", headers=self.h).json
        self.assertEqual([f["name"] for f in got["files"]], [Path(self.iam).name, dropped_part.name])
        self.assertEqual([p["name"] for p in got["parts"]], sorted(Path(p).name for p in self.parts[1:]),
                         "同じフォルダの部品（.ipt）だけ。ドロップしたものは重ねない")
        self.assertEqual(got["missing"], ["消えた.stp"])
        for item in got["files"] + got["parts"]:
            with self.c.get(item["url"], headers=self.h) as r:
                self.assertEqual((r.status_code, len(r.data)), (200, item["size"]), item["name"])
            self.assertEqual(self.c.get(item["url"]).status_code, 403, "合言葉が無ければ読ませない")
        self.assertEqual(self.c.post("/api/launch", headers=self.h).json, {"files": [], "parts": [], "missing": []}, "1 回分は 1 度だけ")
        self.assertEqual(self.c.get("/api/files/unknown", headers=self.h).status_code, 404)

    def test_oldest_first_and_expired_ones_dropped(self):
        old = handoff.record([Path(self.iam)], self.handoff)
        data = json.loads(old.read_text(encoding="utf-8"))
        data["created"] = time.time() - handoff.TTL_SECONDS - 1
        old.write_text(json.dumps(data), encoding="utf-8")
        handoff.record([Path(self.parts[0])], self.handoff)
        handoff.record([Path(self.parts[1])], self.handoff)
        names = [[f["name"] for f in self.c.post("/api/launch", headers=self.h).json["files"]] for _ in range(3)]
        self.assertEqual(names, [[Path(self.parts[0]).name], [Path(self.parts[1]).name], []], "失効した記録は受け取らない")
        self.assertEqual(list(self.handoff.glob("*")), [], "受け取った記録・失効した記録は残さない")


class Heartbeat(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.life = Lifecycle(idle_grace=5, hidden_grace=60)
        self.app.config["LIFECYCLE"] = self.life
        self.c = self.app.test_client()
        self.token = self.app.config["TOKEN"]

    def test_beacon_body_carries_the_token(self):
        """sendBeacon は見出しを付けられず、Content-Type も付かないことがある。本文の合言葉で受け付ける。"""
        r = self.c.post("/api/heartbeat", data=json.dumps({"token": self.token, "visible": False}))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json["visible"])
        self.assertTrue(r.json["seen_client"])
        self.assertEqual(self.c.post("/api/heartbeat", data=json.dumps({"visible": False})).status_code, 403)

    def test_shutdown_asks_the_lifecycle(self):
        r = self.c.post("/api/shutdown", headers={"X-App-Token": self.token})
        self.assertEqual(r.json["status"], "stopping")
        self.assertEqual(self.life._should_shutdown(), "explicit")


if __name__ == "__main__":
    unittest.main()
