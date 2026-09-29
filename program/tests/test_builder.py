"""ビルダー（ipt_build）の評価。Inventor の代わりに fake_inventor を使う。

最も重要な確認は「ビルダーが描いた断面から（第 3 の方法で）求めた体積・表面積が、
アプリ（JS）が変換データに書いた期待値と一致すること」。単位・円弧の向き・端点の共有・回転／押し出しの
指定のどれかを誤ると一致しなくなる。
"""
import io
import json
import math
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests  # noqa: F401 — program フォルダの ipt_build を import できるようにする
from ipt_build import SpecError, load_spec
from ipt_build import inventor as inventor_module
from ipt_build.__main__ import main
from ipt_build.inventor import K_JOIN, K_SYMMETRIC, Builder
from tests.fake_inventor import FakeComError, FakeInventor

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "builder"
NAMES = ["spacer-t50", "finger", "blade", "reel", "plate-holes"]


def spec_of(name):
    return load_spec(FIXTURES / f"{name}.inventor.json")


class BuildPartsTest(unittest.TestCase):
    def build(self, name):
        app = FakeInventor()
        with tempfile.TemporaryDirectory() as tmp:
            results = [Builder(app).build_part(p, Path(tmp)) for p in spec_of(name).parts]
        return app, results

    def test_every_part_matches_expected_volume_and_area(self):
        for name in NAMES:
            with self.subTest(name=name):
                _, results = self.build(name)
                for r in results:
                    self.assertIsNone(r.error, f"{r.part.key}: {r.error}")
                    self.assertTrue(r.ok, f"{r.part.key}: 体積 {r.volume_diff:+.2e} / 表面積 {r.area_diff:+.2e}")

    def test_features_use_xy_sketch_y_axis_symmetric_extent_and_cm(self):
        app, results = self.build("reel")
        for doc, r in zip(app.documents, results):
            definition = doc.ComponentDefinition
            self.assertEqual([s.plane for s in definition.sketches], ["XY"])
            [entry] = definition.log
            part = r.part
            if part.kind == "extrude":
                self.assertEqual(entry, ("extrude", part.distance / 10, K_SYMMETRIC, K_JOIN))
            elif part.full_revolve:
                self.assertEqual(entry, ("revolve-full", "Y", K_JOIN))
            else:
                self.assertEqual(entry[:2], ("revolve-angle", "Y"))
                self.assertAlmostEqual(entry[2], math.radians(part.angle_deg), places=12)
                self.assertEqual(entry[3:], (K_SYMMETRIC, K_JOIN))
            self.assertTrue(doc.closed)
            self.assertTrue(doc.saved_as.endswith(f"{part.name}.ipt"))
            tracking = doc.properties["Design Tracking Properties"]
            self.assertEqual(tracking["Part Number"].Value, part.name)
            self.assertIn("three.js から変換", tracking["Description"].Value)

    def test_clockwise_arcs_are_joined_even_if_inventor_swaps_their_ends(self):
        # スペーサー T50 の逃がし溝は時計回りの円弧。代替オブジェクトは始点・終点を入れ替えて保持する
        _, [r] = self.build("spacer-t50")
        self.assertTrue(any(s.type == "arc" and not s.ccw for s in r.part.loops[0]))
        self.assertTrue(r.ok)

    def test_a_missing_unit_conversion_is_caught_by_the_check(self):
        # 評価関数の確認: 描くときの mm → cm の換算が抜けると、体積の照合で不一致になること
        with mock.patch.object(inventor_module, "cm", lambda v: v):
            _, results = self.build("finger")
        self.assertFalse(results[0].ok)
        self.assertAlmostEqual(results[0].volume_diff, 10**3 - 1, places=6)

    def test_every_part_extent_matches_the_conversion_data(self):
        # 外接箱の照合: 代替オブジェクトが断面の折れ線から求めた箱と、変換データから計算した箱が一致すること
        for name in NAMES:
            _, results = self.build(name)
            for r in results:
                with self.subTest(name=name, part=r.part.key):
                    self.assertIs(r.extent_check, True, r.extent_detail)

    def test_an_extent_offset_is_caught_by_the_check(self):
        # 評価関数の確認: 対称のはずの押し出しが片側に寄る（体積・表面積は変わらない）と、外接箱の照合で不一致になること
        from tests.fake_inventor import Body

        original = Body.__init__

        def one_sided(self, loops, distance):
            original(self, loops, distance)
            self.PreciseRangeBox.MinPoint.Z, self.PreciseRangeBox.MaxPoint.Z = 0.0, distance

        with mock.patch.object(Body, "__init__", one_sided):
            _, results = self.build("finger")
        self.assertIs(results[0].extent_check, False)
        self.assertLess(abs(results[0].volume_diff), 1e-9)
        self.assertFalse(results[0].ok)

    def test_one_failing_part_does_not_stop_the_others(self):
        app = FakeInventor()
        parts = spec_of("reel").parts[:3]
        builder = Builder(app)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(builder, "draw_loop", side_effect=[RuntimeError("描画失敗"), None, None, None, None, None]):
            results = [builder.build_part(p, Path(tmp)) for p in parts]
        self.assertEqual(results[0].error, "描画失敗")
        self.assertTrue(all(d.closed for d in app.documents))


