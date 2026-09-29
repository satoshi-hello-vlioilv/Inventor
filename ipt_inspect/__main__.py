"""使い方:  python -m ipt_inspect FILE.ipt [--json] [--dump DIR]"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import report
from .container import IptFile


def dump(ipt: IptFile, out: Path, result: dict) -> None:
    """展開済みセグメント・SAB ブロック・サムネイル・解析結果をファイルに書き出す。"""
    (out / "segments").mkdir(parents=True, exist_ok=True)
    for s in ipt.segments:
        (out / "segments" / f"{s.name}.bin").write_bytes(s.data)
        (out / "segments" / f"{s.name}.meta.bin").write_bytes(s.meta)
    for segment, doc in report.shapes(ipt):
        (out / f"{segment.name}@{doc.offset}.sab").write_bytes(segment.data[doc.offset : doc.end])
    if ipt.thumbnail:
        (out / "thumbnail.png").write_bytes(ipt.thumbnail)
    (out / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ipt_inspect", description="Autodesk Inventor .ipt の構造と形状を解析する")
    parser.add_argument("file", type=Path)
    parser.add_argument("--json", action="store_true", help="結果を JSON で出力する")
    parser.add_argument("--dump", type=Path, metavar="DIR", help="展開したセグメント等を DIR に書き出す")
    args = parser.parse_args(argv)

    ipt = IptFile(args.file)
    result = report.build(ipt)
    if args.dump:
        dump(ipt, args.dump, result)
    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(report.format_text(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
