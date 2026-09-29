"""部品と組立を作る一連の処理（Inventor への接続 → 部品ごとの作成と照合 → 組立 → 結果の保存）。

表示の仕方とは切り離し、進み具合は progress（呼び出し側の関数）に知らせる。
    コマンド（__main__）… 黒い画面に 1 行ずつ表示する
    画面つき（gui）    … HTML のページに表示する（起動ファイルから使う）
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REPORT = "build-report.json"


@dataclass
class BuildRun:
    spec: object
    out_dir: Path
    parts: list  # 作る部品
    results: list = field(default_factory=list)  # PartResult
    placed: int = 0
    assembly_path: Path | None = None
    assembly_error: str | None = None

    @property
    def good(self) -> int:
        return sum(r.ok for r in self.results)

    @property
    def ok(self) -> bool:
        return self.good == len(self.results) and not self.assembly_error

    def report(self) -> dict:
        return {
            "source": self.spec.source,
            "parts": [
                {
                    "key": r.part.key, "name": r.part.name, "file": r.path.name if r.path else None,
                    "ok": r.ok, "error": r.error,
                    "volume": {"expect": r.part.expect_volume, "inventor": r.volume, "diff": r.volume_diff},
                    "area": {"expect": r.part.expect_area, "inventor": r.area, "diff": r.area_diff},
                    "extent": {"ok": r.extent_check, "detail": r.extent_detail},
                    "instances": len(r.part.instances), "notes": r.notes,
                }
                for r in self.results
            ],
            "assembly": {"file": self.assembly_path.name if self.assembly_path else None, "placed": self.placed, "error": self.assembly_error},
            "skipped": list(self.spec.skipped),
        }


Progress = Callable[..., None]  # progress(event, run, **詳細)


def pct(value: float | None) -> str:
    """期待値との差（相対）を % で表す。表示の桁で 0 になる差は符号を付けない（「-0.0000%」を出さない）。"""
    if value is None:
        return "—"
    text = f"{value * 100:+.4f}%"
    return "0.0000%" if text in ("+0.0000%", "-0.0000%") else text


def build(spec, out_dir: Path, only: set[str] = frozenset(), assembly: bool = True, template: str | None = None,
          progress: Progress = lambda *a, **k: None, connect=None) -> BuildRun:
    """部品と組立を作り、結果（build-report.json）を保存する。

    progress に知らせる出来事: "connecting" → "start" → "part"（部品ごと、result=…）→ "assembly"（組立を作るとき）→ "done"
    """
    from .inventor import Builder  # noqa: PLC0415 — Windows でだけ読み込む（Inventor に触れない評価では不要）
    from .inventor import connect as connect_inventor  # noqa: PLC0415

    run = BuildRun(spec, out_dir, [p for p in spec.parts if not only or p.key in only])
    out_dir.mkdir(parents=True, exist_ok=True)
    progress("connecting", run)
    app = (connect or connect_inventor)()
    builder = Builder(app, part_template=template)
    screen, silent = app.ScreenUpdating, app.SilentOperation
    app.ScreenUpdating, app.SilentOperation = False, True
    try:
        progress("start", run)
        for part in run.parts:
            result = builder.build_part(part, out_dir)
            run.results.append(result)
            progress("part", run, result=result)
        if assembly and sum(len(r.part.instances) for r in run.results if r.path) > 1:
            run.assembly_path = out_dir / f"{Path(spec.source.get('file', 'assembly')).stem}.iam"
            progress("assembly", run)
            run.placed, run.assembly_error = builder.build_assembly(run.results, run.assembly_path)
    finally:
        app.ScreenUpdating, app.SilentOperation = screen, silent
    (out_dir / REPORT).write_text(json.dumps(run.report(), ensure_ascii=False, indent=1), encoding="utf-8")
    progress("done", run)
    return run


def default_out_dir(spec_path: Path) -> Path:
    """既定の保存先: 変換データと同じ場所の「<名前>_ipt」フォルダ。"""
    return spec_path.with_name(spec_path.name.split(".")[0] + "_ipt")
