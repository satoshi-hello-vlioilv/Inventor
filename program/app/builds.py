# -*- coding: utf-8 -*-
"""「Inventor で作る」の仕事（1 度に 1 つ。Inventor は 1 つなので、同時には作らない）。Flask に頼らない。

    1. 変換データを確かめる（ipt_build.parse_spec。作れない内容なら、理由を返して始めない）
    2. 保存先「<出力先>/<名前>_ipt」を作り（同じ名前があれば「 (2)」…。前の結果を上書きしない）、変換データの写しを置く
    3. 必要なら、Inventor の操作に使うライブラリ（pywin32）を入れる（pip。別のプロセス）
    4. 別のプロセスで  python -m ipt_build <写し> --out <保存先> --events  を動かし、1 行ずつの進み具合を読む

別のプロセスで作るのは、入れたばかりのライブラリを読めるようにするため（Python の起動時に読む設定がある）と、
Inventor（COM）の不調でサーバーを巻き込まないため。進み具合の形は ipt_build.runner の BuildRun.status()。
"""
from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable

import settings
from ipt_build import libraries, parse_spec
from ipt_build.runner import BuildRun
from ipt_build.spec import SpecError

RUNNING = ("installing", "connecting", "building", "assembly")
STATE_OF = {"connecting": "connecting", "start": "building", "part": "building", "assembly": "assembly", "done": "done"}  # 作る係の知らせ → 状態
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')  # Windows のファイル名に使えない文字


class BuildBusy(RuntimeError):
    pass


def safe_name(text: str) -> str:
    return UNSAFE.sub("_", text).strip(" .") or "変換データ"


def unique_dir(path: Path) -> Path:
    """まだ無いフォルダの名前（在れば「 (2)」「 (3)」…を付ける）。"""
    n = 1
    candidate = path
    while candidate.exists():
        n += 1
        candidate = path.with_name(f"{path.name} ({n})")
    return candidate


