"""画面つきの実行（起動ファイルが使う。黒い画面は出さない）。

    1. 変換データを読み、作る前にダイアログで確かめる（部品の数・保存先）
    2. Inventor の操作に使う pywin32 が無ければ、入れるかをダイアログで確かめ、入れてから続ける
    3. 進み具合と結果を、保存先の「作成結果.html」に書き、ブラウザーで開く（作成中は 2 秒ごとに自動で読み直す）

ダイアログ・ブラウザー・Inventor への接続などは Env にまとめ、評価では差し替える。
"""
from __future__ import annotations

import html
import importlib.util
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import runner
from .inventor import REL_TOL
from .spec import SpecError, load_spec
from .verify import BBOX_TOL

TITLE = "Inventor 部品の作成"
PAGE = "作成結果.html"
BUILDER_DIR = Path(__file__).resolve().parents[1]  # builder フォルダ（requirements.txt と ipt_build の置き場）


def _ask(title: str, message: str) -> bool:
    import tkinter as tk  # noqa: PLC0415
    from tkinter import messagebox  # noqa: PLC0415

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)  # 非表示で動くので、ダイアログを手前に出す
    try:
        return messagebox.askyesno(title, message, parent=root)
    finally:
        root.destroy()


def _install() -> tuple[bool, str]:
    done = subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(BUILDER_DIR / "requirements.txt")],
                          capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return done.returncode == 0, (done.stdout + done.stderr)[-2000:]


def _relaunch(spec_path: Path) -> int:
    """ライブラリを入れた後は、新しい Python で続きを実行する（入れたライブラリの読み込み設定を反映するため）。"""
    return subprocess.run([sys.executable, "-m", "ipt_build", "--gui", "--yes", str(spec_path)], cwd=BUILDER_DIR).returncode


@dataclass
class Env:
    ask: Callable[[str, str], bool] = _ask
    open_page: Callable[[str], object] = None  # URI を開く（既定: 既定のブラウザー）
    has_pywin32: Callable[[], bool] = lambda: importlib.util.find_spec("win32com") is not None
    install: Callable[[], tuple[bool, str]] = _install
    relaunch: Callable[[Path], int] = _relaunch
    connect: Callable | None = None  # Inventor への接続（既定: inventor.connect）

    def __post_init__(self):
        if self.open_page is None:
            import webbrowser  # noqa: PLC0415

            self.open_page = webbrowser.open


# ---- HTML のページ ------------------------------------------------------------------
# 色はビューアと同じ考え方: 青 = 操作・進行中、緑 = 一致、琥珀 = 注意（不一致）、赤 = 失敗
STYLE = """
:root { --bg:#e8ecf0; --panel:#f8fafc; --ink:#16202b; --muted:#566272; --rule:#cdd5de; --accent:#1a62c4; --accent-soft:rgba(26,98,196,.1);
  --ok:#23703a; --ok-soft:rgba(35,112,58,.1); --warn:#8a5a12; --warn-soft:rgba(211,168,103,.18); --bad:#b3261e; --bad-soft:rgba(179,38,30,.08);
  --font-ui:"Yu Gothic UI","Meiryo",system-ui,sans-serif; --font-num:"Cascadia Mono",Consolas,ui-monospace,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#141a21; --panel:#1a2129; --ink:#e5eaf0; --muted:#98a4b2; --rule:#2e3a47; --accent:#5e9dff;
  --accent-soft:rgba(94,157,255,.14); --ok:#6fcf8a; --ok-soft:rgba(111,207,138,.12); --warn:#e0b36e; --warn-soft:rgba(224,179,110,.12);
  --bad:#ff8a80; --bad-soft:rgba(255,138,128,.1); color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.6 var(--font-ui); }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 48px; display: flex; flex-direction: column; gap: 20px; }
.eyebrow, h2 { margin: 0; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; color: var(--muted); }
h1 { margin: 2px 0 0; font: 500 20px/1.4 var(--font-num); overflow-wrap: anywhere; }
.status { margin: 10px 0 0; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--tone); background: var(--tone-soft); font-weight: 600; }
[data-tone="run"] { --tone: var(--accent); --tone-soft: var(--accent-soft); }
[data-tone="ok"] { --tone: var(--ok); --tone-soft: var(--ok-soft); }
[data-tone="warn"] { --tone: var(--warn); --tone-soft: var(--warn-soft); }
[data-tone="bad"] { --tone: var(--bad); --tone-soft: var(--bad-soft); }
[data-tone="wait"] { --tone: var(--muted); --tone-soft: transparent; }
.bar { height: 6px; margin-top: 10px; border-radius: 3px; background: var(--rule); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.tile { padding: 10px 14px; border: 1px solid var(--rule); border-radius: 8px; background: var(--panel); }
.tile b { display: block; font: 500 20px/1.3 var(--font-num); font-variant-numeric: tabular-nums; }
.tile span { font-size: 12px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
th, td { padding: 8px 12px; border-bottom: 1px solid var(--rule); text-align: start; vertical-align: top; }
th { font-size: 12px; font-weight: 600; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
.num { text-align: end; font-family: var(--font-num); font-variant-numeric: tabular-nums; white-space: nowrap; }
.name { font-family: var(--font-num); overflow-wrap: anywhere; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--tone); color: var(--tone); background: var(--tone-soft); font-size: 12px; font-weight: 600; white-space: nowrap; }
.detail { display: block; margin-top: 2px; font-size: 12px; color: var(--muted); }
.error { color: var(--bad); }
pre { margin: 0; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--panel); font: 12px/1.5 var(--font-num); white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: var(--accent); }
.note { margin: 0; font-size: 12px; color: var(--muted); }
"""


