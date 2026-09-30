"""評価用: 書き出した STEP を読み、B-rep の決まりを満たすかを確かめる（OpenCascade を使わない独立の確かめ）。

- 位相: 立体ごとに、どの稜線もちょうど 2 回、逆向きに使われる。どの輪も、稜線の終わりが次の稜線の始まりにつながって閉じる
- 幾何: 頂点が、その稜線の曲線（直線・円）の上にあり、その面の曲面（平面・円筒・円錐・球・トーラス）の上にある
- 単位: 長さの単位（length_unit）
- 向き: 輪を曲面の座標 (u, v) に写したときの回り方が、面の法線（same_sense）と合う。外周は法線から見て反時計回り、穴は時計回り。
  円弧は稜線の向き（same_sense）どおりにたどるので、円弧の向きの誤りも分かる。
  曲面の特異点（軸の上の点）を通る輪と、軸を 1 周する輪は、境界だけでは内側が決まらないので確かめない
  （OpenCascade は読むときに面の向きを直してしまうので、向きの誤りはここで見つける）
"""
from __future__ import annotations

import math
import re
from pathlib import Path

# 曲面の座標 (u, v) のうち角度のもの（±π で折り返すので、たどるときにつなぐ）
ANGLES = {"PLANE": (False, False), "CYLINDRICAL_SURFACE": (True, False), "CONICAL_SURFACE": (True, False),
          "SPHERICAL_SURFACE": (True, False), "TOROIDAL_SURFACE": (True, True)}

TOKEN = re.compile(r"\s*(#\d+|'(?:[^']|'')*'|\.[A-Z_0-9]+\.|[-+]?\d+\.?\d*(?:E[-+]?\d+)?|[A-Z_][A-Z_0-9]*|[(),$*])")


def decode(text: str) -> str:
    """STEP の文字列（\\X2\\…\\X0\\ は UTF-16 の 16 進、'' は '、\\\\ は \\）を読む"""
    text = re.sub(r"\\X2\\([0-9A-F]+)\\X0\\", lambda m: bytes.fromhex(m.group(1)).decode("utf-16-be"), text)
    return text.replace("''", "'").replace("\\\\", "\\")


def _parse(text: str):
    tokens = [m.group(1) for m in TOKEN.finditer(text)]
    pos = 0

    def value():
        nonlocal pos
        tok = tokens[pos]
        pos += 1
        if tok == "(":
            items = []
            while tokens[pos] != ")":
                items.append(value())
                if tokens[pos] == ",":
                    pos += 1
            pos += 1
            return items
        if tok.startswith("#"):
            return ("ref", int(tok[1:]))
        if tok.startswith("'"):
            return decode(tok[1:-1])
        if tok.startswith("."):
            return tok
        if tok in ("$", "*"):
            return None
        if re.match(r"[-+]?\d", tok):
            return float(tok) if ("." in tok or "E" in tok) else int(tok)
        # 型付きの値 LENGTH_MEASURE(0.01) や複合の中の実体
        if pos < len(tokens) and tokens[pos] == "(":
            return (tok, value())
        return tok

    return value()


def read(path: str | Path) -> dict[int, tuple[str, list]]:
    text = Path(path).read_text(encoding="ascii")
    data = text[text.index("DATA;") + 5 : text.index("ENDSEC;", text.index("DATA;"))]
    entities = {}
    for m in re.finditer(r"#(\d+)=(.*?);\s*(?=#\d+=|$)", data.replace("\n", ""), re.S):
        body = m.group(2).strip()
        if body.startswith("("):
            entities[int(m.group(1))] = ("COMPLEX", body)
        else:
            name = body[: body.index("(")]
            entities[int(m.group(1))] = (name, _parse(body[len(name) :]))
    return entities


def _ref(v):
    return v[1] if isinstance(v, tuple) and v[0] == "ref" else None


def _dot(a, b):
    return sum(a[k] * b[k] for k in range(3))


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _unit(a):
    n = math.sqrt(_dot(a, a))
    return [c / n for c in a]


