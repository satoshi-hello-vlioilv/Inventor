"""Inventor API（COM）で部品（.ipt）と組立（.iam）を作る。

作り方（部品のローカル座標系は変換データと同じ）:
    回転体   … XY 平面のスケッチに断面（x = 半径, y = 軸方向）を描き、Y 軸まわりに回転する。
               360° 未満は XY 平面に対して対称に回す
    押し出し … XY 平面のスケッチに断面を描き、Z 方向に XY 平面に対して対称に押し出す。
               面取りは、押し出した端面（Z = ±長さ/2 の平らな面）の稜線のうち、指定したループの上にあるものを選び、
               等距離の面取り（ChamferFeatures.AddUsingDistance）をかける。同じ大きさの面取りは 1 つのフィーチャにまとめる
対称にするのは、回転・押し出しの「正方向」の解釈に左右されず、変換データと同じ形にするため。
    近似     … 三角形のままの部品は、その部品だけの STEP（step.py が書いたもの）を Inventor で開き、.ipt として保存する
直せる部品（変換データの版 4 の parametric）… 断面に幾何拘束・寸法拘束を付けて完全拘束にし、寸法の値・押し出しの長さ・回転の角度・
               面取りの大きさを、名前つきの値（ユーザー パラメータ。アプリの寸法の欄と同じ名前）の式にする。Inventor でその値を変えると形が変わる。
               付けられない拘束・寸法があっても、形はそのまま作る（作った形は同じ。知らせに数と理由を残す）

Inventor API の長さの単位は cm、角度はラジアン。mm → cm の換算はこのモジュールの中だけで行う。
作った部品の体積・表面積・外接箱を Inventor に計算させ、変換データの期待値と照合する。
"""
from __future__ import annotations

import math
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from .spec import Part, Segment, Spec, distance_to_loop
from .step import write_step
from .verify import body_bbox, check_extent

MM_PER_CM = 10.0
PART_STEPS = "step"  # 近似の部品を Inventor で開くための、部品ごとの STEP を置くフォルダ（保存先の中）
REL_TOL = 1e-4  # 体積・表面積の照合の許容差（相対）
EDGE_TOL = 1e-3  # mm。稜線が端面・ループの上にあるとみなす距離

# Inventor API の列挙値
K_PART_DOCUMENT = 12290  # DocumentTypeEnum.kPartDocumentObject
K_ASSEMBLY_DOCUMENT = 12291  # DocumentTypeEnum.kAssemblyDocumentObject
K_JOIN = 20481  # PartFeatureOperationEnum.kJoinOperation
K_SYMMETRIC = 20995  # PartFeatureExtentDirectionEnum.kSymmetricExtentDirection
XY_PLANE = 3  # 原点の作業平面: 1 = YZ, 2 = XZ, 3 = XY
X_AXIS, Y_AXIS = 1, 2  # 原点の作業軸: 1 = X, 2 = Y, 3 = Z
ORIGIN = 1  # 原点の作業点
# DimensionOrientationEnum（寸法の向き。実物の Inventor ではまだ確かめていない。docs/inventor-builder.md §5）
K_HORIZONTAL_DIM, K_VERTICAL_DIM, K_ALIGNED_DIM = 19201, 19202, 19203

PROG_ID = "Inventor.Application"
# Inventor が起動中・処理中で呼び出しを受け付けない（COM の RPC_E_CALL_REJECTED・RPC_E_SERVERCALL_RETRYLATER）。待ってやり直す
BUSY_HRESULTS = (-2147418111, -2147417846)
READY_TIMEOUT = 300.0  # 秒。起動を待つ上限（ライセンスの確認などで数分かかることがある）

KIND_LABEL = {"revolve": "回転体", "extrude": "押し出し", "mesh": "近似"}
SEGMENT_LABEL = {"line": "直線", "arc": "円弧", "circle": "円"}


def cm(value_mm: float) -> float:
    return value_mm / MM_PER_CM