class ChamferTest(unittest.TestCase):
    """丸刃: 外周 φ240・内径 φ200＋キー溝を厚み 5 で押し出し、穴の縁の両面に C1。"""

    def build(self):
        app = FakeInventor()
        [part] = spec_of("blade").parts
        with tempfile.TemporaryDirectory() as tmp:
            result = Builder(app).build_part(part, Path(tmp))
        return app, part, result

    def test_chamfers_the_hole_edges_on_both_caps_in_one_feature_in_cm(self):
        app, part, result = self.build()
        self.assertIsNone(result.error)
        self.assertTrue(result.ok, f"体積 {result.volume_diff:+.2e} / 表面積 {result.area_diff:+.2e}")
        log = app.documents[0].ComponentDefinition.log
        self.assertEqual(log[0], ("extrude", 0.5, K_SYMMETRIC, K_JOIN))
        # 代替オブジェクトのループ番号は「円 → 線をたどったループ」の順（外周の円が 0、穴が 1）
        self.assertEqual(log[1], ("chamfer", 0.1, [(1, -1), (1, 1)]))
        self.assertEqual([(c.loop, c.side, c.distance) for c in part.chamfers], [(1, -1, 1.0), (1, 1, 1.0)])

    def test_selects_every_edge_of_the_loop_on_the_cap_and_nothing_else(self):
        app = FakeInventor()
        [part] = spec_of("blade").parts
        builder = Builder(app)
        with tempfile.TemporaryDirectory() as tmp:
            builder.build_part(part, Path(tmp))
        body = app.documents[0].ComponentDefinition.SurfaceBodies.Item(1)
        for chamfer in part.chamfers:
            edges = builder.cap_edges(body, part, chamfer)
            self.assertEqual(len(edges), len(part.loops[chamfer.loop]))
            self.assertEqual({(e.loop, e.side) for e in edges}, {(1, chamfer.side)})

    def test_the_chamfer_changes_volume_and_area_as_expected(self):
        # 評価関数の確認: 面取りを作らないと、削られるはずの材料が残り、体積の照合で不一致になること
        with mock.patch.object(Builder, "add_chamfers", lambda self, definition, part: None):
            _, part, result = self.build()
        self.assertFalse(result.ok)
        self.assertGreater(result.volume_diff, 1e-3)

    def test_description_mentions_the_chamfer(self):
        from ipt_build.inventor import describe

        self.assertIn("面取り C1（縁 2 か所）", describe(spec_of("blade").parts[0]))


class PolygonChamferTest(unittest.TestCase):
    """ipt_build.chamfer（折れ線の方法）を手計算の式と照合する（JS 版とは独立）。"""

    def test_square_circle_and_a_vanishing_corner_cut(self):
        from ipt_build.chamfer import chamfer

        root2 = math.sqrt(2)
        square = [(0, 0), (10, 0), (10, 10), (0, 10)]
        cut = [(0, 0), (10, 0), (10, 9.5), (9.5, 10), (0, 10)]
        n = 20000
        circle = [(7 * math.cos(2 * math.pi * i / n), 7 * math.sin(2 * math.pi * i / n)) for i in range(n)]
        vanish = 0.5 / (2 - root2)  # 切り口の辺が消える距離

        def cut_removed(s):  # 外周を内側へ s ずらしたときに削られる面積
            return (100 - 0.125) - ((10 - 2 * s) ** 2 - max(0.5 - (2 - root2) * s, 0) ** 2 / 2)

        steps = 20000
        integral = sum(cut_removed((k + 0.5) / steps) for k in range(steps)) / steps  # 中点則（区切りの前後で 2 次式）
        cases = [
            # 正方形の外周: 削られる面積 100 − (10 − 2s)² = 40s − 4s² → 体積 20 − 4/3
            (square, False, 1, 20 - 4 / 3, 100 - 64),
            # 正方形の穴: (10 + 2s)² − 100 = 40s + 4s² → 体積 20 + 4/3
            (square, True, 1, 20 + 4 / 3, 144 - 100),
            (circle, True, 1.5, math.pi * (7 * 1.5**2 + 1.5**3 / 3), math.pi * (8.5**2 - 49)),
            (cut, False, 1, integral, cut_removed(1)),
        ]
        for points, is_hole, d, volume, face in cases:
            v, f = chamfer(points, d, is_hole)
            self.assertAlmostEqual(v, volume, delta=2e-6 * abs(volume) + 1e-7)
            self.assertAlmostEqual(f, face, delta=2e-6 * abs(face) + 1e-9)
        self.assertGreater(1, vanish)  # 面取り 1 の途中で切り口の辺が消える場合を含む


