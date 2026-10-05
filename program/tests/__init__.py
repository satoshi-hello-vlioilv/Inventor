"""評価（Python）。program フォルダで:

    python -m unittest discover -s tests -t .

各テストはこのパッケージを先に読み込む。program フォルダを import の探索先に入れる。
窓（desktop/。Rust）の評価は desktop フォルダで cargo test（作る仕事・画面を配る・受け取ったファイル・孫まで止める）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # program フォルダ

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
