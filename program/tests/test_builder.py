"""ビルダー（ipt_build）の評価。Inventor の代わりに fake_inventor を使う。

最も重要な確認は「ビルダーが描いた断面から（第 3 の方法で）求めた体積・表面積が、
アプリ（JS）が変換データに書いた期待値と一致すること」。単位・円弧の向き・端点の共有・回転／押し出しの
指定のどれかを誤ると一致しなくなる。
"""
import io
import json
import math
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path, PureWindowsPath
from unittest import mock

import tests  # noqa: F401 — program フォルダの ipt_build を import できるようにする
from ipt_build import SpecError, load_spec, runner
from ipt_build import inventor as inventor_module
from ipt_build.__main__ import main
from ipt_build.inventor import K_JOIN, K_SYMMETRIC, Builder, when_ready
from ipt_build.spec import Chamfer, source_stem
from tests.fake_inventor import FakeComError, FakeInventor

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "builder"
NAMES = ["spacer-t50", "finger", "blade", "reel", "plate-holes", "wire"]


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
                self.assertEqual(entry[0], "extrude")
                self.assertAlmostEqual(entry[1], part.distance / 10, places=12)  # 名前つきの値（mm の式）を Inventor が cm に
                self.assertEqual(entry[2:], (K_SYMMETRIC, K_JOIN))
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
        # 評価関数の確認: 描くときの mm → cm の換算が抜けると、体積の照合で不一致になること。
        # 名前つきの値の無い部品は断面と厚さの両方が 10 倍（体積 1000 倍）。名前つきの値の厚さは mm の式なので、断面だけ（100 倍）
        [part] = spec_of("finger").parts
        for plan, ratio in ((None, 10**3), (part.parametric, 10**2)):
            app = FakeInventor()
            with self.subTest(plan=bool(plan)), tempfile.TemporaryDirectory() as tmp, mock.patch.object(inventor_module, "cm", lambda v: v):
                result = Builder(app).build_part(replace(part, parametric=plan), Path(tmp))
                self.assertFalse(result.ok)
                self.assertAlmostEqual(result.volume_diff, ratio - 1, places=6)

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


