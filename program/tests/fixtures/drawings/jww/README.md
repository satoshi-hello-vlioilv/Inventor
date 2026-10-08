# Jw_cad の図面（.jww）の試験の素材

`jww.test.mjs` と `tools/jww-check.mjs` が使う。どれも [neka-nat/ezjww](https://github.com/neka-nat/ezjww)（コミット 73be949）の
`jww_samples/writer/` にある、ezjww が書いた図面を **Jw_cad 10.02 で開いて保存し直した JWW**（`*_reopened.jww.gz`）と、
**Jw_cad がそれを書き出した DXF**（`*_reopened.dxf.gz`）の組。名前の `_reopened` を省き、圧縮したまま置いている（中身は ezjww の manifest.json の SHA-256 と一致）。

利用条件: MIT（Copyright (c) 2026 k-tanaka）。全文は [`samples/licenses/ezjww-MIT.txt`](../../../../samples/licenses/ezjww-MIT.txt)。

| 名前 | 中身 |
|---|---|
| `attributes` | 線色 1〜9・線種 1〜9・線幅 0／1／25／500 の線と円弧（線種 9 は補助線） |
| `basic` | 線・円・円弧・点・日本語の文字・90° の文字 |
| `block` | ブロックの定義と参照 |
| `dimension` | 寸法（寸法線・文字・補助線） |
| `ellipse` | 楕円と傾けた楕円・楕円の弧 |
| `settings` | A4・16 の画層グループと画層の名前・状態・縮尺（0.5 と 50） |
| `solid` | ソリッド（四角・三角・RGB の色）と円の塗り（円・扇形・輪 105・106） |
| `sxf_colors` | SXF の色（線色 100〜356） |
| `sxf_linetypes` | SXF の線種（線種 30〜62）と倍長の線種 |
| `text_auto_end` | 文字の終わりの点（Jw_cad が計算し直す）。DXF は日本語が「???」になっている（Jw_cad の書き出しの都合） |
| `text_rotations` | 0°・45°・90°・180°・270°・359° の文字 |
