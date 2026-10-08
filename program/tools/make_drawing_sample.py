"""2D の図面のサンプル（program/samples/dwg/）と試験用の図面（program/tests/fixtures/drawings/）を作る（開発用）。

    pip install ezdxf
    python program/tools/make_drawing_sample.py

同梱の部品 A1（Φ54.5 の円筒・両切欠き・片ねじ）の部品図を、ezdxf（MIT）で描く。3D の .ipt と 2D の図面を同じ部品で見比べられる。
  画層: 外形線・かくれ線・中心線・寸法・ハッチング・図枠（色・線種・線の太さが違う）
  図形: 線・円・円弧・ポリライン（膨らみ）・スプライン（通過点）・楕円・文字（日本語）・MTEXT・寸法（ブロック付き）・ハッチング・ブロック参照（属性付きの表題欄）
  レイアウト: モデル（図面）と A3（図枠とビューポート）
出力: ASCII の DXF（R2018）をサンプルに、同じ図面の ASCII（R2000・Shift_JIS）とバイナリの DXF を試験用に。
試験用の DWG（A1_R2000.dwg・A1_R2004.dwg）は、Shift_JIS の DXF を LibreDWG の dxf2dwg で変換したもの（手で作り直す。LibreDWG は GPL の
道具として使うだけで、アプリには入れない）:
    dxf2dwg -y --as r2000 -o A1_R2000.dwg A1_R2000_sjis.dxf
    dxf2dwg -y --as r2004 -o A1_R2004.dwg A1_R2000_sjis.dxf
"""

from __future__ import annotations

import math
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

PROGRAM = Path(__file__).resolve().parents[1]
SAMPLE = PROGRAM / "samples" / "dwg" / "A1_円筒_部品図.dxf"
FIXTURES = PROGRAM / "tests" / "fixtures" / "drawings"

D, L = 54.5, 77.0  # 外径・長さ
R = D / 2
NOTCH_W, NOTCH_D = 30.0, 19.287  # 切欠きの幅（軸の向き）・深さ
CORNER = 5.0  # 切欠きの隅 R

LAYERS = [
    # 名前, 色, 線種, 線の太さ（1/100 mm）
    ("外形線", 7, "Continuous", 50),
    ("かくれ線", 3, "DASHED", 25),
    ("中心線", 1, "CENTER", 18),
    ("寸法", 4, "Continuous", 18),
    ("ハッチング", 8, "Continuous", 13),
    ("図枠", 7, "Continuous", 35),
    ("文字", 7, "Continuous", 25),
]


def make(version: str = "R2018", encoding: str | None = None) -> ezdxf.document.Drawing:
    doc = ezdxf.new(version, setup=True, units=4)  # 4 = mm
    if encoding:
        doc.encoding = encoding
    doc.header["$LTSCALE"] = 1.0
    for name, color, linetype, lw in LAYERS:
        doc.layers.add(name, color=color, linetype=linetype, lineweight=lw)
    doc.styles.add("JIS", font="msgothic.ttc")
    dim = doc.dimstyles.duplicate_entry("EZDXF", "JIS")
    dim.dxf.dimtxsty = "JIS"
    dim.dxf.dimtxt = 3.5
    dim.dxf.dimasz = 3.0
    dim.dxf.dimexe = 2.0
    dim.dxf.dimexo = 1.0
    dim.dxf.dimgap = 1.0
    dim.dxf.dimdec = 1
    dim.dxf.dimlfac = 1.0
    dim.dxf.dimscale = 1.0
    msp = doc.modelspace()
    front(msp)
    side(msp, origin=(140.0, 0.0))
    detail(msp, origin=(230.0, -10.0))
    notes(msp)
    title_block(doc, msp)
    sheet(doc)
    return doc


