# SXF の図面（.sfc・.p21）の試験の素材

`sxf.test.mjs` と `tools/sxf-check.mjs` が使う。どれも [neka-nat/ezsxf](https://github.com/neka-nat/ezsxf)（コミット 91cd37e）の素材かその書き直し。

| 名前 | 中身 |
|---|---|
| `all_features.sfc` | ezsxf の `tests/fixtures/writer_all_features.sfc` そのもの（UTF-8）。SXF Ver.3.1 のフィーチャを全て 1 つずつ並べた図面（表・複合曲線・部品と作図グループ・属性の図形 3 種・点の記号・線・折れ線・円・円弧・楕円・楕円の弧・文字・3 点のスプライン・クロソイド・寸法 5 種・引出線・バルーン・外部の記号・ハッチング 4 種・図面の属性・自由な大きさの用紙）。属性の図形 `$$ATRF` は外部のファイル（SAF）を指すが、そのファイルは無い |
| `pair.sfc`・`pair.p21` | 同じ図面の SFC と P21 の組。`all_features.sfc` から、ezsxf の P21 の書き出しが受け付けないもの（外部の SAF を指す `$$ATRF`・クロソイド・点の数が 3n+1 でないスプライン（4 点にした））を除き、ezsxf の `write_p21` で P21 を書いた |

利用条件: MIT（Copyright (c) 2026 nekanat）。全文は [`samples/licenses/ezsxf-MIT.txt`](../../../../samples/licenses/ezsxf-MIT.txt)。

SFC と P21 の組は、ほかにサンプルの `samples/dwg/SXF_A1_円筒_部品図.sfc`・`.p21`（`tools/make_sxf_sample.py` で作った）もある。
実物の CAD（SXF の変換部品 SCADEC API）が書いた組は、出所の書かれていない素材しか見つからなかったので置かない
（手元の評価だけに使い、文字の配置点のずれ・引出線の矢印の向きを確かめた。`docs/drawing-format.md` §9）。
