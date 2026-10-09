# R2007（AC1021）の DWG の試験の素材

`acadsharp.json` … [DomCR/ACadSharp](https://github.com/DomCR/ACadSharp)（MIT。Copyright (c) 2021 Albert Domenech。`samples/licenses/ACadSharp-MIT.txt`）の
見本の DWG `samples/sample_AC1021.dwg`（AutoCAD が R2007 の形式で保存したもの。約 1 MB と大きいので、そのものは入れない）から、
ファイルの**生のバイト列**を 2 か所だけ抜き出したもの（base64）。

- `fileHeader` … ファイルの 0x80〜0x47F（1024 バイト）。R2007 の見出し: リード・ソロモン符号の 3 つの符号語（データ 239 バイト）を交互に並べ、
  その中身を R2007 の LZ77 で圧縮してある。解くと 0x110 バイトの見出し（ページの地図・節の地図の場所など）になる。
  `fileSize`（元のファイルの大きさ）は、見出しの中の「ファイルの大きさ」と一致する
- `headerPage` … 見出しの変数の節（AcDb:Header）の 1 ページ（ファイルの 0x480 + `offset` から 4 × 255 バイト）。
  4 つの符号語（データ 251 バイト）を交互に並べ、`compressed` バイトに圧縮した `size` バイトの節
- `maintenance` … 元の DWG の保守版の番号（0x0B）
- `dxf` … 同じ図面を AutoCAD が書いた DXF（`sample_AC1021_ascii.dxf`）の `$LTSCALE`・`$INSUNITS`・`$TEXTSIZE`・`$EXTMIN`・`$EXTMAX`

試験（`tests/js/dwg-2007.test.mjs`）は、符号の並びを解き、圧縮を解き、見出しの変数の節を読んだ値が DXF と合うかを確かめる
（範囲 `$EXTMIN`・`$EXTMAX` は既定でない値なので、1 バイトでも解き違えれば合わない）。

見本の DWG のそのものでの確かめ（オブジェクトを全て読む・DXF と図形ごとに突き合わせる）は、ACadSharp の `samples/` の場所を
環境変数 `ACADSHARP_SAMPLES` に入れて `npm test` を動かすと行う（無ければ飛ばす）。

作り直すとき: `sample_AC1021.dwg` の 0x80〜0x47F と、`formats/dwg/rs2007.js` の節の地図で AcDb:Header のページの位置
（ページの地図の大きさの和）を見て、その 1020 バイトを書き出す。
