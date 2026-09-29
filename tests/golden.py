"""Python 版の解析結果を「正解データ」として保存する。JS 版（app/）のテストはこれと照合する。

samples/ipt に置いた全ての .ipt について tests/fixtures/ipt/<名前>.expected.json を作る。
更新:  python -m tests.golden
"""
import json

from tests import ROOT, golden_path, sample_ipts
from ipt_inspect import report, scene
from ipt_inspect.container import IptFile


def expected(sample) -> dict:
    ipt = IptFile(sample)
    # JSON を 1 度往復させ、タプルなど Python 固有の型を JSON と同じ形に揃える
    return json.loads(json.dumps({"report": report.build(ipt), "scene": scene.build(ipt)}, ensure_ascii=False))


if __name__ == "__main__":
    for sample in sample_ipts():
        path = golden_path(sample)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(expected(sample), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)}")
