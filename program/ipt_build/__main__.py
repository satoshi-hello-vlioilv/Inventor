"""使い方:

    ふだんはアプリの「STEP を作る」「Inventor で作る」から使う（アプリのサーバーが --events で実行し、進み具合を画面に出す）。
    コマンドで使うときは program フォルダで:

    python -m ipt_build 変換データ.inventor.json              STEP と、Inventor で部品（と組立）を作る（Inventor のある Windows）
    python -m ipt_build 変換データ.inventor.json --step-only  STEP だけ作る（Inventor を使わない。どの OS でも可）
    python -m ipt_build 変換データ.inventor.json --dry-run    何も作らずに作成計画と期待値を確かめる

オプション:
    --out DIR        保存先（既定: 変換データと同じ場所の「<名前>_cad」フォルダ）
    --step-only      STEP だけ作る（Inventor を使わない）
    --only KEY ...   指定した部品だけ作る（例: --only p01 p03）
    --no-assembly    組立（.iam）を作らない
    --template FILE  部品のテンプレート（.ipt）
    --events         進み具合を 1 行 1 つの JSON で知らせる（アプリのサーバーが読む。{"event": …, 進み具合}）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import runner
from .runner import REPORT
from .spec import SpecError, load_spec, part_properties


def dry_run(spec) -> int:
    """作成計画を表示し、期待値を Python でも計算し直してアプリの値と照合する。
    期待値は小数 6 桁で保存されているので、その丸め幅（1e-6）と計算誤差（相対 1e-9）までを一致とみなす。"""
    mismatches = 0
    print(f"部品 {len(spec.parts)} 種類・配置 {sum(len(p.instances) for p in spec.parts)} か所（Inventor は使いません）")
    for p in spec.parts:
        volume, area = part_properties(p)
        mismatches += any(abs(a - b) > 1e-6 + 1e-9 * abs(b) for a, b in ((volume, p.expect_volume), (area, p.expect_area)))
        extent = f"{p.angle_deg:g}°" if p.kind == "revolve" else f"{p.distance:g} mm" if p.kind == "extrude" else f"三角形 {len(p.mesh.triangles)}"
        print(f"  {p.key}  {p.name}  [{p.kind} {extent}]  体積 {p.expect_volume:,.3f} mm³  表面積 {p.expect_area:,.3f} mm²  ×{len(p.instances)}")
    for s in spec.skipped:
        print(f"  作らない: {s.get('reason')}（{s.get('count')} 個）")
    print(f"期待値の再計算（Python）とアプリの値: {'一致' if not mismatches else f'{mismatches} 種類が不一致'}")
    return 0 if not mismatches else 1


def print_progress(event, run, result=None):
    """黒い画面に 1 行ずつ表示する。"""
    if event == "step":
        if run.step_error:
            print(run.step_error)
        else:
            faceted = [p for p in run.step.parts if p.how == "faceted"]
            print(f"STEP: {run.step.path}（部品 {len(run.step.parts)} 種類・配置 {run.step.placed} か所" +
                  (f"。うち {len(faceted)} 種類は三角形の面）" if faceted else "）"), flush=True)
    elif event == "connecting":
        print("Inventor に接続しています…")
    elif event == "start":
        print(f"部品 {len(run.parts)} 種類を作ります（保存先: {run.out_dir}）")
    elif event == "part":
        verdict = {"ok": "一致", "mismatch": "不一致", "failed": "失敗"}[runner.verdict(result)]
        detail = result.error or f"体積 {runner.pct(result.volume_diff)}  表面積 {runner.pct(result.area_diff)}  {result.extent_detail}"
        print(f"  {verdict}  {result.part.key}  {result.part.name}  {detail}", flush=True)
    elif event == "done":
        if run.inventor_error:
            print(f"Inventor では作れませんでした: {run.inventor_error}")
        if not run.inventor:
            return
        if run.assembly_path:
            print(f"組立: {run.assembly_path.name}（配置 {run.placed} か所）" + (f"  失敗: {run.assembly_error}" if run.assembly_error else ""))
        print(f"結果: 一致 {run.good} / {len(run.results)}（詳細は {run.out_dir / REPORT}）")


def emit(event: str, **data) -> None:
    """1 行 1 つの JSON（ASCII だけで書く: 受け取る側の文字コードの設定に左右されない）。"""
    print(json.dumps({"event": event, **data}), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ipt_build", description="変換データ（JSON）から Inventor の部品・組立を作る")
    parser.add_argument("spec", type=Path, help="アプリで保存した変換データ（.inventor.json）")
    parser.add_argument("--out", type=Path, help="保存先フォルダ")
    parser.add_argument("--only", nargs="+", default=[], metavar="KEY", help="作る部品のキー（p01 など）")
    parser.add_argument("--no-assembly", action="store_true", help="組立（.iam）を作らない")
    parser.add_argument("--template", help="部品のテンプレート（.ipt）")
    parser.add_argument("--dry-run", action="store_true", help="何も作らずに作成計画と期待値を確かめる")
    parser.add_argument("--step-only", action="store_true", help="STEP だけ作る（Inventor を使わない）")
    parser.add_argument("--events", action="store_true", help="進み具合を 1 行 1 つの JSON で知らせる（アプリが使う）")
    args = parser.parse_args(argv)
    try:
        spec = load_spec(args.spec)
    except SpecError as error:
        if args.events:
            emit("error", message=str(error))
        else:
            print(f"エラー: {error}", file=sys.stderr)
        return 2
    if args.dry_run:
        return dry_run(spec)
    out_dir = args.out or runner.default_out_dir(args.spec)
    progress = (lambda event, run, result=None: emit(event, **run.status())) if args.events else print_progress
    try:
        run = runner.build(spec, out_dir, set(args.only), not args.no_assembly, args.template, progress, inventor=not args.step_only)
    except Exception as error:  # noqa: BLE001 — 接続できない・保存できないなど。理由を知らせる（Inventor の例外は COM の説明を取り出す）
        from .inventor import com_error_text  # noqa: PLC0415

        if args.events:
            emit("error", message=com_error_text(error))
        else:
            print(f"エラー: {com_error_text(error)}", file=sys.stderr)
        return 2
    return 0 if run.ok else 1


if __name__ == "__main__":
    sys.exit(main())