def describe(part: Part) -> str:
    """iProperties の「説明」に入れる文。"""
    named = f"・名前つきの値 {len(part.parametric.params)}" if part.parametric and part.parametric.params else ""
    if part.kind == "mesh":
        return f"近似（三角形 {len(part.mesh.triangles)} 枚のまま。円は多角形）（three.js から変換）"
    counts: dict[str, int] = {}
    for loop in part.loops:
        for s in loop:
            counts[s.type] = counts.get(s.type, 0) + 1
    section = "・".join(f"{SEGMENT_LABEL[k]} {v}" for k, v in counts.items())
    extent = f"{part.angle_deg:g}°" if part.kind == "revolve" else f"長さ {part.distance:g} mm"
    chamfer = "".join(f"・面取り C{d:g}（縁 {sum(c.distance == d for c in part.chamfers)} か所）" for d in sorted({c.distance for c in part.chamfers}))
    return f"{KIND_LABEL[part.kind]} {extent}{chamfer}／断面 {section}{named}（three.js から変換）"


@dataclass
class PartResult:
    part: Part
    path: Path | None = None
    volume: float | None = None  # Inventor が計算した体積（mm³）
    area: float | None = None  # Inventor が計算した表面積（mm²）
    error: str | None = None
    extent_check: bool | None = None  # 外接箱の確認（None = 確認できない）
    extent_detail: str = ""
    notes: list[str] = field(default_factory=list)
    parametric: dict | None = None  # 付けた名前つきの値・拘束・寸法の数と、付けられなかったもの（ParametricLog.summary）

    @property
    def volume_diff(self) -> float | None:
        return None if self.volume is None else (self.volume - self.part.expect_volume) / self.part.expect_volume

    @property
    def area_diff(self) -> float | None:
        return None if self.area is None else (self.area - self.part.expect_area) / self.part.expect_area

    @property
    def ok(self) -> bool:
        return (
            self.error is None
            and self.volume is not None
            and abs(self.volume_diff) <= REL_TOL
            and abs(self.area_diff) <= REL_TOL
            and self.extent_check is not False
        )


def com_error_text(error: Exception) -> str:
    """COM の例外から、人が読める説明を取り出す。"""
    info = getattr(error, "excepinfo", None)
    if info and len(info) > 2 and info[2]:
        return str(info[2]).strip()
    return str(error)


class ParametricLog:
    """直せる部品にした結果: 作った名前つきの値・付けた拘束と寸法の数・付けられなかったもの"""

    def __init__(self, plan):
        self.plan = plan
        self.created: set[str] = set()
        self.constraints = self.dimensions = self.driven = 0
        self.failed: list[str] = []

    def fail(self, what: str, error: Exception) -> None:
        self.failed.append(f"{what}: {com_error_text(error)}")

    def value(self, name: str | None, number: float):
        """フィーチャの値: 名前つきの値を作れていれば、その名前（式）。無ければ数（cm・ラジアン）"""
        return name if name and name in self.created else number

    def summary(self) -> dict:
        return {"params": len(self.created), "constraints": self.constraints, "dimensions": self.dimensions, "driven": self.driven,
                "free": self.plan.free, "failed": self.failed}


