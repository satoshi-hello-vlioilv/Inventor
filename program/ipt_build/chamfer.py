"""面取りで削られる量を、断面の輪郭を細かい折れ線にして求める（アプリの JS 版とは別の方法）。

JS 版は直線・円弧のまま縁をずらして厳密に計算する。ここでは輪郭を多角形にし、各辺を材料側へ平行に動かす
（頂点は隣の 2 辺がどちらも単位距離ずつ動くように動く＝留め継ぎ）。辺が長さ 0 になったら取り除き、両隣を直接継ぐ。
頂点は事象（辺が消える距離）の間では直線的に動くので、面積はずらし量の 2 次式になる。その係数から、ずらしながら
面積を厳密に積分する（削られる体積 = ∫ 削られる面積 ds）。
残る誤差は円弧を折れ線にした分だけ（1 周 N 分割で、削られる量の相対誤差はおよそ (2π/N)²/24）。

座標の単位は問わない（呼び出し側と同じ単位で返す）。
"""
from __future__ import annotations

import math

Point = tuple[float, float]


def signed_area(points: list[Point]) -> float:
    """多角形の符号付き面積（反時計回りが正）。"""
    return sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(points, points[1:] + points[:1])) / 2


def _left_normal(p: Point, q: Point) -> Point:
    dx, dy = q[0] - p[0], q[1] - p[1]
    length = math.hypot(dx, dy)
    return (-dy / length, dx / length)


def offset_polygon(points: list[Point], dist: float) -> tuple[list[Point], list[float], float]:
    """材料が進行方向の左にある多角形を、左へ dist ずらす。
    (ずらした多角形, 辺が消えた距離の列, 符号付き面積を 0 から dist まで積分した値) を返す。"""
    pts = [p for i, p in enumerate(points) if math.dist(p, points[i - 1]) > 1e-12]
    normals = [_left_normal(p, q) for p, q in zip(pts, pts[1:] + pts[:1])]  # 辺 i: 頂点 i → i+1
    now, events, integral = 0.0, [], 0.0
    while True:
        n = len(pts)
        if n < 3:
            raise ValueError("面取りが大きすぎて輪郭がつぶれます")
        moves = []  # 頂点 i は辺 i-1 と辺 i の間
        for a, b in zip(normals[-1:] + normals[:-1], normals):
            k = 1 + a[0] * b[0] + a[1] * b[1]
            if k < 1e-9:
                raise ValueError("輪郭が折り返しています")
            moves.append(((a[0] + b[0]) / k, (a[1] + b[1]) / k))
        first, when = None, dist
        for i in range(n):
            j = (i + 1) % n
            tangent = (normals[i][1], -normals[i][0])
            length = (pts[j][0] - pts[i][0]) * tangent[0] + (pts[j][1] - pts[i][1]) * tangent[1]
            rate = (moves[j][0] - moves[i][0]) * tangent[0] + (moves[j][1] - moves[i][1]) * tangent[1]
            if rate < 0 and now + max(length, 0.0) / -rate < when:
                first, when = i, now + max(length, 0.0) / -rate
        # 頂点 p + τm の多角形の面積 = c0 + c1 τ + c2 τ²
        step = when - now
        c1 = c2 = 0.0
        for (p, m), (q, w) in zip(zip(pts, moves), zip(pts[1:] + pts[:1], moves[1:] + moves[:1])):
            c1 += p[0] * w[1] - w[0] * p[1] + m[0] * q[1] - q[0] * m[1]
            c2 += m[0] * w[1] - w[0] * m[1]
        integral += signed_area(pts) * step + c1 / 2 * step**2 / 2 + c2 / 2 * step**3 / 3
        pts = [(p[0] + step * m[0], p[1] + step * m[1]) for p, m in zip(pts, moves)]
        now = when
        if first is None:
            return pts, events, integral
        events.append(when)
        del normals[first]
        del pts[first + 1 if first + 1 < n else first]  # 消えた辺の両端は同じ位置にあるので、片方を残す


def chamfer(points: list[Point], distance: float, is_hole: bool) -> tuple[float, float]:
    """等距離の面取りで削られる (体積, 端面の面積)。points は輪郭の多角形（向きは問わない）。"""
    oriented = points if (signed_area(points) > 0) != is_hole else points[::-1]  # 材料を左に: 外周は反時計回り、穴は時計回り
    base = signed_area(oriented)
    shifted, _, integral = offset_polygon(oriented, distance)
    return base * distance - integral, base - signed_area(shifted)