class ParametricTest(unittest.TestCase):
    """Inventor で直せる部品（変換データの版 4 の parametric）。代替オブジェクトは、拘束・寸法をアプリとは別の式で確かめる
    （今の形に合わない・ほかと重なる拘束を断る。自由度を数える。寸法の式の値が今の寸法と同じか）"""

    def build(self, part, app=None):
        app = app or FakeInventor()
        with tempfile.TemporaryDirectory() as tmp:
            result = Builder(app).build_part(part, Path(tmp))
        return app.documents[-1].ComponentDefinition, result

    def test_every_sketch_is_fully_constrained_with_the_named_values(self):
        for name in NAMES:
            for part in spec_of(name).parts:
                plan = part.parametric
                if part.kind == "mesh":
                    self.assertIsNone(plan)
                    continue
                with self.subTest(name=name, part=part.key):
                    definition, result = self.build(part)
                    self.assertTrue(result.ok, result.error)
                    self.assertEqual(result.parametric["failed"], [])
                    [sketch] = definition.sketches
                    self.assertEqual(sketch.system.free_degrees(), 0, "完全拘束（代替オブジェクトの式で数えた自由度）")
                    self.assertEqual([(p.Name, p.Comment) for p in definition.Parameters.user], [(p["name"], p["comment"]) for p in plan.params])
                    for p, planned in zip(definition.Parameters.user, plan.params):
                        self.assertAlmostEqual(p.Value, planned["value"] * (0.1 if planned["unit"] == "mm" else math.pi / 180), places=12)
                    driving = [d for d in plan.dimensions if not d["driven"]]
                    self.assertEqual(result.parametric | {"failed": None}, {"params": len(plan.params), "constraints": len(plan.constraints),
                                     "dimensions": len(driving), "driven": len(plan.dimensions) - len(driving), "free": 0, "failed": None})
                    expressions = [p.Expression for p in definition.Parameters.model if p.Expression]
                    self.assertEqual(expressions, [d["expression"] for d in driving if d.get("expression")])
                    names = {p.Name for p in definition.Parameters.model}
                    self.assertTrue({d["name"] for d in driving if d.get("name")} <= names)

    def test_features_take_the_named_values(self):
        definition, _ = self.build(spec_of("plate-holes").parts[0])
        self.assertEqual(definition.expressions, [("extrude", "t")])
        self.assertIn("D1_0", [p.Expression for p in definition.Parameters.model])
        partial = next(p for p in spec_of("reel").parts if p.kind == "revolve" and not p.full_revolve)
        definition, _ = self.build(partial)
        self.assertEqual(definition.expressions, [("revolve-angle", "a")])

    def test_shape_is_built_even_if_some_constraints_cannot_be_added(self):
        # 実物の Inventor で付けられない寸法があっても（API の違いなど）、形はそのまま作り、数と理由を知らせる
        from tests.fake_constraints import ConstraintSystem

        part = spec_of("finger").parts[0]
        original = ConstraintSystem.__init__

        def without_angles(self, sketch, parameters):
            original(self, sketch, parameters)

            def refuse(*_):
                raise FakeComError("角度の寸法は付けられません")

            self.Dimensions.AddTwoLineAngle = refuse

        with mock.patch.object(ConstraintSystem, "__init__", without_angles):
            definition, result = self.build(part)
        self.assertTrue(result.ok)
        self.assertEqual(len(result.parametric["failed"]), 2)
        self.assertIn("寸法・拘束のうち 2 個を付けられませんでした", result.notes[0])
        self.assertEqual(definition.sketches[0].system.free_degrees(), 2)

    def test_named_values_that_cannot_be_made_fall_back_to_numbers(self):
        part = spec_of("plate-holes").parts[0]
        app = FakeInventor()
        with mock.patch("tests.fake_constraints.Parameters.check_name", side_effect=FakeComError("名前を付けられません")):
            definition, result = self.build(part, app)
        self.assertTrue(result.ok)
        self.assertEqual(definition.expressions, [("extrude", 0.2)])
        self.assertEqual(result.parametric["params"], 0)

    def test_old_conversion_data_is_built_without_named_values(self):
        definition, result = self.build(replace(spec_of("plate-holes").parts[0], parametric=None))
        self.assertTrue(result.ok)
        self.assertIsNone(result.parametric)
        self.assertEqual(definition.Parameters.user, [])
        self.assertEqual(definition.sketches[0].system.equations, [])


class FakeConstraintTest(unittest.TestCase):
    """評価関数（代替オブジェクトの拘束の式）の確認: 重なる拘束・今の形に合わない拘束・値の違う式を断り、自由度を正しく数える"""

    def rectangle(self):
        app = FakeInventor()
        definition = app.Documents.Add(12290, "Standard.ipt").ComponentDefinition
        sketch = definition.Sketches.Add(definition.WorkPlanes.Item(3))
        tg = app.TransientGeometry
        corners = [tg.CreatePoint2d(*p) for p in ((0, 0), (2, 0), (2, 1), (0, 1))]
        lines, first = [], None
        for i in range(4):
            start = lines[-1].EndSketchPoint if lines else corners[0]
            end = first if i == 3 else corners[i + 1]
            lines.append(sketch.SketchLines.AddByTwoPoints(start, end))
            first = first or lines[0].StartSketchPoint
        return definition, sketch, lines

    def test_counts_degrees_of_freedom_and_refuses_redundant_or_wrong_constraints(self):
        from tests.fake_inventor import K_ALIGNED_DIM

        definition, sketch, lines = self.rectangle()
        self.assertEqual(sketch.system.free_degrees(), 8)
        gc, dc = sketch.GeometricConstraints, sketch.DimensionConstraints
        for line, add in zip(lines, (gc.AddHorizontal, gc.AddVertical, gc.AddHorizontal, gc.AddVertical)):
            add(line)
        self.assertEqual(sketch.system.free_degrees(), 4)
        text = None  # 寸法の文字の位置（代替オブジェクトは使わない）
        dc.AddTwoPointDistance(lines[0].StartSketchPoint, lines[0].EndSketchPoint, K_ALIGNED_DIM, text)
        with self.assertRaisesRegex(FakeComError, "多すぎます"):  # 向かいの辺の長さは、もう決まっている
            dc.AddTwoPointDistance(lines[2].StartSketchPoint, lines[2].EndSketchPoint, K_ALIGNED_DIM, text)
        driven = dc.AddTwoPointDistance(lines[2].StartSketchPoint, lines[2].EndSketchPoint, K_ALIGNED_DIM, text, True)
        self.assertTrue(driven.Driven)
        self.assertEqual(sketch.system.free_degrees(), 3)
        with self.assertRaisesRegex(FakeComError, "今の形に合いません"):
            gc.AddVertical(lines[0])
        definition.Parameters.UserParameters.AddByExpression("W", "25 mm", "mm")
        with self.assertRaisesRegex(FakeComError, "今の寸法"):  # 縦の辺は 10 mm（1 cm）。25 mm の式は形を変える
            dc.AddTwoPointDistance(lines[1].StartSketchPoint, lines[1].EndSketchPoint, K_ALIGNED_DIM, text).Parameter.Expression = "W"


