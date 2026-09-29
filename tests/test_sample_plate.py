"""サンプル samples/ipt/E_Plate_改_Φ54.5.ipt を使った解析器の評価。

期待値は Inventor 上のモデル（押し出し1 → 穴1 → フィレット1）と画面キャプチャから読み取れる寸法。
実行:  python -m unittest discover -s tests
"""
import json
import math
import unittest

from tests import PLATE, golden_path, sample_ipts
from ipt_inspect import build
from ipt_inspect.brep import SLOTS, Topology
from ipt_inspect.container import IptFile
from ipt_inspect.report import shapes
from ipt_inspect import scene

SAMPLE = PLATE
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

    def test_edge_polylines_follow_topology(self):
        """稜線の点列は始点→終点の順で頂点に一致し、ループ内でコエッジが途切れず閉じること（全サンプル）。"""
        for _, doc in (s for sample in sample_ipts() for s in shapes(IptFile(sample))):
            topo = Topology(doc)
            for body in topo.bodies():
                for face in topo.faces(body):
                    for loop in topo.loops(face):
                        runs = []
                        for coedge in topo.chain(topo.ref(loop, "coedge")):
                            e = topo.ref(coedge, "edge")
                            points = topo.edge(e).points
                            self.assertLess(math.dist(points[0], topo.vertex_point(topo.ref(e, "start"))), TOL)
                            self.assertLess(math.dist(points[-1], topo.vertex_point(topo.ref(e, "end"))), TOL)
                            runs.append(points[::-1] if coedge.bools[0] else points)
                        for run, following in zip(runs, runs[1:] + runs[:1]):
                            self.assertLess(math.dist(run[-1], following[0]), TOL)


class SceneExportTest(unittest.TestCase):
    """three.js ビューアへ渡すシーン JSON の評価。"""

    @classmethod
    def setUpClass(cls):
        cls.scene = scene.build(IptFile(SAMPLE))
        cls.body = cls.scene["bodies"][0]

    def test_every_face_is_renderable(self):
        self.assertEqual(len(self.body["faces"]), 12)
        self.assertEqual({f["type"] for f in self.body["faces"]}, {"plane", "cylinder"})
        self.assertEqual(len(self.body["edges"]), 28)

    def test_plane_normals_point_outward(self):
        # このプレートの平面はすべて外殻なので、法線は外接箱の中心から離れる向きになるはず
        center = [(lo + hi) / 2 for lo, hi in zip(self.body["summary"]["bbox_min"], self.body["summary"]["bbox_max"])]
        for f in (f for f in self.body["faces"] if f["type"] == "plane"):
            p = f["loops"][0][0]
            self.assertGreater(sum(n * (a - c) for n, a, c in zip(f["normal"], p, center)), 0, f["id"])

    def test_cylinder_loops_lie_on_surface(self):
        """円筒の境界ループは曲面の上にあり、穴は軸を 1 周するループ 2 本、角 R は 90° 分の 1 本で囲まれること。"""
        cylinders = [f for f in self.body["faces"] if f["type"] == "cylinder"]
        holes = [f for f in cylinders if not f["outward"]]
        rounds = [f for f in cylinders if f["outward"]]
        self.assertEqual((len(holes), len(rounds)), (2, 4))
        for f in cylinders:
            self.assertEqual(f["slope"], 0.0)
            for p in (p for loop in f["loops"] for p in loop):
                d = [a - o for a, o in zip(p, f["origin"])]
                h = sum(a * b for a, b in zip(d, f["axis"]))
                rho = math.dist(d, [h * a for a in f["axis"]])
                self.assertAlmostEqual(rho, f["radius"], delta=1e-4)
        self.assertEqual({len(f["loops"]) for f in holes}, {2})
        self.assertEqual({len(f["loops"]) for f in rounds}, {1})


class NewSamplesTest(unittest.TestCase):
    """円筒・円板のサンプル（ねじ・円錐・交線の B スプラインを含む）の評価。期待値はファイル名とサムネイルから読み取れること。"""

    def body(self, prefix: str) -> dict:
        sample = next(s for s in sample_ipts() if s.name.startswith(prefix))
        shape = next(s for s in build(sample)["shapes"] if s["segment"] == "PmBRepSegment")
        return shape["bodies"][0]

    def test_threads_from_face_attributes(self):
        expected = {"A1_": {"M4x0.7": 4, "M6x1": 2, "M8x1.25": 2}, "A3_": {"M4x0.7": 6, "M8x1.25": 2}, "B_": {"M4x0.7": 4, "M6x1": 2}}
        for prefix, counts in expected.items():
            with self.subTest(sample=prefix):
                threads = [c["thread"] for c in self.body(prefix)["cylinders"] if c["thread"]]
                tally = {}
                for t in threads:
                    tally[t["designation"]] = tally.get(t["designation"], 0) + 1
                    self.assertEqual((t["class"], t["type"]), ("6H", "ISO Metric profile"))
                self.assertEqual(tally, counts)
        both_ends = [c["thread"]["lengths"] for c in self.body("B_")["cylinders"] if c["thread"] and c["thread"]["designation"] == "M6x1"]
        self.assertEqual(both_ends, [[12.0, 12.0], [12.0, 12.0]])  # 両ネジ: 1 つの穴の両端に 12 mm ずつ

    def test_notched_outer_surface_is_one_diameter(self):
        """切り欠きで分断された外周 Φ54.5 は、角 R ではなく 1 つの外径（半周超）として示す。"""
        outer = [c for c in self.body("A1_")["cylinders"] if c["diameter"] == 54.5]
        self.assertEqual([(c["kind"], len(c["face_ids"])) for c in outer], [("boss", 2)])
        self.assertAlmostEqual(outer[0]["sweep_deg"], 269.889083, delta=1e-6)

    def test_drill_point_cones(self):
        cones = self.body("A1_")["cones"]
        self.assertEqual([round(c["angle_deg"]) for c in cones], [118, 118])
        self.assertTrue(all(c["concave"] for c in cones))

    def test_spline_edges_keep_the_outline(self):
        """交線（B スプライン）を折れ線にしても、外形は Φ54.5 × 77 の円筒に収まる（端点だけで表すと寸法が崩れる）。"""
        self.assertVec(self.body("A1_")["size"], (54.5, 54.5, 77.0))

    def test_text_report_shows_threads_and_cones(self):
        from ipt_inspect.report import format_text

        sample = next(s for s in sample_ipts() if s.name.startswith("A1_"))
        text = format_text(build(sample))
        self.assertIn("ねじ穴 M6x1 6H  ねじ長さ 12", text)
        self.assertIn("円錐    頂角 118°", text)

    def assertVec(self, actual, expected):
        for a, e in zip(actual, expected, strict=True):
            self.assertAlmostEqual(a, e, delta=TOL)

class GoldenFixtureTest(unittest.TestCase):
    def test_every_sample_has_a_fixture_matching_current_output(self):
        """samples/ipt の全ての .ipt について、JS 版の照合に使う正解データがあり、現在の Python 版の出力と一致すること。"""
        from tests import golden

        samples = sample_ipts()
        self.assertIn(PLATE, samples)
        for sample in samples:
            with self.subTest(sample=sample.name):
                path = golden_path(sample)
                self.assertTrue(path.exists(), f"{path.name} がありません。python -m tests.golden で作ってください")
                stored = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(stored, golden.expected(sample), "python -m tests.golden で更新してください")


if __name__ == "__main__":
    unittest.main()