class Builder:
    def __init__(self, app, part_template: str | None = None, assembly_template: str | None = None):
        self.app = app
        self.tg = app.TransientGeometry
        self.part_template = part_template or app.FileManager.GetTemplateFile(K_PART_DOCUMENT)
        self.assembly_template = assembly_template or app.FileManager.GetTemplateFile(K_ASSEMBLY_DOCUMENT)

    # ---- スケッチ ---------------------------------------------------------------
    def _point(self, p) -> object:
        return self.tg.CreatePoint2d(cm(p[0]), cm(p[1]))

    @staticmethod
    def _at(sketch_point, p) -> float:
        g = sketch_point.Geometry
        return math.hypot(g.X - cm(p[0]), g.Y - cm(p[1]))

    def _ends(self, entity, s: Segment):
        """作った線の両端のスケッチ点を (s.a 側, s.b 側) の順で返す（Inventor が始点・終点を入れ替えていても正しく選ぶ）。"""
        start, end = entity.StartSketchPoint, entity.EndSketchPoint
        return (start, end) if self._at(end, s.b) <= self._at(start, s.b) else (end, start)

    def draw_loop(self, sketch, loop: tuple[Segment, ...]) -> list[dict]:
        """1 つのループを、隣どうしで端点（スケッチ点）を共有する直線・円弧で描く。
        部分ごとに {entity, a, b, center}（作った線と、s.a 側・s.b 側の端・中心のスケッチ点）を返す（拘束を付けるのに使う）"""
        if len(loop) == 1 and loop[0].type == "circle":
            s = loop[0]
            circle = sketch.SketchCircles.AddByCenterRadius(self._point(s.center), cm(s.radius))
            return [{"entity": circle, "a": None, "b": None, "center": circle.CenterSketchPoint}]
        drawn = []
        first = previous = None
        for i, s in enumerate(loop):
            start = previous if previous is not None else self._point(s.a)
            end = first if i == len(loop) - 1 else self._point(s.b)
            if s.type == "line":
                entity = sketch.SketchLines.AddByTwoPoints(start, end)
            else:
                entity = sketch.SketchArcs.AddByCenterStartEndPoint(self._point(s.center), start, end, s.ccw)
            head, tail = self._ends(entity, s)
            drawn.append({"entity": entity, "a": head, "b": tail, "center": entity.CenterSketchPoint if s.type == "arc" else None})
            if first is None:
                first = head
            previous = tail
        return drawn

    # ---- 面取り -----------------------------------------------------------------
    @staticmethod
    def _items(collection) -> list:
        return [collection.Item(i) for i in range(1, collection.Count + 1)]

    def cap_edges(self, body, part: Part, chamfer) -> list:
        """面取りする稜線: 端面（全ての稜線が Z = ±長さ/2 にある面）の稜線のうち、指定したループの上にあるもの。"""
        z = chamfer.side * part.distance / 2
        loop = part.loops[chamfer.loop]
        selected = []
        for face in self._items(body.Faces):
            edges = self._items(face.Edges)
            points = [(p.X * MM_PER_CM, p.Y * MM_PER_CM, p.Z * MM_PER_CM) for p in (e.PointOnEdge for e in edges)]
            if not edges or any(abs(p[2] - z) > EDGE_TOL for p in points):
                continue
            selected += [e for e, p in zip(edges, points) if distance_to_loop(p[:2], loop) <= EDGE_TOL]
        return selected

    def add_chamfers(self, definition, part: Part, values: list | None = None) -> None:
        """同じ値の面取りを 1 つのフィーチャにする（values: 面取りごとの値。名前つきの値の式なら面取りごとに別の値なので、1 つずつ）。
        稜線は値ごとに、その時点のボディから選び直す（フィーチャを足すと形が作り直され、前に取り出した稜線は使えなくなる）"""
        by_distance: dict = {}
        for chamfer, value in zip(part.chamfers, values or [cm(c.distance) for c in part.chamfers]):
            by_distance.setdefault(value, []).append(chamfer)
        for distance, chamfers in by_distance.items():
            body = definition.SurfaceBodies.Item(1)
            collection = self.app.TransientObjects.CreateEdgeCollection()
            for chamfer in chamfers:
                edges = self.cap_edges(body, part, chamfer)
                if not edges:
                    raise RuntimeError(f"面取りする稜線が見つかりません（{chamfer.label}）")
                for edge in edges:
                    collection.Add(edge)
            definition.Features.ChamferFeatures.AddUsingDistance(collection, distance)

    # ---- 部品 -------------------------------------------------------------------
    def build_part(self, part: Part, out_dir: Path) -> PartResult:
        """部品を作る。近似の部品（kind: mesh）は、その部品だけの STEP を書いて（保存先の step フォルダ）Inventor で開き、.ipt にする"""
        result = PartResult(part)
        doc = None
        try:
            if part.kind == "mesh":
                step_path = out_dir / PART_STEPS / f"{part.name}.stp"
                write_step(Spec(source={}, parts=(part,), skipped=()), step_path, assembly=False)
                doc = self.app.Documents.Open(str(step_path), True)
                return self._finish(doc, doc.ComponentDefinition, part, out_dir, result)
            doc = self.app.Documents.Add(K_PART_DOCUMENT, self.part_template, True)
            definition = doc.ComponentDefinition
            log = ParametricLog(part.parametric)
            if part.parametric:
                self.add_parameters(definition, part.parametric, log)
            sketch = definition.Sketches.Add(definition.WorkPlanes.Item(XY_PLANE))
            drawn = [self.draw_loop(sketch, loop) for loop in part.loops]
            if part.parametric:
                self.constrain(definition, sketch, part.parametric, drawn, log)
            profile = sketch.Profiles.AddForSolid()
            features = definition.Features
            plan = part.parametric
            if part.kind == "revolve":
                axis = definition.WorkAxes.Item(Y_AXIS)
                if part.full_revolve:
                    features.RevolveFeatures.AddFull(profile, axis, K_JOIN)
                else:
                    angle = log.value(plan and plan.angle, math.radians(part.angle_deg))
                    features.RevolveFeatures.AddByAngle(profile, axis, angle, K_SYMMETRIC, K_JOIN)
            else:
                extrude = features.ExtrudeFeatures.CreateExtrudeDefinition(profile, K_JOIN)
                extrude.SetDistanceExtent(log.value(plan and plan.distance, cm(part.distance)), K_SYMMETRIC)
                features.ExtrudeFeatures.Add(extrude)
                if part.chamfers:
                    names = plan.chamfers if plan and plan.chamfers else [None] * len(part.chamfers)
                    self.add_chamfers(definition, part, [log.value(n, cm(c.distance)) for n, c in zip(names, part.chamfers)])
            result.parametric = log.summary() if part.parametric else None
            if log.failed:
                result.notes.append(f"寸法・拘束のうち {len(log.failed)} 個を付けられませんでした（形は同じ。最初の理由: {log.failed[0]}）")
            return self._finish(doc, definition, part, out_dir, result)
        except Exception as error:  # noqa: BLE001 — 1 部品の失敗で全体を止めない
            result.error = com_error_text(error)
        finally:
            if doc is not None:
                try:
                    doc.Close(True)
                except Exception:  # noqa: BLE001
                    result.notes.append("部品を閉じられませんでした")
        return result

    # ---- 直せる部品（拘束・寸法・名前つきの値） -----------------------------------------
    def add_parameters(self, definition, plan, log: ParametricLog) -> None:
        """名前つきの値（ユーザー パラメータ）を作る。作れなかった名前は、式の代わりに数を使う（log.value）"""
        user = definition.Parameters.UserParameters
        for p in plan.params:
            try:
                parameter = user.AddByExpression(p["name"], f"{p['value']:.12g} {p['unit']}", p["unit"])
                parameter.Comment = p.get("comment", "")
                log.created.add(p["name"])
            except Exception as error:  # noqa: BLE001 — 付けられなくても形は作る
                log.fail(f"名前つきの値 {p['name']}", error)

    def constrain(self, definition, sketch, plan, drawn: list[list[dict]], log: ParametricLog) -> None:
        """計画の幾何拘束・寸法拘束を付ける（1 つずつ。付けられないものは数えて飛ばす）"""
        projected: dict[str, object] = {}

        def project(key: str, item):
            if key not in projected:
                projected[key] = sketch.AddByProjectingEntity(item)
            return projected[key]

        origin = lambda: project("origin", definition.WorkPoints.Item(ORIGIN))  # noqa: E731
        axis = lambda name: project(name, definition.WorkAxes.Item(X_AXIS if name == "x" else Y_AXIS))  # noqa: E731
        entity = lambda ref: drawn[ref[0]][ref[1]]["entity"]  # noqa: E731
        point = lambda ref: drawn[ref["loop"]][ref["seg"]][ref["end"]]  # noqa: E731
        gc, dc = sketch.GeometricConstraints, sketch.DimensionConstraints
        for c in plan.constraints:
            try:
                kind = c["type"]
                if kind == "horizontal":
                    gc.AddHorizontal(entity(c["seg"]))
                elif kind == "vertical":
                    gc.AddVertical(entity(c["seg"]))
                elif kind == "parallel":
                    gc.AddParallel(*(entity(s) for s in c["segs"]))
                elif kind == "tangent":
                    gc.AddTangent(*(entity(s) for s in c["segs"]))
                else:  # onAxis: 原点の軸の上（axis "y" = Y 軸の上 = X が 0）
                    gc.AddCoincident(point(c["point"]), axis(c["axis"]))
                log.constraints += 1
            except Exception as error:  # noqa: BLE001
                log.fail(f"拘束 {c['type']}", error)
        for d in plan.dimensions:
            try:
                text = self._point(d["text"])
                driven = bool(d.get("driven"))
                kind = d["type"]
                if kind == "diameter":
                    dim = dc.AddDiameter(entity(d["seg"]), text, driven)
                elif kind == "radius":
                    dim = dc.AddRadius(entity(d["seg"]), text, driven)
                elif kind == "length":
                    line = drawn[d["seg"][0]][d["seg"][1]]
                    dim = dc.AddTwoPointDistance(line["a"], line["b"], K_ALIGNED_DIM, text, driven)
                elif kind in ("x", "y"):
                    dim = dc.AddTwoPointDistance(origin(), point(d["point"]), K_HORIZONTAL_DIM if kind == "x" else K_VERTICAL_DIM, text, driven)
                else:  # angle: 2 本の直線（1 本なら X 軸から）
                    lines = [entity(s) for s in d["segs"]]
                    dim = dc.AddTwoLineAngle(lines[0], lines[1] if len(lines) > 1 else axis("x"), text, driven)
                if driven:
                    log.driven += 1
                    continue
                name = (d.get("expression") or "").split(" ")[0]
                if name and name in log.created:
                    dim.Parameter.Expression = d["expression"]
                elif d.get("name"):
                    dim.Parameter.Name = d["name"]
                log.dimensions += 1
            except Exception as error:  # noqa: BLE001
                log.fail(f"寸法 {d['type']}", error)

    def _finish(self, doc, definition, part: Part, out_dir: Path, result: PartResult) -> PartResult:
        """iProperties を入れ、体積・表面積・外接箱を Inventor に計算させて照合し、.ipt として保存する"""
        tracking = doc.PropertySets.Item("Design Tracking Properties")
        tracking.Item("Part Number").Value = part.name
        tracking.Item("Description").Value = describe(part)

        mass = definition.MassProperties
        result.volume = mass.Volume * MM_PER_CM**3
        result.area = mass.Area * MM_PER_CM**2
        result.extent_check, result.extent_detail = check_extent(body_bbox(definition, MM_PER_CM), part)

        path = out_dir / f"{part.name}.ipt"
        doc.SaveAs(str(path), False)
        result.path = path
        return result

    # ---- 組立 -------------------------------------------------------------------
    def build_assembly(self, results: list[PartResult], path: Path) -> tuple[int, str | None]:
        """作れた部品を、取り込んだシーンと同じ位置に配置した組立を作る。(配置数, エラー) を返す。"""
        doc = None
        placed = 0
        failures: list[str] = []  # 置けなかった出現（1 か所の失敗で組立全体を捨てない）
        try:
            doc = self.app.Documents.Add(K_ASSEMBLY_DOCUMENT, self.assembly_template, True)
            occurrences = doc.ComponentDefinition.Occurrences
            for result in results:
                if result.path is None:
                    continue
                for n, frame in enumerate(result.part.instances, start=1):
                    try:
                        matrix = self.tg.CreateMatrix()
                        matrix.SetCoordinateSystem(
                            self.tg.CreatePoint(*(cm(v) for v in frame.origin)),
                            self.tg.CreateVector(*frame.x),
                            self.tg.CreateVector(*frame.y),
                            self.tg.CreateVector(*frame.z),
                        )
                        occurrences.Add(str(result.path), matrix)
                        placed += 1
                    except Exception as error:  # noqa: BLE001
                        failures.append(f"{result.part.name}:{n}（{com_error_text(error)}）")
            doc.SaveAs(str(path), False)
            if failures:
                return placed, f"{len(failures)} か所を置けませんでした: " + "、".join(failures[:3]) + ("…" if len(failures) > 3 else "")
            return placed, None
        except Exception as error:  # noqa: BLE001
            return placed, com_error_text(error)
        finally:
            if doc is not None:
                try:
                    doc.Close(True)
                except Exception:  # noqa: BLE001
                    pass