class ChamferTest(unittest.TestCase):
    """丸刃: 外周 φ240・内径 φ200＋キー溝を厚み 5 で押し出し、穴の縁の両面に C1。"""

    def build(self):
        app = FakeInventor()
        [part] = spec_of("blade").parts
        with tempfile.TemporaryDirectory() as tmp:
            result = Builder(app).build_part(part, Path(tmp))
        return app, part, result

    def test_chamfers_the_hole_edges_on_both_caps_one_feature_per_named_value(self):
        # 名前つきの値（C0・C1）があれば、面取りごとに 1 つのフィーチャ（Inventor で別々に直せる）。無ければ同じ大きさを 1 つにまとめる
        app, part, result = self.build()
        self.assertIsNone(result.error)
        self.assertTrue(result.ok, f"体積 {result.volume_diff:+.2e} / 表面積 {result.area_diff:+.2e}")
        definition = app.documents[0].ComponentDefinition
        self.assertEqual(definition.log[0], ("extrude", 0.5, K_SYMMETRIC, K_JOIN))
        # 代替オブジェクトのループ番号は「円 → 線をたどったループ」の順（外周の円が 0、穴が 1）
        self.assertEqual(definition.log[1:], [("chamfer", 0.1, [(1, -1)]), ("chamfer", 0.1, [(1, 1)])])
        self.assertEqual(definition.expressions, [("extrude", "t"), ("chamfer", "C0"), ("chamfer", "C1")])
        self.assertEqual([(c.loop, c.side, c.distance) for c in part.chamfers], [(1, -1, 1.0), (1, 1, 1.0)])
        app = FakeInventor()
        with tempfile.TemporaryDirectory() as tmp:
            Builder(app).build_part(replace(part, parametric=None), Path(tmp))
        self.assertEqual(app.documents[0].ComponentDefinition.log[1:], [("chamfer", 0.1, [(1, -1), (1, 1)])])

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
        with mock.patch.object(Builder, "add_chamfers", lambda self, definition, part, values=None: None):
            _, part, result = self.build()
        self.assertFalse(result.ok)
        self.assertGreater(result.volume_diff, 1e-3)

    def test_two_chamfer_sizes_pick_their_edges_from_the_body_after_the_first_chamfer(self):
        # 本物の Inventor と同じく、代替オブジェクトもフィーチャを足すと前の稜線を使えなくする。
        # 大きさごとに、その時点のボディから稜線を選び直さないと、2 つ目の面取りで失敗する
        app = FakeInventor()
        [blade] = spec_of("blade").parts
        part = replace(blade, chamfers=(*blade.chamfers, Chamfer(loop=0, side=1, distance=2.0)), parametric=None)
        with tempfile.TemporaryDirectory() as tmp:
            result = Builder(app).build_part(part, Path(tmp))
        self.assertIsNone(result.error)
        chamfers = [entry for entry in app.documents[0].ComponentDefinition.log if entry[0] == "chamfer"]
        self.assertEqual(chamfers, [("chamfer", 0.1, [(1, -1), (1, 1)]), ("chamfer", 0.2, [(0, 1)])])

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


    def test_an_occurrence_that_cannot_be_placed_does_not_discard_the_assembly(self):
        app = FakeInventor()
        spec = spec_of("finger")
        with tempfile.TemporaryDirectory() as tmp:
            builder = Builder(app)
            results = [builder.build_part(p, Path(tmp)) for p in spec.parts]
            parts = [replace(results[0], part=replace(results[0].part, instances=results[0].part.instances * 3)),
                     replace(results[0], path=Path(tmp) / "無い部品.ipt")]
            placed, error = builder.build_assembly(parts, Path(tmp) / "finger.iam")
            saved = (Path(tmp) / "finger.iam").exists()
        self.assertEqual(placed, 3)
        self.assertTrue(saved, "置けた出現だけで組立を保存する")
        self.assertRegex(error, r"^1 か所を置けませんでした: .+:1（ファイルがありません")


