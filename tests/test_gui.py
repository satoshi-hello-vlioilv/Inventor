"""画面つきの実行（ipt_build --gui、起動ファイルが使う）の評価。

ダイアログ・ブラウザー・pip・Inventor を差し替え、確認の分岐と、進み具合・結果のページ（作成結果.html）を確かめる。
"""
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import ROOT
from ipt_build import gui
from ipt_build.__main__ import main
from tests.fake_inventor import FakeInventor

FIXTURES = ROOT / "tests" / "fixtures" / "builder"


class Recorder(gui.Env):
    """差し替え用の環境。ダイアログの答えを順に返し、呼ばれた内容を記録する。"""

    def __init__(self, answers=(True,), pywin32=True, install_ok=True):
        self.asked, self.opened, self.installed, self.relaunched, self.pages = [], [], 0, [], []
        answers = list(answers)
        app = FakeInventor()
        self.app = app

        def ask(title, message):
            self.asked.append(message)
            return answers.pop(0)

        def install():
            self.installed += 1
            return install_ok, "" if install_ok else "ERROR: Could not find a version that satisfies the requirement pywin32"

        super().__init__(ask=ask, open_page=self.opened.append, has_pywin32=lambda: pywin32, install=install,
                         relaunch=lambda path: self.relaunched.append(path) or 0, connect=lambda: app)


class GuiRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def spec(self, name="finger"):
        path = self.tmp / f"{name}.inventor.json"
        shutil.copy(FIXTURES / f"{name}.inventor.json", path)
        return path

    def run_gui(self, path, env, confirmed=False):
        pages = []
        original = gui.Page.show

        def spy(page, state, **kwargs):
            original(page, state, **kwargs)
            pages.append((state, page.path.read_text(encoding="utf-8")))

        with mock.patch.object(gui.Page, "show", spy):
            code = gui.run(path, confirmed=confirmed, env=env)
        return code, pages

    def test_builds_after_confirmation_and_reports_progress_then_result(self):
        path, env = self.spec("reel"), Recorder()
        code, pages = self.run_gui(path, env)
        self.assertEqual(code, 0)
        self.assertEqual(len(env.asked), 1)
        self.assertIn("部品 25 種類・配置 459 か所（組立を 1 つ作ります）", env.asked[0])
        out = self.tmp / "reel_ipt"
        self.assertEqual(env.opened, [(out / gui.PAGE).as_uri()], "ページは 1 度だけ開く")
        states = [s for s, _ in pages]
        self.assertEqual((states[0], states[-1]), ("connecting", "done"))
        self.assertEqual(states.count("building"), 25 + 2)  # 開始・部品ごと・組立
        building = next(html for s, html in pages if s == "building")
        self.assertIn('http-equiv="refresh"', building)
        self.assertIn(">作成中<", building)
        self.assertIn(">待ち<", building)
        final = pages[-1][1]
        self.assertNotIn('http-equiv="refresh"', final, "作り終えたら読み直さない")
        self.assertIn("すべての部品が期待値と一致しました", final)
        self.assertEqual(final.count('data-tone="ok">一致<'), 25)
        self.assertIn("組立 spool_reel_assembly_v2.iam（配置 459 か所）", final)
        self.assertTrue((out / "build-report.json").exists())

    def test_declining_builds_nothing_and_leaves_nothing(self):
        path, env = self.spec(), Recorder(answers=[False])
        code, pages = self.run_gui(path, env)
        self.assertEqual((code, pages, env.opened), (1, [], []))
        self.assertFalse((self.tmp / "finger_ipt").exists())
        self.assertEqual(env.app.documents, [])

    def test_offers_to_install_pywin32_then_continues_in_a_new_python(self):
        path, env = self.spec(), Recorder(answers=[True, True], pywin32=False)
        code, pages = self.run_gui(path, env)
        self.assertEqual(code, 0)
        self.assertIn("pywin32", env.asked[1])
        self.assertEqual((env.installed, env.relaunched), (1, [path.resolve()]))
        self.assertEqual([s for s, _ in pages], ["installing"])
        self.assertEqual(env.app.documents, [], "このプロセスでは作らない（入れたライブラリを読み込める新しい Python で作る）")

    def test_declining_the_install_stops(self):
        env = Recorder(answers=[True, False], pywin32=False)
        code, pages = self.run_gui(self.spec(), env)
        self.assertEqual((code, pages, env.installed), (1, [], 0))

    def test_a_failed_install_shows_the_pip_output(self):
        env = Recorder(answers=[True, True], pywin32=False, install_ok=False)
        code, pages = self.run_gui(self.spec(), env)
        self.assertEqual(code, 2)
        self.assertEqual(pages[-1][0], "error")
        self.assertIn("ライブラリを入れられませんでした", pages[-1][1])
        self.assertIn("Could not find a version", pages[-1][1])
        self.assertEqual(env.relaunched, [])

    def test_after_install_the_new_python_skips_the_question_and_reuses_the_open_page(self):
        env = Recorder(answers=[])
        code, pages = self.run_gui(self.spec(), env, confirmed=True)
        self.assertEqual((code, env.asked, env.opened), (0, [], []))
        self.assertEqual(pages[-1][0], "done")

    def test_a_broken_spec_is_explained_on_the_page(self):
        path = self.tmp / "壊れた.inventor.json"
        path.write_text(json.dumps({"format": "other"}), encoding="utf-8")
        env = Recorder(answers=[])
        code, pages = self.run_gui(path, env)
        self.assertEqual(code, 2)
        self.assertEqual(pages[-1][0], "error")
        self.assertIn("変換データ（format: inventor-builder）ではありません", pages[-1][1])
        self.assertEqual(len(env.opened), 1)

    def test_inventor_errors_are_explained_on_the_page(self):
        env = Recorder()
        env.connect = mock.Mock(side_effect=RuntimeError("pywin32 が見つかりません。"))
        code, pages = self.run_gui(self.spec(), env)
        self.assertEqual(code, 2)
        self.assertIn("作れませんでした: pywin32 が見つかりません。", pages[-1][1])

    def test_names_are_escaped(self):
        from ipt_build.spec import load_spec

        path = self.spec()
        spec = load_spec(path)
        html = gui.render(self.tmp / "&<i>x.inventor.json", "building", spec=spec)
        self.assertIn("&amp;&lt;i&gt;x.inventor.json", html)
        self.assertNotIn("<i>x", html)
        self.assertEqual(len(re.findall(r"<tr>", html)), 1 + len(spec.parts))


class CommandTest(unittest.TestCase):
    def test_gui_option_runs_the_gui(self):
        with mock.patch.object(gui, "run", return_value=0) as run:
            self.assertEqual(main([str(FIXTURES / "finger.inventor.json"), "--gui"]), 0)
        run.assert_called_once_with(FIXTURES / "finger.inventor.json", confirmed=False)


if __name__ == "__main__":
    unittest.main()
