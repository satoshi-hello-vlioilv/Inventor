"""部品の形を STEP の B-rep（面・稜線・頂点のつながりで表した立体）にする。Inventor を使わない。

- 回転体: 断面の直線・円弧を Y 軸まわりに回した面（円筒・円錐・平面・球・トーラス）。一周する面は半分ずつの 2 面に割る
  （Inventor の STEP と同じ。継ぎ目の無い一周の面を読めない読み手があるため）。360° 未満は XY 平面に対して対称に回し、両端は平面
- 押し出し: 断面を Z 方向に ±長さ/2。側面（平面・円筒）と両端の平面。円は半円 2 つに割る
- 三角形（近似の部品・面取り付きの押し出しの代わり）: 同じ平面の隣り合う三角形を 1 つの平らな面にまとめる

向きの決まり: 面の外向きの法線から見て、外周の輪は反時計回り、穴の輪は時計回り。稜線はどの面でも 2 回、逆向きに使う。
面の法線（same_sense）は、曲面の自然な法線（軸・中心から離れる向き）と外向きの法線を比べて決める。
"""
from __future__ import annotations

import math
from collections import defaultdict

from .p21 import DERIVED, P21Writer, Ref
from .spec import Mesh, Part, Segment, arc_angles, loop_integrals

EPS = 1e-9  # 軸上の点とみなす半径（mm）


