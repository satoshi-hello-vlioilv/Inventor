"""Inventor のスケッチの拘束・寸法とパラメータを模したもの（fake_inventor が使う）。

ビルダーが付ける拘束・寸法を、アプリ（JS の convert/parametric.js）とは別に実装した式で確かめる:
    - 拘束・駆動寸法を付けた時点で、今の形に合っている（合わなければ Inventor は形を動かす。ここでは誤りとして知らせる）
    - ほかの拘束・寸法と重ならない（本物の Inventor も「拘束が多すぎる」で断る）。数値の勾配の階数で判定する
    - 自由度（free_degrees）: 変数（スケッチ点の座標・円の半径）の数 − 式の階数。0 なら完全拘束
    - 寸法のパラメータに式（ユーザー パラメータの名前）を入れると、その値が今の寸法と同じか確かめる
長さの単位は cm、角度はラジアン（Inventor の内部と同じ）。
"""
from __future__ import annotations

import math
import re

H = 1e-7  # cm: 数値微分の幅
RESIDUAL = 1e-6  # 今の形に合うとみなす式の値（cm・単位ベクトルの成分）
VALUE_TOL = 1e-7  # cm: 寸法の式の値と今の寸法の差の許容（名前つきの値は mm で小数 6 桁。Inventor は形をその差だけ動かす）
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
UNITS = {"mm": 0.1, "cm": 1.0, "deg": math.pi / 180, "rad": 1.0}


def _error(message: str) -> Exception:
    from tests.fake_inventor import FakeComError  # noqa: PLC0415 — 循環を避ける

    return FakeComError(message)


# ---- パラメータ ------------------------------------------------------------------------------
class Parameter:
    def __init__(self, registry, name: str, value: float, kind: str):
        self.registry, self._name, self.Value, self.kind = registry, name, value, kind  # Value は cm・ラジアン
        self._expression = None
        self.Comment = ""

    @property
    def Name(self):  # noqa: N802 — COM の名前
        return self._name

    @Name.setter
    def Name(self, name):  # noqa: N802
        self.registry.check_name(name, self)
        self._name = name

    @property
    def Expression(self):  # noqa: N802
        return self._expression

    @Expression.setter
    def Expression(self, expression):  # noqa: N802
        value = self.registry.evaluate(expression)
        if abs(value - self.Value) > VALUE_TOL + 1e-9 * abs(self.Value):
            raise _error(f"式 {expression} の値 {value:.9g} が今の寸法 {self.Value:.9g} と違います（形が変わります）")
        self._expression = expression


class Parameters:
    """部品のパラメータ（ユーザー パラメータと、寸法が作るモデル パラメータ d0, d1, …）"""

    def __init__(self):
        self.user: list[Parameter] = []
        self.model: list[Parameter] = []
        outer = self

        class UserParameters:
            def AddByExpression(self, name, expression, units):  # noqa: N802
                outer.check_name(name, None)
                if units not in UNITS:
                    raise _error(f"単位 {units} は扱えません")
                parameter = Parameter(outer, name, outer.evaluate(expression), "angle" if units in ("deg", "rad") else "length")
                parameter._expression = expression
                outer.user.append(parameter)
                return parameter

            @property
            def Count(self):  # noqa: N802
                return len(outer.user)

        self.UserParameters = UserParameters()

    def all(self) -> list[Parameter]:
        return [*self.user, *self.model]

    def check_name(self, name: str, owner) -> None:
        if not isinstance(name, str) or not NAME.match(name):
            raise _error(f"パラメータの名前 {name!r} は使えません")
        if any(p.Name == name and p is not owner for p in self.all()):
            raise _error(f"パラメータの名前 {name} は既にあります")

    def model_parameter(self, value: float, kind: str) -> Parameter:
        parameter = Parameter(self, f"d{len(self.model)}", value, kind)
        self.model.append(parameter)
        return parameter

    def evaluate(self, expression) -> float:
        """式の値（cm・ラジアン）: 「数 単位」・「名前」・「名前 / 数」"""
        if isinstance(expression, (int, float)):
            return float(expression)
        text = str(expression).strip()
        m = re.fullmatch(r"(-?[\d.]+(?:e-?\d+)?)\s*([a-z]+)", text)
        if m:
            return float(m.group(1)) * UNITS[m.group(2)]
        m = re.fullmatch(r"([A-Za-z]\w*)(?:\s*/\s*([\d.]+))?", text)
        if m:
            found = [p for p in self.all() if p.Name == m.group(1)]
            if not found:
                raise _error(f"パラメータ {m.group(1)} がありません")
            return found[0].Value / (float(m.group(2)) if m.group(2) else 1.0)
        raise _error(f"式 {text} を読めません")


