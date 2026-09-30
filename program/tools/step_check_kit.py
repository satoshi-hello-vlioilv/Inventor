"""docs/step-check の確認用 STEP のうち、今の書き方のもの（4〜8）を、今の STEP の書き手で作り直す（開発用）。

STEP の書き方を変えたら作り直す。1〜3（直す前の書き方）は作り直さない。
9（4 を OpenCascade で書き直したもの）は、OpenCascade（pip install cadquery-ocp）があれば作り直す。
使い方（program フォルダで）:
    python tools/step_check_kit.py
"""
from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ipt_build.spec import parse_spec, part_properties  # noqa: E402
from ipt_build.step import write_step  # noqa: E402
from tests.test_step import box_mesh, extrude, polygon, revolve, spec_of  # noqa: E402

KIT = Path(__file__).resolve().parents[2] / "docs" / "step-check"
BOX = extrude([polygon([-50, -25], [50, -25], [50, 25], [-50, 25])], 20)  # 100 × 50 × 20 mm
CYLINDER = revolve(polygon([0, -30], [20, -30], [20, 30], [0, 30]))  # φ40 × 60 mm
IDENTITY = {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}
LYING = {"x": [1, 0, 0], "y": [0, 0, 1], "z": [0, -1, 0]}  # 円柱を寝かせる（軸を Y から Z へ）


def assembly_spec():
    """箱 1 つと、その上に寝かせた円柱 2 本の組立"""
    shapes = [
        ("box_100x50x20", BOX, [IDENTITY]),
        ("cylinder_d40x60", CYLINDER, [{"origin": [-30, 0, 40], **LYING}, {"origin": [30, 0, 40], **LYING}]),
    ]
    raw = [{"key": f"p{i:02d}", "name": name, **shape, "expect": {"volume": 0, "area": 0}, "instances": instances}
           for i, (name, shape, instances) in enumerate(shapes, start=1)]
    spec = parse_spec({"format": "inventor-builder", "version": 3, "units": "mm", "source": {"file": "kit.html"}, "parts": raw})
    return replace(spec, parts=tuple(replace(p, expect_volume=part_properties(p)[0], expect_area=part_properties(p)[1]) for p in spec.parts))


FILES = {
    "4_new_box.stp": lambda: spec_of({"box_100x50x20": BOX}),
    "5_new_box_japanese.stp": lambda: spec_of({"箱_100x50x20": BOX}),
    "6_new_assembly.stp": assembly_spec,
    "7_new_cylinder.stp": lambda: spec_of({"cylinder_d40x60": CYLINDER}),
    "8_new_faceted_box.stp": lambda: spec_of({"faceted_box_10x20x30": box_mesh(10, 20, 30)}),
}


def rewrite_with_opencascade(source: Path, target: Path) -> bool:
    """source を OpenCascade で読み、AP214 で書き直す（別の書き手の STEP）。OpenCascade が無ければ False"""
    try:
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.Interface import Interface_Static
        from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    except ImportError:
        return False
    reader = STEPControl_Reader()
    if reader.ReadFile(str(source)) != IFSelect_RetDone:
        raise ValueError(f"読めません: {source}")
    reader.TransferRoots()
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    writer = STEPControl_Writer()
    writer.Transfer(reader.OneShape(), STEPControl_AsIs)
    if writer.Write(str(target)) != IFSelect_RetDone:
        raise ValueError(f"書けません: {target}")
    target.write_bytes(target.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))  # 改行は他と同じ CR+LF
    return True


def main() -> None:
    for name, make in FILES.items():
        write_step(make(), KIT / name)
        print(f"作り直した: {name}")
    if rewrite_with_opencascade(KIT / "4_new_box.stp", KIT / "9_opencascade_box.stp"):
        print("作り直した: 9_opencascade_box.stp")
    else:
        print("9_opencascade_box.stp は作り直していない（OpenCascade が無い）")


if __name__ == "__main__":
    main()
