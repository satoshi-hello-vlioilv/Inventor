"""作った部品の外形（外接箱）を、変換データから計算した外接箱と比べる。

体積・表面積の照合では分からない「位置のずれ」（例: 対称のはずの押し出し・回転が片側に寄る）を見つけるため。
Inventor の外接箱は SurfaceBody.PreciseRangeBox（ぴったりの箱）を使う。RangeBox は形を囲むことしか保証しない。

単位: Inventor の内部の長さは cm（ビルダーは mm → cm の換算で描く）。この前提は、Inventor が保存した実物の .ipt の
形状データに書かれた単位（1 = 10 mm）で確かめている（app/test/ipt-format.test.mjs）。
"""
from __future__ import annotations

import math

from .spec import Part, arc_angles

BBOX_TOL = 1e-3  # mm

Box = tuple[tuple[float, float, float], tuple[float, float, float]]


def loop_bounds(loop) -> tuple[float, float, float, float]:
    """断面ループの 2 次元の範囲 (xmin, xmax, ymin, ymax)。円弧は軸方向の極値も含める。"""
    xs: list[float] = []
    ys: list[float] = []
    for s in loop:
        if s.type == "circle":
            cx, cy = s.center
            xs += [cx - s.radius, cx + s.radius]
            ys += [cy - s.radius, cy + s.radius]
            continue
        xs += [s.a[0], s.b[0]]
        ys += [s.a[1], s.b[1]]
        if s.type == "arc":
            a0, sweep, r = arc_angles(s)
            for k in range(-8, 9):  # 0°・90°・180°・270° のうち円弧の範囲に入るもの
                angle = k * math.pi / 2
                t = (angle - a0) / sweep if sweep else -1
                if 0 < t < 1:
                    xs.append(s.center[0] + r * math.cos(angle))
                    ys.append(s.center[1] + r * math.sin(angle))
    return min(xs), max(xs), min(ys), max(ys)


def expected_bbox(part: Part) -> Box:
    """部品のローカル座標系での外接箱（mm）。"""
    bounds = [loop_bounds(loop) for loop in part.loops]
    xmin, xmax = min(b[0] for b in bounds), max(b[1] for b in bounds)
    ymin, ymax = min(b[2] for b in bounds), max(b[3] for b in bounds)
    if part.kind == "extrude":
        return (xmin, ymin, -part.distance / 2), (xmax, ymax, part.distance / 2)
    # 回転体: 半径 r ∈ [rmin, rmax] を Y 軸まわりに ±angle/2 回す（XY 平面に対して対称）
    rmin, rmax = max(xmin, 0.0), xmax
    half = math.radians(part.angle_deg) / 2
    angles = [-half, half] + [k * math.pi / 2 for k in range(-4, 5) if abs(k * math.pi / 2) <= half]
    xs = [r * math.cos(t) for r in (rmin, rmax) for t in angles]
    zs = [r * math.sin(t) for r in (rmin, rmax) for t in angles]
    return (min(xs), ymin, min(zs)), (max(xs), ymax, max(zs))


def body_bbox(definition, mm_per_unit: float) -> Box | None:
    """Inventor が計算したボディの外接箱（mm）。取れなければ None。"""
    try:
        box = definition.SurfaceBodies.Item(1).PreciseRangeBox
        lo, hi = box.MinPoint, box.MaxPoint
        return (lo.X * mm_per_unit, lo.Y * mm_per_unit, lo.Z * mm_per_unit), (hi.X * mm_per_unit, hi.Y * mm_per_unit, hi.Z * mm_per_unit)
    except Exception:  # noqa: BLE001 — 版の違いなどで取れない場合は「確認できない」とする
        return None


def check_extent(actual: Box | None, part: Part) -> tuple[bool | None, str]:
    """(一致 / 不一致 / 確認できない = None, 説明)。"""
    if actual is None:
        return None, "外接箱を取得できませんでした（外形の確認は省略）"
    expected = expected_bbox(part)
    worst = max(abs(a - e) for pa, pe in zip(actual, expected) for a, e in zip(pa, pe))
    size = " × ".join(f"{hi - lo:g}" for lo, hi in zip(*actual))
    return worst <= BBOX_TOL, f"外形 {size} mm（変換データとの差 {worst:.4f} mm）"
