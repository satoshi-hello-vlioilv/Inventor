"""STEP ファイルを OpenCascade（CAD の形状カーネル）で読み、立体として正しいか・体積と表面積を調べる（開発用）。

アプリとは独立の実装で、書き出した STEP を確かめるために使う。OpenCascade の Python 版が要る:
    pip install cadquery-ocp        （Windows・macOS・Linux の Python 3.11〜3.14）
使い方（program フォルダで）:
    python tools/check_step.py 名前.stp [--json]
"""
from __future__ import annotations

import json
import sys

INTEGRATION_EPS = 1e-9  # 体積・表面積の積分の相対誤差の上限


def check(path: str) -> dict:
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError(f"読めません: {path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    solids = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()
        volume, area = GProp_GProps(), GProp_GProps()
        # 誤差を保証する積分（既定の固定次数の積分は、細かく波打つ B スプライン面（ローレットなど）で面積を 9% 誤った）
        BRepGProp.VolumeProperties_s(solid, volume, INTEGRATION_EPS)
        BRepGProp.SurfaceProperties_s(solid, area, INTEGRATION_EPS)
        faces = TopExp_Explorer(solid, TopAbs_FACE)
        count = 0
        while faces.More():
            count += 1
            faces.Next()
        box = __import__("OCP.Bnd", fromlist=["Bnd_Box"]).Bnd_Box()
        __import__("OCP.BRepBndLib", fromlist=["BRepBndLib"]).BRepBndLib.Add_s(solid, box)
        lo, hi = box.CornerMin(), box.CornerMax()
        from OCP.BOPAlgo import BOPAlgo_ArgumentAnalyzer

        crossing = BOPAlgo_ArgumentAnalyzer()  # 自己交差（BRepCheck の「正しい」は、面が交わることまでは調べない）
        crossing.SetShape1(solid)
        crossing.SelfInterMode = True
        crossing.Perform()
        solids.append({
            "valid": BRepCheck_Analyzer(solid).IsValid(),
            "self_intersecting": crossing.HasFaulty(),
            "volume": volume.Mass(),
            "area": area.Mass(),
            "faces": count,
            "center": [volume.CentreOfMass().X(), volume.CentreOfMass().Y(), volume.CentreOfMass().Z()],
            "box": [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()],
        })
        explorer.Next()
    return {"solids": solids}


if __name__ == "__main__":
    result = check(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(result))
    else:
        for i, s in enumerate(result["solids"]):
            print(f"{i}: valid={s['valid']} self_intersecting={s['self_intersecting']} volume={s['volume']:.6f} area={s['area']:.6f} faces={s['faces']}")
