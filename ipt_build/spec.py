"""変換データ（ブラウザのアプリが出力する JSON）の読み込みと、断面の幾何量の計算。

幾何量（体積・表面積）はアプリ（JS）とは独立にここでも計算する。
2 つの実装の答えが一致することで、変換データの期待値そのものの正しさも確かめられる。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

FORMAT = "inventor-builder"
VERSION = 1

Point2 = tuple[float, float]
Vec3 = tuple[float, float, float]


class SpecError(ValueError):
    pass


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
class Frame:
    """部品のローカル座標系（取り込んだシーン内での位置と向き、mm）。"""

    origin: Vec3
    x: Vec3
    y: Vec3
    z: Vec3


@dataclass(frozen=True)
class Part:
    key: str
    name: str
    kind: str  # revolve | extrude
    loops: tuple[tuple[Segment, ...], ...]
    angle_deg: float | None  # revolve: Y 軸まわりの回転角（360 未満は XY 平面に対して対称）
    distance: float | None  # extrude: Z 方向の押し出し量（XY 平面に対して対称）
    expect_volume: float
    expect_area: float
    instances: tuple[Frame, ...]

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


def _part(raw: dict) -> Part:
    key = str(raw.get("key", "?"))
    kind = raw.get("kind")
    if kind not in ("revolve", "extrude"):
        raise SpecError(f"{key}: 種類 {kind!r} は作れません（revolve / extrude のみ）")
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
    return Part(
        key=key,
        name=str(raw.get("name", key)),
        kind=kind,
        loops=loops,
        angle_deg=float(raw["revolve"]["angle_deg"]) if kind == "revolve" else None,
        distance=float(raw["extrude"]["distance"]) if kind == "extrude" else None,
        expect_volume=float(raw["expect"]["volume"]),
        expect_area=float(raw["expect"]["area"]),
        instances=tuple(
            Frame(*(_vec3(inst[k], f"{key} の配置") for k in ("origin", "x", "y", "z"))) for inst in raw.get("instances", [])
        ),
    )


def load_spec(path: str | Path) -> Spec:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SpecError(f"変換データを読めません: {error}") from error
    if data.get("format") != FORMAT:
        raise SpecError("変換データ（format: inventor-builder）ではありません")
    if data.get("version") != VERSION:
        raise SpecError(f"対応していない版です（version {data.get('version')}、このビルダーは {VERSION}）")
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


def properties(kind: str, loops, angle_deg: float | None = None, distance: float | None = None) -> tuple[float, float]:
    """体積と表面積（断面と同じ長さの単位）。"""
    integrals = [loop_integrals(loop) for loop in loops]
    if kind == "revolve":
        theta = math.radians(angle_deg)
        first = integrals[0]
        caps = 2 * abs(first["area"]) if angle_deg < 360 - 1e-9 else 0.0
        return theta * abs(first["moment"]), theta * first["lateral"] + caps
    ordered = sorted(integrals, key=lambda i: -abs(i["area"]))
    section = abs(ordered[0]["area"]) - sum(abs(i["area"]) for i in ordered[1:])
    perimeter = sum(i["perimeter"] for i in integrals)
    return section * distance, 2 * section + perimeter * distance


def part_properties(part: Part) -> tuple[float, float]:
    return properties(part.kind, part.loops, part.angle_deg, part.distance)
