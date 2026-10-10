"""部品と組立を作る一連の処理（STEP → Inventor への接続 → 部品ごとの作成と照合 → 組立 → 結果の保存）。

STEP（.stp）は Inventor を使わずに書く（step.py）。Inventor で作るとき（inventor=True）は、続けて .ipt・.iam を作る
（近似の部品は、その部品だけの STEP を Inventor で開いて .ipt にする。inventor.py）。
Inventor に接続できなくても STEP は残し、理由を inventor_error で知らせる。

表示の仕方とは切り離し、進み具合は progress（呼び出し側の関数）に知らせる。
    コマンド（__main__）          … 黒い画面に 1 行ずつ表示する
    コマンド（__main__ --events）  … 1 行 1 つの JSON（BuildRun.status()）で知らせる。アプリの「Inventor で作る」が読む
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
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
    inventor: bool = True  # Inventor で .ipt・.iam も作る（False なら STEP だけ）
    step: object = None  # StepResult（STEP を書いたら）
    step_error: str | None = None
    inventor_error: str | None = None  # Inventor に接続できない・作れない（STEP はできていることがある）

    @property
    def good(self) -> int:
        return sum(r.ok for r in self.results)

    @property
    def ok(self) -> bool:
        return not self.step_error and not self.inventor_error and self.good == len(self.results) and not self.assembly_error

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
                    "instances": len(r.part.instances), "notes": [*r.part.notes, *r.notes],
                    "parametric": r.parametric,  # 名前つきの値・拘束・寸法の数と、付けられなかったもの（版 4 の変換データ）
                }
                for r in self.results
            ],
            "assembly": {"file": self.assembly_path.name if self.assembly_path else None, "placed": self.placed, "error": self.assembly_error},
            "step": self._step_status(),
            "inventor_error": self.inventor_error,
            "skipped": list(self.spec.skipped),
        }

    def _step_status(self) -> dict | None:
        if self.step_error:
            return {"file": None, "error": self.step_error, "parts": []}
        if not self.step:
            return None
        return {
            "file": self.step.path.name, "error": None, "assembly": self.step.assembly, "placed": self.step.placed,
            "parts": [{"key": p.key, "how": p.how, "faces": p.faces, "note": p.note} for p in self.step.parts],
        }

    def status(self) -> dict:
        """いまの進み具合（アプリの画面が表示する形。まだ作っていない部品も含める）。"""
        done = {r.part.key: r for r in self.results}
        return {
            "out_dir": str(self.out_dir),
            "parts": [{"key": p.key, "name": p.name, "instances": len(p.instances), **_result_status(done.get(p.key))} for p in self.parts],
            "assembly": {"file": self.assembly_path.name, "placed": self.placed, "error": self.assembly_error} if self.assembly_path else None,
            "step": self._step_status(),
            "inventor": self.inventor,
            "inventor_error": self.inventor_error,
            "good": self.good,
            "total": len(self.parts),
        }


def verdict(result) -> str | None:
    """部品の結果の分類: ok（期待値と一致）・mismatch（不一致）・failed（作れなかった）。まだ作っていなければ None。"""
    if result is None:
        return None
    if result.error:
        return "failed"
    return "ok" if result.ok else "mismatch"


def _result_status(result) -> dict:
    return {
        "verdict": verdict(result),
        "file": result.path.name if result and result.path else None,
        "volume_diff": result.volume_diff if result else None,
        "area_diff": result.area_diff if result else None,
        "extent": result.extent_detail if result else "",
        "error": result.error if result else None,
    }


Progress = Callable[..., None]  # progress(event, run, **詳細)


def pct(value: float | None) -> str:
    """期待値との差（相対）を % で表す。表示の桁で 0 になる差は符号を付けない（「-0.0000%」を出さない）。"""
    if value is None:
        return "—"
    text = f"{value * 100:+.4f}%"
    return "0.0000%" if text in ("+0.0000%", "-0.0000%") else text


def build(spec, out_dir: Path, only: set[str] = frozenset(), assembly: bool = True, template: str | None = None,
          progress: Progress = lambda *a, **k: None, connect=None, inventor: bool = True, cancel=None) -> BuildRun:
    """STEP を書き、inventor なら部品と組立を作り、結果（build-report.json）を保存する。

    progress に知らせる出来事: "step"（STEP を書いた）→ "connecting" → "start" → "part"（部品ごと、result=…）
    → "assembly"（組立を作るとき）→ "done"。inventor=False なら "step" → "done"
    cancel … 中止の合図（threading.Event）。部品と部品の間で確かめ、立っていれば残りを作らずに片付けて終わる
    """
    from .spec import source_stem  # noqa: PLC0415
    from .step import write_step  # noqa: PLC0415

    parts = [p for p in spec.parts if not only or p.key in only]
    run = BuildRun(spec, out_dir, parts, inventor=inventor)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = source_stem(spec.source)
    try:
        run.step = write_step(replace(spec, parts=tuple(parts)), out_dir / f"{stem}.stp")
    except Exception as error:  # noqa: BLE001 — STEP を書けなくても、Inventor では作れることがある
        run.step_error = f"STEP を書けませんでした: {error}"
    progress("step", run)
    if inventor:
        try:
            _build_in_inventor(run, spec, stem, assembly, template, progress, connect, cancel)
        except Exception as error:  # noqa: BLE001 — 接続できない・保存できないなど。STEP は残す
            from .inventor import com_error_text  # noqa: PLC0415

            run.inventor_error = com_error_text(error)
    (out_dir / REPORT).write_text(json.dumps(run.report(), ensure_ascii=False, indent=1), encoding="utf-8")
    progress("done", run)
    return run


def _build_in_inventor(run: BuildRun, spec, stem: str, assembly: bool, template, progress: Progress, connect, cancel) -> None:
    from .inventor import Builder, quiet  # noqa: PLC0415 — Windows でだけ読み込む（Inventor に触れない評価では不要）
    from .inventor import connect as connect_inventor  # noqa: PLC0415

    out_dir = run.out_dir
    cancelled = cancel.is_set if cancel is not None else lambda: False
    progress("connecting", run)
    app = (connect or connect_inventor)()
    builder = Builder(app, part_template=template)
    with quiet(app):  # 作る間は画面の更新とダイアログを止める（終われば、中止しても、ふだんの状態に戻す）
        progress("start", run)
        for part in run.parts:
            if cancelled():
                return
            result = builder.build_part(part, out_dir)
            run.results.append(result)
            progress("part", run, result=result)
        if assembly and not cancelled() and sum(len(r.part.instances) for r in run.results if r.path) > 1:
            run.assembly_path = out_dir / f"{stem}.iam"
            progress("assembly", run)
            run.placed, run.assembly_error = builder.build_assembly(run.results, run.assembly_path)


def default_out_dir(spec_path: Path) -> Path:
    """既定の保存先: 変換データと同じ場所の「<名前>_cad」フォルダ。"""
    return spec_path.with_name(spec_path.name.split(".")[0] + "_cad")