def _verdict(result) -> tuple[str, str]:
    if result is None:
        return "wait", "待ち"
    if result.error:
        return "bad", "失敗"
    return ("ok", "一致") if result.ok else ("warn", "不一致")


def render(spec_path: Path, state: str, *, run=None, spec=None, message: str = "", detail: str = "") -> str:
    """ページの HTML。state: installing / connecting / building / done / error。"""
    e = html.escape
    running = state in ("installing", "connecting", "building")
    parts = run.parts if run else (list(spec.parts) if spec else [])
    results = {r.part.key: r for r in (run.results if run else [])}
    done = len(results)
    if state == "done":
        tone, status = ("ok", "すべての部品が期待値と一致しました") if run.ok else (
            "warn", f"一致しない部品があります（一致 {run.good} / {len(run.results)}）")
    elif state == "error":
        tone, status = "bad", f"作れませんでした: {message}"
    else:
        tone, status = "run", message or f"部品を作っています（{done} / {len(parts)}）"

    rows = []
    for p in parts:
        r = results.get(p.key)
        t, label = _verdict(r)
        if r is None and state == "building" and done == parts.index(p):
            t, label = "run", "作成中"
        note = f'<span class="detail error">{e(r.error)}</span>' if r and r.error else (
            f'<span class="detail">{e(r.extent_detail)}</span>' if r and r.extent_detail else "")
        rows.append(
            f'<tr><td class="name">{e(p.name)}{note}</td><td><span class="chip" data-tone="{t}">{label}</span></td>'
            f'<td class="num">{runner.pct(r.volume_diff) if r else "—"}</td><td class="num">{runner.pct(r.area_diff) if r else "—"}</td>'
            f'<td class="num">{len(p.instances)}</td></tr>')
    placed = sum(len(p.instances) for p in parts)
    counts = [(len(parts), "部品の種類"), (placed, "配置"), (sum(r.ok for r in results.values()), "一致"),
              (sum(1 for r in results.values() if not r.ok), "不一致・失敗")]
    out_dir = run.out_dir if run else runner.default_out_dir(spec_path)

    blocks = []
    if detail:
        blocks.append(f"<pre>{e(detail)}</pre>")
    if parts:
        tiles = "".join(f'<div class="tile"><b>{n}</b><span>{label}</span></div>' for n, label in counts)
        blocks.append(f'<div class="tiles">{tiles}</div>')
        head = '<tr><th>部品</th><th>結果</th><th class="num">体積の差</th><th class="num">表面積の差</th><th class="num">配置</th></tr>'
        blocks.append(f"<table><thead>{head}</thead><tbody>{''.join(rows)}</tbody></table>")
    if run and run.assembly_path:
        name = e(run.assembly_path.name)
        blocks.append(f'<p class="error">組立 {name}: {e(run.assembly_error)}</p>' if run.assembly_error
                      else f"<p>組立 {name}（配置 {run.placed} か所）</p>")
    report = f"（結果の詳細は {runner.REPORT}）" if state == "done" else ""
    blocks.append(f'<p>保存先: <a href="{e(out_dir.as_uri())}">{e(str(out_dir))}</a>{report}</p>')
    blocks.append(f'<p class="note">照合の基準: 体積・表面積は Inventor の計算値と変換データの期待値の差が相対 {REL_TOL * 100:g}% 以内、'
                  f"外形は Inventor が計算した外接箱と変換データの外接箱の差が {BBOX_TOL} mm 以内。</p>")
    refresh = '<meta http-equiv="refresh" content="2">\n' if running else ""
    bar = f'<div class="bar"><span style="width:{100 * done / max(len(parts), 1):.0f}%"></span></div>' if running and parts else ""
    body = "\n  ".join(blocks)
    return f"""<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{refresh}<title>{TITLE} – {e(spec_path.name)}</title>
<style>{STYLE}</style>
<main>
  <header>
    <p class="eyebrow">{TITLE}</p>
    <h1>{e(spec_path.name)}</h1>
    <p class="status" data-tone="{tone}" role="status">{e(status)}</p>
    {bar}
  </header>
  {body}
</main>
"""


