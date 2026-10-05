"""起動の係（launch_guard.py）の評価。ダイアログ・ブラウザー・プロセスの起動・サーバーへの問い合わせを差し替えて、分岐を確かめる。

    - ドロップされたファイル（変換データ .json も）は、画面を開く「前に」記録する（開いた画面が受け取る）
    - Flask が無ければ入れるかを尋ね、断られたら何も開かない
    - 動いているサーバーが今のファイルと同じなら使い、違えば止めて起動し直す。起動の途中で終われば理由を知らせる
"""
import shutil
import unittest
from unittest import mock

import tests  # noqa: F401
import handoff
import launch_guard
import settings


class Proc:
    def __init__(self, code=None):
        self.pid, self.code = 4321, code

    def poll(self):
        return self.code


class Recorder(launch_guard.Env):
    def __init__(self, missing=(), answer=True, install_ok=True):
        self.calls = []
        self.records_when_opened = None

        def open_page(url):
            self.records_when_opened = sorted(settings.HANDOFF_DIR.glob("*.json"))
            self.calls.append(("open", url))
            return "test"

        super().__init__(
            ask=lambda text: self.calls.append(("ask", text)) or answer,
            tell=lambda text: self.calls.append(("tell", text)),
            missing=lambda: list(missing),
            install=lambda: self.calls.append(("install",)) or (install_ok, "ERROR: pip failed"),
            open_page=open_page,
            spawn_server=lambda: self.calls.append(("server",)) or Proc(),
        )

    def kinds(self):
        return [c[0] for c in self.calls]


class Main(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(settings.HANDOFF_DIR, ignore_errors=True)
        self.ensure = mock.patch.object(launch_guard, "ensure_server", side_effect=lambda env: env.calls.append(("ensure",)) or 0)
        self.ensure.start()

    def tearDown(self):
        self.ensure.stop()
        shutil.rmtree(settings.HANDOFF_DIR, ignore_errors=True)

    def test_double_click_opens_the_app(self):
        env = Recorder()
        self.assertEqual(launch_guard.main([], env), 0)
        self.assertEqual(env.kinds(), ["open", "ensure"])
        self.assertTrue(env.calls[0][1].endswith(f"loading.html#port={settings.PORT}"))
        self.assertEqual(env.records_when_opened, [], "ファイルが無ければ記録しない")

    def test_files_are_recorded_before_the_page_opens(self):
        env = Recorder()
        self.assertEqual(launch_guard.main(["C:/data/a.iam", "C:/data/reel.inventor.json", "C:/data/b.stp"], env), 0)
        self.assertEqual(env.kinds(), ["open", "ensure"])
        self.assertEqual(len(env.records_when_opened), 1, "開いた時点で、記録は書き終えている")
        self.assertEqual([p.name for p in handoff.claim()], ["a.iam", "reel.inventor.json", "b.stp"],
                         "変換データも画面で開く（画面の「Inventor で作る」で作る）")

    def test_missing_flask_declined_opens_nothing(self):
        env = Recorder(missing=["flask"], answer=False)
        self.assertEqual(launch_guard.main([], env), 1)
        self.assertEqual(env.kinds(), ["ask"])
        self.assertIn("flask", env.calls[0][1])

    def test_missing_flask_installed_after_the_page_opens(self):
        env = Recorder(missing=["flask"])
        self.assertEqual(launch_guard.main([], env), 0)
        self.assertEqual(env.kinds(), ["ask", "open", "install", "ensure"], "入れている間も起動画面が見えている")

    def test_install_failure_is_told(self):
        env = Recorder(missing=["flask"], install_ok=False)
        self.assertEqual(launch_guard.main([], env), 2)
        self.assertEqual(env.kinds(), ["ask", "open", "install", "tell"])
        self.assertIn("pip failed", env.calls[-1][1])

    def test_required_modules_come_from_requirements(self):
        self.assertEqual(launch_guard.required_modules(), ["flask"])


class EnsureServer(unittest.TestCase):
    """サーバーの確かめ（local_app への問い合わせを差し替える）。"""

    def run_with(self, answers, in_use=False, stop_ok=True, proc=None):
        env = Recorder()
        if proc is not None:
            env.spawn_server = lambda: env.calls.append(("server",)) or proc
        answers = list(answers)
        with mock.patch.object(launch_guard.local_app, "instance", side_effect=lambda *a: answers.pop(0) if len(answers) > 1 else answers[0]), \
                mock.patch.object(launch_guard.local_app, "in_use", return_value=in_use), \
                mock.patch.object(launch_guard.local_app, "stop", side_effect=lambda *a: env.calls.append(("stop",)) or stop_ok), \
                mock.patch.object(launch_guard, "is_current", side_effect=lambda d: bool(d) and d.get("build") == "now"), \
                mock.patch.object(launch_guard.time, "sleep"):
            code = launch_guard.ensure_server(env)
        return code, env

    def test_current_server_is_reused(self):
        code, env = self.run_with([{"build": "now"}])
        self.assertEqual((code, env.kinds()), (0, []))

    def test_old_server_is_replaced(self):
        code, env = self.run_with([{"build": "old"}, None, {"build": "now"}])
        self.assertEqual((code, env.kinds()), (0, ["stop", "server"]))

    def test_port_held_by_something_else(self):
        code, env = self.run_with([None], in_use=True, stop_ok=False)
        self.assertEqual((code, env.kinds()), (2, ["stop", "tell"]))
        self.assertIn("appsettings.json", env.calls[-1][1], "ほかのアプリなら、ポートの変え方を示す")

    def test_early_exit_is_explained(self):
        launch_guard.LOG_DIR.mkdir(parents=True, exist_ok=True)
        launch_guard.SERVER_CONSOLE.write_text("ModuleNotFoundError: No module named 'flask'\n", encoding="utf-8")
        code, env = self.run_with([None], proc=Proc(code=1))
        self.assertEqual((code, env.kinds()), (2, ["server", "tell"]))
        self.assertIn("No module named 'flask'", env.calls[-1][1], "サーバーの出力（Python のエラー）をそのまま見せる")


class Pages(unittest.TestCase):
    def test_loading_url_is_a_file_with_the_port(self):
        url = launch_guard.loading_url()
        self.assertTrue(url.startswith("file:///") or url.startswith("file://"), url)
        self.assertTrue(url.endswith(f"/loading.html#port={settings.PORT}"))

    def test_child_processes_find_the_program_and_keep_it_clean(self):
        env = settings.child_env()
        self.assertEqual(env["PYTHONPATH"].split(launch_guard.os.pathsep)[0], str(settings.BASE))
        self.assertEqual(env["PYTHONPYCACHEPREFIX"], str(settings.PYCACHE), ".pyc を program フォルダに作らない")
        self.assertEqual(env["INVENTOR_TOOL_LOCAL_ROOT"], str(settings.LOCAL_ROOT))


if __name__ == "__main__":
    unittest.main()