class AssemblyTest(unittest.TestCase):
    def test_reel_places_459_occurrences_at_the_captured_positions(self):
        app = FakeInventor()
        spec = spec_of("reel")
        with tempfile.TemporaryDirectory() as tmp:
            builder = Builder(app)
            results = [builder.build_part(p, Path(tmp)) for p in spec.parts]
            placed, error = builder.build_assembly(results, Path(tmp) / "reel.iam")
        self.assertIsNone(error)
        self.assertEqual(placed, 459)
        assembly = app.documents[-1].ComponentDefinition
        path, system = assembly.placed[0]
        frame = spec.parts[0].instances[0]
        self.assertEqual(system[0], tuple(v / 10 for v in frame.origin))
        self.assertEqual(system[1:], (frame.x, frame.y, frame.z))


class ExtentTest(unittest.TestCase):
    """変換データから計算する外接箱（外形の照合の期待値）の評価。"""

    def test_expected_bbox_matches_a_brute_force_sampling_of_the_solid(self):
        from ipt_build.verify import expected_bbox

        for name in NAMES:
            for part in spec_of(name).parts:
                with self.subTest(name=name, part=part.key):
                    points = []
                    for loop in part.loops:
                        for s in loop:
                            points += _sample(s)
                    if part.kind == "extrude":
                        solid = [(x, y, z) for x, y in points for z in (-part.distance / 2, part.distance / 2)]
                    else:
                        half = math.radians(part.angle_deg) / 2
                        angles = [-half + 2 * half * i / 720 for i in range(721)]
                        solid = [(x * math.cos(t), y, x * math.sin(t)) for x, y in points for t in angles]
                    lo, hi = expected_bbox(part)
                    for k in range(3):
                        self.assertAlmostEqual(min(p[k] for p in solid), lo[k], delta=1e-3 * max(1, abs(lo[k])) + 5e-3)
                        self.assertAlmostEqual(max(p[k] for p in solid), hi[k], delta=1e-3 * max(1, abs(hi[k])) + 5e-3)


def _sample(s, n=720):
    if s.type == "line":
        return [s.a, s.b]
    if s.type == "circle":
        return [(s.center[0] + s.radius * math.cos(2 * math.pi * i / n), s.center[1] + s.radius * math.sin(2 * math.pi * i / n)) for i in range(n)]
    from ipt_build.spec import arc_angles

    a0, sweep, r = arc_angles(s)
    return [(s.center[0] + r * math.cos(a0 + sweep * i / n), s.center[1] + r * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]


class SpecTest(unittest.TestCase):
    def write(self, data):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, tmp)
        tmp.close()
        return tmp.name

    def test_rejects_chamfers_on_revolves_or_thicker_than_half(self):
        blade = json.loads((FIXTURES / "blade.inventor.json").read_text(encoding="utf-8"))
        revolve = json.loads((FIXTURES / "spacer-t50.inventor.json").read_text(encoding="utf-8"))
        revolve["parts"][0]["chamfers"] = blade["parts"][0]["chamfers"]
        thick = json.loads(json.dumps(blade))
        thick["parts"][0]["chamfers"][0]["distance"] = 2.5
        wrong_side = json.loads(json.dumps(blade))
        wrong_side["parts"][0]["chamfers"][0]["side"] = "Z"
        for label, data in {"revolve": revolve, "thick": thick, "side": wrong_side, "version": {**blade, "version": 3}}.items():
            with self.subTest(label=label), self.assertRaises(SpecError):
                load_spec(self.write(data))

    def test_rejects_other_formats_versions_units_and_open_loops(self):
        base = json.loads((FIXTURES / "finger.inventor.json").read_text(encoding="utf-8"))
        broken_loop = json.loads(json.dumps(base))
        broken_loop["parts"][0]["sketch"]["loops"][0][0]["b"] = [999, 999]
        for label, data in {
            "format": {**base, "format": "other"},
            "version": {**base, "version": 99},
            "units": {**base, "units": "inch"},
            "loop": broken_loop,
        }.items():
            with self.subTest(label=label), self.assertRaises(SpecError):
                load_spec(self.write(data))


