"""評価（Python）: Inventor で部品を作るビルダー（ipt_build）。

ビルダーは配布フォルダ（アプリ本体）にあるので、各テストはこのパッケージを先に読み込み、そこを import できるようにする。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "Inventor3Dツール" / "アプリ本体"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
