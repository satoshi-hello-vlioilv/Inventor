# Inventor

Autodesk Inventor の部品ファイル（.ipt）をブラウザで表示し、将来的には他の HTML に含まれる three.js の 3D モデルを .ipt に変換することを目指すリポジトリ。

- 構造の調査結果: [docs/ipt-format.md](docs/ipt-format.md)
- アプリの構成と段階計画: [docs/app-architecture.md](docs/app-architecture.md)

## Inventor 部品ビューア（ブラウザアプリ）

[`dist/ipt-viewer.html`](dist/ipt-viewer.html) をダウンロードし、ブラウザ（Chrome / Edge）で開く。
.ipt をボタン・ドラッグ＆ドロップ・`Ctrl`+`O` で開くと、形状を three.js で表示する。

- ファイルはブラウザ内だけで解析し、外部には送信しない
- three.js とフォントはインターネット上の CDN から読み込む（オフラインでは表示できない）
- 対応している面は平面と円筒。それ以外の面は稜線だけを表示する

### 開発

```
npm install
npm test        # JS 版の評価（Python 版の正解データとの一致・三角形分割の面積）
npm run build   # app/ → dist/ipt-viewer.html
```

| ディレクトリ | 内容 |
|---|---|
| `app/src/ipt/` | .ipt の解析（OLE2 → Zstandard 展開 → SAB → B-rep → シーン JSON） |
| `app/src/viewer/` | 三角形分割・3D 表示・面の説明 |
| `app/src/ui/`, `app/src/main.js` | 仕様パネル、ファイル読み込み、画面の連動 |
| `spec/labels.json` | 表示名（Python 版と JS 版で共用） |

## ipt_inspect（Python 版の解析ツール）

JS 版と同じ解析を行う参照実装。JS 版の正しさを確かめる「正解データ」を作る。

```
pip install -r requirements.txt
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt"            # 構造と形状の要約
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --json     # JSON で出力
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --dump out # 展開したセグメント・SAB・サムネイルを保存
python -m tests.golden                                  # 正解データ tests/fixtures/ を更新
python -m unittest discover -s tests                    # 評価
```

出力例（抜粋）:

```
形状データ（ASM/ACIS SAB）
  [PmBRepSegment] ASM 231.3.1.65535 NT / Mon Mar 23 21:51:14 2026 / 1 単位 = 10 mm / エンティティ 405（履歴 6）
    ボディ#1  ソリッド  面 12（円筒 6・平面 6）  稜線 28  頂点 20  種数 2
      外形寸法  21.000 × 2.000 × 7.500 mm  （X×Y×Z）
      穴       Φ4.500  長さ 2.000  360°  軸 Y  中心 (4.000, 1.000, -3.750)
      角R      R3.500  長さ 2.000  90°  軸 Y  中心 (3.500, 1.000, -4.000)
```
