# DWG の見出しの変数の試験の素材

`acadsharp.json` … [DomCR/ACadSharp](https://github.com/DomCR/ACadSharp)（MIT。Copyright (c) 2021 Albert Domenech。`samples/licenses/ACadSharp-MIT.txt`）の
見本の DWG（`samples/sample_AC1015.dwg`〜`sample_AC1032.dwg`。R2000・R2004・R2010・R2013・R2018）から、**見出しの変数の節（AcDb:Header）だけ**を
抜き出したもの（`header`。展開した後のバイト列を base64 で。DWG そのものは 1 つ約 1 MB と大きいので入れない）。

- `version`・`maintenance` … 元の DWG の版と保守版の番号（節の頭の大きさの欄の数が、これで変わる）
- `dxf` … 同じ図面を AutoCAD が書いた DXF（`sample_AC10xx_ascii.dxf`）の値（`$LTSCALE`・`$INSUNITS`・`$EXTMIN`・`$TDUCREATE` など 12 個）。
  試験（`tests/js/dwg-header.test.mjs`）は、節を読んだ値がこれと合うかを確かめる。範囲（`$EXTMIN`・`$EXTMAX`）・日時（`$TDUCREATE`・`$TDUUPDATE`・`$TDINDWG`）は既定でない値なので、
  変数の並びが 1 つでもずれれば合わなくなる。
  DWG の日時は世界時なので、地方時の `$TDCREATE` ではなく `$TDUCREATE` と比べる（見本では 1 時間違う）。
  DXF は DWG の 1 秒後に保存してあり（5 版とも）、直した日（`$TDUUPDATE`）と編集した時間（`$TDINDWG`）は DXF の方がちょうど 1 秒進んでいる

作り直すとき: ACadSharp の `samples/` の DWG と `_ascii.dxf` を並べ、`formats/dwg/file.js` の `readDwgFile(…).section("AcDb:Header")` を書き出す。