class Unsupported(ValueError):
    """この形は B-rep にできない（三角形で書く）。何も書く前に投げる（書きかけの実体を残さない）"""


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _unit(a):
    n = math.sqrt(_dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


def _perpendicular(n):
    helper = (1.0, 0.0, 0.0) if abs(n[0]) < 0.9 else (0.0, 1.0, 0.0)
    return _unit(_cross(helper, n))


class Topology:
    """頂点・稜線・面を登録し、閉じた立体（MANIFOLD_SOLID_BREP）にする。頂点と稜線は鍵で 1 つにまとめる。"""

    def __init__(self, w: P21Writer) -> None:
        self.w = w
        self.vertices: dict = {}
        self.edges: dict = {}  # 鍵 → (EDGE_CURVE, 始点の鍵)
        self.faces: list[Ref] = []

    # ---- 幾何 ----
    def point(self, p) -> Ref:
        return self.w.add("CARTESIAN_POINT", "", tuple(float(v) + 0.0 for v in p), dedupe=True)

    def direction(self, d) -> Ref:
        return self.w.add("DIRECTION", "", tuple(float(v) + 0.0 for v in _unit(d)), dedupe=True)

    def placement(self, origin, axis, refdir) -> Ref:
        return self.w.add("AXIS2_PLACEMENT_3D", "", self.point(origin), self.direction(axis), self.direction(refdir), dedupe=True)

    def line(self, a, b) -> Ref:
        d = _sub(b, a)
        return self.w.add("LINE", "", self.point(a), self.w.add("VECTOR", "", self.direction(d), math.sqrt(_dot(d, d))))

    def circle(self, center, axis, refdir, radius: float) -> Ref:
        return self.w.add("CIRCLE", "", self.placement(center, axis, refdir), float(radius))

    # ---- 位相 ----
    def vertex(self, key, p) -> None:
        if key not in self.vertices:
            self.vertices[key] = self.w.add("VERTEX_POINT", "", self.point(p))

    def edge(self, key, start, end, curve: Ref, same_sense: bool) -> None:
        """稜線（まだ無ければ作る）: start → end の向きで、curve の向きと同じなら same_sense"""
        if key not in self.edges:
            self.edges[key] = (self.w.add("EDGE_CURVE", "", self.vertices[start], self.vertices[end], curve, same_sense), start)

    def use(self, key, start) -> Ref:
        """稜線を start 側から使う（ORIENTED_EDGE）"""
        edge, first = self.edges[key]
        return self.w.add("ORIENTED_EDGE", "", DERIVED, DERIVED, edge, first == start)

    def face(self, surface: Ref, same_sense: bool, loops: list[list[tuple]]) -> None:
        """loops: 最初が外周。輪は (稜線の鍵, その稜線を使い始める頂点の鍵) の並び"""
        bounds = []
        for i, loop in enumerate(loops):
            ring = self.w.add("EDGE_LOOP", "", [self.use(key, start) for key, start in loop])
            bounds.append(self.w.add("FACE_OUTER_BOUND" if i == 0 else "FACE_BOUND", "", ring, True))
        self.faces.append(self.w.add("ADVANCED_FACE", "", bounds, surface, same_sense))

    def solid(self, name: str) -> Ref:
        shell = self.w.add("CLOSED_SHELL", "", self.faces)
        return self.w.add("MANIFOLD_SOLID_BREP", name, shell)


# ---- 断面の下ごしらえ -------------------------------------------------------------
def _split_circles(loop) -> list[Segment]:
    """円は半円 2 つにする（頂点を持たせる）"""
    out = []
    for s in loop:
        if s.type != "circle":
            out.append(s)
            continue
        (cx, cy), r = s.center, s.radius
        east, west = (cx + r, cy), (cx - r, cy)
        out += [Segment("arc", east, west, s.center, True), Segment("arc", west, east, s.center, True)]
    return out


def _oriented(loop, ccw: bool) -> list[Segment]:
    loop = _split_circles(loop)
    if (loop_integrals(loop)["area"] > 0) != ccw:
        loop = [s.reversed() for s in reversed(loop)]
    return loop


def _midpoint(s: Segment):
    """部分の中点と、進む向きの接線"""
    if s.type == "line":
        (x0, y0), (x1, y1) = s.a, s.b
        return ((x0 + x1) / 2, (y0 + y1) / 2), (x1 - x0, y1 - y0)
    a0, sweep, r = arc_angles(s)
    t = a0 + sweep / 2
    point = (s.center[0] + r * math.cos(t), s.center[1] + r * math.sin(t))
    sign = 1 if sweep > 0 else -1
    return point, (-math.sin(t) * sign, math.cos(t) * sign)


def _radius(s: Segment) -> float:
    return math.dist(s.a, s.center)


# ---- 回転体 --------------------------------------------------------------------
def revolve(topo: Topology, part: Part) -> None:
    """断面（x = 半径、y = 軸方向）を Y 軸まわりに回す。点 (r, y) を角度 φ 回した位置は (r cos φ, y, −r sin φ)"""
    loop = _oriented(part.loops[0], ccw=False)  # 時計回り: 進む向きの左が外（外向きの法線 = ∂断面 × ∂φ）
    for s in loop:
        # 円弧の円が軸と交わる（中心が軸の反対側・軸と円の間）: 紡錘形のトーラス。規格の DEGENERATE_TOROIDAL_SURFACE は読み手の扱いが
        # そろわず（OpenCascade は体積を読み違えた）、TOROIDAL_SURFACE の半径は正でなければならない。変換データは元の三角形を添えている
        if s.type == "arc" and abs(s.center[0]) > EPS and s.center[0] < _radius(s) - 1e-9:
            raise Unsupported("断面の円弧の円が軸と交わる回転面（紡錘形のトーラス。たる形・りんご形）")
    full = part.full_revolve
    theta = math.radians(part.angle_deg)
    angles = [0.0, math.pi] if full else [-theta / 2, theta / 2]
    sectors = [(0, 1), (1, 0)] if full else [(0, 1)]
    at = lambda r, y, phi: (r * math.cos(phi), y, -r * math.sin(phi))  # noqa: E731
    on_axis = [abs(s.a[0]) <= EPS for s in loop]
    n = len(loop)
    # 軸の上の直線（面を作らない）。両端が軸上でも円弧は球面の子午線なので面を作る
    along_axis = [s.type == "line" and on_axis[i] and on_axis[(i + 1) % n] for i, s in enumerate(loop)]

    def vkey(i, k):
        return ("axis", i) if on_axis[i] else ("v", i, k)

    for i, s in enumerate(loop):
        for k, phi in enumerate(angles):
            topo.vertex(vkey(i, k), at(s.a[0], s.a[1], phi))

    # 断面の部分を角度 φ に置いた稜線（子午線）
    def meridian(i, k):
        s, j = loop[i], (i + 1) % n
        phi = angles[k]
        a, b = at(*s.a, phi), at(*s.b, phi)
        if s.type == "line":
            curve, same = topo.line(a, b), True
        else:
            normal = (math.sin(phi), 0.0, math.cos(phi))  # 子午面の法線（この向きで見て、断面の反時計回り = 円の正の向き）
            curve, same = topo.circle(at(s.center[0], s.center[1], phi), normal, (math.cos(phi), 0.0, -math.sin(phi)), _radius(s)), s.ccw
        topo.edge(("m", i, k), vkey(i, k), vkey(j, k), curve, same)
        return ("m", i, k)

    # 断面の頂点を回した円弧（角度 k → k2）
    def arc(i, k, k2):
        r, y = loop[i].a
        topo.edge(("c", i, k), vkey(i, k), vkey(i, k2), topo.circle((0.0, y, 0.0), (0.0, 1.0, 0.0), (1.0, 0.0, 0.0), r), True)
        return ("c", i, k)

    for i, s in enumerate(loop):
        j = (i + 1) % n
        if along_axis[i]:
            continue  # 軸の上の直線は面を作らない（360° 未満では両端の平面の稜線になる）
        surface, natural = _revolve_surface(topo, s)
        (mr, my), (dr, dy) = _midpoint(s)
        outward = (-dy, dr)  # 進む向きの左
        same = outward[0] * natural(mr, my)[0] + outward[1] * natural(mr, my)[1] > 0
        for k, k2 in sectors:
            ring = [(meridian(i, k), vkey(i, k))]
            if not on_axis[j]:
                ring.append((arc(j, k, k2), vkey(j, k)))
            ring.append((meridian(i, k2), vkey(j, k2)))
            if not on_axis[i]:
                ring.append((arc(i, k, k2), vkey(i, k2)))
            topo.face(surface, same, [ring])

    if full:
        return
    # 360° 未満: 両端の平面。終わりの端（+θ/2）は断面の順、始めの端（−θ/2）は逆順
    for k, sign in ((1, 1), (0, -1)):
        phi = angles[k]
        ring = []
        for i, s in enumerate(loop):
            j = (i + 1) % n
            if along_axis[i]:
                key = ("x", i)
                if key not in topo.edges:
                    topo.edge(key, vkey(i, 0), vkey(j, 0), topo.line(at(*s.a, 0.0), at(*s.b, 0.0)), True)
            else:
                key = meridian(i, k)
            ring.append((key, vkey(i, k), vkey(j, k)))
        if sign < 0:
            ring = [(key, end, start) for key, start, end in reversed(ring)]
        tangent = (-math.sin(phi), 0.0, -math.cos(phi))  # 角度が増える向き
        normal = tuple(sign * v for v in tangent)
        plane = topo.w.add("PLANE", "", topo.placement((0.0, 0.0, 0.0), normal, (math.cos(phi), 0.0, -math.sin(phi))))
        topo.face(plane, True, [[(key, start) for key, start, _ in ring]])


def _revolve_surface(topo: Topology, s: Segment):
    """断面の部分を回した面と、断面の平面での自然な法線の向き（関数）"""
    Y = (0.0, 1.0, 0.0)
    X = (1.0, 0.0, 0.0)
    if s.type == "arc":
        (cr, cy), radius = s.center, _radius(s)
        natural = lambda r, y: (r - cr, y - cy)  # noqa: E731  中心（管の中心の円）から離れる向き
        if abs(cr) <= EPS:
            return topo.w.add("SPHERICAL_SURFACE", "", topo.placement((0.0, cy, 0.0), Y, X), radius), natural
        return topo.w.add("TOROIDAL_SURFACE", "", topo.placement((0.0, cy, 0.0), Y, X), cr, radius), natural
    (r0, y0), (r1, y1) = s.a, s.b
    if abs(r1 - r0) <= EPS:
        return topo.w.add("CYLINDRICAL_SURFACE", "", topo.placement((0.0, 0.0, 0.0), Y, X), r0), lambda r, y: (1.0, 0.0)
    if abs(y1 - y0) <= EPS:
        return topo.w.add("PLANE", "", topo.placement((0.0, y0, 0.0), Y, X)), lambda r, y: (0.0, 1.0)
    # 円錐: 半径の大きい端に置き、軸の向きは半径が増える向き（半頂角は 0〜90° の間）
    rp, yp = (r0, y0) if r0 >= r1 else (r1, y1)
    rising = (r1 - r0) / (y1 - y0) > 0
    axis = Y if rising else (0.0, -1.0, 0.0)
    slope = abs((r1 - r0) / (y1 - y0))
    cone = topo.w.add("CONICAL_SURFACE", "", topo.placement((0.0, yp, 0.0), axis, X), rp, math.atan(slope))
    return cone, lambda r, y: (1.0, -slope * axis[1])


# ---- 押し出し ------------------------------------------------------------------
def extrude(topo: Topology, part: Part) -> None:
    """断面（外周は反時計回り、穴は時計回り）を Z 方向に ±長さ/2"""
    if part.chamfers:
        raise Unsupported("面取り付きの押し出し")
    loops = [_oriented(loop, ccw=(i == 0)) for i, loop in enumerate(part.loops)]
    z = (-part.distance / 2, part.distance / 2)
    for li, loop in enumerate(loops):
        for i, s in enumerate(loop):
            for side in (0, 1):
                topo.vertex(("v", li, i, side), (s.a[0], s.a[1], z[side]))

    def edge(li, i, side):
        loop = loops[li]
        s, j = loop[i], (i + 1) % len(loop)
        a, b = (s.a[0], s.a[1], z[side]), (s.b[0], s.b[1], z[side])
        if s.type == "line":
            curve, same = topo.line(a, b), True
        else:
            curve, same = topo.circle((s.center[0], s.center[1], z[side]), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0), _radius(s)), s.ccw
        topo.edge(("e", li, i, side), ("v", li, i, side), ("v", li, j, side), curve, same)
        return ("e", li, i, side)

    def rise(li, i):
        s = loops[li][i]
        topo.edge(("u", li, i), ("v", li, i, 0), ("v", li, i, 1), topo.line((s.a[0], s.a[1], z[0]), (s.a[0], s.a[1], z[1])), True)
        return ("u", li, i)

    Z = (0.0, 0.0, 1.0)
    for li, loop in enumerate(loops):
        for i, s in enumerate(loop):
            j = (i + 1) % len(loop)
            (mx, my), (dx, dy) = _midpoint(s)
            outward = (dy, -dx)  # 進む向きの右（材料は左）
            if s.type == "line":
                surface = topo.w.add("PLANE", "", topo.placement((s.a[0], s.a[1], 0.0), (outward[0], outward[1], 0.0), (dx, dy, 0.0)))
                same = True
            else:
                surface = topo.w.add("CYLINDRICAL_SURFACE", "", topo.placement((s.center[0], s.center[1], 0.0), Z, (1.0, 0.0, 0.0)), _radius(s))
                same = outward[0] * (mx - s.center[0]) + outward[1] * (my - s.center[1]) > 0
            ring = [
                (edge(li, i, 0), ("v", li, i, 0)),
                (rise(li, j), ("v", li, j, 0)),
                (edge(li, i, 1), ("v", li, j, 1)),
                (rise(li, i), ("v", li, i, 1)),
            ]
            topo.face(surface, same, [ring])
    top = topo.w.add("PLANE", "", topo.placement((0.0, 0.0, z[1]), Z, (1.0, 0.0, 0.0)))
    topo.face(top, True, [[(("e", li, i, 1), ("v", li, i, 1)) for i in range(len(loop))] for li, loop in enumerate(loops)])
    bottom = topo.w.add("PLANE", "", topo.placement((0.0, 0.0, z[0]), (0.0, 0.0, -1.0), (1.0, 0.0, 0.0)))
    topo.face(bottom, True, [
        [(("e", li, i, 0), ("v", li, (i + 1) % len(loop), 0)) for i in reversed(range(len(loop)))] for li, loop in enumerate(loops)
    ])