# ---- 投影した原点・軸 ------------------------------------------------------------------------
class FixedPoint:
    def __init__(self, x: float, y: float):
        from tests.fake_inventor import Point2d  # noqa: PLC0415

        self.Geometry = Point2d(x, y)
        self.fixed = True


class FixedLine:
    """原点を通る軸（投影した作業軸）。direction: (1, 0) = X 軸、(0, 1) = Y 軸"""

    def __init__(self, direction):
        self.direction = direction
        self.fixed = True


# ---- 拘束の式 --------------------------------------------------------------------------------
def _xy(point) -> tuple[float, float]:
    return point.Geometry.X, point.Geometry.Y


def _direction(line) -> tuple[float, float]:
    (ax, ay), (bx, by) = _xy(line.StartSketchPoint), _xy(line.EndSketchPoint)
    return bx - ax, by - ay


def _unit(v) -> tuple[float, float]:
    n = math.hypot(*v)
    return v[0] / n, v[1] / n


def _shared(e1, e2):
    ends = lambda e: [e.StartSketchPoint, e.EndSketchPoint]  # noqa: E731
    for p in ends(e1):
        if any(p is q for q in ends(e2)):
            return p
    raise _error("接線の拘束: 2 つの線が端点を共有していません")


class DimensionConstraint:
    def __init__(self, parameter, driven: bool):
        self.Parameter, self.Driven = parameter, driven


