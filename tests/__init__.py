"""評価（Python）: Inventor で部品を作るビルダー（builder/ipt_build）。

各テストはこのパッケージを先に読み込み、builder/ の ipt_build を import できるようにする。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER_DIR = ROOT / "builder"

if str(BUILDER_DIR) not in sys.path:
    sys.path.insert(0, str(BUILDER_DIR))