class InventorSessionTest(unittest.TestCase):
    """Inventor の状態（画面の更新・ダイアログ）と、中止・起動待ち"""

    def run_build(self, app, **options):
        with tempfile.TemporaryDirectory() as tmp:
            return runner.build(spec_of("reel"), Path(tmp), connect=lambda: app, **options)

    def test_restores_normal_screen_updating_and_dialogs_even_if_an_earlier_run_was_killed(self):
        # 前の実行が強制的に止められ、画面の更新が止まったまま・ダイアログを出さないまま残っていても、ふだんの状態に戻す
        app = FakeInventor(screen_updating=False, silent=True)
        run = self.run_build(app)
        self.assertTrue(run.ok)
        self.assertEqual((app.ScreenUpdating, app.SilentOperation), (True, False))

    def test_restores_the_settings_when_building_fails(self):
        app = FakeInventor()
        with mock.patch.object(Builder, "build_assembly", side_effect=RuntimeError("組立で失敗")):
            run = self.run_build(app)
        self.assertEqual(run.inventor_error, "組立で失敗")
        self.assertEqual((app.ScreenUpdating, app.SilentOperation), (True, False))

    def test_cancel_stops_between_parts_and_restores_the_settings(self):
        app, cancel = FakeInventor(), threading.Event()

        def progress(event, run, result=None):
            if event == "part" and len(run.results) == 2:
                cancel.set()

        run = self.run_build(app, progress=progress, cancel=cancel)
        self.assertEqual(len(run.results), 2, "作りかけの部品を終えたところで止まる")
        self.assertIsNone(run.assembly_path, "組立は作らない")
        self.assertTrue(all(d.closed for d in app.documents))
        self.assertEqual((app.ScreenUpdating, app.SilentOperation), (True, False))

    def test_waits_while_inventor_rejects_calls_and_gives_up_after_the_timeout(self):
        class Busy(Exception):
            hresult = -2147418111  # RPC_E_CALL_REJECTED

        now = [0.0]
        clock, sleep = (lambda: now[0]), (lambda s: now.__setitem__(0, now[0] + s))
        answers = iter([Busy(), Busy(), 42])

        def call():
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return answer

        self.assertEqual(when_ready(call, timeout=10, clock=clock, sleep=sleep), 42)
        with self.assertRaises(Busy):
            when_ready(lambda: (_ for _ in ()).throw(Busy()), timeout=5, clock=clock, sleep=sleep)
        with self.assertRaises(ValueError, msg="断られたのではない失敗は、待たずに出す"):
            when_ready(lambda: (_ for _ in ()).throw(ValueError("別の失敗")), timeout=5, clock=clock, sleep=sleep)

    def test_waits_until_a_starting_inventor_is_ready(self):
        app = FakeInventor()
        states = iter([False, False, True])
        type(app).Ready = property(lambda self: next(states), lambda self, v: None)
        try:
            inventor_module._wait_until_started(app, timeout=10, pause=0, sleep=lambda s: None)
        finally:
            del type(app).Ready
        with self.assertRaises(StopIteration):
            next(states)


