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

from ipt_build import SpecError, load_spec
from ipt_build import inventor as inventor_module
from ipt_build.__main__ import main
from ipt_build.inventor import K_JOIN, K_SYMMETRIC, Builder
from tests.fake_inventor import FakeInventor

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "builder"
NAMES = ["spacer-t50", "finger", "reel", "plate-holes"]


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

    def test_fake_files_cannot_be_reread_so_the_file_check_is_skipped_not_failed(self):
        _, results = self.build("finger")
        self.assertIsNone(results[0].file_check)
        self.assertTrue(results[0].ok)

    def test_one_failing_part_does_not_stop_the_others(self):
        app = FakeInventor()
        parts = spec_of("reel").parts[:3]
        builder = Builder(app)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(builder, "draw_loop", side_effect=[RuntimeError("描画失敗"), None, None, None, None, None]):
            results = [builder.build_part(p, Path(tmp)) for p in parts]
        self.assertEqual(results[0].error, "描画失敗")
        self.assertTrue(all(d.closed for d in app.documents))


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


class FileCheckTest(unittest.TestCase):
    """保存したファイルを読み直す確認（ビルダーの単位の前提から独立した確認）。"""

    def test_reads_the_sample_ipt_in_mm_from_the_units_written_in_the_file(self):
        from ipt_build.verify import file_bbox

        lo, hi = file_bbox(Path(__file__).resolve().parents[1] / "E_Plate_改_Φ54.5.ipt")
        self.assertEqual((lo, hi), ((0.0, 0.0, -7.5), (21.0, 2.0, 0.0)))

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


if __name__ == "__main__":
    unittest.main()
