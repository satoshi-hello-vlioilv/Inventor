"""Inventor API（COM）の動きを模したテスト用の代替オブジェクト。

ビルダーが使う範囲だけを、Inventor と同じ名前・引数で実装する。忠実さのために次を再現する:
    - 長さは cm、角度はラジアンで受け取る
    - 時計回りの円弧は、始点と終点を入れ替えて（反時計回りとして）保持する
    - 端点を共有していない断面は AddForSolid で失敗する
    - 体積・表面積は、描かれた断面を細かい折れ線にして数値的に求める
      （アプリの JS 版・ビルダーの Python 版の厳密式とは別の方法で計算し、同じ式の誤りを見逃さないため）
    - 押し出すと、端面（Z = ±長さ/2）と側面を持つボディを作る。端面の稜線は、描いた線 1 本ごとに 1 本
    - ボディの外接箱（PreciseRangeBox）は、断面の折れ線を押し出し・回転した点から求める（ビルダーの厳密式とは別の方法）
    - 面取りは、選ばれた稜線が「どのループの・どちらの端面の縁か」を調べ、ループの全ての稜線がそろっている場合だけ
      体積・表面積に反映する（一部だけの選択・端面以外の稜線は失敗）。削られる量は ipt_build.chamfer の折れ線の方法
      （JS 版の厳密式とは独立）で、代替オブジェクト自身の折れ線から求める
"""
from __future__ import annotations

import math
from pathlib import Path

from ipt_build.chamfer import chamfer as polygon_chamfer

K_PART_DOCUMENT = 12290
K_ASSEMBLY_DOCUMENT = 12291
K_JOIN = 20481
K_SYMMETRIC = 20995
SAMPLES_PER_TURN = 4096
MM_PER_CM = 10.0  # Inventor の内部の長さは cm


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


class TransientObjects:
    def CreateEdgeCollection(self):  # noqa: N802
        return Collection()


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

    @property
    def Count(self):  # noqa: N802
        return len(self)

    def Add(self, item):  # noqa: N802
        self.append(item)


class Loop:
    """スケッチの閉じた輪郭: 折れ線（cm）と、それを作る線（稜線の元）。"""

    def __init__(self, points, entities):
        self.points, self.entities = points, entities


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

    def loops(self) -> list[Loop]:
        """端点を共有する線をたどって閉じたループにする。"""
        loops = [Loop(_circle_points(e), [e]) for e in self.entities if isinstance(e, SketchCircle)]
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
            point, polyline, members = start, [], []
            while True:
                polyline += _curve_points(entity, point)[:-1]
                members.append(entity)
                point = entity.EndSketchPoint if point is entity.StartSketchPoint else entity.StartSketchPoint
                if point is start:
                    break
                entity = next(e for e in uses[id(point)] if e is not entity)
                remaining.remove(entity)
            loops.append(Loop(polyline, members))
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


