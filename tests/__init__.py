"""評価（Python）。

配布フォルダ（Inventor部品ビューア/アプリ本体）にある Python パッケージ（ipt_build・ipt_inspect）を import できるようにする。
各テストは ipt_build・ipt_inspect より先にこのパッケージを読み込む。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "Inventor部品ビューア" / "アプリ本体"
SAMPLES_IPT = ROOT / "samples" / "ipt"
GOLDEN_IPT = ROOT / "tests" / "fixtures" / "ipt"
PLATE = SAMPLES_IPT / "E_Plate_改_Φ54.5.ipt"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def sample_ipts() -> list[Path]:
    """samples/ipt に置いた全ての .ipt（名前順）。"""
    return sorted(SAMPLES_IPT.glob("*.ipt"))


def golden_path(sample: Path) -> Path:
    return GOLDEN_IPT / f"{sample.stem}.expected.json"
