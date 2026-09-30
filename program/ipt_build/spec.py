"""変換データ（ブラウザのアプリが出力する JSON）の読み込みと、断面の幾何量の計算。

幾何量（体積・表面積）はアプリ（JS）とは独立にここでも計算する。
2 つの実装の答えが一致することで、変換データの期待値そのものの正しさも確かめられる。
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

FORMAT = "inventor-builder"
VERSIONS = (1, 2, 3)  # 2: 押し出しの面取り（chamfers）、3: 近似の部品（kind: mesh）と STEP 用の三角形（mesh）
SAMPLES_PER_TURN = 16384  # 面取りの計算で円弧を折れ線にする細かさ（1 周の分割数）

Point2 = tuple[float, float]
Vec3 = tuple[float, float, float]


UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')  # Windows のファイル名に使えない文字


class SpecError(ValueError):
    pass


def safe_name(text: str) -> str:
    """ファイル・フォルダの名前にできる文字列（使えない文字は _ に。空なら「変換データ」）"""
    return UNSAFE.sub("_", text).strip(" .") or "変換データ"


def source_stem(source: dict) -> str:
    """変換データの元のファイルの名前（拡張子を除く）。保存先・STEP・組立の名前に使う（名前が無い・null でもよい）"""
    return safe_name(Path(str(source.get("file") or "")).stem)


@dataclass(frozen=True)
class Segment:
    type: str  # line | arc | circle
    a: Point2 | None = None
    b: Point2 | None = None
    center: Point2 | None = None
    ccw: bool = True
    radius: float | None = None  # circle のみ

    def reversed(self) -> Segment:
        if self.type == "circle":
            return self
        return Segment(self.type, self.b, self.a, self.center, not self.ccw)


@dataclass(frozen=True)
class Chamfer:
    """押し出しの端面の縁の等距離面取り。"""

    loop: int  # 断面のループの番号（0 = 外周、1 以降 = 穴）
    side: int  # +1 = Z が +長さ/2 の端面、-1 = -長さ/2 の端面
    distance: float

    @property
    def label(self) -> str:
        return f"{'外周' if self.loop == 0 else f'穴 {self.loop}'}の縁（{'+Z' if self.side > 0 else '-Z'} 側）"


@dataclass(frozen=True)
class Frame:
    """部品のローカル座標系（取り込んだシーン内での位置と向き、mm）。"""

    origin: Vec3
    x: Vec3
    y: Vec3
    z: Vec3


@dataclass(frozen=True)
class Mesh:
    """三角形のままの形（部品のローカル座標、mm）。三角形は外向き（反時計回り）にそろっている。"""

    positions: tuple[Vec3, ...]
    triangles: tuple[tuple[int, int, int], ...]


@dataclass(frozen=True)
class Part:
    key: str
    name: str
    kind: str  # revolve | extrude | mesh
    loops: tuple[tuple[Segment, ...], ...]
    angle_deg: float | None  # revolve: Y 軸まわりの回転角（360 未満は XY 平面に対して対称）
    distance: float | None  # extrude: Z 方向の押し出し量（XY 平面に対して対称）
    expect_volume: float
    expect_area: float
    instances: tuple[Frame, ...]
    chamfers: tuple[Chamfer, ...] = ()
    mesh: Mesh | None = None  # 近似の部品の形。面取り付きの押し出しでは STEP 用の代わりの形
    notes: tuple[str, ...] = ()  # アプリが見つけた注意（元の形が自分と交わる、など）

    @property
    def full_revolve(self) -> bool:
        return self.kind == "revolve" and self.angle_deg >= 360 - 1e-9


@dataclass(frozen=True)
class Spec:
    source: dict
    parts: tuple[Part, ...]
    skipped: tuple[dict, ...]


def _point(value, where: str) -> Point2:
    if not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value)):
        raise SpecError(f"{where}: 座標は [x, y] の数値で指定してください")
    return (float(value[0]), float(value[1]))


def _vec3(value, where: str) -> Vec3:
    if not (isinstance(value, list) and len(value) == 3 and all(isinstance(v, (int, float)) for v in value)):
        raise SpecError(f"{where}: [x, y, z] の数値で指定してください")
    return (float(value[0]), float(value[1]), float(value[2]))


def _segment(raw: dict, where: str) -> Segment:
    kind = raw.get("type")
    if kind == "line":
        return Segment("line", _point(raw.get("a"), where), _point(raw.get("b"), where))
    if kind == "arc":
        return Segment("arc", _point(raw.get("a"), where), _point(raw.get("b"), where), _point(raw.get("center"), where), bool(raw.get("ccw")))
    if kind == "circle":
        return Segment("circle", center=_point(raw.get("center"), where), radius=float(raw.get("radius")))
    raise SpecError(f"{where}: 未知の種類 {kind!r}")


def _mesh(raw, key: str) -> Mesh | None:
    if raw is None:
        return None
    where = f"{key} の三角形"
    positions, triangles = raw.get("positions") if isinstance(raw, dict) else None, raw.get("triangles") if isinstance(raw, dict) else None
    if not (isinstance(positions, list) and isinstance(triangles, list) and len(positions) % 3 == 0 and len(triangles) % 3 == 0 and triangles):
        raise SpecError(f"{where}: positions（x, y, z の並び）と triangles（頂点番号 3 つずつの並び）を指定してください")
    if not all(isinstance(v, (int, float)) for v in positions):
        raise SpecError(f"{where}: 座標は数値で指定してください")
    count = len(positions) // 3
    if not all(isinstance(i, int) and 0 <= i < count for i in triangles):
        raise SpecError(f"{where}: 頂点番号は 0 から {count - 1} までの整数で指定してください")
    return Mesh(
        tuple((float(positions[3 * i]), float(positions[3 * i + 1]), float(positions[3 * i + 2])) for i in range(count)),
        tuple((triangles[k], triangles[k + 1], triangles[k + 2]) for k in range(0, len(triangles), 3)),
    )


def _part(raw: dict) -> Part:
    key = str(raw.get("key", "?"))
    kind = raw.get("kind")
    if kind not in ("revolve", "extrude", "mesh"):
        raise SpecError(f"{key}: 種類 {kind!r} は作れません（revolve / extrude / mesh のみ）")
    instances = tuple(Frame(*(_vec3(inst[k], f"{key} の配置") for k in ("origin", "x", "y", "z"))) for inst in raw.get("instances", []))
    expect = raw.get("expect", {})
    if kind == "mesh":
        mesh = _mesh(raw.get("mesh"), key)
        if mesh is None:
            raise SpecError(f"{key}: 近似の部品に三角形（mesh）がありません")
        return Part(key=key, name=str(raw.get("name", key)), kind=kind, loops=(), angle_deg=None, distance=None,
                    expect_volume=float(expect["volume"]), expect_area=float(expect["area"]), instances=instances, mesh=mesh,
                    notes=_notes(raw))
    loops = tuple(
        tuple(_segment(s, f"{key} のループ {i}") for s in loop)
        for i, loop in enumerate(raw.get("sketch", {}).get("loops", []))
    )
    if not loops or any(not loop for loop in loops):
        raise SpecError(f"{key}: 断面がありません")
    for i, loop in enumerate(loops):
        if len(loop) == 1 and loop[0].type == "circle":
            continue
        for j, s in enumerate(loop):
            nxt = loop[(j + 1) % len(loop)]
            if s.type == "circle" or math.dist(s.b, nxt.a) > 1e-6:
                raise SpecError(f"{key} のループ {i}: {j} 番目の終点が次の始点とつながっていません")
    chamfers = tuple(_chamfer(c, key, kind, loops, raw) for c in raw.get("chamfers", []))
    return Part(
        chamfers=chamfers,
        key=key,
        name=str(raw.get("name", key)),
        kind=kind,
        loops=loops,
        angle_deg=float(raw["revolve"]["angle_deg"]) if kind == "revolve" else None,
        distance=float(raw["extrude"]["distance"]) if kind == "extrude" else None,
        expect_volume=float(expect["volume"]),
        expect_area=float(expect["area"]),
        instances=instances,
        mesh=_mesh(raw.get("mesh"), key),
        notes=_notes(raw),
    )


def _notes(raw: dict) -> tuple[str, ...]:
    notes = raw.get("notes", [])
    return tuple(str(n) for n in notes) if isinstance(notes, list) else ()


def _chamfer(raw: dict, key: str, kind: str, loops, part: dict) -> Chamfer:
    where = f"{key} の面取り"
    if kind != "extrude":
        raise SpecError(f"{where}: 面取りは押し出しにだけ指定できます")
    side = {"+Z": 1, "-Z": -1}.get(raw.get("side"))
    loop, distance = raw.get("loop"), raw.get("distance")
    if side is None or not isinstance(loop, int) or not 0 <= loop < len(loops) or not isinstance(distance, (int, float)):
        raise SpecError(f"{where}: loop（ループの番号）・side（+Z / -Z）・distance（mm）を指定してください")
    if not 0 < distance < float(part["extrude"]["distance"]) / 2:
        raise SpecError(f"{where}: 大きさ {distance} mm は 0 より大きく、厚みの半分より小さくしてください")
    return Chamfer(loop, side, float(distance))


def load_spec(path: str | Path) -> Spec:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SpecError(f"変換データを読めません: {error}") from error
    return parse_spec(data)


def parse_spec(data) -> Spec:
    """変換データ（JSON を読んだもの）を確かめて読む。作れない内容なら、理由を添えて SpecError。"""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise SpecError("変換データ（format: inventor-builder）ではありません")
    if data.get("version") not in VERSIONS:
        raise SpecError(f"対応していない版です（version {data.get('version')}、このビルダーは {' / '.join(map(str, VERSIONS))}）")
    if data.get("units") != "mm":
        raise SpecError("単位は mm のみ対応しています")
    parts = tuple(_part(p) for p in data.get("parts", []))
    return Spec(source=data.get("source", {}), parts=parts, skipped=tuple(data.get("skipped", [])))


# ---- 幾何量（アプリの export/geometry2d.js と同じ式を、独立に実装したもの） ------------
def arc_angles(s: Segment) -> tuple[float, float, float]:
    cx, cy = s.center
    a0 = math.atan2(s.a[1] - cy, s.a[0] - cx)
    a1 = math.atan2(s.b[1] - cy, s.b[0] - cx)
    d = (a1 - a0 if s.ccw else a0 - a1) % (2 * math.pi)
    return a0, (d if s.ccw else -d), math.hypot(s.a[0] - cx, s.a[1] - cy)


def loop_integrals(loop) -> dict[str, float]:
    """符号付き面積・y 軸まわりの 1 次モーメント（ループの向きに従う）と、周長・母線積分 ∫x ds。"""
    area = moment = perimeter = lateral = 0.0
    for s in loop:
        if s.type == "line":
            (x0, y0), (x1, y1) = s.a, s.b
            length = math.hypot(x1 - x0, y1 - y0)
            area += (x0 * y1 - x1 * y0) / 2
            moment += (y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1) / 6
            perimeter += length
            lateral += length * (x0 + x1) / 2
        elif s.type == "arc":
            a0, sweep, r = arc_angles(s)
            cx, cy = s.center
            a1 = a0 + sweep

            def f_area(p: float) -> float:
                return r * (cx * math.sin(p) - cy * math.cos(p) + r * p) / 2

            def f_moment(p: float) -> float:
                return r / 2 * (cx * cx * math.sin(p) + 2 * cx * r * (p / 2 + math.sin(2 * p) / 4) + r * r * (math.sin(p) - math.sin(p) ** 3 / 3))

            area += f_area(a1) - f_area(a0)
            moment += f_moment(a1) - f_moment(a0)
            perimeter += r * abs(sweep)
            lateral += math.copysign(1, sweep) * r * (cx * sweep + r * (math.sin(a1) - math.sin(a0)))
        else:
            cx, r = s.center[0], s.radius
            area += math.pi * r * r
            moment += math.pi * r * r * cx
            perimeter += 2 * math.pi * r
            lateral += 2 * math.pi * r * cx
    return {"area": area, "moment": moment, "perimeter": perimeter, "lateral": lateral}


def polygonize(loop, samples_per_turn: int = SAMPLES_PER_TURN) -> list[Point2]:
    """ループを折れ線にする（終点は次の部分の始点なので含めない）。円は反時計回り。"""
    points: list[Point2] = []
    for s in loop:
        if s.type == "line":
            points.append(s.a)
            continue
        if s.type == "circle":
            a0, sweep, r = 0.0, 2 * math.pi, s.radius
        else:
            a0, sweep, r = arc_angles(s)
        n = max(1, math.ceil(samples_per_turn * abs(sweep) / (2 * math.pi)))
        points += [(s.center[0] + r * math.cos(a0 + sweep * k / n), s.center[1] + r * math.sin(a0 + sweep * k / n)) for k in range(n)]
    return points


def distance_to_segment(p: Point2, s: Segment) -> float:
    """点から断面の部分（直線・円弧・円）までの最短距離。"""
    if s.type == "circle":
        return abs(math.dist(p, s.center) - s.radius)
    if s.type == "arc":
        a0, sweep, r = arc_angles(s)
        angle = math.atan2(p[1] - s.center[1], p[0] - s.center[0])
        if ((angle - a0) if sweep > 0 else (a0 - angle)) % (2 * math.pi) <= abs(sweep):
            return abs(math.dist(p, s.center) - r)
        return min(math.dist(p, s.a), math.dist(p, s.b))
    (x0, y0), (x1, y1) = s.a, s.b
    dx, dy = x1 - x0, y1 - y0
    t = max(0.0, min(1.0, ((p[0] - x0) * dx + (p[1] - y0) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(p[0] - (x0 + t * dx), p[1] - (y0 + t * dy))


def distance_to_loop(p: Point2, loop) -> float:
    return min(distance_to_segment(p, s) for s in loop)


def properties(kind: str, loops, angle_deg: float | None = None, distance: float | None = None, chamfers=()) -> tuple[float, float]:
    """体積と表面積（断面と同じ長さの単位）。面取りは折れ線で計算する（chamfer モジュール）。"""
    from .chamfer import chamfer  # noqa: PLC0415

    integrals = [loop_integrals(loop) for loop in loops]
    if kind == "revolve":
        theta = math.radians(angle_deg)
        first = integrals[0]
        caps = 2 * abs(first["area"]) if angle_deg < 360 - 1e-9 else 0.0
        return theta * abs(first["moment"]), theta * first["lateral"] + caps
    ordered = sorted(integrals, key=lambda i: -abs(i["area"]))
    section = abs(ordered[0]["area"]) - sum(abs(i["area"]) for i in ordered[1:])
    perimeter = sum(i["perimeter"] for i in integrals)
    volume, area = section * distance, 2 * section + perimeter * distance
    for c in chamfers:
        cut_volume, cut_face = chamfer(polygonize(loops[c.loop]), c.distance, c.loop > 0)
        volume -= cut_volume
        area += (math.sqrt(2) - 1) * cut_face - integrals[c.loop]["perimeter"] * c.distance
    return volume, area


def mesh_properties(mesh: Mesh) -> tuple[float, float]:
    """三角形の体積（外向きなら正）と表面積。"""
    volume = area = 0.0
    for i, j, k in mesh.triangles:
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = mesh.positions[i], mesh.positions[j], mesh.positions[k]
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
        ux, uy, uz, vx, vy, vz = bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az
        area += math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2) / 2
    return volume, area


def part_properties(part: Part) -> tuple[float, float]:
    if part.kind == "mesh":
        return mesh_properties(part.mesh)
    return properties(part.kind, part.loops, part.angle_deg, part.distance, part.chamfers)
