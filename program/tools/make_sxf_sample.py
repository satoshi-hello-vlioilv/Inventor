"""SXF（.sfc・.p21）の図面のサンプル（program/samples/dwg/）を作る（開発用）。

    python program/tools/make_sxf_sample.py            # SFC だけ
    pip install ezsxf && python program/tools/make_sxf_sample.py   # P21 も（ezsxf（MIT）の write_p21 で SFC を書き直す）

同梱の部品 A1（Φ54.5 の円筒・両切欠き・片ねじ。make_drawing_sample.py の DXF と同じ部品）の部品図を、SFC（SXF Ver.3.1 の
フィーチャの並び）で直に書く。電子納品の図面の作りに合わせて:
  用紙 A3 横（drawing_sheet）・図枠と表題欄・図面の属性（drawing_attribute）
  部分図（sfig_org の種類 1）: 正面図・側面図（1:1）と詳細図 A（2:1。縮尺 2 で用紙に置く）
  画層・既定の色・線種（実線・破線・一点鎖線）・線幅、文字（Shift_JIS の日本語）
  図形: 線・折れ線・円・円弧・楕円・スプライン・寸法（長さ・半径・直径）・引出線・バルーン・ハッチング（複合曲線の境界）
P21 は同じ図面の AP202 の書き方。読み取りの評価（tools/sxf-check.mjs・tests/js/sxf.test.mjs）で SFC と突き合わせる。
"""

from __future__ import annotations

import math
from pathlib import Path

PROGRAM = Path(__file__).resolve().parents[1]
SFC = PROGRAM / "samples" / "dwg" / "SXF_A1_円筒_部品図.sfc"
P21 = SFC.with_suffix(".p21")

D, L = 54.5, 77.0
R = D / 2
NOTCH_W, NOTCH_D, CORNER = 30.0, 19.287, 5.0

# 画層（名前・番号は並びの順）・色（既定の番号: 1 black 2 red 3 green 4 blue 8 white 10 brown 16 darkgray）
LAYERS = ["外形線", "かくれ線", "中心線", "寸法", "ハッチング", "図枠", "文字"]
LAYER = {name: i + 1 for i, name in enumerate(LAYERS)}
WHITE, RED, GREEN, BROWN, DARKGRAY = 8, 2, 3, 10, 16
CONT, DASHED, CHAIN = 1, 2, 8  # 既定の線種の番号
W018, W025, W035, W050, W070 = 2, 3, 4, 5, 6  # 既定の線幅の番号
ARROW, ARROW_SCALE = 6, 0.3  # 塗りの矢印・尺度（読み取りは 尺度 × 10 mm で描く。実物の図面は 0.27 ほど）


MARKS = {"drawing_attribute": "3", "clothoid": "3.1", "curve_dim": "3.1"}


class Sfc:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.n = 0

    def add(self, name: str, *params) -> None:
        self.n += 10
        mark = MARKS.get(name, "")  # Ver.3 で増えたフィーチャは /*SXF3 … SXF3*/ などで囲む
        self.lines.append(f"/*SXF{mark}\n#{self.n} = {name}_feature({','.join(param(p) for p in params)})\nSXF{mark}*/\n")


def param(v) -> str:
    if isinstance(v, str):
        return "\\'" + v.replace("\\", "\\\\") + "\\'"
    if isinstance(v, (list, tuple)):
        return "'(" + ",".join(f"{x:.6f}" for x in v) + ")'"
    if isinstance(v, int):
        return f"'{v}'"
    return f"'{v:.6f}'"


def width_of(text: str, h: float) -> float:
    """文字列の幅（全角は高さ・半角は高さの 0.6 で見積もる。読み取りはこの幅に合わせて描く）"""
    return sum(h if ord(c) > 0xFF else h * 0.6 for c in text)


