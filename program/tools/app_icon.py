"""アプリのアイコン（デスクトップ版の exe・窓・タスクバー）。絵はここの 1 か所が描く（desktop/build.rs が作るたびに書き出す）。

絵: 角を丸めた正方形の地に、等角に見た立方体（上面・左面・右面を画面の色の 3 段で塗り分ける）。
色は画面の色（app.css の --accent など）に合わせる。外部のライブラリを使わない（PNG は zlib で、ICO は PNG を並べて書く）。
使い方（program フォルダで）:
    python tools/app_icon.py 出力フォルダ      icon.png（256）と icon.ico（16・24・32・48・64・128・256）を書く
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZES = (16, 24, 32, 48, 64, 128, 256)
SUPERSAMPLE = 4  # 1 画素を 4 × 4 に分けて塗り、平均してなめらかにする
GROUND = (0x16, 0x20, 0x2B)  # 地（--ink）
TOP = (0x5E, 0x9D, 0xFF)  # 上面（暗い画面の --accent）
LEFT = (0x1A, 0x62, 0xC4)  # 左面（--accent）
RIGHT = (0x12, 0x46, 0x8C)  # 右面（--accent を暗く）
EDGE = (0xE5, 0xEA, 0xF0)  # 稜線（暗い画面の --ink）

Point = tuple[float, float]


def _cube(size: float) -> list[tuple[tuple[int, int, int], list[Point]]]:
    """立方体の 3 面（色と、時計回りの頂点。1 辺 1 の正方形の座標）"""
    cx, cy, r = 0.5, 0.53, 0.30  # 中心・六角形の外接円の半径
    hexagon = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in (-90, -30, 30, 90, 150, 210)]
    top, upper_right, lower_right, bottom, lower_left, upper_left = hexagon
    center = (cx, cy)
    return [
        (TOP, [top, upper_right, center, upper_left]),
        (LEFT, [upper_left, center, bottom, lower_left]),
        (RIGHT, [center, upper_right, lower_right, bottom]),
    ]


def _inside(poly: list[Point], x: float, y: float) -> bool:
    """凸多角形の内側か（全ての辺の同じ側）"""
    sign = 0
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if cross != 0:
            if sign and (cross > 0) != (sign > 0):
                return False
            sign = 1 if cross > 0 else -1
    return True


def _rounded_square(x: float, y: float, radius: float = 0.18, margin: float = 0.04) -> bool:
    lo, hi = margin + radius, 1 - margin - radius
    dx, dy = max(lo - x, 0, x - hi), max(lo - y, 0, y - hi)
    return x >= margin and x <= 1 - margin and y >= margin and y <= 1 - margin and dx * dx + dy * dy <= radius * radius


def _edges(size: int) -> list[tuple[Point, Point]]:
    faces = _cube(size)
    return [(a, b) for _, poly in faces for a, b in zip(poly, poly[1:] + poly[:1])]


def _near_edge(edges, x: float, y: float, width: float) -> bool:
    for (x1, y1), (x2, y2) in edges:
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        px, py = x1 + t * dx - x, y1 + t * dy - y
        if px * px + py * py <= width * width:
            return True
    return False


def pixels(size: int) -> list[list[tuple[int, int, int, int]]]:
    """size × size の RGBA（行ごと）"""
    faces = _cube(size)
    edges = _edges(size)
    line = max(0.6 / size, 0.008)  # 稜線の太さ（小さい絵でも見える幅）
    rows = []
    n = SUPERSAMPLE
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(n):
                for sx in range(n):
                    x, y = (px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size
                    if not _rounded_square(x, y):
                        continue
                    color = GROUND
                    for face_color, poly in faces:
                        if _inside(poly, x, y):
                            color = EDGE if size >= 32 and _near_edge(edges, x, y, line) else face_color
                            break
                    for k in range(3):
                        acc[k] += color[k]
                    acc[3] += 255
            count = n * n
            alpha = acc[3] / count
            row.append(tuple(round(acc[k] / (acc[3] / 255)) if acc[3] else 0 for k in range(3)) + (round(alpha),))
        rows.append(row)
    return rows


def png(size: int) -> bytes:
    """PNG（RGBA・8 ビット）"""
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in pixels(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico() -> bytes:
    """ICO（中身はどの大きさも PNG。Windows Vista 以降が読む形）"""
    images = [png(s) for s in SIZES]
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    for size, data in zip(SIZES, images):
        out += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + b"".join(images)


def main(argv: list[str]) -> int:
    out = Path(argv[1] if len(argv) > 1 else "icons")
    out.mkdir(parents=True, exist_ok=True)
    (out / "icon.png").write_bytes(png(256))
    (out / "icon.ico").write_bytes(ico())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
