"""変換データから STEP ファイル（AP214）を書く。Inventor を使わない。

製品の構造は、Inventor 2026 が書き出す STEP（samples/stp）と同じつなぎ方にする:
  部品ごとに PRODUCT → PRODUCT_DEFINITION → 形状表現（SHAPE_REPRESENTATION。部品の座標系の AXIS2_PLACEMENT_3D だけ）
  → SHAPE_REPRESENTATION_RELATIONSHIP → 形（ADVANCED_BREP_SHAPE_REPRESENTATION）。
  配置が 2 か所以上なら組立の PRODUCT を作り、出現ごとに NEXT_ASSEMBLY_USAGE_OCCURRENCE と、
  部品の座標系 → 組立の中の位置の変換（ITEM_DEFINED_TRANSFORMATION）を書く。
  点・方向・座標系は部品の中でだけ使い回す（別の部品の形状表現と共有しない）。改行は CR+LF、1 行はおよそ 80 文字。
形は部品ごとに、厳密な面（回転体・押し出し）か、三角形をまとめた平らな面（近似の部品・面取り付きの押し出し）で書く（brep.py）。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import brep
from .p21 import DERIVED, Enum, P21Writer, Ref, Typed
from .spec import Spec

SYSTEM = "Inventor 3Dツール"
UNCERTAINTY = brep.PLANE_TOL  # mm。形の座標の精度（変換データは 1e-6 mm に丸め、三角形の平らな面はこの幅でまとめる）


@dataclass(frozen=True)
class PartResult:
    key: str
    name: str
    how: str  # exact（厳密な面）| faceted（三角形をまとめた平らな面）
    faces: int
    note: str | None = None  # 三角形で書いた理由


@dataclass(frozen=True)
class StepResult:
    path: Path
    parts: tuple[PartResult, ...]
    placed: int
    assembly: bool


def _context(w: P21Writer) -> Ref:
    length = w.complex(("LENGTH_UNIT",), ("NAMED_UNIT", DERIVED), ("SI_UNIT", Enum("MILLI"), Enum("METRE")))
    angle = w.complex(("NAMED_UNIT", DERIVED), ("PLANE_ANGLE_UNIT",), ("SI_UNIT", None, Enum("RADIAN")))
    solid = w.complex(("NAMED_UNIT", DERIVED), ("SI_UNIT", None, Enum("STERADIAN")), ("SOLID_ANGLE_UNIT",))
    uncertainty = w.add("UNCERTAINTY_MEASURE_WITH_UNIT", Typed("LENGTH_MEASURE", UNCERTAINTY), length, "distance_accuracy_value", "")
    return w.complex(
        ("GEOMETRIC_REPRESENTATION_CONTEXT", 3),
        ("GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT", (uncertainty,)),
        ("GLOBAL_UNIT_ASSIGNED_CONTEXT", (length, angle, solid)),
        ("REPRESENTATION_CONTEXT", "", "3D"),
    )


def _product(w: P21Writer, app: Ref, product_context: Ref, definition_context: Ref, key: str, name: str) -> Ref:
    product = w.add("PRODUCT", key, name, "", (product_context,))
    w.add("PRODUCT_RELATED_PRODUCT_CATEGORY", "part", None, (product,))
    formation = w.add("PRODUCT_DEFINITION_FORMATION", "", "", product)
    return w.add("PRODUCT_DEFINITION", "design", "", formation, definition_context)


def _placement(topo: brep.Topology, origin, z, x) -> Ref:
    """形状表現の要素にする座標系（形の中の座標系とは使い回さない。同じ位置の出現も別の実体にする）"""
    return topo.w.add("AXIS2_PLACEMENT_3D", "", topo.point(origin), topo.direction(z), topo.direction(x))


def _solid(topo: brep.Topology, part) -> tuple[Ref, str, str | None]:
    """部品の立体と、書き方（exact / faceted）と、三角形で書いた理由"""
    note = None
    if part.kind in ("revolve", "extrude"):
        try:
            (brep.revolve if part.kind == "revolve" else brep.extrude)(topo, part)  # 書けない形なら、何も書く前に Unsupported
            return topo.solid(part.name), "exact", None
        except brep.Unsupported as reason:
            if part.mesh is None:
                raise
            note = f"{reason}は厳密な面で書けないため、元の形の三角形で書いた"
    brep.faceted(topo, part.mesh)
    return topo.solid(part.name), "faceted", note


def write_step(spec: Spec, path: str | Path, name: str | None = None, assembly: bool | None = None) -> StepResult:
    """STEP を書く。配置が 2 か所以上なら組立（部品 × 出現）、1 か所なら部品だけ（部品の座標系）。
    assembly=False なら配置によらず部品だけを書く（部品ごとの STEP。Inventor で開いて .ipt にする）。"""
    path = Path(path)
    name = name or path.stem
    w = P21Writer()
    context = _context(w)
    # 文脈の名前と年は Inventor 2026・2022 が書く値（規格の本文の語「core data for automotive mechanical design processes」、
    # 第 3 版の年 2010 ではない）
    app = w.add("APPLICATION_CONTEXT", "Core Data for Automotive Mechanical Design Process")
    w.add("APPLICATION_PROTOCOL_DEFINITION", "international standard", "automotive_design", 2009, app)
    product_context = w.add("PRODUCT_CONTEXT", "part definition", app, "mechanical")
    definition_context = w.add("PRODUCT_DEFINITION_CONTEXT", "part definition", app, "design")

    results, shapes = [], []
    placed = sum(len(p.instances) for p in spec.parts)
    for part in spec.parts:
        w.forget()  # 点・方向・座標系を、別の部品と共有しない
        topo = brep.Topology(w)
        solid, how, note = _solid(topo, part)
        brep_shape = w.add("ADVANCED_BREP_SHAPE_REPRESENTATION", part.name, (solid,), context)
        origin = _placement(topo, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
        shape = w.add("SHAPE_REPRESENTATION", part.name, (origin,), context)
        w.add("SHAPE_REPRESENTATION_RELATIONSHIP", "SRR", "None", shape, brep_shape)  # 名前・説明も Inventor と同じ
        definition = _product(w, app, product_context, definition_context, part.key, part.name)
        w.add("SHAPE_DEFINITION_REPRESENTATION", w.add("PRODUCT_DEFINITION_SHAPE", "", "", definition), shape)
        shapes.append((part, definition, shape, origin, topo))
        results.append(PartResult(part.key, part.name, how, len(topo.faces), "。".join(n for n in (note, *part.notes) if n) or None))

    assembly = placed > 1 if assembly is None else assembly
    if assembly:
        w.forget()
        topo = brep.Topology(w)
        root_origin = _placement(topo, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
        items = [root_origin]
        occurrences = []
        for part, definition, shape, origin, _ in shapes:
            for n, frame in enumerate(part.instances, start=1):
                target = _placement(topo, frame.origin, frame.z, frame.x)
                items.append(target)
                occurrences.append((part, definition, shape, origin, target, n))
        root_shape = w.add("SHAPE_REPRESENTATION", name, items, context)
        root = _product(w, app, product_context, definition_context, name, name)
        w.add("SHAPE_DEFINITION_REPRESENTATION", w.add("PRODUCT_DEFINITION_SHAPE", "", "", root), root_shape)
        for i, (part, definition, shape, origin, target, n) in enumerate(occurrences, start=1):
            label = f"{part.name}:{n}"
            usage = w.add("NEXT_ASSEMBLY_USAGE_OCCURRENCE", f"NAUO{i}", label, "", root, definition, None)
            transform = w.add("ITEM_DEFINED_TRANSFORMATION", "", "", origin, target)
            relation = w.complex(
                ("REPRESENTATION_RELATIONSHIP", "", "", shape, root_shape),
                ("REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION", transform),
                ("SHAPE_REPRESENTATION_RELATIONSHIP",),
            )
            w.add("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION", relation, w.add("PRODUCT_DEFINITION_SHAPE", "", "", usage))

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(w.text(path.name, f"{SYSTEM} で three.js の形から作成", SYSTEM), encoding="ascii", newline="")  # 改行は text の CR+LF のまま
    return StepResult(path, tuple(results), placed, assembly)