class Drawing:
    def __init__(self, sfc: Sfc) -> None:
        self.s = sfc

    def style(self, layer: str, color: int, ltype: int, width: int):
        return (LAYER[layer], color, ltype, width)

    def line(self, st, a, b) -> None:
        self.s.add("line", *st, *a, *b)

    def polyline(self, st, pts) -> None:
        self.s.add("polyline", *st, len(pts), [p[0] for p in pts], [p[1] for p in pts])

    def circle(self, st, c, r) -> None:
        self.s.add("circle", *st, *c, r)

    def arc(self, st, c, r, a0, a1) -> None:
        self.s.add("arc", *st, *c, r, 0, float(a0) % 360, float(a1) % 360)  # 角は 0 以上 360 未満（SXF の決まり）

    def text(self, layer, color, text, x, y, h, base=1, angle=0.0) -> None:
        self.s.add("text_string", LAYER[layer], color, 1, text, x, y, h, width_of(text, h), 0.0, float(angle), 0.0, base, 1)

    def text_block(self, text, x, y, h, base, angle=0.0):
        """寸法・引出線の文字の 12 個の引数（角は 0 以上 360 未満。下から・右から読める向き（-90° より大きく 90° 以下）にする）"""
        angle = (float(angle) + 90) % 180 - 90
        return (1, 1, text, x, y, h, width_of(text, h), 0.0, angle % 360, 0.0, base, 1)

    def linear_dim(self, st, a, b, offset, text, h=3.5):
        """a・b を測る長さの寸法（寸法線は a→b の向きに、その左へ offset 離す）"""
        ux, uy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(ux, uy)
        ux, uy = ux / n, uy / n
        nx, ny = -uy, ux
        da = (a[0] + nx * offset, a[1] + ny * offset)
        db = (b[0] + nx * offset, b[1] + ny * offset)
        sign = 1 if offset > 0 else -1
        ext = lambda p, d: (1, *p, p[0] + nx * sign * 1, p[1] + ny * sign * 1, d[0] + nx * sign * 2, d[1] + ny * sign * 2)  # noqa: E731
        mid = ((da[0] + db[0]) / 2 + nx * 1, (da[1] + db[1]) / 2 + ny * 1)
        angle = math.degrees(math.atan2(uy, ux))
        self.s.add("linear_dim", *st, *da, *db, *ext(a, da), *ext(b, db), ARROW, 1, *da, ARROW_SCALE, ARROW, 1, *db, ARROW_SCALE,
                   *self.text_block(text, *mid, h, 2, angle))

    def radius_dim(self, st, center, r, angle, text, h=3.5):
        t = math.radians(angle)
        tip = (center[0] + r * math.cos(t), center[1] + r * math.sin(t))
        out = (center[0] + (r + 12) * math.cos(t), center[1] + (r + 12) * math.sin(t))
        self.s.add("radius_dim", *st, *center, *out, ARROW, 2, *tip, ARROW_SCALE, *self.text_block(text, out[0] + 1, out[1] + 1, h, 1))

    def diameter_dim(self, st, center, r, angle, text, h=3.5):
        t = math.radians(angle)
        a = (center[0] - r * math.cos(t), center[1] - r * math.sin(t))
        b = (center[0] + r * math.cos(t), center[1] + r * math.sin(t))
        mid = (center[0] + (r * 0.6) * math.cos(t) - 1.5 * math.sin(t), center[1] + (r * 0.6) * math.sin(t) + 1.5 * math.cos(t))
        self.s.add("diameter_dim", *st, *a, *b, ARROW, 1, *a, ARROW_SCALE, ARROW, 1, *b, ARROW_SCALE, *self.text_block(text, *mid, h, 2, angle))

    def label(self, st, pts, text, h=3.5):
        last = pts[-1]
        self.s.add("label", *st, len(pts), [p[0] for p in pts], [p[1] for p in pts], ARROW, ARROW_SCALE, *self.text_block(text, last[0] + 1, last[1] + 0.8, h, 1))

    def balloon(self, st, pts, center, r, text, h=5.0):
        self.s.add("balloon", *st, len(pts), [p[0] for p in pts], [p[1] for p in pts], *center, r, ARROW, ARROW_SCALE,
                   *self.text_block(text, *center, h, 5))


def tables(s: Sfc) -> None:
    for name in LAYERS:
        s.add("layer", name, 1)
    for name in ("red", "green", "white", "brown", "darkgray"):
        s.add("pre_defined_colour", name)
    for name in ("continuous", "dashed", "chain"):
        s.add("pre_defined_font", name)
    for w in (0.18, 0.25, 0.35, 0.5, 0.7):
        s.add("width", w)
    s.add("text_font", "ＭＳ ゴシック")


