"""STEP の書き出し（ipt_build/step.py・brep.py・p21.py）の評価。Inventor は使わない。

1. B-rep の決まり（tests/step_check.py。常に行う）: どの稜線も逆向きに 2 回使われ、どの輪も閉じ、頂点が曲線・曲面の上にあり、
   輪の回り方が面の法線と合う（形状カーネルは読むときに面の向きを直すので、向きの誤りはここで見つける）。長さの単位は mm
2. 形状カーネル OpenCascade で読む（cadquery-ocp が入っていれば行う）: 正しい立体で、体積・表面積が変換データの期待値と一致する。
   ここでの期待値は、書き出しとは別の実装（spec.py の断面の積分）で計算したもの
3. 組立: 出現の数・名前・置いた位置が変換データと一致する

面の種類ごとの形（円柱・円錐・平面・球・半球・トーラス・扇形・穴・円弧・三角形）を、変換データと同じ JSON から作って確かめる。
"""
import math
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import tests  # noqa: F401
from ipt_build.p21 import real, string
from ipt_build.spec import load_spec, parse_spec, part_properties
from ipt_build.step import UNCERTAINTY, write_step
from tests.step_check import Brep

try:
    import OCP  # noqa: F401

    from tools.check_step import check as kernel_check
except ImportError:  # 開発用の確かめ。入っていなければ飛ばす（pip install cadquery-ocp）
    kernel_check = None

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "builder"
I = {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}


def line(a, b):
    return {"type": "line", "a": a, "b": b}


def arc(a, b, center, ccw):
    return {"type": "arc", "a": a, "b": b, "center": center, "ccw": ccw}