def front(msp) -> None:
    """正面図（軸を横に。左端に切欠き、右端にねじ穴の位置。右半分を断面に）"""
    o = {"layer": "外形線"}
    x0, x1 = 0.0, L
    # 外形: 下の辺・右の辺・切欠きより右の上の辺。左端から NOTCH_W までは上側を深さ NOTCH_D だけ切り欠く
    msp.add_lwpolyline([(x0, -R), (x1, -R), (x1, R), (x0 + NOTCH_W, R)], dxfattribs=o)
    # 切欠き: 立ち上がり・隅 R の円弧（膨らみ）・底の線
    y = R - NOTCH_D
    msp.add_lwpolyline([(x0 + NOTCH_W, R, 0, 0, 0), (x0 + NOTCH_W, y + CORNER, 0, 0, math.tan(math.radians(90) / 4)),
                        (x0 + NOTCH_W - CORNER, y, 0, 0, 0), (x0, y)], format="xyseb", dxfattribs=o)
    msp.add_line((x0, y), (x0, -R), dxfattribs=o)
    # 面取り（右端）
    msp.add_line((x1 - 1, R), (x1, R - 1), dxfattribs=o)
    msp.add_line((x1 - 1, -R), (x1, -R + 1), dxfattribs=o)
    # 中心線
    msp.add_line((x0 - 6, 0), (x1 + 6, 0), dxfattribs={"layer": "中心線"})
    # かくれ線: ねじ穴 M8（右端から深さ 12）と穴 Φ6.6
    for yy in (-4.0, 4.0):
        msp.add_line((x1 - 12, yy), (x1, yy), dxfattribs={"layer": "かくれ線"})
    msp.add_line((x1 - 12, -4.0), (x1 - 12 - 2.4, 0), dxfattribs={"layer": "かくれ線"})
    msp.add_line((x1 - 12, 4.0), (x1 - 12 - 2.4, 0), dxfattribs={"layer": "かくれ線"})
    msp.add_circle((50.0, 0.0), 3.3, dxfattribs=o)
    msp.add_line((50.0, -7), (50.0, 7), dxfattribs={"layer": "中心線"})
    # 部分断面: 右下の 1/4 にハッチング（ANSI31）
    hatch = msp.add_hatch(color=256, dxfattribs={"layer": "ハッチング"})
    hatch.set_pattern_fill("ANSI31", scale=0.8)
    hatch.paths.add_polyline_path([(x1 - 20, -R), (x1 - 1, -R), (x1, -R + 1), (x1, -4), (x1 - 20, -4)], is_closed=True)
    msp.add_line((x1 - 20, -R), (x1 - 20, -4), dxfattribs={"layer": "外形線"})
    # 寸法
    s = {"dimstyle": "JIS", "dxfattribs": {"layer": "寸法"}}
    msp.add_linear_dim(base=(L / 2, -R - 12), p1=(x0, -R), p2=(x1, -R), **s).render()
    msp.add_linear_dim(base=(x0 - 14, 0), p1=(x0 + NOTCH_W, R), p2=(x0 + NOTCH_W, -R), angle=90, text="%%c<>", **s).render()
    msp.add_linear_dim(base=(NOTCH_W / 2, R + 10), p1=(x0, y), p2=(x0 + NOTCH_W, R), **s).render()
    msp.add_radius_dim(center=(x0 + NOTCH_W - CORNER, y + CORNER), radius=CORNER, angle=225, **s).render()


def side(msp, origin) -> None:
    """側面図（右から見た円。切欠きの平らな面、ねじ穴 M4×4 の位置）"""
    ox, oy = origin
    o = {"layer": "外形線"}
    cut = R - NOTCH_D
    # 切欠きで欠けた円: 弦の上は平ら
    a = math.degrees(math.asin(cut / R))
    msp.add_arc((ox, oy), R, 180 - a, 360 + a, dxfattribs=o)
    msp.add_line((ox - math.sqrt(R * R - cut * cut), oy + cut), (ox + math.sqrt(R * R - cut * cut), oy + cut), dxfattribs=o)
    msp.add_circle((ox, oy), R - 1, dxfattribs={"layer": "かくれ線"})
    for k in range(4):
        t = math.radians(45 + 90 * k)
        cx, cy = ox + 20 * math.cos(t), oy + 20 * math.sin(t)
        msp.add_circle((cx, cy), 1.621, dxfattribs=o)
        msp.add_arc((cx, cy), 2.0, 0, 270, dxfattribs={"layer": "外形線", "color": 2})  # ねじ山（3/4 円）
    msp.add_line((ox - R - 5, oy), (ox + R + 5, oy), dxfattribs={"layer": "中心線"})
    msp.add_line((ox, oy - R - 5), (ox, oy + R + 5), dxfattribs={"layer": "中心線"})
    msp.add_circle((ox, oy), 20, dxfattribs={"layer": "中心線"})
    s = {"dimstyle": "JIS", "dxfattribs": {"layer": "寸法"}}
    msp.add_diameter_dim(center=(ox, oy), radius=R, angle=-35, **s).render()
    msp.add_diameter_dim(center=(ox, oy), radius=20, angle=200, text="P.C.D. <>", **s).render()