class Brep:
    def __init__(self, path: str | Path):
        self.e = read(path)

    def of(self, name: str) -> list[int]:
        return [i for i, (n, _) in self.e.items() if n == name]

    def point(self, i):
        name, args = self.e[i]
        if name == "VERTEX_POINT":
            return self.point(_ref(args[1]))
        return tuple(args[1])

    def placement(self, i):
        _, (_, o, z, x) = self.e[i]
        return self.point(_ref(o)), tuple(self.e[_ref(z)][1][1]), tuple(self.e[_ref(x)][1][1])

    # ---- 幾何: 点と曲線・曲面の距離（軸からの距離は、軸の成分を除いたベクトルの長さで求める。|v|² − h² は桁落ちする）----
    @staticmethod
    def _split(p, o, z):
        """点 p の、原点 o・単位ベクトル z に対する (軸方向の成分 h, 軸からの距離)"""
        n = math.sqrt(sum(c * c for c in z))
        z = [c / n for c in z]
        v = [p[k] - o[k] for k in range(3)]
        h = sum(v[k] * z[k] for k in range(3))
        return h, math.sqrt(sum((v[k] - h * z[k]) ** 2 for k in range(3)))

    def curve_distance(self, curve: int, p) -> float:
        name, args = self.e[curve]
        if name == "LINE":
            o = self.point(_ref(args[1]))
            d = self.e[_ref(self.e[_ref(args[2])][1][1])][1][1]
            return self._split(p, o, d)[1]
        if name == "CIRCLE":
            (o, z, _), r = self.placement(_ref(args[1])), args[2]
            h, radial = self._split(p, o, z)
            return math.hypot(h, radial - r)
        raise ValueError(name)

    def surface_distance(self, surface: int, p) -> float:
        name, args = self.e[surface]
        o, z, _ = self.placement(_ref(args[1]))
        h, radial = self._split(p, o, z)
        if name == "PLANE":
            return abs(h)
        if name == "CYLINDRICAL_SURFACE":
            return abs(radial - args[2])
        if name == "CONICAL_SURFACE":
            r, angle = args[2], args[3]
            return abs(radial - (r + h * math.tan(angle))) * math.cos(angle)
        if name == "SPHERICAL_SURFACE":
            return abs(math.hypot(h, radial) - args[2])
        if name == "TOROIDAL_SURFACE":
            return abs(math.hypot(h, radial - args[2]) - args[3])
        raise ValueError(name)

    # ---- 向き: 稜線を輪の向きにたどった点と、曲面の座標 (u, v) ----
    def frame(self, placement: int):
        """配置の正規直交の枠 (原点, x, y, z)"""
        o, z, x = self.placement(placement)
        z = _unit(z)
        x = _unit([x[k] - _dot(x, z) * z[k] for k in range(3)])
        return o, x, _cross(z, x), z

    def edge_points(self, edge: int, forward: bool, n: int = 16) -> list:
        """稜線を、輪の向き（forward）にたどった点。終点は次の稜線の始点なので含めない"""
        _, (_, v1, v2, curve, same) = self.e[edge]
        a, b = self.point(_ref(v1)), self.point(_ref(v2))
        name, args = self.e[_ref(curve)]
        if name == "LINE":
            points = [a, b]
        elif name == "CIRCLE":
            o, x, y, _ = self.frame(_ref(args[1]))
            r = args[2]

            def angle(p):
                d = [p[k] - o[k] for k in range(3)]
                return math.atan2(_dot(d, y), _dot(d, x))

            start, end = angle(a), angle(b)
            sweep = (end - start) % math.tau if same == ".T." else -((start - end) % math.tau)
            sweep = sweep or (math.tau if same == ".T." else -math.tau)  # 始点と終点が同じなら 1 周
            points = [[o[k] + r * (math.cos(t) * x[k] + math.sin(t) * y[k]) for k in range(3)]
                      for t in (start + sweep * i / n for i in range(n + 1))]
        else:
            raise ValueError(name)
        return (points if forward else points[::-1])[:-1]

    def surface_uv(self, surface: int, p, tol: float):
        """曲面の座標 (u, v)。u, v の向きは ISO 10303-42 の曲面の式どおりで、∂u × ∂v が自然な法線（軸・中心から離れる向き）。
        特異点（平面以外で軸の上の点）は None"""
        name, args = self.e[surface]
        o, x, y, z = self.frame(_ref(args[1]))
        d = [p[k] - o[k] for k in range(3)]
        px, py, h = _dot(d, x), _dot(d, y), _dot(d, z)
        if name == "PLANE":
            return px, py
        rho = math.hypot(px, py)
        if rho <= tol:
            return None
        u = math.atan2(py, px)
        if name in ("CYLINDRICAL_SURFACE", "CONICAL_SURFACE"):
            return u, h
        if name == "SPHERICAL_SURFACE":
            return u, math.atan2(h, rho)
        if name == "TOROIDAL_SURFACE":
            return u, math.atan2(h, rho - args[2])
        raise ValueError(name)

    def loop_area(self, surface: int, loop: int, tol: float) -> float | None:
        """輪を曲面の座標に写した多角形の符号付き面積（反時計回りが正）。特異点を通る・軸（管）を 1 周する輪は None"""
        uv = []
        for used in self.e[loop][1][1]:
            _, (_, _, _, edge, forward) = self.e[_ref(used)]
            for p in self.edge_points(_ref(edge), forward == ".T."):
                if (q := self.surface_uv(surface, p, tol)) is None:
                    return None
                uv.append(list(q))
        # 角度の座標（平面以外の u、トーラスの v）は、隣の点との差が ±π に収まるようにつなぐ
        for k in [k for k, angle in enumerate(ANGLES[self.e[surface][0]]) if angle]:
            turn = 0.0
            for i in range(1, len(uv) + 1):
                step = (uv[i % len(uv)][k] - uv[i - 1][k] + math.pi) % math.tau - math.pi
                turn += step
                if i < len(uv):
                    uv[i][k] = uv[i - 1][k] + step
            if abs(turn) > math.pi:
                return None
        return sum(uv[i - 1][0] * uv[i][1] - uv[i][0] * uv[i - 1][1] for i in range(len(uv))) / 2

    def orientation_problems(self, face: int, tol: float) -> list[str]:
        """外周は面の法線から見て反時計回り、穴は時計回りか"""
        _, (_, bounds, surface, same) = self.e[face]
        out = []
        for bound in bounds:
            kind, (_, loop, positive) = self.e[_ref(bound)]
            area = self.loop_area(_ref(surface), _ref(loop), tol)
            if area is None:
                continue
            outer = kind == "FACE_OUTER_BOUND" or len(bounds) == 1
            expected = (same == ".T.") == (positive == ".T.") == outer
            if (area > 0) != expected:
                out.append(f"面 #{face} の{'外周' if outer else '穴'} #{_ref(loop)} の向きが法線と合わない（面積 {area:.3g}）")
        return out

    # ---- 確かめ ----
    def problems(self, tol: float = 1e-6) -> list[str]:
        out = []
        for solid in self.of("MANIFOLD_SOLID_BREP"):
            shell = _ref(self.e[solid][1][1])
            uses: dict[int, list[bool]] = {}
            for face_ref in self.e[shell][1][1]:
                face = _ref(face_ref)
                _, (_, bounds, surface, _) = self.e[face]
                for bound in bounds:
                    loop = _ref(self.e[_ref(bound)][1][1])
                    ring = []
                    for used in self.e[loop][1][1]:
                        _, (_, _, _, edge, forward) = self.e[_ref(used)]
                        edge = _ref(edge)
                        uses.setdefault(edge, []).append(forward == ".T.")
                        _, (_, v1, v2, curve, _) = self.e[edge]
                        start, end = (_ref(v1), _ref(v2)) if forward == ".T." else (_ref(v2), _ref(v1))
                        ring.append((start, end))
                        for v in (start, end):
                            p = self.point(v)
                            if (d := self.curve_distance(_ref(curve), p)) > tol:
                                out.append(f"#{v} が稜線 #{edge} の曲線から {d:.2e} 離れている")
                            if (d := self.surface_distance(_ref(surface), p)) > tol:
                                out.append(f"#{v} が面 #{face} の曲面から {d:.2e} 離れている")
                    for (_, end), (start, _) in zip(ring, ring[1:] + ring[:1]):
                        if end != start:
                            out.append(f"面 #{face} の輪 #{loop} が #{end} → #{start} で途切れている")
                out += self.orientation_problems(face, tol)
            for edge, directions in uses.items():
                if sorted(directions) != [False, True]:
                    out.append(f"稜線 #{edge} の使われ方が {directions}（逆向きに 2 回のはず）")
        return out

    def length_unit(self) -> str:
        """長さの単位（SI の接頭語と単位。例: "MILLI METRE"。接頭語が無ければ "METRE"）"""
        for name, body in self.e.values():
            if name == "COMPLEX" and "LENGTH_UNIT" in body:
                prefix, unit = re.search(r"SI_UNIT\(([^,]*),([^)]*)\)", body).groups()
                return " ".join(v.strip(".") for v in (prefix, unit) if v != "$")
        raise ValueError("長さの単位が無い")

    def occurrences(self) -> list[tuple[str, tuple]]:
        """組立の出現: (名前, 置いた位置の原点)"""
        out = []
        for i in self.of("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION"):
            relation, shape = (_ref(v) for v in self.e[i][1])
            usage = _ref(self.e[shape][1][2])
            body = self.e[relation][1]
            transform = int(re.search(r"REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\(#(\d+)\)", body).group(1))
            target = _ref(self.e[transform][1][3])
            out.append((self.e[usage][1][1], self.placement(target)))
        return out