def polygon(*points):
    return [line(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]


def revolve(loop, angle=360):
    return {"kind": "revolve", "sketch": {"loops": [loop]}, "revolve": {"angle_deg": angle}}


def extrude(loops, distance):
    return {"kind": "extrude", "sketch": {"loops": loops}, "extrude": {"distance": distance}}


def box_mesh(w, h, d):
    corners = [[x, y, z] for x in (-w / 2, w / 2) for y in (-h / 2, h / 2) for z in (-d / 2, d / 2)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]  # 外向き
    tris = [t for a, b, c, e in quads for t in (a, b, c, a, c, e)]
    return {"kind": "mesh", "mesh": {"positions": [v for c in corners for v in c], "triangles": tris}}


def lathe_mesh(profile, n=48):
    """断面 [(r, y), …]（軸の上の点で始まり、軸の上の点で終わる）を Y 軸まわりに n 分割で回した、閉じた外向きの三角形"""
    positions, index = [], {}

    def vertex(i, j):
        r, y = profile[i]
        key = (i, 0 if r == 0 else j % n)
        if key not in index:
            index[key] = len(positions) // 3
            phi = 2 * math.pi * (j % n) / n
            positions.extend([r * math.cos(phi), y, -r * math.sin(phi)])
        return index[key]

    tris = []
    for i in range(len(profile) - 1):
        for j in range(n):
            a, b, c, d = vertex(i, j), vertex(i + 1, j), vertex(i + 1, j + 1), vertex(i, j + 1)
            tris += [v for t in ((a, c, b), (a, d, c)) if len(set(t)) == 3 for v in t]
    return {"kind": "mesh", "mesh": {"positions": positions, "triangles": tris}}


BARREL_R = math.sqrt(1000)  # たる形: 断面の円弧の中心が軸の反対側 (-20, 0)
BARREL = revolve([line([0, -10], [10, -10]), arc([10, -10], [10, 10], [-20, 0], True), line([10, 10], [0, 10]), line([0, 10], [0, -10])])
BARREL_PROFILE = [(0, -10), *[(-20 + BARREL_R * math.cos(t), BARREL_R * math.sin(t))
                              for t in (math.asin(-10 / BARREL_R) + 2 * math.asin(10 / BARREL_R) * i / 32 for i in range(33))], (0, 10)]

SHAPES = {
    "円柱（回転体）": revolve(polygon([0, -50], [20, -50], [20, 50], [0, 50])),
    "管（内径あり）": revolve(polygon([10, -5], [20, -5], [20, 5], [10, 5])),
    "円錐台": revolve(polygon([0, 0], [30, 0], [10, 40], [0, 40])),
    "球": revolve([arc([0, -10], [0, 10], [0, 0], True), line([0, 10], [0, -10])]),
    "半球": revolve([line([0, 0], [10, 0]), arc([10, 0], [0, 10], [0, 0], True), line([0, 10], [0, 0])]),
    "トーラス（円の断面）": revolve([{"type": "circle", "center": [30, 0], "radius": 5}]),
    "丸い溝のある円板（トーラスの凹面）": revolve([line([0, -5], [40, -5]), line([40, -5], [40, -2]), arc([40, -2], [40, 2], [40, 0], False), line([40, 2], [40, 5]), line([40, 5], [0, 5]), line([0, 5], [0, -5])]),
    "扇形の円柱（90°、軸に接する）": revolve(polygon([0, -10], [20, -10], [20, 10], [0, 10]), 90),
    "扇形の管（270°）": revolve(polygon([10, -5], [20, -5], [20, 5], [10, 5]), 270),
    "扇形の球（120°）": revolve([arc([0, -10], [0, 10], [0, 0], True), line([0, 10], [0, -10])], 120),
    "穴あきの板": extrude([polygon([-20, -10], [20, -10], [20, 10], [-20, 10]), [{"type": "circle", "center": [5, 0], "radius": 3}]], 4),
    "角の丸い板（凸の円弧）": extrude([[line([-10, -5], [10, -5]), arc([10, -5], [15, 0], [10, 0], True), line([15, 0], [15, 5]),
                                  line([15, 5], [-10, 5]), line([-10, 5], [-10, -5])]], 3),
    "へこんだ円弧の板（凹の円弧）": extrude([[line([-10, -5], [10, -5]), line([10, -5], [10, 5]), arc([10, 5], [-10, 5], [0, 12], False),
                                    line([-10, 5], [-10, -5])]], 2),
    "箱（三角形）": box_mesh(10, 20, 30),
}


def spec_of(parts: dict, instances=None):
    raw = []
    for i, (name, shape) in enumerate(parts.items(), start=1):
        raw.append({"key": f"p{i:02d}", "name": name, **shape, "expect": {"volume": 0, "area": 0}, "instances": instances or [I]})
    spec = parse_spec({"format": "inventor-builder", "version": 3, "units": "mm", "source": {"file": "test.html"}, "parts": raw})
    # 期待値は書き出しとは別の実装（断面の積分・三角形の和）で
    return replace(spec, parts=tuple(replace(p, expect_volume=part_properties(p)[0], expect_area=part_properties(p)[1]) for p in spec.parts))


class EncodingTest(unittest.TestCase):
    def test_reals_always_have_a_decimal_point(self):
        self.assertEqual([real(v) for v in (1.0, -0.0, 0.5, 1e-7, 1e22, -2.5e21)],
                         ["1.0", "0.", "0.5", "1.E-07", "1.E+22", "-2.5E+21"])

    def test_lengths_are_in_millimetres(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = write_step(spec_of({"円柱": SHAPES["円柱（回転体）"]}), Path(tmp) / "unit.stp")
            self.assertEqual(Brep(result.path).length_unit(), "MILLI METRE")

    def test_strings_escape_quotes_and_encode_japanese_as_x2(self):
        self.assertEqual(string("it's"), "'it''s'")
        self.assertEqual(string("回転体_φ30"), "'\\X2\\56DE8EE24F53\\X0\\_\\X2\\03C6\\X0\\30'")


class ShapesTest(unittest.TestCase):
    def write(self, spec, **kw):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return write_step(spec, Path(tmp.name) / "test.stp", **kw)

    def test_every_face_type_follows_brep_rules(self):
        for name, shape in SHAPES.items():
            with self.subTest(name=name):
                result = self.write(spec_of({name: shape}))
                self.assertEqual(Brep(result.path).problems(1e-9), [])  # 厳密な面は丸めの誤差だけ
                self.assertEqual(result.parts[0].how, "faceted" if shape["kind"] == "mesh" else "exact")

    @unittest.skipIf(kernel_check is None, "OpenCascade（cadquery-ocp）が無い")
    def test_kernel_reads_valid_solids_with_expected_volume_and_area(self):
        for name, shape in SHAPES.items():
            with self.subTest(name=name):
                spec = spec_of({name: shape})
                [solid] = kernel_check(str(self.write(spec).path))["solids"]
                part = spec.parts[0]
                self.assertTrue(solid["valid"])
                self.assertFalse(solid["self_intersecting"])
                self.assertAlmostEqual(solid["volume"] / part.expect_volume, 1, delta=1e-9)
                self.assertAlmostEqual(solid["area"] / part.expect_area, 1, delta=1e-9)

    def test_chamfered_extrusion_falls_back_to_the_source_triangles(self):
        blade = load_spec(FIXTURES / "blade.inventor.json")
        result = self.write(blade)
        self.assertEqual(result.parts[0].how, "faceted")
        self.assertIn("面取り", result.parts[0].note)
        self.assertEqual(Brep(result.path).problems(UNCERTAINTY), [])


    def test_spindle_torus_revolve_falls_back_to_the_source_triangles(self):
        # たる形の回転面は紡錘形のトーラス（半径が負の TOROIDAL_SURFACE は規格違反。DEGENERATE_TOROIDAL_SURFACE は読み手が読み違える）
        spec = spec_of({"たる": {**BARREL, "mesh": lathe_mesh(BARREL_PROFILE)["mesh"]}})
        result = self.write(spec)
        self.assertEqual(result.parts[0].how, "faceted")
        self.assertIn("紡錘形", result.parts[0].note)
        self.assertEqual(Brep(result.path).problems(UNCERTAINTY), [])
        self.assertNotIn("TOROIDAL", result.path.read_text(encoding="ascii"))
        if kernel_check:
            [solid] = kernel_check(str(result.path))["solids"]
            self.assertTrue(solid["valid"])
            self.assertAlmostEqual(solid["volume"] / spec.parts[0].expect_volume, 1, delta=0.01)  # 48 分割の弦の差


class AssemblyTest(unittest.TestCase):
    def test_occurrences_match_instances_with_names_and_origins(self):
        spec = load_spec(FIXTURES / "wire.inventor.json")
        with tempfile.TemporaryDirectory() as tmp:
            result = write_step(spec, Path(tmp) / "wire.stp")
            brep = Brep(result.path)
            self.assertEqual(brep.problems(UNCERTAINTY), [])
            got = sorted((name, tuple(round(v, 6) for v in origin)) for name, (origin, _, _) in brep.occurrences())
        expected = sorted((f"{p.name}:{n}", tuple(round(v, 6) for v in f.origin)) for p in spec.parts for n, f in enumerate(p.instances, start=1))
        self.assertTrue(result.assembly)
        self.assertEqual(result.placed, 25)
        self.assertEqual(got, expected)

    def test_structure_matches_what_inventor_writes(self):
        # Inventor 2026 が書き出す STEP（samples/stp）と同じつなぎ方: 形状定義 → 形状表現（座標系だけ）→ 関係 → B-rep の形状表現。
        # 座標系は部品ごと（別の部品の形状表現と共有しない）。改行は CR+LF
        with tempfile.TemporaryDirectory() as tmp:
            result = write_step(load_spec(FIXTURES / "wire.inventor.json"), Path(tmp) / "wire.stp")
            raw = result.path.read_bytes()
            brep = Brep(result.path)
        e = brep.e
        ref = lambda v: v[1]  # noqa: E731
        used = [ref(e[i][1][1]) for i in brep.of("SHAPE_DEFINITION_REPRESENTATION")]
        self.assertTrue(used and all(e[r][0] == "SHAPE_REPRESENTATION" for r in used), "形状定義は形状表現につなぐ")
        links = {ref(e[i][1][2]): ref(e[i][1][3]) for i in brep.of("SHAPE_REPRESENTATION_RELATIONSHIP")}
        parts = [r for r in used if r in links]
        self.assertEqual(len(parts), 15, "部品ごとに関係が 1 つ")
        self.assertTrue(all(e[links[r]][0] == "ADVANCED_BREP_SHAPE_REPRESENTATION" for r in parts))
        items = [ref(i) for r in used for i in e[r][1][1]]
        self.assertEqual(len(items), len(set(items)), "形状表現の座標系を共有しない")
        self.assertFalse(b"\n" in raw.replace(b"\r\n", b""), "改行は CR+LF だけ")

    def test_single_placement_writes_only_the_part(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = write_step(load_spec(FIXTURES / "finger.inventor.json"), Path(tmp) / "finger.stp")
            self.assertFalse(result.assembly)
            self.assertEqual(Brep(result.path).occurrences(), [])

    @unittest.skipIf(kernel_check is None, "OpenCascade（cadquery-ocp）が無い")
    def test_kernel_reads_every_fixture_with_expected_total_volume(self):
        for name in ("finger", "plate-holes", "spacer-t50", "reel", "wire", "blade"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                spec = load_spec(FIXTURES / f"{name}.inventor.json")
                solids = kernel_check(str(write_step(spec, Path(tmp) / f"{name}.stp").path))["solids"]
                self.assertEqual(len(solids), sum(len(p.instances) for p in spec.parts))
                self.assertTrue(all(s["valid"] for s in solids))
                expected = sum(p.expect_volume * len(p.instances) for p in spec.parts)
                # 面取り付きの押し出しは元の三角形で書く（CAD の面取りとの差は 1.4e-5。丸刃）
                self.assertAlmostEqual(sum(s["volume"] for s in solids) / expected, 1, delta=2e-5)


if __name__ == "__main__":
    unittest.main()
