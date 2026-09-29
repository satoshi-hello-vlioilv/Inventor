"""B-rep 層: SAB エンティティからトポロジを辿り、設計者が読める寸法情報にまとめる。

トポロジは ACIS と同じ ``body → lump → shell → face → loop → coedge → edge → vertex``。
面・稜線には解析曲面／解析曲線（plane, cone, straight, ellipse …）か、交線の B スプライン（intcurve）が紐づく。
面には Inventor が属性（ねじ・フィーチャの由来など）を付ける。
座標は SAB ヘッダの ``mm_per_unit``（Inventor は内部単位 cm なので 10.0）で mm に換算する。
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

from .sab import Entity, SabDocument, Tag
from .vec import Vec, add, cross, dot, length, mul, reject, sub, unit

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
_THREAD_TAG = "INV_NMX_THREAD_TAG"
_ATTRIB_NEXT = 1  # 属性の refs: [attrib, next, prev, owner]（同じ持ち主の属性が next でつながる）
_ARC_STEP = math.pi / 32  # 円弧のサンプリング刻み（外接箱・表示用の折れ線）
_SPLINE_STEPS = 4  # B スプラインの 1 区間（ノット間）の分割数
_PERIODIC = 2
_FULL_TURN_DEG = 360.0
_HALF_TURN_DEG = 180.0
_ANGLE_TOL_DEG = 1e-3
_OVERLAP_TOL = 1e-7  # 軸方向の範囲の重なりとみなす長さ（モデル単位）。端で接するだけの面は重なりとしない
_ROUND = 6


# ---- ベクトル演算の補助 ------------------------------------------------------
def _canonical_direction(a: Vec) -> Vec:
    """軸の向きを正規化する（符号違いの同一軸を同一視するため）。"""
    a = unit(a)
    first = next((c for c in a if abs(c) > 1e-9), 0.0)
    return mul(a, -1.0) if first < 0 else a


def _r(v, digits: int = _ROUND):
    if isinstance(v, float):
        return round(v, digits) + 0.0  # -0.0 を 0.0 に揃える
    if isinstance(v, tuple):
        return tuple(_r(x, digits) for x in v)
    return v


def _extent(values) -> tuple[float, float]:
    values = list(values)
    return min(values), max(values)


def _divide(a: float, b: float, n: int) -> list[float]:
    """等分点 a → b（両端を含む n + 1 点）。"""
    return [a + (b - a) * i / n for i in range(n + 1)]


# ---- 解析曲線・曲面 -----------------------------------------------------------
@dataclass(frozen=True)
class Spline:
    """交線など（intcurve）が持つ B スプライン（ACIS の bs3_curve）。ノットは標準の形（両端が次数 + 1 重）。"""

    degree: int
    knots: tuple[float, ...]
    points: tuple[Vec, ...]
    weights: tuple[float, ...]
    period: float  # 周期的なら 1 周期のパラメータの長さ、そうでなければ 0
    reversed: bool  # 曲線の向きが B スプラインと逆（曲線のパラメータ t は B スプラインの -t）

    @classmethod
    def of(cls, e: Entity) -> Spline | None:
        """並び: "nubs"（有理なら "nurbs"）, 次数, 閉じ方, ノット数, (ノット値, 重複度) × ノット数,
        制御点 (x, y, z[, 重み]) × (重複度の合計 − 次数 + 1)。読めない形なら None。
        ACIS は両端のノットを「次数」重で持つので、標準の形（次数 + 1 重）に揃える。
        """
        f = e.fields
        i = next((k for k, (t, v) in enumerate(f) if t == Tag.IDENT and v in ("nubs", "nurbs")), None)
        if i is None:
            return None
        rational = f[i][1] == "nurbs"
        i += 1

        def take(*tags):
            nonlocal i
            if i < len(f) and f[i][0] in tags:
                i += 1
                return f[i - 1][1]
            return math.nan

        degree = take(Tag.LONG)
        closure = take(Tag.ENUM)  # 0: 開いている, 1: 閉じている, 2: 周期的（パラメータが周期で巡る。制御点は全て並ぶ）
        count = take(Tag.LONG)
        knots: list[float] = []
        for _ in range(count if isinstance(count, int) else 0):
            value, multiplicity = take(Tag.DOUBLE), take(Tag.LONG)
            knots += [value] * (multiplicity if isinstance(multiplicity, int) else 0)
        points, weights = [], []
        if isinstance(degree, int):
            for _ in range(len(knots) - degree + 1):
                points.append((take(Tag.DOUBLE), take(Tag.DOUBLE), take(Tag.DOUBLE)))
                weights.append(take(Tag.DOUBLE) if rational else 1)
        values = [*knots, *(c for p in points for c in p), *weights]
        if not isinstance(degree, int) or degree < 1 or len(points) <= degree or any(math.isnan(v) for v in values):
            return None
        period = knots[-1] - knots[0] if closure == _PERIODIC else 0
        return cls(degree, (knots[0], *knots, knots[-1]), tuple(points), tuple(weights), period, bool(e.bools and e.bools[0]))

    def point(self, t: float) -> Vec:
        """de Boor 法（有理なら同次座標で計算する）。周期的なら t を 1 周期の範囲に戻す。"""
        p, u, points, weights = self.degree, self.knots, self.points, self.weights
        if self.reversed:
            t = -t
        if self.period:
            t = u[0] + (t - u[0]) % self.period
        k = p
        while k < len(points) - 1 and t >= u[k + 1]:
            k += 1
        d = []
        for j in range(p + 1):
            (x, y, z), w = points[k - p + j], weights[k - p + j]
            d.append([x * w, y * w, z * w, w])
        for r in range(1, p + 1):
            for j in range(p, r - 1, -1):
                i = k - p + j
                span = u[i + p - r + 1] - u[i]
                a = 0 if span == 0 else (t - u[i]) / span
                d[j] = [(1 - a) * d[j - 1][m] + a * d[j][m] for m in range(4)]
        x, y, z, w = d[p]
        return (x / w, y / w, z / w)

    def sample(self, t0: float, t1: float) -> list[Vec]:
        """ノットの位置で区切り、各区間を等分する（曲がり具合はノットの細かさに表れている）。周期的なら周期ずらしたノットも使う。"""
        lo, hi = min(t0, t1), max(t0, t1)
        unique = list(dict.fromkeys(self.knots))
        base = [(-k if self.reversed else k) for k in (unique[:-1] if self.period else unique)]  # 周期的なら末尾 = 先頭 + 周期
        shifts = [0.0]
        if self.period:
            kmin, kmax = _extent(base)
            first, last = math.floor((lo - kmax) / self.period), math.ceil((hi - kmin) / self.period)
            shifts = [m * self.period for m in range(first, last + 1)]
        inside = sorted((t for d in shifts for t in (k + d for k in base) if lo < t < hi), reverse=t1 < t0)
        breaks = [t0, *inside, t1]
        params = [t for i in range(1, len(breaks)) for t in _divide(breaks[i - 1], breaks[i], _SPLINE_STEPS)[(1 if i > 1 else 0):]]
        return [self.point(t) for t in params]


@dataclass(frozen=True)
class Curve:
    kind: str  # line | ellipse | spline | <生の型名>
    origin: Vec | None = None
    direction: Vec | None = None  # line: 方向, ellipse: 法線
    major: Vec | None = None
    ratio: float = 1.0
    spline: Spline | None = None

    @classmethod
    def of(cls, e: Entity | None) -> Curve:
        if e is None:
            return cls("none")
        if e.type == "straight-curve":
            return cls("line", e.positions[0], e.vectors[0])
        if e.type == "ellipse-curve":
            return cls("ellipse", e.positions[0], e.vectors[0], e.vectors[1], e.doubles[0])
        if e.type == "intcurve-curve":
            spline = Spline.of(e)
            return cls("spline", spline=spline) if spline else cls(e.type)
        return cls(e.type)

    def point(self, t: float) -> Vec:
        if self.kind == "line":
            return add(self.origin, mul(self.direction, t))
        if self.kind == "spline":
            return self.spline.point(t)
        minor = mul(cross(unit(self.direction), self.major), self.ratio)
        return add(self.origin, add(mul(self.major, math.cos(t)), mul(minor, math.sin(t))))

    def sample(self, t0: float, t1: float) -> list[Vec]:
        if self.kind == "line":
            return [self.point(t0), self.point(t1)]
        if self.kind == "ellipse":
            return [self.point(t) for t in _divide(t0, t1, max(2, math.ceil(abs(t1 - t0) / _ARC_STEP)))]
        if self.kind == "spline":
            return self.spline.sample(t0, t1)
        return []


@dataclass(frozen=True)
class Surface:
    kind: str  # plane | cylinder | cone | <生の型名>
    origin: Vec | None = None
    direction: Vec | None = None  # plane: 法線, cylinder/cone: 軸
    major: Vec | None = None  # cylinder/cone: origin を通る断面の半径方向（角度の基準）
    radius: float | None = None  # cylinder/cone: origin を通る断面の半径
    slope: float = 0.0  # cone: 軸方向の高さ h あたりの半径の増え方。ρ(h) = radius + slope・h
    normal_outward: bool | None = None  # cylinder/cone: 曲面法線が軸から離れる向きか

    @classmethod
    def of(cls, e: Entity | None) -> Surface:
        if e is None:
            return cls("none")
        if e.type == "plane-surface":
            return cls("plane", e.positions[0], e.vectors[0])
        if e.type == "cone-surface":
            # doubles: ratio, [u 範囲], sin(半頂角), cos(半頂角), u スケール。
            # 半径は軸方向の高さ h（origin から軸の向きに測る）に比例して変わる: ρ(h) = |major| + h・sin / cos
            sin_angle, cos_angle = e.doubles[-3], e.doubles[-2]
            circular = abs(e.doubles[0] - 1.0) < 1e-12
            kind = e.type if not circular else "cylinder" if abs(sin_angle) < 1e-12 else "cone"
            slope = sin_angle / cos_angle if kind == "cone" else 0.0
            return cls(kind, e.positions[0], e.vectors[0], e.vectors[1], length(e.vectors[1]), slope, cos_angle >= 0)
        return cls(e.type)


@dataclass(frozen=True)
class Thread:
    """ねじ（INV_NMX_THREAD_TAG）。穴・ねじフィーチャが面に付ける。

    doubles: ピッチ, ねじ山の高さ / positions: ねじの始点, 終点, … / strings: 名前, 呼び径, 呼び, 種類, , , 等級, …
    始点・終点の座標系はフィーチャごとに異なる（穴の中心と一致しないことがある）ので、使うのは両者の距離（ねじ長さ）だけ。
    """

    designation: str
    type: str
    grade: str
    pitch: float
    length: float

    @classmethod
    def of(cls, attrib: Entity) -> Thread | None:
        s = attrib.strings
        designation = s[2] if len(s) > 2 else ""
        if not designation or len(attrib.positions) < 2:
            return None
        start, end = attrib.positions[0], attrib.positions[1]
        return cls(designation, s[3] if len(s) > 3 else "", s[6] if len(s) > 6 else "", attrib.doubles[0], length(sub(end, start)))


# ---- トポロジ ----------------------------------------------------------------
@dataclass(frozen=True)
class Edge:
    index: int
    curve: Curve
    t0: float
    t1: float
    points: tuple[Vec, ...]  # 始点 → 終点の順に並んだ折れ線

    @property
    def sweep_deg(self) -> float:
        return math.degrees(abs(self.t1 - self.t0)) if self.curve.kind == "ellipse" else 0.0


@dataclass(frozen=True)
class Face:
    index: int
    surface: Surface
    reversed: bool
    edges: tuple[Edge, ...]
    loops: tuple[tuple[Vec, ...], ...]  # 境界ループ（閉じた折れ線、末尾は先頭と同じ点）
    threads: tuple[Thread, ...] = ()

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

    def attributes(self, e: Entity) -> list[Entity]:
        """面などに付いた属性（持ち主ごとに next でつながったリスト）。"""
        out, seen = [], set()
        a = self.ref(e, "attrib")
        while a is not None and a.index not in seen:
            seen.add(a.index)
            out.append(a)
            a = self.doc.get(a.refs[_ATTRIB_NEXT])
        return out

    def edge(self, e: Entity) -> Edge:
        curve = Curve.of(self.ref(e, "curve"))
        t0, t1 = e.doubles[0], e.doubles[1]
        against_curve = bool(e.bools and e.bools[0])
        if against_curve:  # 稜線が曲線と逆向きなら、曲線上のパラメータは符号反転した区間
            t0, t1 = -t1, -t0
        points = curve.sample(t0, t1)
        if against_curve:
            points.reverse()
        ends = [self.vertex_point(self.ref(e, s)) for s in ("start", "end")]
        if not points:  # 読めない曲線の稜線は端点だけで表す
            points = [p for p in ends if p is not None]
        else:  # 端点は頂点の座標にそろえる（交線の B スプラインは近似で、端が許容差の範囲でずれうる。隣の稜線と点を合わせるため）
            for i, p in enumerate(ends):
                if p is not None:
                    points[-1 if i else 0] = p
        return Edge(e.index, curve, t0, t1, tuple(points))

    def loop_polyline(self, loop: Entity) -> tuple[Vec, ...]:
        """ループを 1 本の閉じた折れ線にする（コエッジが逆向きなら稜線の点列を反転）。"""
        out: list[Vec] = []
        for coedge in self.chain(self.ref(loop, "coedge")):
            points = self.edge(self.ref(coedge, "edge")).points
            if coedge.bools and coedge.bools[0]:
                points = points[::-1]
            out.extend(points[1:] if out else points)
        return tuple(out)

    def face(self, e: Entity) -> Face:
        edges = tuple(self.edge(self.ref(c, "edge")) for c in self.coedges(e))
        loops = tuple(self.loop_polyline(loop) for loop in self.loops(e))
        threads = (Thread.of(a) for a in self.attributes(e) if a.strings and a.strings[0] == _THREAD_TAG)
        surface = Surface.of(self.ref(e, "surface"))
        return Face(e.index, surface, bool(e.bools and e.bools[0]), edges, loops, tuple(t for t in threads if t))

    def is_closed(self, body: Entity) -> bool:
        return all(
            self.ref(c, "partner") is not None for f in self.faces(body) for c in self.coedges(f)
        )


# ---- 要約 --------------------------------------------------------------------
# 円筒の呼び名: 凹凸と周回角で決める。半周を超える円弧は直径（Φ）、半周以下は半径（R）で表す（JIS の寸法記入の規則）
_CYLINDER_KIND = {  # (凹か, 半周を超えるか) → 形状の呼び名
    (True, True): "hole",
    (False, True): "boss",
    (False, False): "round",
    (True, False): "inner_round",
}


@dataclass(frozen=True)
class CylinderFeature:
    """同一の円筒面の上の 1 つの形状要素。凹凸と周回角から 穴/外径/角R/隅R を判別し、ねじがあれば添える。"""

    kind: str
    diameter: float
    radius: float
    axis: Vec
    center: Vec
    length: float
    sweep_deg: float
    face_ids: tuple[int, ...]
    thread: dict | None = None  # designation・type・class・pitch・lengths（mm）


@dataclass(frozen=True)
class ConeFeature:
    """円錐面（ドリルの先端・皿・面取りなど）。頂角と、両端の直径を示す。"""

    kind: str
    concave: bool
    angle_deg: float
    diameters: tuple[float, float]
    axis: Vec
    center: Vec
    length: float
    face_ids: tuple[int, ...]


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
    cones: tuple[ConeFeature, ...] = ()


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
        size=_r(sub(hi, lo)),
        cylinders=tuple(_cylinder_features(faces, scale)),
        cones=tuple(_cone_features(faces, scale)),
    )


def _connected_groups(faces: list[Face], key_of) -> list[list[Face]]:
    """同じ曲面の上にある面を、1 つの形状要素ごとにまとめる。次のどちらかなら同じ要素とみなす。

    - 稜線を共有している（1 つの穴が 2 枚の半円筒に分かれている場合など）
    - 軸方向の範囲が重なっている（切り欠きで周方向に分断された外周など）

    同じ軸・同じ径でも軸方向に離れた面（向かい合う壁のねじ穴など）は別の要素になる。
    """
    by_key: dict = {}
    for f in faces:
        key = key_of(f)
        if key is not None:
            by_key.setdefault(key, []).append(f)
    groups = []
    for members in by_key.values():
        parent = list(range(len(members)))

        def find(i: int) -> int:
            if parent[i] != i:
                parent[i] = find(parent[i])
            return parent[i]

        def union(i: int, j: int) -> None:
            parent[find(i)] = find(j)

        owner: dict[int, int] = {}  # 稜線 → 最初に見つけた面
        for i, f in enumerate(members):
            for e in f.edges:
                if e.index in owner:
                    union(i, owner[e.index])
                else:
                    owner[e.index] = i
        axis = _canonical_direction(members[0].surface.direction)
        spans = [_extent(dot(p, axis) for e in f.edges for p in e.points) for f in members]
        for i, (a0, a1) in enumerate(spans):
            for j, (b0, b1) in enumerate(spans):
                if j > i and min(a1, b1) - max(a0, b0) > _OVERLAP_TOL:
                    union(i, j)
        roots: dict[int, list[Face]] = {}
        for i, f in enumerate(members):
            roots.setdefault(find(i), []).append(f)
        groups += roots.values()
    return groups


def _revolved_extent(members: list[Face], scale: float):
    """回転面の要素に共通する値: 軸（向きを正規化）、中心（軸方向の範囲の中央の軸上の点）、長さ、軸からの距離の範囲。"""
    surface = members[0].surface
    axis = _r(_canonical_direction(surface.direction))
    points = [p for f in members for e in f.edges for p in e.points]
    h0, h1 = _extent(dot(p, axis) for p in points)
    r0, r1 = _extent(length(reject(sub(p, surface.origin), axis)) for p in points)
    center = add(reject(surface.origin, axis), mul(axis, (h0 + h1) / 2))
    return axis, _r(mul(center, scale)), _r((h1 - h0) * scale), (r0 * scale, r1 * scale)


def _face_sweep_deg(face: Face) -> float:
    """面の円弧が囲む角度。同じ円（中心・向き・半径）の上の円弧は足し合わせ（STEP は 1 周の円を頂点で分けて持つことがある）、
    円ごとの最大を 360° で頭打ちにする。角の R の上下の縁のように別の円の円弧は足さない。"""
    circles: dict[tuple, float] = {}
    for edge in face.edges:
        if edge.curve.kind != "ellipse":
            continue
        c = edge.curve
        key = (_r(c.origin, 5), _r(_canonical_direction(c.direction)), _r(length(c.major), 5))
        circles[key] = circles.get(key, 0.0) + edge.sweep_deg
    return min(_FULL_TURN_DEG, max(circles.values(), default=0.0))


def _cylinder_features(faces: list[Face], scale: float) -> list[CylinderFeature]:
    def key_of(f: Face):
        s = f.surface
        if s.kind != "cylinder":
            return None
        axis = _canonical_direction(s.direction)
        return (_r(s.radius, 5), _r(axis), _r(reject(s.origin, axis), 5), f.concave)  # 軸上で原点に最も近い点

    features = []
    for members in _connected_groups(faces, key_of):
        surface = members[0].surface
        sweep = min(_FULL_TURN_DEG, sum(_face_sweep_deg(f) for f in members))
        axis, center, extent_length, _ = _revolved_extent(members, scale)
        threads = [t for f in members for t in f.threads]
        thread = (
            {
                "designation": threads[0].designation,
                "type": threads[0].type,
                "class": threads[0].grade,
                "pitch": _r(threads[0].pitch * scale),
                "lengths": [_r(t.length * scale) for t in threads],
            }
            if threads
            else None
        )
        features.append(
            CylinderFeature(
                kind=_CYLINDER_KIND[(bool(members[0].concave), sweep > _HALF_TURN_DEG + _ANGLE_TOL_DEG)],
                diameter=_r(surface.radius * 2 * scale),
                radius=_r(surface.radius * scale),
                axis=axis,
                center=center,
                length=extent_length,
                sweep_deg=_r(sweep),
                face_ids=tuple(f.index for f in members),
                thread=thread,
            )
        )
    return sorted(features, key=lambda c: (c.kind, c.center))


def _cone_features(faces: list[Face], scale: float) -> list[ConeFeature]:
    def key_of(f: Face):
        s = f.surface
        if s.kind != "cone":
            return None
        apex = add(s.origin, mul(unit(s.direction), -s.radius / s.slope))
        return (_r(abs(s.slope), 9), _r(_canonical_direction(s.direction)), _r(apex, 5), f.concave)

    features = []
    for members in _connected_groups(faces, key_of):
        axis, center, extent_length, radii = _revolved_extent(members, scale)
        features.append(
            ConeFeature(
                kind="cone",
                concave=bool(members[0].concave),
                angle_deg=_r(2 * math.atan(abs(members[0].surface.slope)) * 180 / math.pi),
                diameters=_r(tuple(r * 2 for r in radii)),
                axis=axis,
                center=center,
                length=extent_length,
                face_ids=tuple(f.index for f in members),
            )
        )
    return sorted(features, key=lambda c: (c.kind, c.center))
