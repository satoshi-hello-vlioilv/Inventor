# AcDs の節（R2013+ の DWG の 3D ソリッドの形の置き場）の試験の素材

[DomCR/ACadSharp](https://github.com/DomCR/ACadSharp)（MIT。Copyright (c) 2021 Albert Domenech。`samples/licenses/ACadSharp-MIT.txt`）の見本の DWG
（`samples/sample_AC1027.dwg`・`sample_AC1032.dwg`）から、**AcDb:AcDsPrototype_1b の節だけ**を抜き出し、gzip したもの。
DWG そのものは 1 つ約 1 MB と大きいので入れない。

- `R2013.acds.gz`（AC1027）… データの並びが目録の順と違う（位置の大きさで次のデータまでを測らないと、1 つ取りこぼす）
- `R2018.acds.gz`（AC1032）… ACIS のデータの頭が "ASM BinaryFile4"

どちらも 3D ソリッド 2 つ（ハンドル 3429・3434）とリージョン 1 つ（3433）を持つ。同じ図面の R2004（`samples/dwg/ACadSharp_sample_R2004.dwg`。
オブジェクトの中の SAB）と同じ形になる（箱の体積 125・もう 1 つ 47.539392）。

作り直すとき: ACadSharp の DWG を `formats/dwg/file.js` の `readDwgFile(…).section("AcDb:AcDsPrototype_1b")` で書き出して gzip する。
