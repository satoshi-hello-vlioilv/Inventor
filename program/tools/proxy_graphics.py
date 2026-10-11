"""AutoCAD が図形に添えた見本の描画（代理図形 = proxy graphics）を、DXF に書き出す（annotation-check.mjs が答えに使う。開発用）。

マルチ引出線・表などは、AutoCAD が描いた形を図形の中に「代理図形」として持つ（92・310 の群）。ezdxf で読み解いて線・文字・塗りにし、
図形のハンドルを画層の名前にして、新しい DXF のモデル空間に置く（元の画層・色は比べないので捨てる）。

    python proxy_graphics.py 入力.dxf 出力.dxf [種類 ...]（既定: MULTILEADER ACAD_TABLE）
"""

import sys

import ezdxf
from ezdxf.proxygraphic import ProxyGraphic


def main(source, target, kinds):
    doc = ezdxf.readfile(source)
    out = ezdxf.new("R2013")
    msp = out.modelspace()
    count = 0
    for layout in doc.layouts:
        for entity in layout:
            if entity.dxftype() not in kinds or not getattr(entity, "proxy_graphic", None):
                continue
            try:
                parts = list(ProxyGraphic(entity.proxy_graphic, doc).virtual_entities())
            except Exception as error:  # 読み解けない代理図形は飛ばす（数を出す）
                print(f"skip {entity.dxf.handle}: {error}", file=sys.stderr)
                continue
            name = f"H{entity.dxf.handle}"
            if name not in out.layers:
                out.layers.add(name)
            for part in parts:
                copy = part.copy()
                copy.dxf.layer = name
                copy.dxf.color = 7
                msp.add_entity(copy)
            count += 1
    out.saveas(target)
    print(count)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], set(sys.argv[3:]) or {"MULTILEADER", "ACAD_TABLE"})