class ExtentTest(unittest.TestCase):
    """変換データから計算する外接箱（外形の照合の期待値）の評価。"""

    def test_expected_bbox_matches_a_brute_force_sampling_of_the_solid(self):
        from ipt_build.verify import expected_bbox

        for name in NAMES:
            for part in spec_of(name).parts:
                with self.subTest(name=name, part=part.key):
                    if part.kind == "mesh":  # 三角形の部品の外接箱は頂点の範囲
                        lo, hi = expected_bbox(part)
                        for k in range(3):
                            self.assertEqual((lo[k], hi[k]), (min(p[k] for p in part.mesh.positions), max(p[k] for p in part.mesh.positions)))
                        continue
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


class SourceNameTest(unittest.TestCase):
    def test_names_come_from_the_source_file_even_when_it_is_missing_or_unsafe(self):
        self.assertEqual(source_stem({"file": None}), "変換データ")
        self.assertEqual(source_stem({}), "変換データ")
        self.assertEqual(source_stem({"file": "a:b?.html"}), "a_b_")
        with mock.patch("ipt_build.spec.Path", PureWindowsPath):  # Windows の解釈でも同じ名前（取り込んだ PC と作る PC は違ってよい）
            self.assertEqual(source_stem({"file": "a:b?.html"}), "a_b_")
            self.assertEqual(source_stem({"file": "x\\a.html"}), "x_a")
        spec = replace(spec_of("finger"), source={"file": None})
        with tempfile.TemporaryDirectory() as tmp:
            run = runner.build(spec, Path(tmp), inventor=False)
            self.assertIsNone(run.step_error)
            self.assertTrue((Path(tmp) / "変換データ.stp").exists())


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
        for label, data in {"revolve": revolve, "thick": thick, "side": wrong_side, "version": {**blade, "version": 5}}.items():
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
    """--events: アプリの「CAD ファイルを作る」が読む進み具合（1 行 1 つの JSON）。"""

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
        self.assertEqual(kinds, ["step", "connecting", "start"] + ["part"] * 25 + ["assembly", "done"])
        first, last = events[0], events[-1]
        self.assertEqual(first["step"]["file"], "spool_reel_assembly_v2.stp", "STEP を最初に書く")
        self.assertEqual([p["verdict"] for p in first["parts"]], [None] * 25, "まだ作っていない部品も並べる")
        self.assertEqual((last["good"], last["total"]), (25, 25))
        self.assertTrue(all(p["verdict"] == "ok" and p["file"].endswith(".ipt") for p in last["parts"]))
        self.assertEqual(last["assembly"], {"file": "spool_reel_assembly_v2.iam", "placed": 459, "error": None})
        self.assertEqual([e["good"] for e in events if e["event"] == "part"], list(range(1, 26)), "部品ごとに 1 つずつ進む")

    def test_mismatch_is_reported_with_the_difference(self):
        with mock.patch.object(inventor_module, "cm", lambda v: v):  # 単位換算の誤り → 不一致（断面が 10 倍。厚さは名前つきの値の mm の式）
            code, events = self.run_events(FIXTURES / "finger.inventor.json", lambda: FakeInventor())
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["parts"][0]["verdict"], "mismatch")
        self.assertAlmostEqual(events[-1]["parts"][0]["volume_diff"], 10**2 - 1, places=6)

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
        self.assertEqual((code, [e["event"] for e in events]), (1, ["step", "connecting", "done"]), "STEP は書いてから知らせる")
        self.assertEqual(events[-1]["inventor_error"], "Inventor のライセンスが見つかりません", "COM の説明をそのまま伝える")
        self.assertEqual(events[-1]["step"]["file"], "LS4_parts_viewer.stp")


if __name__ == "__main__":
    unittest.main()
