# -*- coding: utf-8 -*-
"""起動の係（start_app.py から呼ぶ。Start.vbs が窓を出さずに起動する）。転写距離・ピッチ解析の launch_guard.py と同じ作り。

    Start.vbs [ドロップされたファイル…]  アプリで開く（.ipt・.iam・.stp・.html・変換データ .json。引数なしなら開くだけ）
        1. 受け取ったファイルを記録する（handoff.py。開いた画面が受け取る）
        2. 足りないライブラリ（requirements.txt。Flask）があれば、入れるかを尋ねる
        3. 起動画面（loading.html）を開く（Edge があればアドレスバーの無いアプリの窓で）。サーバーが答えると画面が切り替わる
        4. サーバーが動いていなければ起動し、答えるまで待つ（前の版・固まったサーバーは止めて起動し直す）

ダイアログ・ブラウザー・プロセスの起動は Env にまとめ、評価では差し替える。
"""
from __future__ import annotations

import ctypes
import hashlib
import importlib.util
import os
import re
import subprocess
import sys
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import handoff
import local_app
from settings import APP_ID, APP_NAME, BASE, LOCAL_ROOT, LOG_DIR, PORT, RUNTIME, URL, child_env

LOG = LOG_DIR / "launcher.log"
SERVER_CONSOLE = LOG_DIR / "server_console.log"  # サーバーの画面出力（起動の途中で落ちたときの Python のエラー）
REQUIREMENTS = BASE / "requirements.txt"
WAIT_SECONDS = 120
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED = (CREATE_NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | 0x00000008) if os.name == "nt" else 0
DIAG = os.environ.get("INVENTOR_TOOL_DIAG") == "1"  # 診断起動（start.bat）: 段階と失敗の理由をその窓に出す


def log(message: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
    except OSError:
        pass


def say(message: str) -> None:
    """診断起動の窓へ（通常の起動では何もしない）。"""
    if DIAG:
        print(message, flush=True)


def tail(path: Path, lines: int = 15) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


# ---- 利用者とのやりとり（Windows のメッセージボックス。黒い画面が無くても見える）------------------------
MB_OK, MB_YESNO, MB_ICONWARNING, MB_ICONQUESTION, MB_TOPMOST, IDYES = 0x0, 0x4, 0x30, 0x20, 0x40000, 6


def _message_box(text: str, flags: int) -> int:
    if os.name != "nt":
        print(text, flush=True)
        return 0
    return ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, flags | MB_TOPMOST)


def _ask(text: str) -> bool:
    return _message_box(text, MB_YESNO | MB_ICONQUESTION) == IDYES


def _tell(text: str) -> None:
    say(text)
    if not DIAG:  # 診断起動では窓に出したので、重ねて出さない
        _message_box(text, MB_OK | MB_ICONWARNING)


# ---- 足りないライブラリ ------------------------------------------------------------------------
def required_modules(path: Path = REQUIREMENTS) -> list[str]:
    """requirements.txt の名前（行頭の名前。-_ は _ に、小文字に）。答えは requirements.txt の 1 か所。"""
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z0-9_.-]+)", line.split("#", 1)[0])
        if m:
            names.append(m.group(1).lower().replace("-", "_"))
    return names


def missing_modules() -> list[str]:
    return [name for name in required_modules() if importlib.util.find_spec(name) is None]


def _install() -> tuple[bool, str]:
    done = subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)], capture_output=True, text=True,
                          errors="replace", creationflags=CREATE_NO_WINDOW)
    return done.returncode == 0, (done.stdout + done.stderr)[-1500:]


# ---- 起動画面 ----------------------------------------------------------------------------------
def loading_url() -> str:
    """起動画面の URL。ポートは #port= で渡す（画面の既定のポートと違う設定にしても、この画面は正しいポートを見る）。"""
    return (BASE / "loading.html").as_uri() + f"#port={PORT}"


def find_edge() -> str | None:
    """Microsoft Edge の場所（Windows の「App Paths」の登録）。無ければ None。"""
    if os.name != "nt":
        return None
    import winreg  # noqa: PLC0415

    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe") as key:
                path = winreg.QueryValue(key, None)
        except OSError:
            continue
        if path and Path(path).is_file():
            return path
    return None


