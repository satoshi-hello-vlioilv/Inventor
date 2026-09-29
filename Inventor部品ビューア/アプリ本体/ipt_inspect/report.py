"""解析結果を 1 つの辞書（JSON 互換）にまとめ、テキスト表示もそこから生成する。"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from . import brep, sab
from .container import IptFile

_AXES = {(1.0, 0.0, 0.0): "X", (0.0, 1.0, 0.0): "Y", (0.0, 0.0, 1.0): "Z"}
# 表示名は Python 版と JS 版（app/）で共用する
LABELS = json.loads(Path(__file__).with_name("labels.json").read_text(encoding="utf-8"))  # JS 版と共用
SURFACE_LABELS = LABELS["surfaces"]
CYLINDER_LABELS = LABELS["cylinders"]  # kind → 表示名・寸法記号・寸法に使う値
THREAD_LABELS = LABELS["threads"]  # 凹（めねじ）・凸（おねじ）→ 表示名
CONE_LABEL = LABELS["cone"]


def shapes(ipt: IptFile):
    """全セグメント中の SAB ブロックを (セグメント, SabDocument) で列挙する。"""
    for segment in ipt.segments:
        for offset in sab.find_blocks(segment.data):
            yield segment, sab.parse(segment.data, offset)


def build(source: str | Path | IptFile) -> dict:
    ipt = source if isinstance(source, IptFile) else IptFile(source)
    size = ipt.thumbnail_size
    return {
        "file": {"name": ipt.path.name, "size": ipt.file_size},
        "container": {
            "format": "OLE2 Compound File (MS-CFB)",
            "clsid": ipt.clsid,
            "streams": [asdict(s) for s in ipt.streams],
        },
        "thumbnail": {"format": "png", "width": size[0], "height": size[1]} if size else None,
        "segments": [
            {
                "name": s.name,
                "key": s.key,
                "compressed": s.compressed,
                "data_stored": s.data_stored_size,
                "data_expanded": len(s.data),
                "meta_stored": s.meta_stored_size,
                "meta_expanded": len(s.meta),
            }
            for s in ipt.segments
        ],
        "shapes": [
            {
                "segment": segment.name,
                "offset": doc.offset,
                "product": doc.product,
                "kernel": doc.kernel,
                "saved_at": doc.saved_at,
                "mm_per_unit": doc.mm_per_unit,
                "entities": len(doc.entities),
                "history_records": len(doc.history),
                "bodies": [asdict(b) for b in brep.summarize(doc)],
            }
            for segment, doc in shapes(ipt)
        ],
    }


def _axis(v) -> str:
    return _AXES.get(tuple(v), "({:.3f}, {:.3f}, {:.3f})".format(*v))


def _xyz(v) -> str:
    return "({:.3f}, {:.3f}, {:.3f})".format(*v)


def format_text(r: dict) -> str:
    lines = [
        f"{r['file']['name']}  ({r['file']['size']:,} bytes)",
        f"  コンテナ    {r['container']['format']} / ストリーム {len(r['container']['streams'])} 本",
    ]
    if r["thumbnail"]:
        lines.append(f"  サムネイル  PNG {r['thumbnail']['width']}×{r['thumbnail']['height']}")

    lines += ["", "RSe セグメント（格納サイズ → 展開後）"]
    width = max((len(s["name"]) for s in r["segments"]), default=0)
    for s in r["segments"]:
        codec = "zstd" if s["compressed"] else "非圧縮"
        lines.append(
            f"  {s['name']:<{width}}  {s['data_stored']:>8,} → {s['data_expanded']:>8,} B  {codec}"
        )

    lines += ["", "形状データ（ASM/ACIS SAB）"]
    for shape in r["shapes"]:
        lines.append(
            f"  [{shape['segment']}] {shape['kernel']} / {shape['saved_at']} / "
            f"1 単位 = {shape['mm_per_unit']:g} mm / エンティティ {shape['entities']}"
            f"（履歴 {shape['history_records']}）"
        )
        for b in shape["bodies"]:
            lines += _format_body(b)
    return "\n".join(lines)


def _format_body(b: dict) -> list[str]:
    kind = "ソリッド" if b["closed"] else "シート（開いた面）"
    surfaces = "・".join(f"{SURFACE_LABELS.get(k, k)} {v}" for k, v in sorted(b["surfaces"].items()))
    genus = f"  種数 {b['genus']}" if b["genus"] is not None else ""
    out = [
        f"    ボディ#{b['index']}  {kind}  面 {b['faces']}（{surfaces}）"
        f"  稜線 {b['edges']}  頂点 {b['vertices']}{genus}",
        "      外形寸法  {:.3f} × {:.3f} × {:.3f} mm  （X×Y×Z）".format(*b["size"]),
        f"      範囲      {_xyz(b['bbox_min'])} 〜 {_xyz(b['bbox_max'])}",
    ]
    for c in b["cylinders"]:
        label = CYLINDER_LABELS[c["kind"]]
        dim = f"{label['symbol']}{c[label['field']]:.3f}"
        out.append(
            f"      {label['name']:<4}{dim:>10}  長さ {c['length']:.3f}  "
            f"{c['sweep_deg']:g}°  軸 {_axis(c['axis'])}  中心 {_xyz(c['center'])}"
        )
        if c["thread"]:
            t = c["thread"]
            name = THREAD_LABELS["internal" if c["kind"] in ("hole", "inner_round") else "external"]
            lengths = " / ".join(f"{v:g}" for v in t["lengths"])
            out.append(f"        {name} {t['designation']} {t['class']}  ねじ長さ {lengths}  {t['type']}")
    for c in b.get("cones", ()):
        out.append(
            f"      {CONE_LABEL['name']:<4}  頂角 {c['angle_deg']:g}°  "
            f"Φ{c['diameters'][0]:.3f} 〜 Φ{c['diameters'][1]:.3f}  長さ {c['length']:.3f}  中心 {_xyz(c['center'])}"
        )
    return out