def open_folder(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))  # noqa: S606 — エクスプローラーで開く
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Builds:
    def __init__(self, root: Path, command: Callable[[list], list] | None = None, install: Callable[[], list] | None = None,
                 opener: Callable[[Path], None] = open_folder):
        self.root = Path(root)
        self.command = command or (lambda args: [sys.executable, "-X", "utf8", "-m", "ipt_build", *args])
        self.install_command = install or libraries.install_command
        self.opener = opener
        self.console = settings.LOG_DIR / "builder_console.log"  # 作る係のエラー出力（途中で終わったときの理由）
        self._lock = threading.Lock()
        self._job: dict = {"state": "idle"}
        self._proc: subprocess.Popen | None = None
        self._cancelled = False
        self._done = False  # 作る係が「終わった」と知らせたか
        self._error: str | None = None  # 作る係が知らせた、作れなかった理由

    # ---- 状態 ----------------------------------------------------------------------------------
    def status(self) -> dict:
        with self._lock:
            return copy.deepcopy(self._job)

    def busy(self) -> bool:
        return self._job["state"] in RUNNING

    def _set(self, **changes) -> None:
        with self._lock:
            self._job.update(changes)

    # ---- 始める・止める ----------------------------------------------------------------------------
    def start(self, data: dict, install: bool = False) -> dict:
        """変換データ（JSON を読んだもの）から作り始める。作れない内容なら SpecError、作成中なら BuildBusy。"""
        spec = parse_spec(data)
        if not spec.parts:
            raise SpecError("作れる部品がありません（近似の部品だけでした）")
        with self._lock:
            if self._job["state"] in RUNNING:
                raise BuildBusy(f"「{self._job['name']}」を作っています。終わってから、もう一度押してください")
            name = safe_name(Path(str(spec.source.get("file") or "変換データ")).stem)
            out_dir = unique_dir(self.root / f"{name}_ipt")
            out_dir.mkdir(parents=True)
            spec_path = out_dir / f"{name}.inventor.json"
            spec_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            self._job = {"state": "installing" if install else "connecting", "name": name, "spec": str(spec_path),
                         "message": "", "detail": "", **BuildRun(spec, out_dir, list(spec.parts)).status()}
            self._cancelled = False
        threading.Thread(target=self._run, args=(spec_path, out_dir, install), name="inventor-build", daemon=True).start()
        return self.status()

    def cancel(self) -> dict:
        with self._lock:
            if self._job["state"] not in RUNNING:
                return copy.deepcopy(self._job)
            self._cancelled = True
            proc = self._proc
        if proc and proc.poll() is None:
            proc.terminate()
        return self.status()

    def open_output(self) -> bool:
        """いまの（直前の）仕事の保存先を開く。仕事の保存先のほかは開かない。"""
        out_dir = self._job.get("out_dir")
        if not out_dir or not Path(out_dir).is_dir():
            return False
        self.opener(Path(out_dir))
        return True

    # ---- 別のプロセス ------------------------------------------------------------------------------
    def _spawn(self, args: list, stdout) -> subprocess.Popen:
        with self._lock:
            if self._cancelled:
                raise InterruptedError
            self._proc = subprocess.Popen(args, cwd=str(settings.LOCAL_ROOT), env=settings.child_env(), stdin=subprocess.DEVNULL,
                                          stdout=subprocess.PIPE, stderr=stdout, text=True, encoding="utf-8", errors="replace",
                                          creationflags=CREATE_NO_WINDOW)
            return self._proc

    def _run(self, spec_path: Path, out_dir: Path, install: bool) -> None:
        """仕事の本体（別の糸）。終わりの状態（done・failed・cancelled）は、片付けまで済ませてから 1 度に出す
        （画面が「終わった」と読んだときには、保存先が決まっている）。"""
        self._done, self._error = False, None
        final = {"state": "failed", "message": "理由が分からないまま終わりました"}
        try:
            settings.LOCAL_ROOT.mkdir(parents=True, exist_ok=True)  # 作業フォルダ（program フォルダを「使用中」にしない）
            settings.LOG_DIR.mkdir(parents=True, exist_ok=True)
            if install:
                with self._spawn(self.install_command(), subprocess.STDOUT) as proc:
                    output = proc.communicate()[0]
                if self._cancelled:
                    raise InterruptedError
                if proc.returncode != 0:
                    final = {"state": "failed", "message": "Inventor の操作に使うライブラリを入れられませんでした", "detail": output[-1500:]}
                    return
                self._set(state="connecting")
            with self.console.open("w", encoding="utf-8") as errors, \
                    self._spawn(self.command([str(spec_path), "--out", str(out_dir), "--events"]), errors) as proc:
                for line in proc.stdout:
                    self._apply(line)
            if self._cancelled:
                raise InterruptedError
            if self._done:
                final = {"state": "done"}
            elif self._error is not None:
                final = {"state": "failed", "message": self._error}
            else:  # 「終わった」と知らせずに終わった（落ちた）
                tail = "\n".join(self.console.read_text(encoding="utf-8", errors="replace").splitlines()[-15:])
                final = {"state": "failed", "message": f"部品を作る係が途中で終わりました（終了コード {proc.returncode}）", "detail": tail}
        except InterruptedError:
            final = {"state": "cancelled", "message": "中止しました。Inventor に作りかけの部品が開いていれば、保存せずに閉じてください"}
        except Exception as error:  # noqa: BLE001 — 起こせなかった（Python が見つからないなど）
            final = {"state": "failed", "message": f"部品を作る係を起こせませんでした（{type(error).__name__}: {error}）"}
        finally:
            if final["state"] != "done" and self._tidy(out_dir, spec_path):
                final["out_dir"] = None
            self._set(**final)

    @staticmethod
    def _tidy(out_dir: Path, spec_path: Path) -> bool:
        """何も作れなかった試みの保存先を片付ける（自分が置いた変換データの写しだけのときに限る）。→ 片付けたか"""
        try:
            if [p.name for p in out_dir.iterdir()] != [spec_path.name]:
                return False
            spec_path.unlink()
            out_dir.rmdir()
            return True
        except OSError:
            return False

    def _apply(self, line: str) -> None:
        """作る係の 1 行（{"event": …, 進み具合}）を状態に当てる。JSON でない行は無視する。"""
        try:
            event = json.loads(line)
        except ValueError:
            return
        kind = event.pop("event", None)
        if kind == "error":
            self._error = str(event.get("message", ""))  # 終わりの状態は _run が片付けてから出す
        elif kind in STATE_OF:
            self._done = kind == "done"
            progress = {k: v for k, v in event.items() if k in ("out_dir", "parts", "assembly", "good", "total")}
            self._set(**progress, **({} if self._done else {"state": STATE_OF[kind]}))