def is_busy(error: Exception) -> bool:
    """Inventor が起動中・処理中で呼び出しを断った（待てば受け付ける）か"""
    code = getattr(error, "hresult", None)
    if code is None and getattr(error, "args", None):
        code = error.args[0]
    return code in BUSY_HRESULTS


def when_ready(call, timeout: float = READY_TIMEOUT, pause: float = 0.5, clock=time.monotonic, sleep=time.sleep):
    """call() を、Inventor が呼び出しを断る間は待ってやり直す。timeout 秒を過ぎても断られれば、その例外を出す"""
    end = clock() + timeout
    while True:
        try:
            return call()
        except Exception as error:  # noqa: BLE001
            if not is_busy(error) or clock() >= end:
                raise
        sleep(pause)


def _wait_until_started(app, timeout: float = READY_TIMEOUT, pause: float = 0.5, clock=time.monotonic, sleep=time.sleep) -> None:
    """起動したばかりの Inventor が準備を終える（Application.Ready が真になる）まで待つ"""
    end = clock() + timeout
    while not when_ready(lambda: app.Ready, max(0.0, end - clock()), pause, clock, sleep):
        if clock() >= end:
            raise RuntimeError(f"Inventor の起動が {timeout:.0f} 秒たっても終わりません。Inventor の画面にダイアログが出ていないか確かめてください")
        sleep(pause)