def detail(msp, origin) -> None:
    """詳細図 A（切欠きの隅。楕円・スプラインの見本を兼ねる）"""
    ox, oy = origin
    msp.add_ellipse((ox, oy), major_axis=(14, 0), ratio=0.6, dxfattribs={"layer": "中心線"})
    msp.add_spline([(ox - 12, oy - 22), (ox - 4, oy - 16), (ox + 3, oy - 20), (ox + 12, oy - 14)], dxfattribs={"layer": "外形線"})
    msp.add_text("詳細 A (2:1)", height=3.5, dxfattribs={"layer": "文字", "style": "JIS"}).set_placement((ox, oy + 12), align=TextEntityAlignment.BOTTOM_CENTER)


def notes(msp) -> None:
    text = "注記\\P1. 指示なき角部は C0.5\\P2. 材質 S45C 調質\\P3. ねじ穴 M4×0.7 深さ 8（4 か所）"
    m = msp.add_mtext(text, dxfattribs={"layer": "文字", "style": "JIS", "char_height": 3.5, "width": 80})
    m.set_location((0, -60))


def title_block(doc, msp) -> None:
    """表題欄（属性付きのブロック）"""
    blk = doc.blocks.new("表題欄", base_point=(0, 0))
    o = {"layer": "0"}
    blk.add_lwpolyline([(0, 0), (120, 0), (120, 28), (0, 28)], close=True, dxfattribs=o)
    blk.add_line((0, 14), (120, 14), dxfattribs=o)
    blk.add_line((40, 0), (40, 28), dxfattribs=o)
    blk.add_text("品名", height=3, dxfattribs={"style": "JIS"}).set_placement((3, 18))
    blk.add_text("図番", height=3, dxfattribs={"style": "JIS"}).set_placement((3, 4))
    blk.add_attdef("品名", insert=(44, 18), text="", dxfattribs={"height": 3.5, "style": "JIS"})
    blk.add_attdef("図番", insert=(44, 4), text="", dxfattribs={"height": 5, "style": "JIS"})
    ref = msp.add_blockref("表題欄", (150, -90), dxfattribs={"layer": "図枠"})
    ref.add_auto_attribs({"品名": "円筒 両切欠き＋片ネジ Φ54.5", "図番": "A1-001"})


def sheet(doc) -> None:
    """A3 のレイアウト: 図枠（420×297）とビューポート（1:1）"""
    layout = doc.layouts.get("Layout1")
    layout.rename("A3")
    layout.page_setup(size=(420, 297), margins=(0, 0, 0, 0), units="mm")
    layout.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True, dxfattribs={"layer": "図枠", "lineweight": 70})
    layout.add_viewport(center=(210, 148.5), size=(380, 257), view_center_point=(140, -20), view_height=257)
    layout.add_text("A3  1:1", height=4, dxfattribs={"layer": "文字", "style": "JIS"}).set_placement((400, 14), align=TextEntityAlignment.BOTTOM_RIGHT)


def main() -> None:
    SAMPLE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    make().saveas(SAMPLE)
    make().saveas(FIXTURES / "A1_binary.dxf", fmt="bin")
    make("R2000", encoding="cp932").saveas(FIXTURES / "A1_R2000_sjis.dxf")
    for p in [SAMPLE, *sorted(FIXTURES.glob("*.dxf"))]:
        print(p.relative_to(PROGRAM), f"{p.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
