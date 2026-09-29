"""Inventor API（COM）の動きを模したテスト用の代替オブジェクト。

ビルダーが使う範囲だけを、Inventor と同じ名前・引数で実装する。忠実さのために次を再現する:
    - 長さは cm、角度はラジアンで受け取る
    - 時計回りの円弧は、始点と終点を入れ替えて（反時計回りとして）保持する
    - 端点を共有していない断面は AddForSolid で失敗する
    - 体積・表面積は、描かれた断面を細かい折れ線にして数値的に求める
      （アプリの JS 版・ビルダーの Python 版の厳密式とは別の方法で計算し、同じ式の誤りを見逃さないため）
"""
from __future__ import annotations

import math
from pathlib import Path

K_PART_DOCUMENT = 12290
K_ASSEMBLY_DOCUMENT = 12291
K_JOIN = 20481
K_SYMMETRIC = 20995
SAMPLES_PER_TURN = 4096


class FakeComError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.excepinfo = (0, "Inventor", message, None, 0, 0)


class Point2d:
    def __init__(self, x: float, y: float):
        self.X, self.Y = x, y


class Point:
    def __init__(self, x: float, y: float, z: float):
        self.X, self.Y, self.Z = x, y, z


class Vector(Point):
    pass


class Matrix:
    def __init__(self):
        self.system = None

    def SetCoordinateSystem(self, origin, x, y, z):  # noqa: N802 — COM の名前に合わせる
        self.system = tuple((v.X, v.Y, v.Z) for v in (origin, x, y, z))


class TransientGeometry:
    def CreatePoint2d(self, x, y):  # noqa: N802
        return Point2d(x, y)

    def CreatePoint(self, x, y, z):  # noqa: N802
        return Point(x, y, z)

    def CreateVector(self, x, y, z):  # noqa: N802
        return Vector(x, y, z)

    def CreateMatrix(self):  # noqa: N802
        return Matrix()


class SketchPoint:
    def __init__(self, geometry: Point2d):
        self.Geometry = geometry


def _as_sketch_point(p) -> SketchPoint:
    return p if isinstance(p, SketchPoint) else SketchPoint(Point2d(p.X, p.Y))


class SketchLine:
    def __init__(self, start, end):
        self.StartSketchPoint, self.EndSketchPoint = start, end


class SketchArc:
    """常に反時計回りで保持する（時計回りで作られたら始点と終点を入れ替える）。"""

    def __init__(self, center: Point2d, start, end, ccw: bool):
        self.center = center
        self.StartSketchPoint, self.EndSketchPoint = (start, end) if ccw else (end, start)


class SketchCircle:
    def __init__(self, center: Point2d, radius: float):
        self.center, self.radius = center, radius


class Collection(list):
    def Item(self, index):  # noqa: N802 — Inventor のコレクションは 1 始まり
        return self[index - 1]


class Sketch:
    def __init__(self, plane):
        self.plane = plane
        self.entities: list = []
        outer = self

        class Lines:
            def AddByTwoPoints(self, a, b):  # noqa: N802
                line = SketchLine(_as_sketch_point(a), _as_sketch_point(b))
                outer.entities.append(line)
                return line

        class Arcs:
            def AddByCenterStartEndPoint(self, center, start, end, ccw=True):  # noqa: N802
                arc = SketchArc(center, _as_sketch_point(start), _as_sketch_point(end), ccw)
                outer.entities.append(arc)
                return arc

        class Circles:
            def AddByCenterRadius(self, center, radius):  # noqa: N802
                circle = SketchCircle(center, radius)
                outer.entities.append(circle)
                return circle

        class Profiles:
            def AddForSolid(self):  # noqa: N802
                return Profile(outer.loops())

        self.SketchLines, self.SketchArcs, self.SketchCircles, self.Profiles = Lines(), Arcs(), Circles(), Profiles()

    def loops(self) -> list[list[tuple[float, float]]]:
        """端点を共有する線をたどって閉じたループにし、折れ線（cm）で返す。"""
        loops = [_circle_points(e) for e in self.entities if isinstance(e, SketchCircle)]
        curves = [e for e in self.entities if not isinstance(e, SketchCircle)]
        uses: dict[int, list] = {}
        for e in curves:
            for p in (e.StartSketchPoint, e.EndSketchPoint):
                uses.setdefault(id(p), []).append(e)
        if any(len(v) != 2 for v in uses.values()):
            raise FakeComError("プロファイルを作成できません（閉じていない輪郭があります）")
        remaining = list(curves)
        while remaining:
            entity = remaining.pop(0)
            start = entity.StartSketchPoint
            point, polyline = start, []
            while True:
                polyline += _curve_points(entity, point)[:-1]
                point = entity.EndSketchPoint if point is entity.StartSketchPoint else entity.StartSketchPoint
                if point is start:
                    break
                entity = next(e for e in uses[id(point)] if e is not entity)
                remaining.remove(entity)
            loops.append(polyline)
        return loops


