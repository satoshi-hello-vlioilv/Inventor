"""配る形（最上位の Inventor3DTool.exe と program フォルダ）と、窓（desktop/）・画面・作る係の約束の評価。

    - 最上位の入口は exe だけ（.vbs・.bat・.py を置かない）。アプリの中身はすべて program の中。exe は CI が作って置く
    - 同じ値（exe の名前・アプリの名前・作業場所の名前・自前の仕組みの名前）を持つファイルどうしが食い違わない
    - 画面の合言葉の差し込み口と、作る係の問い合わせの形（--check・--libraries）が、窓の読み方と合う
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import tests

REPO = tests.ROOT.parent
DESKTOP = REPO / "desktop"
EXE = "Inventor3DTool.exe"
APP_NAME = "Inventor 3Dツール"
APP_ID = "Inventor3DTool"


def rust_const(name: str) -> str:
    """desktop/src の Rust の定数（pub const NAME: &str = "…";）"""
    for path in (DESKTOP / "src").glob("*.rs"):
        m = re.search(rf'const {name}: &str = "([^"]*)";', path.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    raise AssertionError(f"{name} が desktop/src にありません")


class Layout(unittest.TestCase):
    def test_top_level_has_only_the_exe_as_an_entry(self):
        top = {p.name for p in REPO.iterdir() if p.is_file()}
        self.assertEqual([n for n in top if n.endswith((".py", ".bat", ".cmd", ".vbs"))], [], "最上位に .py・.bat・.vbs を置かない")
        self.assertEqual([n for n in top if n.endswith(".exe")], [EXE] if EXE in top else [], "入口は 1 つ（CI が置く）")
        self.assertFalse((tests.ROOT / "requirements.txt").exists(), "アプリを動かすのに Python のライブラリは要らない（作る係の分は ipt_build の中）")

    def test_names_agree_across_the_window_the_page_and_the_workflow(self):
        cargo = (DESKTOP / "Cargo.toml").read_text(encoding="utf-8")
        conf = json.loads((DESKTOP / "tauri.conf.json").read_text(encoding="utf-8"))
        self.assertIn('name = "Inventor3DTool"', cargo, "exe の名前")
        self.assertEqual(conf["mainBinaryName"] + ".exe", EXE)
        self.assertEqual((conf["productName"], rust_const("APP_NAME")), (APP_NAME, APP_NAME), "窓の題・保存先のフォルダ名")
        self.assertEqual(rust_const("APP_ID"), APP_ID, "作業場所（%LOCALAPPDATA%）のフォルダ名")
        version = re.search(r'^version = "([^"]+)"', cargo, re.M).group(1)
        self.assertEqual(conf["version"], version, "版は Cargo.toml と tauri.conf.json で同じ")
        product = (tests.ROOT / "app" / "static" / "js" / "ui" / "product.js").read_text(encoding="utf-8")
        self.assertIn(f'export const LAUNCHER = "{EXE}";', product, "画面の案内の exe の名前")
        page = (tests.ROOT / "app" / "index.html").read_text(encoding="utf-8")
        self.assertIn(f"<title>{APP_NAME}</title>", page)
        workflow = (REPO / ".github" / "workflows" / "desktop.yml").read_text(encoding="utf-8")
        self.assertIn(f"built/{EXE}", workflow, "CI が置く exe の名前")
        self.assertIn(f"{EXE} program/{APP_ID}.build.json", workflow.replace("'", ""), "CI は exe を最上位、作った元の控えを program に置く")

    def test_the_distribution_is_minimal_and_released_by_ci(self):
        """配る物（desktop/src/update.rs の PAYLOAD）は exe・README と、program の中で動かすのに要る物だけ。CI は配る ZIP を --pack で作り、
        版ごとに Releases へ置く（main へ入れる準備: CLAUDE.md）"""
        source = (DESKTOP / "src" / "update.rs").read_text(encoding="utf-8")
        payload = re.findall(r'"([^"]+)"', re.search(r"pub const PAYLOAD: \[&str; \d+\] =\s*\[(.*?)\];", source, re.S).group(1))
        self.assertEqual(set(payload) - {"EXE"}, {"README.md", "program/version.json", f"program/{APP_ID}.build.json", "program/app", "program/ipt_build"})
        for unit in payload:
            self.assertTrue((REPO / unit).exists(), unit)
        for heavy in ("program/samples", "program/tests", "program/tools", "program/config"):
            self.assertNotIn(heavy, payload, "サンプル・試験・道具・この PC の設定は配らない")
        workflow = (REPO / ".github" / "workflows" / "desktop.yml").read_text(encoding="utf-8")
        self.assertIn("'--pack'", workflow, "CI が配る ZIP を作る")
        self.assertIn('gh release create "v$ver"', workflow, "配る ZIP を版ごとに Releases へ置く")

    def test_the_app_version_is_readable_by_the_window(self):
        """版の管理（desktop/src/update.rs）は program/version.json の version で版を見分ける（ZIP から置く・各 PC がそろえる）"""
        import json
        version = json.loads((tests.ROOT / "version.json").read_text(encoding="utf-8"))["version"]
        self.assertRegex(version, r"^[0-9][0-9A-Za-z.\-]{0,40}$", "フォルダの名前にできる版の番号")
        self.assertEqual(rust_const("VERSION_FILE"), "program/version.json")
        update_rs = (DESKTOP / "src" / "update.rs").read_text(encoding="utf-8")
        self.assertIn('DEFAULT_DIR: &str = r"C:\\boxdrive\\Box\\', update_rs, "既定の置き場は Box Drive（利用者の指定）")

    def test_page_has_one_token_slot_and_plain_paths(self):
        page = (tests.ROOT / "app" / "index.html").read_text(encoding="utf-8")
        self.assertEqual(page.count("{{ token }}"), 1, "合言葉の差し込み口（desktop/src/router.rs の index）")
        self.assertIn('<meta name="app-token" content="{{ token }}">', page)
        self.assertNotIn("{%", page, "テンプレートの書き方は使わない（窓が置き換えるのは合言葉だけ）")
        self.assertEqual(re.findall(r"\{\{[^}]*\}\}", page), ["{{ token }}"])
        for src in re.findall(r'(?:src|href)="(/static/[^"]+)"', page):
            self.assertTrue((tests.ROOT / "app" / src.lstrip("/")).is_file(), src)
        self.assertIn('"/static/vendor/three/three.module.min.js"', page, "ライブラリは同梱を読む")

    def test_the_window_scheme_is_used_by_the_selftest_and_the_page(self):
        scheme = rust_const("SCHEME")
        self.assertEqual(scheme, "inventor")
        main = (DESKTOP / "src" / "main.rs").read_text(encoding="utf-8")
        self.assertIn(f'"http://{scheme}.localhost"', main, "Windows（WebView2）の置き場")
        launch = re.search(r'LAUNCH_EVENT_JS: &str = "([^"]+)"', main).group(1)
        event = re.search(r"new Event\('([^']+)'\)", launch).group(1)
        desktop_js = (tests.ROOT / "app" / "static" / "js" / "desktop.js").read_text(encoding="utf-8")
        self.assertIn(f'addEventListener("{event}"', desktop_js, "2 つめの起動の知らせを画面が聞く")

    def test_builder_answers_in_the_shape_the_window_reads(self):
        """窓（desktop/src/jobs.rs）は作る係の 1 行の JSON（--check・--libraries）を読む。形がずれると作り始められない。"""
        spec = tests.ROOT / "tests" / "fixtures" / "builder" / "finger.inventor.json"
        env_cmd = [sys.executable, "-X", "utf8", "-m", "ipt_build"]
        run = lambda *args: subprocess.run([*env_cmd, *args], cwd=tests.ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)  # noqa: E731
        checked = run(str(spec), "--check", "--step-only")
        answer = json.loads(checked.stdout.strip().splitlines()[-1])
        self.assertEqual((checked.returncode, answer["event"], answer["ok"], answer["name"]), (0, "check", True, "LS4_parts_viewer"))
        self.assertEqual(set(answer["status"]), {"out_dir", "parts", "assembly", "step", "inventor", "inventor_error", "good", "total"})
        self.assertFalse(answer["status"]["inventor"], "STEP だけ")
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text('{"format": "other"}', encoding="utf-8")
            refused = run(str(bad), "--check")
        answer = json.loads(refused.stdout.strip().splitlines()[-1])
        self.assertEqual((refused.returncode, answer["event"], answer["ok"]), (2, "check", False))
        self.assertTrue(answer["message"])
        libraries = json.loads(run("--libraries").stdout.strip().splitlines()[-1])
        self.assertEqual(libraries["event"], "libraries")
        self.assertIsInstance(libraries["ready"], bool)

    def test_requirements_are_named(self):
        path = tests.ROOT / "ipt_build" / "requirements.txt"
        names = [re.match(r"[A-Za-z0-9_.-]+", line).group(0) for line in path.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]
        self.assertEqual(names, ["pywin32"], "Inventor の操作に使うライブラリ（窓が pip で入れる）")


if __name__ == "__main__":
    unittest.main()