class ConstraintSystem:
    """スケッチの拘束の式の集まり。変数はスケッチ点の座標と円の半径（投影した点・軸は動かない）"""

    def __init__(self, sketch, parameters: Parameters):
        self.sketch, self.parameters = sketch, parameters
        self.equations: list[tuple[str, callable]] = []
        self.dimensions: list[DimensionConstraint] = []
        self.geometric: list[str] = []
        outer = self

        class Geometric:
            def AddHorizontal(self, line, *_):  # noqa: N802
                outer.add("水平", lambda: _direction(line)[1] / math.hypot(*_direction(line)))
                outer.geometric.append("horizontal")

            def AddVertical(self, line, *_):  # noqa: N802
                outer.add("垂直", lambda: _direction(line)[0] / math.hypot(*_direction(line)))
                outer.geometric.append("vertical")

            def AddParallel(self, a, b, *_):  # noqa: N802
                outer.add("平行", lambda: _cross(_unit(_direction(a)), _unit(_direction(b))))
                outer.geometric.append("parallel")

            def AddTangent(self, a, b, *_):  # noqa: N802
                p = _shared(a, b)
                lines = [e for e in (a, b) if not hasattr(e, "CenterSketchPoint")]
                if len(lines) == 1:
                    arc = b if lines[0] is a else a
                    f = lambda: _dot(_unit(_direction(lines[0])), _unit(_sub(_xy(p), _xy(arc.CenterSketchPoint))))  # noqa: E731
                elif not lines:
                    f = lambda: _cross(_unit(_sub(_xy(p), _xy(a.CenterSketchPoint))), _unit(_sub(_xy(p), _xy(b.CenterSketchPoint))))  # noqa: E731
                else:
                    raise _error("接線の拘束: 直線どうしには付けられません")
                outer.add("接線", f)
                outer.geometric.append("tangent")

            def AddCoincident(self, point, other, *_):  # noqa: N802
                if not isinstance(other, FixedLine):
                    raise _error("一致の拘束: この代替は、点と投影した軸だけを扱います")
                k = 1 if other.direction == (1, 0) else 0  # X 軸の上なら Y = 0、Y 軸の上なら X = 0
                outer.add("軸の上", lambda: _xy(point)[k])
                outer.geometric.append("onAxis")

        class Dimensions:
            def AddDiameter(self, circle, text, driven=False):  # noqa: N802
                return outer.dimension("直径", lambda: 2 * circle.radius, driven, "length")

            def AddRadius(self, arc, text, driven=False):  # noqa: N802
                return outer.dimension("半径", lambda: math.dist(_xy(arc.StartSketchPoint), _xy(arc.CenterSketchPoint)), driven, "length")

            def AddTwoPointDistance(self, a, b, orientation, text, driven=False):  # noqa: N802
                from tests.fake_inventor import K_HORIZONTAL_DIM, K_VERTICAL_DIM  # noqa: PLC0415

                if orientation == K_HORIZONTAL_DIM:
                    f = lambda: abs(_xy(b)[0] - _xy(a)[0])  # noqa: E731
                elif orientation == K_VERTICAL_DIM:
                    f = lambda: abs(_xy(b)[1] - _xy(a)[1])  # noqa: E731
                else:
                    f = lambda: math.dist(_xy(a), _xy(b))  # noqa: E731
                if f() < 1e-9:
                    raise _error("長さ 0 の寸法は付けられません")
                return outer.dimension("2 点の距離", f, driven, "length")

            def AddTwoLineAngle(self, a, b, text, driven=False):  # noqa: N802
                da = (lambda: _direction(a)) if not isinstance(a, FixedLine) else (lambda: a.direction)
                db = (lambda: _direction(b)) if not isinstance(b, FixedLine) else (lambda: b.direction)
                return outer.dimension("角度", lambda: math.atan2(abs(_cross(da(), db())), _dot(da(), db())), driven, "angle")

        self.Geometric, self.Dimensions = Geometric(), Dimensions()

    # 変数と式
    def variables(self) -> list[tuple[object, str]]:
        out, seen = [], set()
        for e in self.sketch.entities:
            points = [e.CenterSketchPoint] if hasattr(e, "radius") else [e.StartSketchPoint, e.EndSketchPoint]
            if hasattr(e, "CenterSketchPoint") and not hasattr(e, "radius"):
                points.append(e.CenterSketchPoint)
            for p in points:
                if id(p) not in seen:
                    seen.add(id(p))
                    out += [(p.Geometry, "X"), (p.Geometry, "Y")]
            if hasattr(e, "radius"):
                out.append((e, "radius"))
        return out

    def inherent(self) -> list[callable]:
        """円弧が元から持つ式: 両端が中心から同じ距離"""
        return [(lambda e=e: math.dist(_xy(e.StartSketchPoint), _xy(e.CenterSketchPoint)) - math.dist(_xy(e.EndSketchPoint), _xy(e.CenterSketchPoint)))
                for e in self.sketch.entities if hasattr(e, "CenterSketchPoint") and not hasattr(e, "radius")]

    def row(self, f, variables) -> list[float]:
        """式 f の勾配（数値微分）"""
        out = [0.0] * len(variables)
        for j, (obj, attr) in enumerate(variables):
            v = getattr(obj, attr)
            setattr(obj, attr, v + H)
            plus = f()
            setattr(obj, attr, v - H)
            minus = f()
            setattr(obj, attr, v)
            out[j] = (plus - minus) / (2 * H)
        return out

    def basis(self) -> list[list[float]]:
        """これまでの式（円弧の式を含む）の勾配が張る空間の正規直交基底（スケッチに線が増えたら作り直す）"""
        variables = self.variables()
        key = (len(self.sketch.entities), len(variables))
        if getattr(self, "_key", None) != key:
            self._key, self._variables, self._basis, self._count = key, variables, [], 0
            for f in self.inherent():
                self._extend(f)
        while self._count < len(self.equations):
            self._extend(self.equations[self._count][1])
            self._count += 1
        return self._basis

    def _extend(self, f) -> bool:
        """勾配が今の基底と独立なら基底に足して True（グラム・シュミットを 2 回。丸めの誤差を抑える）"""
        r = self.row(f, self._variables)
        norm = math.sqrt(math.fsum(v * v for v in r))
        if norm == 0:
            return False
        r = [v / norm for v in r]
        for _ in range(2):
            for b in self._basis:
                d = math.fsum(x * y for x, y in zip(r, b))
                if d:
                    r = [x - d * y for x, y in zip(r, b)]
        rest = math.sqrt(math.fsum(v * v for v in r))
        if rest <= 1e-7:
            return False
        self._basis.append([v / rest for v in r])
        return True

    def add(self, label: str, f) -> None:
        residual = f()
        if abs(residual) > RESIDUAL:
            raise _error(f"{label}の拘束が今の形に合いません（{residual:.2e}）")
        self.basis()
        if not self._extend(f):
            raise _error(f"{label}: 拘束が多すぎます（ほかの拘束・寸法と重なります）")
        self.equations.append((label, f))
        self._count += 1

    def dimension(self, label: str, measure, driven: bool, kind: str) -> DimensionConstraint:
        value = measure()
        if not driven:
            self.add(label, lambda: measure() - value)
        constraint = DimensionConstraint(self.parameters.model_parameter(value, kind), driven)
        self.dimensions.append(constraint)
        return constraint

    def free_degrees(self) -> int:
        """自由度（0 = 完全拘束）"""
        return len(self.variables()) - len(self.basis())


def _sub(p, q):
    return p[0] - q[0], p[1] - q[1]


def _dot(p, q):
    return p[0] * q[0] + p[1] * q[1]


def _cross(p, q):
    return p[0] * q[1] - p[1] * q[0]
