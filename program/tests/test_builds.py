"""「Inventor で作る」の仕事（app/builds.py）と、その API の評価。

作る係は本物の別のプロセス（python -m ipt_build --events）で動かし、Inventor だけを代替オブジェクト（fake_inventor）にする。
    - 進み具合（1 行 1 つの JSON）を読んで、状態・部品ごとの結果・組立を画面の形にする
    - 保存先は前の結果を上書きしない。変換データの写しを置く
    - 作れない変換データは始めない・作成中は次を受け付けない・中止できる
    - ライブラリ（pywin32）を入れてから作る／入れられない・作る係が途中で落ちた、を理由つきで伝える
"""
import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import tests
from app import create_app
from app.builds import BuildBusy, Builds, safe_name
from app.lifecycle import Lifecycle
from ipt_build import libraries
from ipt_build.spec import SpecError

FIXTURES = tests.ROOT / "tests" / "fixtures" / "builder"
# 作る係: 本物の ipt_build を別のプロセスで動かし、Inventor への接続だけを代替オブジェクトにする
FAKE = ("import sys; sys.path.insert(0, {root!r}); import tests.fake_inventor as f, ipt_build.inventor as inv; "
        "inv.connect = lambda visible=True: f.FakeInventor(); from ipt_build.__main__ import main; sys.exit(main(sys.argv[1:]))").format(root=str(tests.ROOT))


def fake_command(args):
    return [sys.executable, "-c", FAKE, *args]


def python(code):
    return lambda args=None: [sys.executable, "-c", code]


def fixture(name):
    return json.loads((FIXTURES / f"{name}.inventor.json").read_text(encoding="utf-8"))


def wait(builds, seconds=60):
    end = time.monotonic() + seconds
    while builds.busy() and time.monotonic() < end:
        time.sleep(0.05)
    return builds.status()


