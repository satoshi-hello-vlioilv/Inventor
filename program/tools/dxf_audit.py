"""DXF の書き出しを、別の読み取り（ezdxf）で確かめる（開発用）。

    python program/tools/dxf_audit.py 置き場か .dxf …

dxf-write-check.mjs の --out に書いた DXF を、ezdxf が読めるか・検査（audit）で誤りが無いかを見る。
図形の種類ごとの数（モデルと全てのレイアウトとブロックの中）も出すので、アプリの読み取りの数と突き合わせられる。
ezdxf（MIT）は開発の道具としてだけ使う（アプリには入れない）。
"""

import sys
from collections import Counter
from pathlib import Path

import ezdxf
from ezdxf import recover


def check(path: Path) -> bool:
    try:
        doc = ezdxf.readfile(path)  # 厳しく読む（壊れていれば例外）
    except Exception as error:  # noqa: BLE001 - 何が起きても理由を出して次へ
        try:
            doc, auditor = recover.readfile(path)
            print(f"{path.name}  厳しくは読めない（{error}）・直して読むと 誤り {len(auditor.errors)}・直したこと {len(auditor.fixes)}")
        except Exception as again:  # noqa: BLE001
            print(f"{path.name}  読めない: {again}")
        return False
    auditor = doc.audit()
    kinds = Counter(e.dxftype() for layout in doc.layouts for e in layout)
    kinds.update(e.dxftype() for block in doc.blocks if not block.is_any_layout for e in block)
    ok = not auditor.errors and not auditor.fixes
    print(f"{path.name}  {doc.dxfversion}  誤り {len(auditor.errors)}・直したこと {len(auditor.fixes)}  図形 {sum(kinds.values())}"
          f"（{'・'.join(f'{k} {n}' for k, n in sorted(kinds.items()))}）")
    for entry in [*auditor.errors, *auditor.fixes][:8]:
        print(f"  {entry.message}")
    return ok


def main(args: list[str]) -> int:
    files = [f for a in args for f in (sorted(Path(a).glob("*.dxf")) if Path(a).is_dir() else [Path(a)])]
    good = sum(check(f) for f in files)
    print(f"\n合計: {len(files)} のうち {good} が誤り・直したこと 0")
    return 0 if good == len(files) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