def _open_page(url: str) -> str:
    """起動画面を開き、開き方を返す。Edge があれば、アドレスバーの無いアプリの窓（最大化）で開く。"""
    edge = find_edge()
    if edge:
        subprocess.Popen([edge, f"--app={url}", "--start-maximized"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "edge-app"
    return "webbrowser" if webbrowser.open(url) else "none"


# ---- サーバーのプロセス ------------------------------------------------------------------------
def _spawn_server() -> subprocess.Popen:
    """窓を出さずに起動する。作業フォルダは手元の作業場所（program フォルダを「使用中」にしない）。画面出力はファイルへ。"""
    LOCAL_ROOT.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with SERVER_CONSOLE.open("w", encoding="utf-8") as out:
        return subprocess.Popen([sys.executable, "-X", "utf8", str(BASE / "server.py")], cwd=str(LOCAL_ROOT), env=child_env(),
                                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, creationflags=DETACHED)


@dataclass
class Env:
    ask: Callable[[str], bool] = _ask
    tell: Callable[[str], None] = _tell
    missing: Callable[[], list] = missing_modules
    install: Callable[[], tuple] = _install
    open_page: Callable[[str], str] = _open_page
    spawn_server: Callable[[], object] = _spawn_server


# ---- サーバー ----------------------------------------------------------------------------------
def is_current(data) -> bool:
    """動いているサーバーが、このフォルダのいまのプログラムと同じか（app_build.py の指紋）。"""
    import app_build  # noqa: PLC0415

    return (bool(data) and str(data.get("app_path", "")).lower() == str(BASE).lower()
            and not data.get("stale") and data.get("build") == app_build.fingerprint(BASE))


def _mutex():
    """同じフォルダの起動の係が同時に 2 つサーバーを起こさないための印（Windows）。→ (handle, ほかが持っていたか)"""
    if os.name != "nt":
        return None, False
    name = f"Local\\{APP_ID}_" + hashlib.sha256(str(BASE).lower().encode("utf-8")).hexdigest()[:20]
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, name)
    return handle, ctypes.windll.kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS


def ensure_server(env: Env) -> int:
    """サーバーが答えるようにする。→ 終了コード（0: 答えた）"""
    handle, busy = _mutex()
    try:
        if busy:  # ほかの起動の係が起こしている。答えるのを待つだけ（開いた起動画面は、答えれば切り替わる）
            for _ in range(WAIT_SECONDS * 4):
                if is_current(local_app.instance()):
                    return 0
                time.sleep(0.25)
            return 2
        running = local_app.instance()
        if running is None and local_app.in_use():
            running = {}  # ポートは使われているのに、このアプリとして答えない（固まった・古い・ほかのアプリ）
        if is_current(running):
            log("EXISTING_INSTANCE")
            say("アプリはもう動いています。")
            return 0
        if running is not None:
            log(f"OLD_INSTANCE {running.get('version', '?')} {running.get('build', '?')} pid={running.get('pid')}")
            say("前に起動したアプリ（前の版・答えないもの）が残っているので止めます…")
            if not local_app.stop(lambda m: (log("STOP " + m), say("  " + m)), running):
                env.tell(f"ポート {PORT} をほかのプログラムが使っているため、起動できません。\n\n"
                         "前に起動したこのアプリなら program フォルダの stop.bat で止めてから、もう一度起動してください。"
                         "ほかのアプリなら、program\\config\\appsettings.json の port を別の番号に変えてください。")
                return 2
        proc = env.spawn_server()
        log(f"SERVER_SPAWN pid={proc.pid}")
        say(f"サーバーを起動しました（プロセス {proc.pid}）。準備ができるのを待っています…")
        started = time.perf_counter()
        for i in range(WAIT_SECONDS * 4):
            if is_current(local_app.instance()):
                log(f"SERVER_READY {time.perf_counter() - started:.2f}s")
                say(f"準備ができました（{time.perf_counter() - started:.1f} 秒）: {URL}")
                return 0
            code = proc.poll()
            if code is not None:
                log(f"SERVER_EARLY_EXIT code={code}")
                env.tell(f"アプリのサーバーが起動の途中で終了しました（終了コード {code}）。\n\n{tail(SERVER_CONSOLE)}\n\n記録: {LOG_DIR}")
                return 2
            if DIAG and i % 40 == 39:
                say(f"  まだ準備中です（{time.perf_counter() - started:.0f} 秒）…")
            time.sleep(0.25)
        log(f"SERVER_TIMEOUT {WAIT_SECONDS}s")
        say(f"{WAIT_SECONDS} 秒待っても準備ができませんでした。\n{tail(SERVER_CONSOLE)}")
        return 2
    finally:
        if handle:
            ctypes.windll.kernel32.ReleaseMutex(handle)
            ctypes.windll.kernel32.CloseHandle(handle)


# ---- 入口 --------------------------------------------------------------------------------------
def main(argv: list[str] | None = None, env: Env | None = None) -> int:
    env = env or Env()
    args = [Path(a) for a in (sys.argv[1:] if argv is None else argv)]
    log(f"START pid={os.getpid()} python={sys.executable} base={BASE} args={len(args)}")
    say(f"  Python: {sys.executable}\n  アプリ: {BASE}\n  記録: {LOG_DIR}")
    try:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        if args:
            handoff.record(args)  # 画面を開く前に書く（開いた画面が受け取る）
        missing = env.missing()
        if missing and not env.ask(f"{APP_NAME}を動かすための Python のライブラリ（{', '.join(missing)}）が入っていません。\n"
                                   "今入れますか？（インターネットから入れます。1 分ほどかかることがあります）"):
            log(f"MISSING {missing} declined")
            return 1
        method = env.open_page(loading_url())
        log(f"LOADING_PAGE {method}")
        if missing:
            say(f"ライブラリを入れています: {', '.join(missing)}")
            ok, output = env.install()
            log(f"INSTALL ok={ok}")
            if not ok:
                env.tell(f"ライブラリを入れられませんでした。\n\n{output}\n\nprogram フォルダの start.bat（診断起動）で詳しい状況を確かめられます。")
                return 2
        return ensure_server(env)
    except Exception as exc:  # noqa: BLE001 — 窓の無い起動なので、理由を必ず残して知らせる
        log(f"LAUNCH_ERROR {type(exc).__name__}: {exc}")
        env.tell(f"起動できませんでした（{type(exc).__name__}: {exc}）。\n\n記録: {LOG}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
