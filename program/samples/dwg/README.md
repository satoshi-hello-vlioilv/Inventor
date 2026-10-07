# 図面（2D）のサンプルの置き場

ここに置いた 2 次元の図面（`.dwg`・`.dxf`）は、次の 2 つに使われます。

1. **アプリのサンプル** … 「サンプル・受け取ったファイル」の「図面」に並びます（置くだけで並びます）。
   アプリを人に渡すときはサンプルも含まれるので、社外に出せない図面は置かないでください。
2. **読み取りの評価** … `npm test` が、置いた図面を全て読み、全てのレイアウトを描けるかを確かめます。

AutoCAD・Inventor で書いた DWG（Inventor の図面を「DWG に書き出し」したもの・AutoCAD の図面）を置くと、
いちばん良い評価になります（版の違い・Inventor の書き方を確かめられます）。読み方の詳しいことは [docs/drawing-format.md](../../../docs/drawing-format.md)。

## 置いてあるファイル

| ファイル | 中身 |
|---|---|
| `A1_円筒_部品図.dxf` | サンプルの部品 A1（[`samples/ipt/`](../ipt)）の部品図。DXF R2018（UTF-8）。正面図（部分断面のハッチング）・側面図・詳細図・寸法・注記・表題欄（属性付きのブロック）・A3 のレイアウト。`program/tools/make_drawing_sample.py`（ezdxf）で作った |
| `ACadSharp_sample_R2004.dwg` | ネットの無料の素材。AutoCAD で保存した DWG R2004。図形の種類を一通り並べた試験の図面（寸法・ハッチング・引出線・表・ブロック・3 つの紙のレイアウト・色見本帳の色など）。まだ描かない図形（マルチ引出線・表など）は、右の欄がそう知らせる |
| `JPL_rover_side_plate.dxf` | ネットの無料の素材。NASA JPL の Open Source Rover の、レーザーで切り出す側板の外形。FreeCAD が書いた DXF R14 |

## ネットから入手した素材の出典と利用条件

再配布できる利用条件（MIT・Apache 2.0）のものだけを置いている。利用条件の全文は [`samples/licenses/`](../licenses)。

| ファイル | 出典 | 利用条件 |
|---|---|---|
| `ACadSharp_sample_R2004.dwg` | [DomCR/ACadSharp](https://github.com/DomCR/ACadSharp) の `samples/sample_AC1018.dwg`（コミット 0647526） | MIT（Copyright (c) 2021 Albert Domenech）。`licenses/ACadSharp-MIT.txt` |
| `JPL_rover_side_plate.dxf` | [nasa-jpl/open-source-rover](https://github.com/nasa-jpl/open-source-rover) の `mechanical/body/laser_cut_parts/dxf/side_plate.dxf`（コミット 0bea824） | Apache License 2.0（Copyright 2018 California Institute of Technology）。`licenses/open-source-rover-Apache-2.0.txt` |
