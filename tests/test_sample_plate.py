"""サンプル E_Plate_改_Φ54.5.ipt を使った解析器の評価。

期待値は Inventor 上のモデル（押し出し1 → 穴1 → フィレット1）と画面キャプチャから読み取れる寸法。
実行:  python -m unittest discover -s tests
"""
import unittest
from pathlib import Path

from ipt_inspect import build
from ipt_inspect.brep import SLOTS
from ipt_inspect.container import IptFile
from ipt_inspect.report import shapes

SAMPLE = Path(__file__).resolve().parents[1] / "E_Plate_改_Φ54.5.ipt"
TOL = 1e-6

# 参照スロット名 → 参照先として正しい型の判定
_EXPECTED_TARGET = {
    "next": lambda src, dst: dst == src,
    "prev": lambda src, dst: dst == "coedge",
    "partner": lambda src, dst: dst == "coedge",
    "lump": lambda src, dst: dst == "lump",
    "shell": lambda src, dst: dst == "shell",
    "face": lambda src, dst: dst == "face",
    "loop": lambda src, dst: dst == "loop",
    "coedge": lambda src, dst: dst == "coedge",
    "edge": lambda src, dst: dst == "edge",
    "start": lambda src, dst: dst == "vertex",
    "end": lambda src, dst: dst == "vertex",
    "point": lambda src, dst: dst == "point",
    "body": lambda src, dst: dst == "body",
    "surface": lambda src, dst: dst.endswith("-surface"),
    "curve": lambda src, dst: dst.endswith("-curve"),
    "attrib": lambda src, dst: dst.endswith("attrib"),
}


class SamplePlateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = build(SAMPLE)
        cls.shapes = {s["segment"]: s for s in cls.report["shapes"]}

    def assertVec(self, actual, expected):
        for a, e in zip(actual, expected, strict=True):
            self.assertAlmostEqual(a, e, delta=TOL)

    def solid(self):
        return self.shapes["PmBRepSegment"]["bodies"][0]

    def test_segments_are_decompressed(self):
        names = {s["name"] for s in self.report["segments"]}
        self.assertTrue(
            {"PmBRepSegment", "PmDCSegment", "PmGraphicsSegment", "PmBrowserSegment", "PmAppSegment"} <= names
        )
        for s in self.report["segments"]:
            self.assertTrue(s["compressed"], s["name"])

    def test_thumbnail(self):
        self.assertEqual((self.report["thumbnail"]["width"], self.report["thumbnail"]["height"]), (512, 512))

    def test_solid_outline(self):
        body = self.solid()
        self.assertTrue(body["closed"])
        self.assertEqual((body["faces"], body["edges"], body["vertices"]), (12, 28, 20))
        self.assertEqual(body["surfaces"], {"plane": 6, "cylinder": 6})
        self.assertVec(body["size"], (21.0, 2.0, 7.5))

    def test_holes(self):
        holes = [c for c in self.solid()["cylinders"] if c["kind"] == "hole"]
        self.assertEqual(len(holes), 2)
        for h in holes:
            self.assertAlmostEqual(h["diameter"], 4.5, delta=TOL)
            self.assertAlmostEqual(h["length"], 2.0, delta=TOL)  # 板厚と同じ = 貫通
            self.assertVec(h["axis"], (0.0, 1.0, 0.0))
        xs = sorted(h["center"][0] for h in holes)
        self.assertVec(xs, (4.0, 17.0))  # ピッチ 13 mm
        # 位相から求めた種数（貫通穴の数）と、形状認識した穴の数が一致すること
        self.assertEqual(self.solid()["genus"], len(holes))

    def test_rounds(self):
        rounds = [c for c in self.solid()["cylinders"] if c["kind"] == "round"]
        self.assertEqual(len(rounds), 4)
        for r in rounds:
            self.assertAlmostEqual(r["radius"], 3.5, delta=TOL)
            self.assertAlmostEqual(r["sweep_deg"], 90.0, delta=TOL)

    def test_extrude_profile_in_design_segment(self):
        sheet = self.shapes["PmDCSegment"]["bodies"][0]
        self.assertFalse(sheet["closed"])
        self.assertEqual(sheet["surfaces"], {"plane": 1})
        self.assertVec(sheet["size"], (21.0, 0.0, 7.5))

    def test_every_reference_points_to_expected_type(self):
        """SAB パーサの番号付け（履歴セクションの除外を含む）が正しいことの網羅検証。"""
        checked, unverified = 0, []
        for _, doc in shapes(IptFile(SAMPLE)):
            for e in doc.entities:
                for slot, ref in zip(SLOTS.get(e.type, ()), e.refs):
                    target = doc.get(ref)
                    if target is None:
                        continue
                    if slot not in _EXPECTED_TARGET:
                        unverified.append((e.index, e.type, slot, target.type))
                        continue
                    with self.subTest(entity=e.index, type=e.type, slot=slot, ref=ref):
                        self.assertTrue(_EXPECTED_TARGET[slot](e.type, target.type), target.type)
                    checked += 1
        self.assertGreater(checked, 0)
        self.assertEqual(unverified, [])


if __name__ == "__main__":
    unittest.main()