class Page:
    """作成結果.html。ブラウザーが読み直す途中で壊れた内容を読まないよう、書き換えは置き換えで行う。"""

    def __init__(self, spec_path: Path, env: Env, opened: bool):
        self.path = runner.default_out_dir(spec_path) / PAGE  # フォルダは最初に書くときに作る（取りやめたら何も残さない）
        self.spec_path, self.env, self.opened = spec_path, env, opened

    def show(self, state: str, **kwargs) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:  # 書き込めない場所なら一時フォルダに置く
            self.path = Path(tempfile.gettempdir()) / "inventor-3d-tool" / self.path.name
            self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(render(self.spec_path, state, **kwargs), encoding="utf-8")
        os.replace(tmp, self.path)
        if not self.opened:
            self.env.open_page(self.path.as_uri())
            self.opened = True


def confirmation(spec, spec_path: Path) -> str:
    placed = sum(len(p.instances) for p in spec.parts)
    skipped = sum(s.get("count", 0) for s in spec.skipped)
    return (f"「{spec_path.name}」から、Inventor で部品を作ります。\n\n"
            f"部品 {len(spec.parts)} 種類・配置 {placed} か所" + ("（組立を 1 つ作ります）" if placed > 1 else "") + "\n"
            + (f"近似のため作らない部品: {skipped} 個\n" if skipped else "")
            + f"保存先: {runner.default_out_dir(spec_path)}\n\n"
            "Inventor が起動し、数分かかることがあります。作りますか？")


def run(spec_path: Path, confirmed: bool = False, env: Env | None = None) -> int:
    env = env or Env()
    spec_path = Path(spec_path).resolve()
    page = Page(spec_path, env, opened=confirmed)
    try:
        spec = load_spec(spec_path)
    except SpecError as error:
        page.show("error", message=str(error))
        return 2
    if not spec.parts:
        page.show("error", spec=spec, message="作れる部品がありません（近似の部品だけでした）")
        return 2
    if not confirmed and not env.ask(TITLE, confirmation(spec, spec_path)):
        return 1
    if not env.has_pywin32():
        if not env.ask(TITLE, "Inventor を操作するための Python のライブラリ（pywin32 など）が入っていません。\n"
                              "今入れますか？（インターネットから入れます。数分かかることがあります）"):
            return 1
        page.show("installing", spec=spec, message="必要なライブラリ（pywin32 など）を入れています…")
        ok, log = env.install()
        if not ok:
            page.show("error", spec=spec, message="ライブラリを入れられませんでした", detail=log)
            return 2
        return env.relaunch(spec_path)

    def progress(event, current, result=None):
        state = "connecting" if event == "connecting" else "done" if event == "done" else "building"
        message = {"connecting": "Inventor に接続しています…", "assembly": "組立を作っています…"}.get(event, "")
        page.show(state, run=current, message=message)

    try:
        result = runner.build(spec, runner.default_out_dir(spec_path), progress=progress, connect=env.connect)
    except Exception as error:  # noqa: BLE001 — 接続できない・保存できないなど。理由をページに示す
        from .inventor import com_error_text  # noqa: PLC0415

        page.show("error", spec=spec, message=com_error_text(error))
        return 2
    return 0 if result.ok else 1
