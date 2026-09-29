# Inventor

Autodesk Inventor の部品ファイル（.ipt）を解析し、将来的に three.js で作った形状を .ipt に変換することを目指すリポジトリ。

- 構造の調査結果と変換ツールの設計方針: [docs/ipt-format.md](docs/ipt-format.md)

## ipt_inspect — .ipt の読み取り専用解析ツール

```
pip install -r requirements.txt
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt"            # 構造と形状の要約
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --json     # JSON で出力
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --dump out # 展開したセグメント・SAB・サムネイルを保存
```

出力例（抜粋）:

```
形状データ（ASM/ACIS SAB）
  [PmBRepSegment] ASM 231.3.1.65535 NT / Mon Mar 23 21:51:14 2026 / 1 単位 = 10 mm / エンティティ 405（履歴 6）
    ボディ#1  ソリッド  面 12（cylinder 6, plane 6）  稜線 28  頂点 20  種数 2
      外形寸法  21.000 × 2.000 × 7.500 mm  （X×Y×Z）
      穴       Φ4.500  長さ 2.000  360°  軸 Y  中心 (4.000, 1.000, -3.750)
      角R      R3.500  長さ 2.000  90°  軸 Y  中心 (3.500, 1.000, -4.000)
```

## テスト

```
python -m unittest discover -s tests
```
