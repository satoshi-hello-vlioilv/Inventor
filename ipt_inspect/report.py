"""解析結果を 1 つの辞書（JSON 互換）にまとめ、テキスト表示もそこから生成する。"""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from . import brep, sab
from .container import IptFile

_AXES = {(1.0, 0.0, 0.0): "X", (0.0, 1.0, 0.0): "Y", (0.0, 0.0, 1.0): "Z"}
SURFACE_LABELS = {"plane": "平面", "cylinder": "円筒", "cone": "円錐"}
CYLINDER_LABELS = {  # kind → 表示名・寸法記号・寸法に使う値（テキスト出力とビューアで共用）
    "hole": {"name": "穴", "symbol": "Φ", "field": "diameter"},
    "boss": {"name": "軸", "symbol": "Φ", "field": "diameter"},
    "round": {"name": "角R", "symbol": "R", "field": "radius"},
    "inner_round": {"name": "隅R", "symbol": "R", "field": "radius"},
}


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
    return out