def _midpoint(entity) -> tuple[float, float]:
    """稜線の代表点（Inventor の Edge.PointOnEdge に相当）: 線の中点。円は中心から +X 方向の点。"""
    if isinstance(entity, SketchCircle):
        return (entity.center.X + entity.radius, entity.center.Y)
    points = _curve_points(entity, entity.StartSketchPoint)
    if isinstance(entity, SketchLine):
        return ((points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2)
    return points[len(points) // 2]


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
    def __init__(self, loops: list[Loop]):
        self.loops = loops


class Edge:
    def __init__(self, loop: int, entity, side: int, z: float):
        self.loop, self.entity, self.side = loop, entity, side
        self.PointOnEdge = Point(*_midpoint(entity), z)
        self.valid = True  # フィーチャを足して形が作り直されると、前に取り出した稜線は使えなくなる（本物の Inventor と同じ）


class Face:
    def __init__(self, edges):
        self.Edges = Collection(edges)


class Box:
    def __init__(self, points):
        self.MinPoint = Point(*(min(p[k] for p in points) for k in range(3)))
        self.MaxPoint = Point(*(max(p[k] for p in points) for k in range(3)))


class RevolvedBody:
    """回転したボディ（Y 軸まわり、XY 平面に対して対称に theta）。外接箱だけを持つ。"""

    def __init__(self, loops: list[Loop], theta: float):
        n = max(8, int(SAMPLES_PER_TURN * theta / (2 * math.pi)))
        angles = [-theta / 2 + theta * i / n for i in range(n + 1)]
        self.PreciseRangeBox = Box([(x * math.cos(t), y, x * math.sin(t)) for loop in loops for x, y in loop.points for t in angles])


class Body:
    """押し出したボディ: 端面 2 つ（稜線はループの線ごと）と、ループごとの側面。"""

    def __init__(self, loops: list[Loop], distance: float):
        self.loops, self.distance = loops, distance
        self.PreciseRangeBox = Box([(x, y, z) for loop in loops for x, y in loop.points for z in (-distance / 2, distance / 2)])
        caps = {side: [Edge(i, e, side, side * distance / 2) for i, loop in enumerate(loops) for e in loop.entities] for side in (1, -1)}
        sides = [Face([e for side in (1, -1) for e in caps[side] if e.loop == i]) for i in range(len(loops))]
        self.Faces = Collection([Face(caps[1]), Face(caps[-1]), *sides])

    def rebuilt(self) -> "Body":
        """フィーチャを足した後のボディ（稜線は新しいもの。前の稜線は使えない）。面取りの形そのものは持たない"""
        for face in self.Faces:
            for edge in face.Edges:
                edge.valid = False
        return Body(self.loops, self.distance)


class MassProperties:
    def __init__(self):
        self.Volume = 0.0
        self.Area = 0.0


class Features:
    def __init__(self, definition):
        self.log = definition.log
        mass = definition.MassProperties
        log = self.log
        owner = definition

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
                area, moment, _, lateral = _polygon_integrals(profile.loops[0].points)
                mass.Volume = theta * abs(moment)
                mass.Area = theta * lateral + (2 * abs(area) if theta < 2 * math.pi - 1e-12 else 0.0)
                owner.SurfaceBodies = Collection([RevolvedBody(profile.loops, theta)])

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
                integrals = sorted((_polygon_integrals(loop.points) for loop in definition.profile.loops), key=lambda i: -abs(i[0]))
                section = abs(integrals[0][0]) - sum(abs(i[0]) for i in integrals[1:])
                perimeter = sum(i[2] for i in integrals)
                mass.Volume = section * definition.distance
                mass.Area = 2 * section + perimeter * definition.distance
                owner.SurfaceBodies = Collection([Body(definition.profile.loops, definition.distance)])

        class Chamfers:
            def AddUsingDistance(self, edges, distance):  # noqa: N802
                body = owner.SurfaceBodies.Item(1)
                groups: dict[tuple[int, int], set[int]] = {}
                for edge in edges:
                    if not isinstance(edge, Edge):
                        raise FakeComError("稜線ではないものが選ばれています")
                    if not edge.valid:
                        raise FakeComError("パラメータが正しくありません（形が作り直される前に取り出した稜線）")
                    groups.setdefault((edge.loop, edge.side), set()).add(id(edge.entity))
                if not 0 < distance < body.distance / 2:
                    raise FakeComError("面取りの大きさが不正です")
                largest = max(range(len(body.loops)), key=lambda i: abs(_polygon_integrals(body.loops[i].points)[0]))
                for (loop, side), chosen in sorted(groups.items()):
                    if chosen != {id(e) for e in body.loops[loop].entities}:
                        raise FakeComError("ループの一部の稜線だけが選ばれています")
                    points = body.loops[loop].points
                    cut_volume, cut_face = polygon_chamfer(points, distance, loop != largest)
                    mass.Volume -= cut_volume
                    mass.Area += (math.sqrt(2) - 1) * cut_face - _polygon_integrals(points)[2] * distance
                owner.SurfaceBodies = Collection([body.rebuilt()])
                log.append(("chamfer", distance, sorted(groups)))

        self.RevolveFeatures, self.ExtrudeFeatures, self.ChamferFeatures = Revolves(), Extrudes(), Chamfers()


class Named:
    def __init__(self, name):
        self.name = name


class PartDefinition:
    def __init__(self):
        self.log: list = []
        self.sketches: list[Sketch] = []
        self.MassProperties = MassProperties()
        self.SurfaceBodies = Collection()
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


class ImportedBody:
    """STEP を開いてできたボディ（三角形をまとめた平らな面だけの STEP を読む）。外接箱を持つ。"""

    def __init__(self, points):
        self.PreciseRangeBox = Box(points)


def read_faceted_step(path) -> tuple[float, float, list]:
    """平らな面だけの STEP を読み、(体積, 表面積, 頂点) を返す（cm 単位。Inventor の内部と同じ）。
    面の輪は、面の外向きの法線から見て外周が反時計回り・穴が時計回りのはず（体積は面ごとの (面積ベクトル · 点) / 3 の和）。
    輪の向きが逆なら体積が負になり、照合で見つかる。"""
    import re  # noqa: PLC0415

    text = Path(path).read_text(encoding="ascii")
    entities = {int(m.group(1)): (m.group(2), m.group(3)) for m in re.finditer(r"#(\d+)=([A-Z_0-9]+)\((.*?)\);", re.sub(r"[\r\n]", "", text))}
    refs = lambda body: [int(r) for r in re.findall(r"#(\d+)", body)]  # noqa: E731
    point = lambda i: tuple(float(v) / MM_PER_CM for v in re.search(r"\(([^()]*)\)\s*$", entities[i][1]).group(1).split(","))  # noqa: E731
    vertex = lambda i: point(refs(entities[i][1])[0])  # noqa: E731
    volume = area = 0.0
    points = []
    for name, body in entities.values():
        if name != "ADVANCED_FACE":
            continue
        vector = [0.0, 0.0, 0.0]
        anchor = None
        for bound in refs(body)[:-1]:
            loop = refs(entities[bound][1])[0]
            ring = []
            for used in refs(entities[loop][1]):
                edge_ref = refs(entities[used][1])[0]
                forward = entities[used][1].rstrip().endswith(".T.")
                start, end = refs(entities[edge_ref][1])[:2]
                ring.append(vertex(start if forward else end))
            anchor = anchor or ring[0]
            points += ring
            for a, b in zip(ring, ring[1:] + ring[:1]):
                vector[0] += (a[1] * b[2] - a[2] * b[1]) / 2
                vector[1] += (a[2] * b[0] - a[0] * b[2]) / 2
                vector[2] += (a[0] * b[1] - a[1] * b[0]) / 2
        volume += sum(v * c for v, c in zip(vector, anchor)) / 3
        area += math.sqrt(sum(v * v for v in vector))
    return volume, area, points


class FakeInventor:
    def __init__(self, screen_updating: bool = True, silent: bool = False):
        self.TransientGeometry = TransientGeometry()
        self.TransientObjects = TransientObjects()
        self.documents: list[Document] = []
        self.ScreenUpdating = screen_updating  # 前の実行が強制的に止められると、False のまま残る
        self.SilentOperation = silent
        self.Visible = False
        self.Ready = True
        outer = self

        class FileManager:
            def GetTemplateFile(self, kind):  # noqa: N802
                return {K_PART_DOCUMENT: "Standard.ipt", K_ASSEMBLY_DOCUMENT: "Standard.iam"}[kind]

        class Documents:
            def Add(self, kind, template, visible=True):  # noqa: N802
                doc = Document(kind, template)
                outer.documents.append(doc)
                return doc

            def Open(self, path, visible=True):  # noqa: N802 — STEP を開くと部品のドキュメントになる
                if not Path(path).exists():
                    raise FakeComError(f"ファイルがありません: {path}")
                doc = Document(K_PART_DOCUMENT, None)
                doc.opened = path
                volume, area, points = read_faceted_step(path)
                definition = doc.ComponentDefinition
                definition.MassProperties.Volume, definition.MassProperties.Area = volume, area
                definition.SurfaceBodies.Add(ImportedBody(points))
                outer.documents.append(doc)
                return doc

        self.FileManager, self.Documents = FileManager(), Documents()