def front(d: Drawing) -> None:
    """正面図（図形の中の座標は実寸の mm。軸が横、左端に切欠き、右端にねじ穴。右下を部分断面）"""
    # 部分断面のハッチングの境界（複合曲線）は、図形より先に書く（複合曲線は、それまでにたまった図形を全て自分の線にする）
    hs = d.style("ハッチング", DARKGRAY, CONT, W018)
    d.polyline(hs, [(L - 20, -R), (L - 1, -R), (L, -R + 1), (L, -4), (L - 20, -4), (L - 20, -R)])
    d.s.add("composite_curve_org", DARKGRAY, CONT, W018, 0)  # 見えない（線は外形線が描く）。番号 1
    o = d.style("外形線", WHITE, CONT, W050)
    y = R - NOTCH_D
    d.polyline(o, [(NOTCH_W, R), (L, R), (L, -R), (0, -R), (0, y), (NOTCH_W - CORNER, y)])
    d.arc(o, (NOTCH_W - CORNER, y + CORNER), CORNER, 270, 360)
    d.line(o, (NOTCH_W, y + CORNER), (NOTCH_W, R))
    d.line(o, (L - 1, R), (L, R - 1))
    d.line(o, (L - 1, -R), (L, -R + 1))
    d.line(o, (L - 20, -R), (L - 20, -4))
    d.circle(o, (50.0, 0.0), 3.3)
    c = d.style("中心線", RED, CHAIN, W018)
    d.line(c, (-6, 0), (L + 6, 0))
    d.line(c, (50.0, -7), (50.0, 7))
    h = d.style("かくれ線", GREEN, DASHED, W025)
    for yy in (-4.0, 4.0):
        d.line(h, (L - 12, yy), (L, yy))
    d.line(h, (L - 12, -4.0), (L - 14.4, 0))
    d.line(h, (L - 12, 4.0), (L - 14.4, 0))
    # 部分断面のハッチング: 境界は複合曲線 1。模様は 45° の線（間隔 2）
    d.s.add("fill_area_style_hatching", LAYER["ハッチング"], 1, f"(16,1,2,{L - 20:.6f},{-R:.6f},2.000000,45.000000)", 1, 0, "()")
    m = d.style("寸法", BROWN, CONT, W018)
    d.linear_dim(m, (0, -R), (L, -R), -10, "77")
    d.linear_dim(m, (0, -R), (0, R), 12, "φ54.5")
    d.linear_dim(m, (0, R), (NOTCH_W, R), 8, "30")
    d.radius_dim(m, (NOTCH_W - CORNER, y + CORNER), CORNER, 225, "R5")
    d.label(m, [(L - 0.5, R - 0.5), (L + 8, R + 8), (L + 18, R + 8)], "C1")


def side(d: Drawing) -> None:
    """側面図（右から見た円。切欠きの平らな面・ねじ穴 M4 の 4 か所）"""
    o = d.style("外形線", WHITE, CONT, W050)
    cut = R - NOTCH_D
    a = math.degrees(math.asin(cut / R))
    half = math.sqrt(R * R - cut * cut)
    d.arc(o, (0, 0), R, 180 - a, 360 + a)
    d.line(o, (-half, cut), (half, cut))
    for k in range(4):
        t = math.radians(45 + 90 * k)
        d.circle(o, (20 * math.cos(t), 20 * math.sin(t)), 1.621)
    d.circle(d.style("かくれ線", GREEN, DASHED, W025), (0, 0), R - 1)
    c = d.style("中心線", RED, CHAIN, W018)
    d.line(c, (-R - 5, 0), (R + 5, 0))
    d.line(c, (0, -R - 5), (0, R + 5))
    d.circle(c, (0, 0), 20)
    m = d.style("寸法", BROWN, CONT, W018)
    d.diameter_dim(m, (0, 0), R, -35, "φ54.5")
    d.diameter_dim(m, (0, 0), 20, 200, "P.C.D. φ40")


