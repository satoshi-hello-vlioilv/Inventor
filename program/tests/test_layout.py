"""配る形（Start.vbs と program フォルダ）の約束の評価。WaveLog・転写距離・ピッチ解析と同じ形であること。

    - リポジトリの最上位の入口は Start.vbs だけ（.py・.bat を置かない）。アプリの中身はすべて program の中
    - Start.vbs・*.bat は Windows がそのまま読む形（CP932・CRLF）。git が改行を変えない（.gitattributes）
    - 同じ値（アプリの印・ポート・作業場所の名前）を持つファイルどうしが食い違わない
"""
import json
import re
import tempfile
import unittest
from pathlib import Path

import tests
import process_manager
import settings

REPO = tests.ROOT.parent


def windows_text(path) -> str:
    raw = path.read_bytes()
    text = raw.decode("cp932")  # CP932 で読めること
    self_check = raw.replace(b"\r\n", b"")
    assert b"\n" not in self_check and b"\r" not in self_check, f"{path.name}: 改行は CRLF だけ"
    return text


class Layout(unittest.TestCase):
    def test_top_level_has_one_entry(self):
        top = {p.name for p in REPO.iterdir() if p.is_file()}
        self.assertIn("Start.vbs", top)
        self.assertEqual([n for n in top if n.endswith((".py", ".bat", ".cmd"))], [], "最上位に .py・.bat を置かない")
        self.assertEqual([n for n in top if n.endswith(".vbs")], ["Start.vbs"], "入口は 1 つ")

    def test_windows_files_keep_their_bytes(self):
        attributes = (REPO / ".gitattributes").read_text(encoding="utf-8")
        for pattern in ("*.bat -text", "*.vbs -text"):
            self.assertIn(pattern, attributes)
        for path in [REPO / "Start.vbs", *tests.ROOT.glob("*.bat")]:
            windows_text(path)

    def test_start_vbs_hands_everything_to_start_app(self):
        vbs = windows_text(REPO / "Start.vbs")
        self.assertIn('app  = base & "\\program"', vbs)
        self.assertIn('"\\start_app.py"', vbs)
        self.assertIn("WScript.Arguments(i)", vbs, "ドロップされたファイルを渡す")
        self.assertIn("sh.Run cmd, 0, False", vbs, "窓を出さない")
        self.assertIn(f"\\{settings.APP_ID}\\logs", vbs)
        code = "\n".join(line.split("'", 1)[0] for line in vbs.splitlines())  # 注記を除いた命令
        self.assertNotIn(".Exec", code, "Exec は黒い窓を開く")

    def test_batch_files_call_the_python_entry_points(self):
        start = windows_text(tests.ROOT / "start.bat")
        self.assertIn('"%APPDIR%start_app.py" %*', start)
        self.assertIn('set "INVENTOR_TOOL_DIAG=1"', start)
        self.assertIn('"%APPDIR%process_manager.py"', windows_text(tests.ROOT / "stop.bat"))
        for name in ("start.bat", "stop.bat"):
            text = windows_text(tests.ROOT / name)
            self.assertIn('cd /d "%TEMP%"', text, "program フォルダを「使用中」にしない")
            self.assertIn(f"\\{settings.APP_ID}\\logs", start)

    def test_loading_page_agrees_with_the_settings(self):
        page = (tests.ROOT / "loading.html").read_text(encoding="utf-8")
        default = json.loads((tests.ROOT / "config" / "appsettings.json").read_text(encoding="utf-8"))["server"]["port"]
        self.assertEqual(default, settings.SERVER_DEFAULTS["port"], "配った設定と既定のポートが同じ")
        self.assertIn(f'|| "{default}"', page, "#port= が無いときの既定")
        self.assertIn(f'href="http://127.0.0.1:{default}/"', page)
        self.assertIn(f'var APP_ID = "{settings.APP_ID}"', page)
        self.assertIn(f"%LOCALAPPDATA%\\{settings.APP_ID}\\logs", page)

    def test_stop_recognizes_this_app_only(self):
        """止める係は、同じフォルダの settings.py にこのアプリの印がある server.py だけを止める。"""
        self.assertTrue(process_manager.is_ours(f'"pythonw.exe" -X utf8 "{tests.ROOT / "server.py"}"'))
        other = Path(tempfile.mkdtemp())
        (other / "server.py").write_text("", encoding="utf-8")
        (other / "settings.py").write_text('APP_ID = "OtherApp"\n', encoding="utf-8")
        self.assertFalse(process_manager.is_ours(f'"pythonw.exe" "{other / "server.py"}"'))

    def test_requirements_are_named(self):
        for path in (tests.ROOT / "requirements.txt", tests.ROOT / "ipt_build" / "requirements.txt"):
            names = [re.match(r"[A-Za-z0-9_.-]+", l).group(0) for l in path.read_text(encoding="utf-8").splitlines() if l and not l.startswith("#")]
            self.assertTrue(names, path)


if __name__ == "__main__":
    unittest.main()
