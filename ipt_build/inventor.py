"""Inventor API（COM）で部品（.ipt）と組立（.iam）を作る。

作り方（部品のローカル座標系は変換データと同じ）:
    回転体   … XY 平面のスケッチに断面（x = 半径, y = 軸方向）を描き、Y 軸まわりに回転する。
               360° 未満は XY 平面に対して対称に回す
    押し出し … XY 平面のスケッチに断面を描き、Z 方向に XY 平面に対して対称に押し出す。
               面取りは、押し出した端面（Z = ±長さ/2 の平らな面）の稜線のうち、指定したループの上にあるものを選び、
               等距離の面取り（ChamferFeatures.AddUsingDistance）をかける。同じ大きさの面取りは 1 つのフィーチャにまとめる
対称にするのは、回転・押し出しの「正方向」の解釈に左右されず、変換データと同じ形にするため。

Inventor API の長さの単位は cm、角度はラジアン。mm → cm の換算はこのモジュールの中だけで行う。
作った部品の体積・表面積を Inventor に計算させ、変換データの期待値と照合する。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

from .spec import Part, Segment, distance_to_loop
from .verify import check_file

MM_PER_CM = 10.0
REL_TOL = 1e-4  # 体積・表面積の照合の許容差（相対）
EDGE_TOL = 1e-3  # mm。稜線が端面・ループの上にあるとみなす距離

# Inventor API の列挙値
K_PART_DOCUMENT = 12290  # DocumentTypeEnum.kPartDocumentObject
K_ASSEMBLY_DOCUMENT = 12291  # DocumentTypeEnum.kAssemblyDocumentObject
K_JOIN = 20481  # PartFeatureOperationEnum.kJoinOperation
K_SYMMETRIC = 20995  # PartFeatureExtentDirectionEnum.kSymmetricExtentDirection
XY_PLANE = 3  # 原点の作業平面: 1 = YZ, 2 = XZ, 3 = XY
Y_AXIS = 2  # 原点の作業軸: 1 = X, 2 = Y, 3 = Z

KIND_LABEL = {"revolve": "回転体", "extrude": "押し出し"}
SEGMENT_LABEL = {"line": "直線", "arc": "円弧", "circle": "円"}


def cm(value_mm: float) -> float:
    return value_mm / MM_PER_CM


def describe(part: Part) -> str:
    """iProperties の「説明」に入れる文。"""
    counts: dict[str, int] = {}
    for loop in part.loops:
        for s in loop:
            counts[s.type] = counts.get(s.type, 0) + 1
    section = "・".join(f"{SEGMENT_LABEL[k]} {v}" for k, v in counts.items())
    extent = f"{part.angle_deg:g}°" if part.kind == "revolve" else f"長さ {part.distance:g} mm"
    chamfer = "".join(f"・面取り C{d:g}（縁 {sum(c.distance == d for c in part.chamfers)} か所）" for d in sorted({c.distance for c in part.chamfers}))
    return f"{KIND_LABEL[part.kind]} {extent}{chamfer}／断面 {section}（three.js から変換）"


@dataclass
class PartResult:
    part: Part
    path: Path | None = None
    volume: float | None = None  # Inventor が計算した体積（mm³）
    area: float | None = None  # Inventor が計算した表面積（mm²）
    error: str | None = None
    file_check: bool | None = None  # 保存したファイルを読み直した外形の確認（None = 確認できない）
    file_detail: str = ""
    notes: list[str] = field(default_factory=list)

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
            and self.file_check is not False
        )


def com_error_text(error: Exception) -> str:
    """COM の例外から、人が読める説明を取り出す。"""
    info = getattr(error, "excepinfo", None)
    if info and len(info) > 2 and info[2]:
        return str(info[2]).strip()
    return str(error)


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

    def draw_loop(self, sketch, loop: tuple[Segment, ...]) -> None:
        """1 つのループを、隣どうしで端点（スケッチ点）を共有する直線・円弧で描く。"""
        if len(loop) == 1 and loop[0].type == "circle":
            s = loop[0]
            sketch.SketchCircles.AddByCenterRadius(self._point(s.center), cm(s.radius))
            return
        first = previous = None
        for i, s in enumerate(loop):
            start = previous if previous is not None else self._point(s.a)
            end = first if i == len(loop) - 1 else self._point(s.b)
            if s.type == "line":
                entity = sketch.SketchLines.AddByTwoPoints(start, end)
            else:
                entity = sketch.SketchArcs.AddByCenterStartEndPoint(self._point(s.center), start, end, s.ccw)
            head, tail = self._ends(entity, s)
            if first is None:
                first = head
            previous = tail

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

    def add_chamfers(self, definition, part: Part) -> None:
        body = definition.SurfaceBodies.Item(1)
        by_distance: dict[float, list] = {}
        for chamfer in part.chamfers:
            edges = self.cap_edges(body, part, chamfer)
            if not edges:
                raise RuntimeError(f"面取りする稜線が見つかりません（{chamfer.label}）")
            by_distance.setdefault(chamfer.distance, []).extend(edges)
        for distance, edges in by_distance.items():
            collection = self.app.TransientObjects.CreateEdgeCollection()
            for edge in edges:
                collection.Add(edge)
            definition.Features.ChamferFeatures.AddUsingDistance(collection, cm(distance))

    # ---- 部品 -------------------------------------------------------------------
    def build_part(self, part: Part, out_dir: Path) -> PartResult:
        result = PartResult(part)
        doc = None
        try:
            doc = self.app.Documents.Add(K_PART_DOCUMENT, self.part_template, True)
            definition = doc.ComponentDefinition
            sketch = definition.Sketches.Add(definition.WorkPlanes.Item(XY_PLANE))
            for loop in part.loops:
                self.draw_loop(sketch, loop)
            profile = sketch.Profiles.AddForSolid()
            features = definition.Features
            if part.kind == "revolve":
                axis = definition.WorkAxes.Item(Y_AXIS)
                if part.full_revolve:
                    features.RevolveFeatures.AddFull(profile, axis, K_JOIN)
                else:
                    features.RevolveFeatures.AddByAngle(profile, axis, math.radians(part.angle_deg), K_SYMMETRIC, K_JOIN)
            else:
                extrude = features.ExtrudeFeatures.CreateExtrudeDefinition(profile, K_JOIN)
                extrude.SetDistanceExtent(cm(part.distance), K_SYMMETRIC)
                features.ExtrudeFeatures.Add(extrude)
                if part.chamfers:
                    self.add_chamfers(definition, part)

            tracking = doc.PropertySets.Item("Design Tracking Properties")
            tracking.Item("Part Number").Value = part.name
            tracking.Item("Description").Value = describe(part)

            mass = definition.MassProperties
            result.volume = mass.Volume * MM_PER_CM**3
            result.area = mass.Area * MM_PER_CM**2

            path = out_dir / f"{part.name}.ipt"
            doc.SaveAs(str(path), False)
            result.path = path
        except Exception as error:  # noqa: BLE001 — 1 部品の失敗で全体を止めない
            result.error = com_error_text(error)
        finally:
            if doc is not None:
                try:
                    doc.Close(True)
                except Exception:  # noqa: BLE001
                    result.notes.append("部品を閉じられませんでした")
        if result.path is not None:
            result.file_check, result.file_detail = check_file(result.path, part)
        return result

    # ---- 組立 -------------------------------------------------------------------
    def build_assembly(self, results: list[PartResult], path: Path) -> tuple[int, str | None]:
        """作れた部品を、取り込んだシーンと同じ位置に配置した組立を作る。(配置数, エラー) を返す。"""
        doc = None
        placed = 0
        try:
            doc = self.app.Documents.Add(K_ASSEMBLY_DOCUMENT, self.assembly_template, True)
            occurrences = doc.ComponentDefinition.Occurrences
            for result in results:
                if result.path is None:
                    continue
                for frame in result.part.instances:
                    matrix = self.tg.CreateMatrix()
                    matrix.SetCoordinateSystem(
                        self.tg.CreatePoint(*(cm(v) for v in frame.origin)),
                        self.tg.CreateVector(*frame.x),
                        self.tg.CreateVector(*frame.y),
                        self.tg.CreateVector(*frame.z),
                    )
                    occurrences.Add(str(result.path), matrix)
                    placed += 1
            doc.SaveAs(str(path), False)
            return placed, None
        except Exception as error:  # noqa: BLE001
            return placed, com_error_text(error)
        finally:
            if doc is not None:
                try:
                    doc.Close(True)
                except Exception:  # noqa: BLE001
                    pass


def connect(visible: bool = True):
    """起動中の Inventor に接続する（起動していなければ起動する）。"""
    try:
        import win32com.client  # noqa: PLC0415 — Windows でだけ必要
    except ImportError as error:
        raise RuntimeError("pywin32 が見つかりません。コマンドプロンプトで  pip install pywin32  を実行してください。") from error
    try:
        app = win32com.client.GetActiveObject("Inventor.Application")
    except Exception:  # noqa: BLE001
        app = win32com.client.Dispatch("Inventor.Application")
    app.Visible = visible
    return app
