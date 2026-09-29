"""使い方（Windows、Inventor をインストールした PC）:

    python -m ipt_build 変換データ.inventor.json              部品（と組立）を作る
    python -m ipt_build 変換データ.inventor.json --dry-run    Inventor を使わずに作成計画と期待値を確かめる

オプション:
    --out DIR        保存先（既定: 変換データと同じ場所の「<名前>_ipt」フォルダ）
    --only KEY ...   指定した部品だけ作る（例: --only p01 p03）
    --no-assembly    組立（.iam）を作らない
    --template FILE  部品のテンプレート（.ipt）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .spec import SpecError, load_spec, part_properties

REPORT = "build-report.json"


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:+.4f}%"


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
    from .inventor import Builder, connect  # noqa: PLC0415 — Windows でだけ読み込む

    parts = [p for p in spec.parts if not only or p.key in only]
    out_dir.mkdir(parents=True, exist_ok=True)
    print("Inventor に接続しています…")
    app = connect()
    builder = Builder(app, part_template=template)
    screen, silent = app.ScreenUpdating, app.SilentOperation
    app.ScreenUpdating, app.SilentOperation = False, True
    results = []
    try:
        print(f"部品 {len(parts)} 種類を作ります（保存先: {out_dir}）")
        for p in parts:
            r = builder.build_part(p, out_dir)
            results.append(r)
            verdict = "一致" if r.ok else ("失敗" if r.error else "不一致")
            detail = r.error or f"体積 {_pct(r.volume_diff)}  表面積 {_pct(r.area_diff)}  {r.file_detail}"
            print(f"  {verdict}  {p.key}  {p.name}  {detail}", flush=True)
        placed, asm_error, asm_path = 0, None, None
        if assembly and sum(len(r.part.instances) for r in results if r.path) > 1:
            asm_path = out_dir / f"{Path(spec.source.get('file', 'assembly')).stem}.iam"
            placed, asm_error = builder.build_assembly(results, asm_path)
            print(f"組立: {asm_path.name}（配置 {placed} か所）" + (f"  失敗: {asm_error}" if asm_error else ""))
    finally:
        app.ScreenUpdating, app.SilentOperation = screen, silent

    report = {
        "source": spec.source,
        "parts": [
            {
                "key": r.part.key, "name": r.part.name, "file": r.path.name if r.path else None,
                "ok": r.ok, "error": r.error,
                "volume": {"expect": r.part.expect_volume, "inventor": r.volume, "diff": r.volume_diff},
                "area": {"expect": r.part.expect_area, "inventor": r.area, "diff": r.area_diff},
                "file_check": {"ok": r.file_check, "detail": r.file_detail},
                "instances": len(r.part.instances), "notes": r.notes,
            }
            for r in results
        ],
        "assembly": {"file": asm_path.name if asm_path else None, "placed": placed, "error": asm_error},
        "skipped": list(spec.skipped),
    }
    (out_dir / REPORT).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    good = sum(r.ok for r in results)
    print(f"結果: 一致 {good} / {len(results)}（詳細は {out_dir / REPORT}）")
    return 0 if good == len(results) and not asm_error else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ipt_build", description="変換データ（JSON）から Inventor の部品・組立を作る")
    parser.add_argument("spec", type=Path, help="アプリで保存した変換データ（.inventor.json）")
    parser.add_argument("--out", type=Path, help="保存先フォルダ")
    parser.add_argument("--only", nargs="+", default=[], metavar="KEY", help="作る部品のキー（p01 など）")
    parser.add_argument("--no-assembly", action="store_true", help="組立（.iam）を作らない")
    parser.add_argument("--template", help="部品のテンプレート（.ipt）")
    parser.add_argument("--dry-run", action="store_true", help="Inventor を使わずに作成計画と期待値を確かめる")
    args = parser.parse_args(argv)
    try:
        spec = load_spec(args.spec)
    except SpecError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 2
    if args.dry_run:
        return dry_run(spec)
    out_dir = args.out or args.spec.with_name(args.spec.name.split(".")[0] + "_ipt")
    try:
        return build(spec, out_dir, set(args.only), not args.no_assembly, args.template)
    except RuntimeError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