class Jobs(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.opened = []
        self.builds = Builds(self.root, command=fake_command, opener=self.opened.append)

    def tearDown(self):
        self.builds.cancel()
        wait(self.builds)
        shutil.rmtree(self.root, ignore_errors=True)

    def test_builds_and_reports_every_part_and_the_assembly(self):
        started = self.builds.start(fixture("reel"))
        self.assertEqual(started["state"], "connecting")
        self.assertEqual([p["verdict"] for p in started["parts"]], [None] * 25, "始めた時点で、作る部品を全て並べる")
        done = wait(self.builds)
        self.assertEqual(done["state"], "done", done)
        self.assertEqual((done["good"], done["total"]), (25, 25))
        self.assertEqual(done["assembly"], {"file": "spool_reel_assembly_v2.iam", "placed": 459, "error": None})
        out = Path(done["out_dir"])
        self.assertEqual(out, self.root / "spool_reel_assembly_v2_ipt")
        self.assertEqual(json.loads((out / "spool_reel_assembly_v2.inventor.json").read_text(encoding="utf-8")), fixture("reel"),
                         "作った変換データの写しを保存先に置く")
        self.assertTrue((out / "build-report.json").exists())
        self.assertTrue(self.builds.open_output())
        self.assertEqual(self.opened, [out])

    def test_never_overwrites_an_earlier_result(self):
        self.builds.start(fixture("finger"))
        first = wait(self.builds)
        self.builds.start(fixture("finger"))
        second = wait(self.builds)
        self.assertEqual(Path(second["out_dir"]).name, Path(first["out_dir"]).name + " (2)")
        self.assertEqual(second["state"], "done")

    def test_refuses_what_it_cannot_build_before_starting(self):
        for data in ({"format": "other"}, {**fixture("finger"), "parts": []}, None):
            with self.subTest(data=str(data)[:30]), self.assertRaises(SpecError):
                self.builds.start(data)
        self.assertEqual(list(self.root.iterdir()), [], "何も作らない")
        self.assertEqual(self.builds.status()["state"], "idle")

    def test_one_build_at_a_time_and_it_can_be_cancelled(self):
        builds = Builds(self.root, command=python("import time; time.sleep(30)"), opener=self.opened.append)
        builds.start(fixture("finger"))
        with self.assertRaises(BuildBusy):
            builds.start(fixture("blade"))
        time.sleep(0.3)
        builds.cancel()
        cancelled = wait(builds, 10)
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertIn("保存せずに閉じて", cancelled["message"])
        self.assertEqual(list(self.root.iterdir()), [], "中止して何も作らなかったら、保存先を残さない")

    def test_installs_the_library_first_then_builds_in_a_new_process(self):
        builds = Builds(self.root, command=fake_command, install=python("print('Successfully installed pywin32')"))
        self.assertEqual(builds.start(fixture("finger"), install=True)["state"], "installing")
        self.assertEqual(wait(builds)["state"], "done")

    def test_a_failed_install_shows_what_pip_said(self):
        builds = Builds(self.root, command=fake_command,
                        install=python("import sys; print('ERROR: No matching distribution found for pywin32'); sys.exit(1)"))
        builds.start(fixture("finger"), install=True)
        failed = wait(builds)
        self.assertEqual(failed["state"], "failed")
        self.assertIn("ライブラリを入れられませんでした", failed["message"])
        self.assertIn("No matching distribution", failed["detail"])

    def test_a_partial_result_is_kept(self):
        """途中まで作った部品があれば、失敗しても保存先を残す（作った .ipt を消さない）"""
        partial = python("import sys, pathlib; out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1]); (out / 'p01.ipt').write_text('x'); sys.exit(3)")
        builds = Builds(self.root, command=lambda args: [*partial(), *args])
        builds.start(fixture("finger"))
        failed = wait(builds)
        self.assertEqual(failed["state"], "failed")
        self.assertTrue((Path(failed["out_dir"]) / "p01.ipt").exists())
        self.assertTrue(Path(failed["spec"]).exists(), "変換データの写しも残す（作った部品の元の記録）")

    def test_a_crash_is_explained_with_its_output(self):
        builds = Builds(self.root, command=python("import sys; sys.stderr.write('Traceback: boom\\n'); sys.exit(3)"))
        builds.start(fixture("finger"))
        failed = wait(builds)
        self.assertEqual(failed["state"], "failed")
        self.assertIn("終了コード 3", failed["message"])
        self.assertIn("boom", failed["detail"])

    def test_inventor_errors_are_passed_on(self):
        refuse = ("import sys; sys.path.insert(0, {root!r}); import tests.fake_inventor as f, ipt_build.inventor as inv; "
                  "inv.connect = lambda visible=True: (_ for _ in ()).throw(f.FakeComError('Inventor を起動できません')); "
                  "from ipt_build.__main__ import main; sys.exit(main(sys.argv[1:]))").format(root=str(tests.ROOT))
        builds = Builds(self.root, command=lambda args: [sys.executable, "-c", refuse, *args])
        started = builds.start(fixture("finger"))
        failed = wait(builds)
        self.assertEqual((failed["state"], failed["message"]), ("failed", "Inventor を起動できません"))
        self.assertIsNone(failed["out_dir"], "何も作れなかった試みの保存先は片付ける")
        self.assertFalse(Path(started["out_dir"]).exists())
        self.assertFalse(builds.open_output())

    def test_names_are_safe_for_windows(self):
        self.assertEqual(safe_name('a<b>:c"d/e\\f|g?h*'), "a_b_c_d_e_f_g_h_")
        self.assertEqual(safe_name(" . "), "変換データ")


class Api(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.opened = []
        self.app = create_app({"BUILDS": Builds(self.root, command=fake_command, opener=self.opened.append)})
        self.c = self.app.test_client()
        self.h = {"X-App-Token": self.app.config["TOKEN"]}

    def tearDown(self):
        wait(self.app.config["BUILDS"])
        shutil.rmtree(self.root, ignore_errors=True)

    def test_every_call_needs_the_token(self):
        for method, path in (("get", "/api/build"), ("post", "/api/build"), ("post", "/api/build/cancel"), ("post", "/api/build/open")):
            self.assertEqual(getattr(self.c, method)(path).status_code, 403, path)

    def test_asks_before_installing_the_library(self):
        with mock.patch.object(libraries, "ready", return_value=False):
            got = self.c.post("/api/build", json={"spec": fixture("finger")}, headers=self.h).json
        self.assertTrue(got["needs_install"])
        self.assertEqual((got["state"], got["ready"]), ("idle", False), "尋ねるまで始めない")
        self.assertEqual(got["root"], str(self.root), "保存先を先に示す")

    def test_start_poll_and_open(self):
        with mock.patch.object(libraries, "ready", return_value=True):
            started = self.c.post("/api/build", json={"spec": fixture("finger")}, headers=self.h)
            self.assertEqual(started.status_code, 200)
            wait(self.app.config["BUILDS"])
            done = self.c.get("/api/build", headers=self.h).json
        self.assertEqual((done["state"], done["good"], done["total"]), ("done", 1, 1))
        self.assertTrue(self.c.post("/api/build/open", headers=self.h).json["opened"])
        self.assertEqual(self.opened, [Path(done["out_dir"])])

    def test_bad_data_and_busy_are_explained(self):
        with mock.patch.object(libraries, "ready", return_value=True):
            bad = self.c.post("/api/build", json={"spec": {"format": "other"}}, headers=self.h)
            self.assertEqual(bad.status_code, 400)
            self.assertIn("この変換データからは作れません", bad.json["message"])
            self.app.config["BUILDS"].command = python("import time; time.sleep(30)")
            self.c.post("/api/build", json={"spec": fixture("finger")}, headers=self.h)
            busy = self.c.post("/api/build", json={"spec": fixture("finger")}, headers=self.h)
            self.assertEqual(busy.status_code, 409)
            self.assertIn("作っています", busy.json["message"])
            self.assertIn(self.c.post("/api/build/cancel", headers=self.h).json["state"], ("connecting", "cancelled"))
            self.assertEqual(wait(self.app.config["BUILDS"], 10)["state"], "cancelled")


    def test_an_unwritable_destination_is_explained(self):
        blocked = self.root / "file"
        blocked.write_text("x", encoding="utf-8")  # 保存先の親がファイル → フォルダを作れない
        self.app.config["BUILDS"].root = blocked
        with mock.patch.object(libraries, "ready", return_value=True):
            r = self.c.post("/api/build", json={"spec": fixture("finger")}, headers=self.h)
        self.assertEqual(r.status_code, 500)
        self.assertIn("build.output_dir", r.json["message"], "直し方（設定の場所）を示す")


class KeepsRunning(unittest.TestCase):
    def test_the_server_waits_for_the_build(self):
        """画面を閉じても、作り終えるまでサーバーを止めない（明示の終了だけは止まる）。"""
        building = [True]
        life = Lifecycle(idle_grace=0.01, hidden_grace=60, no_client_grace=0.01, busy=lambda: building[0])
        life.beat(closing=True)
        time.sleep(0.05)
        self.assertIsNone(life._should_shutdown())
        building[0] = False
        self.assertEqual(life._should_shutdown(), "idle_timeout")
        building[0] = True
        life.request_stop()
        self.assertEqual(life._should_shutdown(), "explicit")


if __name__ == "__main__":
    unittest.main()
