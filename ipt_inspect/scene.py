"""表示層: 最終形状を three.js で描ける中立な JSON（mm 単位）に変換し、ビューア HTML に埋め込む。

三角形分割はビューア側で行う。ここで渡すのは次の 3 つだけにして、形状の意味は Python 側に一元化する。
    faces    … 面ごとの曲面パラメータ（平面: 法線と境界ループ / 円筒: 軸・半径・角度と高さの範囲）
    edges    … 稜線の折れ線
    summary  … 外形・穴・R の要約（テキスト出力と同じ値）
"""
from __future__ import annotations

import html
import json
import math
from dataclasses import asdict
from pathlib import Path

from . import brep, report
from .container import IptFile
from .vec import Vec, cross, dot, mul, reject, sub, unit

BREP_SEGMENT = "PmBRepSegment"
_TEMPLATE = Path(__file__).with_name("viewer.html")
_PLACEHOLDER = "__SCENE_JSON__"
_TITLE = "__TITLE__"
_DIGITS = 5
_STANDALONE_HEAD = (
    '<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
)


def _mm(v: Vec, scale: float) -> list[float]:
    return [round(c * scale, _DIGITS) + 0.0 for c in v]


def _plane(face: brep.Face, scale: float) -> dict:
    normal = unit(face.surface.direction)
    return {
        "type": "plane",
        "normal": _mm(mul(normal, -1.0 if face.reversed else 1.0), 1.0),
        "loops": [[_mm(p, scale) for p in loop] for loop in face.loops],
    }


def _cylinder(face: brep.Face, scale: float) -> dict:
    s = face.surface
    axis = unit(s.direction)
    points = [p for loop in face.loops for p in loop]
    radials = [reject(sub(p, s.origin), axis) for p in points]
    full = any(e.sweep_deg >= 360.0 - 1e-3 for e in face.edges)
    # 部分円筒は点群の平均方向（円弧の中央）を角度の基準にすると、角度が ±π を跨がない
    mean = tuple(sum(r[k] for r in radials) / len(radials) for k in range(3))
    ref = unit(radials[0] if full else mean)
    side = cross(axis, ref)
    angles = [math.atan2(dot(r, side), dot(r, ref)) for r in radials]
    heights = [dot(sub(p, s.origin), axis) for p in points]
    return {
        "type": "cylinder",
        "origin": _mm(s.origin, scale),
        "axis": _mm(axis, 1.0),
        "ref": _mm(ref, 1.0),
        "radius": round(s.radius * scale, _DIGITS),
        "theta": [0.0, round(2 * math.pi, 9)] if full else [round(min(angles), 9), round(max(angles), 9)],
        "height": [round(min(heights) * scale, _DIGITS), round(max(heights) * scale, _DIGITS)],
        "outward": not face.concave,  # 面の法線が軸から外へ向くか（凸面なら True）
    }


_FACE_EXPORTERS = {"plane": _plane, "cylinder": _cylinder}


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
        "labels": {"surfaces": report.SURFACE_LABELS, "cylinders": report.CYLINDER_LABELS},
        "bodies": bodies,
    }


def render_viewer(scene: dict, standalone: bool = True) -> str:
    """ビューア HTML にシーンを埋め込む。standalone=False は外側の骨格を持たない断片（埋め込み用）。"""
    payload = json.dumps(scene, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    title = html.escape(f"{Path(scene['file']).stem} ビューア")
    page = _TEMPLATE.read_text(encoding="utf-8").replace(_TITLE, title).replace(_PLACEHOLDER, payload)
    return _STANDALONE_HEAD + page if standalone else page