def _dispatch(active: bool):
    """Inventor の Application（遅延バインディング）。active なら起動中のものだけ（無ければ例外）。
    遅延バインディングにするのは、この PC に pywin32 の型ライブラリのキャッシュ（makepy）があっても同じ動きにするため
    （キャッシュがあると Documents.Add が汎用の Document を返し、部品の ComponentDefinition を読めない）"""
    try:
        import pythoncom  # noqa: PLC0415 — Windows でだけ必要
        import pywintypes  # noqa: PLC0415
        from win32com.client import dynamic  # noqa: PLC0415
    except ImportError as error:
        raise RuntimeError("pywin32 が見つかりません。コマンドプロンプトで  pip install pywin32  を実行してください。") from error
    try:
        running = pythoncom.GetActiveObject(pywintypes.IID(PROG_ID))
        return dynamic.Dispatch(running.QueryInterface(pythoncom.IID_IDispatch))
    except pythoncom.com_error:
        if active:
            raise
        return dynamic.Dispatch(PROG_ID)


def connect(visible: bool = True):
    """起動中の Inventor に接続する（起動していなければ起動し、準備が終わるまで待つ）。"""
    app = _dispatch(active=False)
    _wait_until_started(app)
    when_ready(lambda: setattr(app, "Visible", visible))
    return app


def restore_normal(app) -> None:
    """画面の更新とダイアログを、Inventor のふだんの状態（更新する・ダイアログを出す）に戻す。
    作る前の値ではなく、ふだんの状態に戻す（前の実行が途中で止められていると、作る前の値が「止めたまま」になっている）"""
    when_ready(lambda: setattr(app, "ScreenUpdating", True), timeout=30.0)
    when_ready(lambda: setattr(app, "SilentOperation", False), timeout=30.0)


@contextmanager
def quiet(app):
    """作る間だけ、画面の更新を止め、ダイアログを出さない（速く・止まらずに作る）。終われば必ずふだんの状態に戻す"""
    app.ScreenUpdating, app.SilentOperation = False, True
    try:
        yield app
    finally:
        restore_normal(app)


def restore_running_inventor() -> bool:
    """起動中の Inventor の画面の更新とダイアログを、ふだんの状態に戻す（作る係を強制的に止めた後の片付け）。
    起動していなければ何もしない（新しく起動はしない）。戻したら True"""
    try:
        app = _dispatch(active=True)
    except Exception:  # noqa: BLE001 — pywin32 が無い・Inventor が起動していない
        return False
    restore_normal(app)
    return True
