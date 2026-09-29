"""B-rep 層: SAB エンティティからトポロジを辿り、設計者が読める寸法情報にまとめる。

トポロジは ACIS と同じ ``body → lump → shell → face → loop → coedge → edge → vertex``。
面・稜線には解析曲面／解析曲線（plane, cone, straight, ellipse …）が紐づく。
座標は SAB ヘッダの ``mm_per_unit``（Inventor は内部単位 cm なので 10.0）で mm に換算する。
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

from .sab import Entity, SabDocument

Vec = tuple[float, float, float]

# ASM 231 における refs の並び。先頭 2 つ (attrib, history) は全エンティティ共通。
SLOTS = {
    "body": ("attrib", "history", "lump", "wire", "transform"),
    "lump": ("attrib", "history", "next", "shell", "body"),
    "shell": ("attrib", "history", "next", "subshell", "face", "wire", "lump"),
    "face": ("attrib", "history", "next", "loop", "shell", "subshell", "surface"),
    "loop": ("attrib", "history", "next", "coedge", "face"),
    "coedge": ("attrib", "history", "next", "prev", "partner", "edge", "loop", "pcurve"),
    "edge": ("attrib", "history", "start", "end", "coedge", "curve"),
    "vertex": ("attrib", "history", "edge", "point"),
}
_ARC_STEP = math.pi / 32  # 円弧のサンプリング刻み（外接箱の算出用）
_FULL_TURN_DEG = 360.0
_ANGLE_TOL_DEG = 1e-3
_ROUND = 6


# ---- ベクトル演算 -------------------------------------------------------------
def _add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a: Vec, k: float) -> Vec:
    return (a[0] * k, a[1] * k, a[2] * k)


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _length(a: Vec) -> float:
    return math.sqrt(_dot(a, a))


def _unit(a: Vec) -> Vec:
    n = _length(a)
    return _mul(a, 1.0 / n) if n else a


def _canonical_direction(a: Vec) -> Vec:
    """軸の向きを正規化する（符号違いの同一軸を同一視するため）。"""
    a = _unit(a)
    first = next((c for c in a if abs(c) > 1e-9), 0.0)
    return _mul(a, -1.0) if first < 0 else a


def _r(v):
    if isinstance(v, float):
        return round(v, _ROUND) + 0.0  # -0.0 を 0.0 に揃える
    if isinstance(v, tuple):
        return tuple(_r(x) for x in v)
    return v


# ---- 解析曲線・曲面 -----------------------------------------------------------
@dataclass(frozen=True)
class Curve:
    kind: str  # line | ellipse | <生の型名>
    origin: Vec | None = None
    direction: Vec | None = None  # line: 方向, ellipse: 法線
    major: Vec | None = None
    ratio: float = 1.0

    @classmethod
    def of(cls, e: Entity | None) -> Curve:
        if e is None:
            return cls("none")
        if e.type == "straight-curve":
            return cls("line", e.positions[0], e.vectors[0])
        if e.type == "ellipse-curve":
            return cls("ellipse", e.positions[0], e.vectors[0], e.vectors[1], e.doubles[0])
        return cls(e.type)

    def point(self, t: float) -> Vec:
        if self.kind == "line":
            return _add(self.origin, _mul(self.direction, t))
        minor = _mul(_cross(_unit(self.direction), self.major), self.ratio)
        return _add(self.origin, _add(_mul(self.major, math.cos(t)), _mul(minor, math.sin(t))))

    def sample(self, t0: float, t1: float) -> list[Vec]:
        if self.kind == "line":
            return [self.point(t0), self.point(t1)]
        if self.kind == "ellipse":
            n = max(2, math.ceil(abs(t1 - t0) / _ARC_STEP))
            return [self.point(t0 + (t1 - t0) * i / n) for i in range(n + 1)]
        return []


@dataclass(frozen=True)
class Surface:
    kind: str  # plane | cylinder | cone | <生の型名>
    origin: Vec | None = None
    direction: Vec | None = None  # plane: 法線, cylinder/cone: 軸
    radius: float | None = None
    normal_outward: bool | None = None  # cylinder/cone: 曲面法線が軸から離れる向きか

    @classmethod
    def of(cls, e: Entity | None) -> Surface:
        if e is None:
            return cls("none")
        if e.type == "plane-surface":
            return cls("plane", e.positions[0], e.vectors[0])
        if e.type == "cone-surface":
            # doubles: ratio, [u 範囲], sin(半頂角), cos(半頂角), u スケール
            sin_angle, cos_angle = e.doubles[-3], e.doubles[-2]
            ratio = e.doubles[0]
            kind = "cylinder" if abs(sin_angle) < 1e-12 and abs(ratio - 1.0) < 1e-12 else "cone"
            return cls(kind, e.positions[0], e.vectors[0], _length(e.vectors[1]), cos_angle >= 0)
        return cls(e.type)


# ---- トポロジ ----------------------------------------------------------------
@dataclass(frozen=True)
class Edge:
    curve: Curve
    t0: float
    t1: float
    points: tuple[Vec, ...]

    @property
    def sweep_deg(self) -> float:
        return math.degrees(abs(self.t1 - self.t0)) if self.curve.kind == "ellipse" else 0.0


@dataclass(frozen=True)
class Face:
    index: int
    surface: Surface
    reversed: bool
    edges: tuple[Edge, ...]

    @property
    def concave(self) -> bool | None:
        """円筒・円錐面が凹（面の法線が軸を向く）か。穴と軸・角R と隅R の判別に使う。"""
        if self.surface.normal_outward is None:
            return None
        return self.surface.normal_outward == self.reversed


class Topology:
    def __init__(self, doc: SabDocument):
        self.doc = doc

    def ref(self, e: Entity, slot: str) -> Entity | None:
        return self.doc.get(e.refs[SLOTS[e.type].index(slot)])

    def chain(self, first: Entity | None, slot: str = "next"):
        """next 参照で連結されたリストを辿る（循環していても 1 周で止める）。"""
        seen = set()
        e = first
        while e is not None and e.index not in seen:
            seen.add(e.index)
            yield e
            e = self.ref(e, slot)

    def bodies(self) -> list[Entity]:
        return self.doc.of_type("body")

    def faces(self, body: Entity) -> list[Entity]:
        return [face for shell in self.shells(body) for face in self.chain(self.ref(shell, "face"))]

    def loops(self, face: Entity) -> list[Entity]:
        return list(self.chain(self.ref(face, "loop")))

    def coedges(self, face: Entity) -> list[Entity]:
        return [c for loop in self.loops(face) for c in self.chain(self.ref(loop, "coedge"))]

    def shells(self, body: Entity) -> list[Entity]:
        return [
            shell
            for lump in self.chain(self.ref(body, "lump"))
            for shell in self.chain(self.ref(lump, "shell"))
        ]

    def vertex_point(self, vertex: Entity | None) -> Vec | None:
        point = self.ref(vertex, "point") if vertex is not None else None
        return point.positions[0] if point is not None else None

    def edge(self, e: Entity) -> Edge:
        curve = Curve.of(self.ref(e, "curve"))
        t0, t1 = e.doubles[0], e.doubles[1]
        if e.bools and e.bools[0]:  # 稜線が曲線と逆向きなら曲線パラメータは符号反転
            t0, t1 = -t1, -t0
        ends = [self.vertex_point(self.ref(e, s)) for s in ("start", "end")]
        points = [p for p in ends if p is not None] + curve.sample(t0, t1)
        return Edge(curve, t0, t1, tuple(points))

    def face(self, e: Entity) -> Face:
        edges = tuple(self.edge(self.ref(c, "edge")) for c in self.coedges(e))
        return Face(e.index, Surface.of(self.ref(e, "surface")), bool(e.bools and e.bools[0]), edges)

    def is_closed(self, body: Entity) -> bool:
        return all(
            self.ref(c, "partner") is not None for f in self.faces(body) for c in self.coedges(f)
        )


# ---- 要約 --------------------------------------------------------------------
_CYLINDER_KIND = {  # (凹か, 全周か) → 形状の呼び名
    (True, True): "hole",
    (False, True): "boss",
    (False, False): "round",
    (True, False): "inner_round",
}


@dataclass(frozen=True)
class CylinderFeature:
    """同一軸・同一半径の円筒面群。凹凸と周回角から 穴/軸/角R/隅R を判別する。"""

    kind: str
    diameter: float
    radius: float
    axis: Vec
    center: Vec
    length: float
    sweep_deg: float
    faces: int


@dataclass(frozen=True)
class BodySummary:
    index: int
    closed: bool
    shells: int
    faces: int
    loops: int
    edges: int
    vertices: int
    genus: int | None  # 閉じたソリッドの種数 = 貫通穴の数（オイラー・ポアンカレの式）
    surfaces: dict[str, int]
    bbox_min: Vec
    bbox_max: Vec
    size: Vec
    cylinders: tuple[CylinderFeature, ...] = ()


def summarize(doc: SabDocument) -> list[BodySummary]:
    topo = Topology(doc)
    return [_summarize_body(topo, body, doc.mm_per_unit) for body in topo.bodies()]


def _summarize_body(topo: Topology, body: Entity, scale: float) -> BodySummary:
    face_entities = topo.faces(body)
    faces = [topo.face(f) for f in face_entities]
    edge_ids = {topo.ref(c, "edge").index for f in face_entities for c in topo.coedges(f)}
    vertex_ids = {
        v.index
        for i in edge_ids
        for v in (topo.ref(topo.doc.get(i), s) for s in ("start", "end"))
        if v is not None
    }
    shells = len(topo.shells(body))
    loops = sum(len(topo.loops(f)) for f in face_entities)
    closed = topo.is_closed(body)
    # V - E + F - (L - F) = 2(S - G)  →  G = S - (V - E + 2F - L) / 2
    euler = len(vertex_ids) - len(edge_ids) + 2 * len(faces) - loops
    genus = shells - euler // 2 if closed and euler % 2 == 0 else None
    points = [p for f in faces for e in f.edges for p in e.points]
    lo = tuple(min(p[k] for p in points) * scale for k in range(3)) if points else (0.0,) * 3
    hi = tuple(max(p[k] for p in points) * scale for k in range(3)) if points else (0.0,) * 3
    return BodySummary(
        index=body.index,
        closed=closed,
        shells=shells,
        faces=len(faces),
        loops=loops,
        edges=len(edge_ids),
        vertices=len(vertex_ids),
        genus=genus,
        surfaces=dict(Counter(f.surface.kind for f in faces)),
        bbox_min=_r(lo),
        bbox_max=_r(hi),
        size=_r(_sub(hi, lo)),
        cylinders=tuple(_cylinder_features(faces, scale)),
    )


def _cylinder_features(faces: list[Face], scale: float) -> list[CylinderFeature]:
    groups: dict[tuple, list[Face]] = {}
    for f in faces:
        s = f.surface
        if s.kind != "cylinder":
            continue
        axis = _canonical_direction(s.direction)
        foot = _sub(s.origin, _mul(axis, _dot(s.origin, axis)))  # 軸上で原点に最も近い点
        key = (round(s.radius, 5), _r(axis), tuple(round(c, 5) for c in foot), f.concave)
        groups.setdefault(key, []).append(f)

    features = []
    for (_, axis, _, concave), members in groups.items():
        surface = members[0].surface
        sweep = min(_FULL_TURN_DEG, sum(max((e.sweep_deg for e in f.edges), default=0.0) for f in members))
        heights = [_dot(p, axis) for f in members for e in f.edges for p in e.points]
        h0, h1 = min(heights), max(heights)
        base = _sub(surface.origin, _mul(axis, _dot(surface.origin, axis)))
        center = _add(base, _mul(axis, (h0 + h1) / 2))
        full = sweep >= _FULL_TURN_DEG - _ANGLE_TOL_DEG
        features.append(
            CylinderFeature(
                kind=_CYLINDER_KIND[(bool(concave), full)],
                diameter=_r(surface.radius * 2 * scale),
                radius=_r(surface.radius * scale),
                axis=axis,
                center=_r(_mul(center, scale)),
                length=_r((h1 - h0) * scale),
                sweep_deg=_r(sweep),
                faces=len(members),
            )
        )
    return sorted(features, key=lambda c: (c.kind, c.center))