def _curve_points(entity, from_point) -> list[tuple[float, float]]:
    a, b = entity.StartSketchPoint.Geometry, entity.EndSketchPoint.Geometry
    if isinstance(entity, SketchLine):
        points = [(a.X, a.Y), (b.X, b.Y)]
    else:
        c = entity.center
        a0 = math.atan2(a.Y - c.Y, a.X - c.X)
        sweep = (math.atan2(b.Y - c.Y, b.X - c.X) - a0) % (2 * math.pi)
        r = math.hypot(a.X - c.X, a.Y - c.Y)
        n = max(8, int(SAMPLES_PER_TURN * sweep / (2 * math.pi)))
        points = [(c.X + r * math.cos(a0 + sweep * i / n), c.Y + r * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]
    return points if from_point is entity.StartSketchPoint else points[::-1]


def _circle_points(circle: SketchCircle) -> list[tuple[float, float]]:
    c, r = circle.center, circle.radius
    return [(c.X + r * math.cos(2 * math.pi * i / SAMPLES_PER_TURN), c.Y + r * math.sin(2 * math.pi * i / SAMPLES_PER_TURN)) for i in range(SAMPLES_PER_TURN)]


def _polygon_integrals(points):
    area = moment = perimeter = lateral = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        length = math.hypot(x1 - x0, y1 - y0)
        area += (x0 * y1 - x1 * y0) / 2
        moment += (y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1) / 6
        perimeter += length
        lateral += length * (x0 + x1) / 2
    return area, moment, perimeter, lateral


class Profile:
    def __init__(self, loops):
        self.loops = loops


class MassProperties:
    def __init__(self):
        self.Volume = 0.0
        self.Area = 0.0


class Features:
    def __init__(self, definition):
        self.log = definition.log
        mass = definition.MassProperties
        log = self.log

        class Revolves:
            def AddFull(self, profile, axis, operation):  # noqa: N802
                log.append(("revolve-full", axis.name, operation))
                self._solid(profile, 2 * math.pi)

            def AddByAngle(self, profile, axis, angle, direction, operation):  # noqa: N802
                log.append(("revolve-angle", axis.name, angle, direction, operation))
                self._solid(profile, angle)

            def _solid(self, profile, theta):
                if len(profile.loops) != 1:
                    raise FakeComError("回転の断面は 1 つにしてください")
                area, moment, _, lateral = _polygon_integrals(profile.loops[0])
                mass.Volume = theta * abs(moment)
                mass.Area = theta * lateral + (2 * abs(area) if theta < 2 * math.pi - 1e-12 else 0.0)

        class ExtrudeDefinition:
            def __init__(self, profile, operation):
                self.profile, self.operation, self.distance, self.direction = profile, operation, None, None

            def SetDistanceExtent(self, distance, direction):  # noqa: N802
                self.distance, self.direction = distance, direction

        class Extrudes:
            def CreateExtrudeDefinition(self, profile, operation):  # noqa: N802
                return ExtrudeDefinition(profile, operation)

            def Add(self, definition):  # noqa: N802
                log.append(("extrude", definition.distance, definition.direction, definition.operation))
                integrals = sorted((_polygon_integrals(loop) for loop in definition.profile.loops), key=lambda i: -abs(i[0]))
                section = abs(integrals[0][0]) - sum(abs(i[0]) for i in integrals[1:])
                perimeter = sum(i[2] for i in integrals)
                mass.Volume = section * definition.distance
                mass.Area = 2 * section + perimeter * definition.distance

        self.RevolveFeatures, self.ExtrudeFeatures = Revolves(), Extrudes()


class Named:
    def __init__(self, name):
        self.name = name


class PartDefinition:
    def __init__(self):
        self.log: list = []
        self.sketches: list[Sketch] = []
        self.MassProperties = MassProperties()
        self.WorkPlanes = Collection(Named(n) for n in ("YZ", "XZ", "XY"))
        self.WorkAxes = Collection(Named(n) for n in ("X", "Y", "Z"))
        outer = self

        class Sketches:
            def Add(self, plane):  # noqa: N802
                sketch = Sketch(plane.name)
                outer.sketches.append(sketch)
                return sketch

        self.Sketches = Sketches()
        self.Features = Features(self)


class AssemblyDefinition:
    def __init__(self):
        self.placed: list = []
        outer = self

        class Occurrences:
            def Add(self, path, matrix):  # noqa: N802
                if not Path(path).exists():
                    raise FakeComError(f"ファイルがありません: {path}")
                outer.placed.append((path, matrix.system))

        self.Occurrences = Occurrences()


class Property:
    def __init__(self):
        self.Value = ""


class PropertySet(dict):
    def Item(self, name):  # noqa: N802
        return self.setdefault(name, Property())


class Document:
    def __init__(self, kind: int, template: str):
        self.kind, self.template = kind, template
        self.ComponentDefinition = PartDefinition() if kind == K_PART_DOCUMENT else AssemblyDefinition()
        self.properties: dict[str, PropertySet] = {}
        self.saved_as: str | None = None
        self.closed = False
        outer = self

        class PropertySets:
            def Item(self, name):  # noqa: N802
                return outer.properties.setdefault(name, PropertySet())

        self.PropertySets = PropertySets()

    def SaveAs(self, path, save_copy):  # noqa: N802
        Path(path).write_bytes(b"fake")
        self.saved_as = path

    def Close(self, skip_save=False):  # noqa: N802
        self.closed = True


class FakeInventor:
    def __init__(self):
        self.TransientGeometry = TransientGeometry()
        self.documents: list[Document] = []
        self.ScreenUpdating = True
        self.SilentOperation = False
        self.Visible = False
        outer = self

        class FileManager:
            def GetTemplateFile(self, kind):  # noqa: N802
                return {K_PART_DOCUMENT: "Standard.ipt", K_ASSEMBLY_DOCUMENT: "Standard.iam"}[kind]

        class Documents:
            def Add(self, kind, template, visible=True):  # noqa: N802
                doc = Document(kind, template)
                outer.documents.append(doc)
                return doc

        self.FileManager, self.Documents = FileManager(), Documents()