def detail(d: Drawing) -> None:
    """詳細図 A（切欠きの隅を 2 倍で。楕円・スプラインの見本を兼ねる）"""
    o = d.style("外形線", WHITE, CONT, W050)
    d.arc(o, (0, 0), CORNER, 270, 360)
    d.line(o, (-8, -CORNER), (0, -CORNER))
    d.line(o, (CORNER, 0), (CORNER, 8))
    d.s.add("ellipse", *d.style("中心線", RED, CHAIN, W018), 0.0, 0.0, 9.0, 6.0, 30.0)
    d.s.add("spline", *o, 1, 4, [-8.0, -4.0, 0.0, 4.0], [-9.0, -12.0, -7.0, -10.0])


def sheet(d: Drawing) -> None:
    """用紙（A3 横）: 図枠・表題欄・注記・バルーン・部分図を置く"""
    f = d.style("図枠", WHITE, CONT, W070)
    d.polyline(f, [(10, 10), (410, 10), (410, 287), (10, 287), (10, 10)])
    t = d.style("図枠", WHITE, CONT, W035)
    d.polyline(t, [(290, 10), (290, 38), (410, 38)])
    d.line(t, (290, 24), (410, 24))
    d.line(t, (330, 10), (330, 38))
    d.text("文字", WHITE, "品名", 293, 28, 3.0)
    d.text("文字", WHITE, "図番", 293, 14, 3.0)
    d.text("文字", WHITE, "円筒 両切欠き＋片ネジ φ54.5", 333, 28, 3.5)
    d.text("文字", WHITE, "A1-001", 333, 13, 5.0)
    d.text("文字", WHITE, "尺度 1:1（詳細 A 2:1）", 405, 41, 3.0, base=3)
    for i, line in enumerate(["注記", "1. 指示なき角部は C0.5", "2. 材質 S45C 調質", "3. ねじ穴 M4×0.7 深さ 8（4 か所）"]):
        d.text("文字", WHITE, line, 30, 80 - i * 6, 3.5)
    d.text("文字", WHITE, "正面図", 98.5, 235, 5.0, base=2)
    d.text("文字", WHITE, "側面図", 260, 235, 5.0, base=2)
    d.text("文字", WHITE, "詳細 A (2:1)", 340, 112, 3.5, base=2)
    d.balloon(d.style("寸法", BROWN, CONT, W018), [(75, 186), (60, 215)], (55, 220), 5, "1")
    d.s.add("sfig_locate", 0, "正面図", 60.0, 160.0, 0.0, 1.0, 1.0)
    d.s.add("sfig_locate", 0, "側面図", 260.0, 160.0, 0.0, 1.0, 1.0)
    d.s.add("sfig_locate", 0, "詳細図A", 340.0, 80.0, 0.0, 2.0, 2.0)
    d.s.add("drawing_attribute", "サンプル事業", "部品 A1 の製作", "－", "円筒 部品図", "A1-001", "部品図", "1:1", 2026, 10, 8, "－", "－")
    d.s.add("drawing_sheet", "部品図", 3, 1, 420, 297)


def header() -> str:
    return ("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 feature_mode'),\n        '2;1');\n"
            "FILE_NAME('SXF_A1_円筒_部品図.sfc',\n        '2026-10-08T12:00:00',\n        (''),\n        (''),\n"
            "        'make_sxf_sample.py$$3.1',\n        'Inventor 3Dツール',\n        '');\n"
            "FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));\nENDSEC;\nDATA;\n\n")


def main() -> None:
    s = Sfc()
    d = Drawing(s)
    tables(s)
    front(d)
    s.add("sfig_org", "正面図", 1)
    side(d)
    s.add("sfig_org", "側面図", 1)
    detail(d)
    s.add("sfig_org", "詳細図A", 1)
    sheet(d)
    text = header() + "\n".join(s.lines) + "ENDSEC;\nEND-ISO-10303-21;\n"
    SFC.write_bytes(text.replace("\n", "\r\n").encode("cp932"))  # 日本の CAD と同じ Shift_JIS・CRLF
    print(SFC.relative_to(PROGRAM), f"{SFC.stat().st_size / 1024:.0f} KB")
    try:
        import ezsxf  # noqa: PLC0415 — P21 を作るときだけ要る
    except ImportError:
        print("ezsxf が無いので P21 は作りません（pip install ezsxf）")
        return
    ezsxf.write_p21(ezsxf.parse_sfc(SFC.read_bytes()), str(P21))
    print(P21.relative_to(PROGRAM), f"{P21.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
