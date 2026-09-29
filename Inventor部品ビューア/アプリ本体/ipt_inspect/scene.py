"""表示層: 最終形状を three.js で描ける中立な JSON（mm 単位）に変換する。

ブラウザアプリ（app/）の JS 版 scene.js と同じ出力を作り、tests/golden.py で正解データとして保存する。
三角形分割はビューア側で行う。ここで渡すのは次の 3 つだけ。
    faces    … 面ごとの曲面パラメータと境界ループ
               平面: 法線 / 円筒・円錐（回転面）: 軸上の原点・軸・角度の基準方向・半径・半径の傾き
               （ビューアは境界ループに沿って分割する。ループは隣の面と同じ点列なので、面どうしが隙間なくつながる）
    edges    … 稜線の折れ線
    summary  … 外形・穴・R・ねじ・円錐の要約（テキスト出力と同じ値）
"""
from __future__ import annotations

from dataclasses import asdict

from . import brep, report
from .container import IptFile
from .vec import Vec, mul, reject, unit

BREP_SEGMENT = "PmBRepSegment"
_DIGITS = 5
_SLOPE_DIGITS = 9


def _mm(v: Vec, scale: float) -> list[float]:
    return [round(c * scale, _DIGITS) + 0.0 for c in v]


def _loops(face: brep.Face, scale: float) -> list[list[list[float]]]:
    return [[_mm(p, scale) for p in loop] for loop in face.loops]


def _plane(face: brep.Face, scale: float) -> dict:
    normal = unit(face.surface.direction)
    return {
        "type": "plane",
        "normal": _mm(mul(normal, -1.0 if face.reversed else 1.0), 1.0),
        "loops": _loops(face, scale),
    }


def _revolved(face: brep.Face, scale: float) -> dict:
    """円筒・円錐: 点 = origin + h・axis + ρ(h)・(cos θ・ref + sin θ・(axis × ref))、ρ(h) = radius + slope・h"""
    s = face.surface
    axis = unit(s.direction)
    return {
        "type": s.kind,
        "origin": _mm(s.origin, scale),
        "axis": _mm(axis, 1.0),
        "ref": _mm(unit(reject(s.major, axis)), 1.0),
        "radius": round(s.radius * scale, _DIGITS) + 0.0,
        "slope": round(s.slope, _SLOPE_DIGITS) + 0.0,
        "outward": not face.concave,  # 面の法線が軸から外へ向くか（凸面なら True）
        "loops": _loops(face, scale),
    }


_FACE_EXPORTERS = {"plane": _plane, "cylinder": _revolved, "cone": _revolved}


def _face(face: brep.Face, scale: float) -> dict:
    exporter = _FACE_EXPORTERS.get(face.surface.kind)
    # 未対応の曲面は種類だけを渡す（ビューアは稜線のみ描く）
    return {"id": face.index, **(exporter(face, scale) if exporter else {"type": face.surface.kind})}


def build(ipt: IptFile) -> dict:
    bodies, source = [], None
    for segment, doc in report.shapes(ipt):
        if segment.name != BREP_SEGMENT:
            continue
        topo = brep.Topology(doc)
        for body, summary in zip(topo.bodies(), brep.summarize(doc)):
            faces = [topo.face(f) for f in topo.faces(body)]
            edges = {e.index: e for f in faces for e in f.edges}
            bodies.append(
                {
                    "faces": [_face(f, doc.mm_per_unit) for f in faces],
                    "edges": [[_mm(p, doc.mm_per_unit) for p in e.points] for e in edges.values()],
                    "summary": asdict(summary),
                }
            )
        source = {"kernel": doc.kernel, "saved_at": doc.saved_at}
    return {
        "file": ipt.path.name,
        "units": "mm",
        "source": source,
        "labels": report.LABELS,
        "bodies": bodies,
    }