# ---- 三角形 --------------------------------------------------------------------
PLANE_TOL = 1e-5  # 同じ平面とみなす距離（mm）: まとめた面の全ての頂点が、最初の三角形の平面からこれ以内（STEP に書く精度と同じ）


def faceted(topo: Topology, mesh: Mesh, tol: float = PLANE_TOL) -> None:
    """外向きにそろった閉じた三角形を、同じ平面の隣り合う三角形をまとめた平らな面の立体にする"""
    P = mesh.positions
    normals, offsets = [], []
    for i, j, k in mesh.triangles:
        n = _cross(_sub(P[j], P[i]), _sub(P[k], P[i]))
        length = math.sqrt(_dot(n, n))
        if length == 0:
            raise Unsupported("面積の無い三角形がある")
        n = (n[0] / length, n[1] / length, n[2] / length)
        normals.append(n)
        offsets.append(_dot(n, P[i]))
    edge_owner: dict[tuple[int, int], int] = {}
    for t, tri in enumerate(mesh.triangles):
        for e in range(3):
            edge_owner[(tri[e], tri[(e + 1) % 3])] = t
    # 同じ平面の隣どうしを 1 つの領域にまとめる
    region = [-1] * len(mesh.triangles)
    regions = []
    for seed in range(len(mesh.triangles)):
        if region[seed] >= 0:
            continue
        rid, stack, members = len(regions), [seed], []
        region[seed] = rid
        while stack:
            t = stack.pop()
            members.append(t)
            tri = mesh.triangles[t]
            for e in range(3):
                u = edge_owner.get((tri[(e + 1) % 3], tri[e]))
                if u is None:
                    raise Unsupported("閉じていない三角形（稜線の相手が無い）")
                if region[u] < 0 and _dot(normals[u], normals[seed]) > 0 and all(
                    abs(_dot(normals[seed], P[v]) - offsets[seed]) <= tol for v in mesh.triangles[u]
                ):
                    region[u] = rid
                    stack.append(u)
        regions.append(members)

    for i, p in enumerate(P):
        topo.vertex(("p", i), p)
    for rid, members in enumerate(regions):
        # 領域の縁（相手の三角形が別の領域の稜線）を輪にする
        nxt = defaultdict(list)
        for t in members:
            tri = mesh.triangles[t]
            for e in range(3):
                a, b = tri[e], tri[(e + 1) % 3]
                if region[edge_owner[(b, a)]] != rid:
                    nxt[a].append(b)
        loops = []
        while nxt:
            start = next(iter(nxt))
            loop, at = [start], nxt[start].pop()
            if not nxt[start]:
                del nxt[start]
            while at != start:
                loop.append(at)
                following = nxt[at].pop()
                if not nxt[at]:
                    del nxt[at]
                at = following
            loops.append(loop)
        n = normals[members[0]]
        # 外周: 法線から見て反時計回り（符号付き面積が正）。穴は負
        def area(loop):
            s = (0.0, 0.0, 0.0)
            for a, b in zip(loop, loop[1:] + loop[:1]):
                c = _cross(P[a], P[b])
                s = (s[0] + c[0], s[1] + c[1], s[2] + c[2])
            return _dot(s, n) / 2

        loops.sort(key=area, reverse=True)
        ring_list = []
        for loop in loops:
            ring = []
            for a, b in zip(loop, loop[1:] + loop[:1]):
                key = ("l", min(a, b), max(a, b))
                start, end = (a, b) if a < b else (b, a)
                topo.edge(key, ("p", start), ("p", end), topo.line(P[start], P[end]), True)
                ring.append((key, ("p", a)))
            ring_list.append(ring)
        plane = topo.w.add("PLANE", "", topo.placement(P[loops[0][0]], n, _perpendicular(n)))
        topo.face(plane, True, ring_list)
