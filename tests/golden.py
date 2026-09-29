"""Python 版の解析結果を「正解データ」として保存する。JS 版（app/）のテストはこれと照合する。

更新:  python -m tests.golden
"""
import json
from pathlib import Path

from ipt_inspect import report, scene
from ipt_inspect.container import IptFile

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "E_Plate_改_Φ54.5.ipt"
FIXTURE = ROOT / "tests" / "fixtures" / "E_Plate.expected.json"


def expected() -> dict:
    ipt = IptFile(SAMPLE)
    # JSON を 1 度往復させ、タプルなど Python 固有の型を JSON と同じ形に揃える
    return json.loads(json.dumps({"report": report.build(ipt), "scene": scene.build(ipt)}, ensure_ascii=False))


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(expected(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")
