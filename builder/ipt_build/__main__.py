"""使い方（Windows、Inventor をインストールした PC）:

    起動ファイル（Inventor3Dツール.vbs）に変換データをドラッグ＆ドロップする（起動.bat が --gui で実行する）か、
    リポジトリの builder フォルダで:

    python -m ipt_build 変換データ.inventor.json              部品（と組立）を作る
    python -m ipt_build 変換データ.inventor.json --dry-run    Inventor を使わずに作成計画と期待値を確かめる

オプション:
    --out DIR        保存先（既定: 変換データと同じ場所の「<名前>_ipt」フォルダ）
    --only KEY ...   指定した部品だけ作る（例: --only p01 p03）
    --no-assembly    組立（.iam）を作らない
    --template FILE  部品のテンプレート（.ipt）
    --gui            画面つきで実行する（起動ファイルが使う）: 作る前にダイアログで確かめ、進み具合と結果を HTML のページで示す
"""
from __future__ import annotations

import argparse
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
        extent = f"{p.angle_deg:g}°" if p.kind == "revolve" else f"{p.distance:g} mm"
        print(f"  {p.key}  {p.name}  [{p.kind} {extent}]  体積 {p.expect_volume:,.3f} mm³  表面積 {p.expect_area:,.3f} mm²  ×{len(p.instances)}")
    for s in spec.skipped:
        print(f"  作らない: {s.get('reason')}（{s.get('count')} 個）")
    print(f"期待値の再計算（Python）とアプリの値: {'一致' if not mismatches else f'{mismatches} 種類が不一致'}")
    return 0 if not mismatches else 1


def build(spec, out_dir: Path, only: set[str], assembly: bool, template: str | None) -> int:
    """部品と組立を作り、黒い画面に 1 行ずつ結果を表示する。"""

    def progress(event, run, result=None):
        if event == "connecting":
            print("Inventor に接続しています…")
        elif event == "start":
            print(f"部品 {len(run.parts)} 種類を作ります（保存先: {run.out_dir}）")
        elif event == "part":
            verdict = "一致" if result.ok else ("失敗" if result.error else "不一致")
            detail = result.error or f"体積 {runner.pct(result.volume_diff)}  表面積 {runner.pct(result.area_diff)}  {result.extent_detail}"
            print(f"  {verdict}  {result.part.key}  {result.part.name}  {detail}", flush=True)
        elif event == "done":
            if run.assembly_path:
                print(f"組立: {run.assembly_path.name}（配置 {run.placed} か所）" + (f"  失敗: {run.assembly_error}" if run.assembly_error else ""))
            print(f"結果: 一致 {run.good} / {len(run.results)}（詳細は {run.out_dir / REPORT}）")

    run = runner.build(spec, out_dir, only, assembly, template, progress)
    return 0 if run.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ipt_build", description="変換データ（JSON）から Inventor の部品・組立を作る")
    parser.add_argument("spec", type=Path, help="アプリで保存した変換データ（.inventor.json）")
    parser.add_argument("--out", type=Path, help="保存先フォルダ")
    parser.add_argument("--only", nargs="+", default=[], metavar="KEY", help="作る部品のキー（p01 など）")
    parser.add_argument("--no-assembly", action="store_true", help="組立（.iam）を作らない")
    parser.add_argument("--template", help="部品のテンプレート（.ipt）")
    parser.add_argument("--dry-run", action="store_true", help="Inventor を使わずに作成計画と期待値を確かめる")
    parser.add_argument("--gui", action="store_true", help="画面つきで実行する（確認はダイアログ、進み具合と結果は HTML）")
    parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)  # --gui で、作る前の確認を省く（ライブラリを入れた後の再実行）
    args = parser.parse_args(argv)
    if args.gui:
        from . import gui  # noqa: PLC0415

        return gui.run(args.spec, confirmed=args.yes)
    try:
        spec = load_spec(args.spec)
    except SpecError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 2
    if args.dry_run:
        return dry_run(spec)
    out_dir = args.out or runner.default_out_dir(args.spec)
    try:
        return build(spec, out_dir, set(args.only), not args.no_assembly, args.template)
    except RuntimeError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