class CommandTest(unittest.TestCase):
    def test_dry_run_confirms_expected_values_without_inventor(self):
        for name in NAMES:
            with self.subTest(name=name), redirect_stdout(io.StringIO()) as out:
                self.assertEqual(main([str(FIXTURES / f"{name}.inventor.json"), "--dry-run"]), 0)
            self.assertIn("一致", out.getvalue())

    def test_build_writes_parts_assembly_and_report(self):
        app = FakeInventor()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(inventor_module, "connect", return_value=app), redirect_stdout(io.StringIO()) as out:
            code = main([str(FIXTURES / "reel.inventor.json"), "--out", tmp])
            report = json.loads((Path(tmp) / "build-report.json").read_text(encoding="utf-8"))
            files = sorted(p.suffix for p in Path(tmp).iterdir())
        self.assertEqual(code, 0, out.getvalue())
        self.assertEqual(files.count(".ipt"), 25)
        self.assertEqual(files.count(".iam"), 1)
        self.assertTrue(all(p["ok"] for p in report["parts"]))
        self.assertEqual(report["assembly"]["placed"], 459)
        self.assertEqual((app.ScreenUpdating, app.SilentOperation), (True, False))  # 元の設定に戻す


class EventsTest(unittest.TestCase):
    """--events: アプリの「Inventor で作る」が読む進み具合（1 行 1 つの JSON）。"""

    def run_events(self, spec_path, connect):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(inventor_module, "connect", side_effect=connect), \
                redirect_stdout(io.StringIO()) as out:
            code = main([str(spec_path), "--out", tmp, "--events"])
        lines = out.getvalue().splitlines()
        self.assertTrue(all(line.isascii() for line in lines), "受け取る側の文字コードに左右されないよう ASCII だけ")
        return code, [json.loads(line) for line in lines]

    def test_reports_every_step_with_the_whole_status(self):
        code, events = self.run_events(FIXTURES / "reel.inventor.json", lambda: FakeInventor())
        self.assertEqual(code, 0)
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds, ["connecting", "start"] + ["part"] * 25 + ["assembly", "done"])
        first, last = events[0], events[-1]
        self.assertEqual([p["verdict"] for p in first["parts"]], [None] * 25, "まだ作っていない部品も並べる")
        self.assertEqual((last["good"], last["total"]), (25, 25))
        self.assertTrue(all(p["verdict"] == "ok" and p["file"].endswith(".ipt") for p in last["parts"]))
        self.assertEqual(last["assembly"], {"file": "spool_reel_assembly_v2.iam", "placed": 459, "error": None})
        self.assertEqual([e["good"] for e in events if e["event"] == "part"], list(range(1, 26)), "部品ごとに 1 つずつ進む")

    def test_mismatch_is_reported_with_the_difference(self):
        with mock.patch.object(inventor_module, "cm", lambda v: v):  # 単位換算の誤り → 不一致
            code, events = self.run_events(FIXTURES / "finger.inventor.json", lambda: FakeInventor())
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["parts"][0]["verdict"], "mismatch")
        self.assertAlmostEqual(events[-1]["parts"][0]["volume_diff"], 10**3 - 1, places=6)

    def test_errors_are_one_event_with_the_reason(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        tmp.write('{"format": "other"}')
        tmp.close()
        code, events = self.run_events(tmp.name, lambda: FakeInventor())
        self.assertEqual((code, [e["event"] for e in events]), (2, ["error"]))
        self.assertIn("inventor-builder", events[0]["message"])

        def refuse():
            raise FakeComError("Inventor のライセンスが見つかりません")
        code, events = self.run_events(FIXTURES / "finger.inventor.json", refuse)
        self.assertEqual((code, [e["event"] for e in events]), (2, ["connecting", "error"]))
        self.assertEqual(events[-1]["message"], "Inventor のライセンスが見つかりません", "COM の説明をそのまま伝える")


if __name__ == "__main__":
    unittest.main()
