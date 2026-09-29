# Inventor

Autodesk Inventor の部品ファイル（.ipt）と、three.js で書かれた HTML の 3D モデルをブラウザで表示・解析し、将来的には .ipt に変換することを目指すリポジトリ。

- 構造の調査結果: [docs/ipt-format.md](docs/ipt-format.md)
- アプリの構成と段階計画: [docs/app-architecture.md](docs/app-architecture.md)
- Inventor で .ipt を作る手順: [docs/inventor-builder.md](docs/inventor-builder.md)

## Inventor 部品ビューア（ブラウザアプリ）

[`dist/ipt-viewer.html`](dist/ipt-viewer.html) をダウンロードし、ブラウザ（Chrome / Edge）で開く。
ファイルはボタン・ドラッグ＆ドロップ・`Ctrl`+`O` で開ける。サンプル（ipt 1 つ・HTML 2 つ）も同梱している。

- **.ipt**: ブラウザ内で解析し、形状と寸法（外形・穴・R）を表示する。対応している面は平面と円筒で、それ以外は稜線だけを表示する
- **.html（three.js）**: 元のページを隔離した枠の中で動かし、表示中の 3D モデルを取り出す。元のページで表示を切り替えて
  「この状態を取り込む」を押すと、その状態を取り込む。部品ごとに「回転体」「押し出し（端面の縁の等距離面取りを含む）」
  「近似（三角形のまま）」に分類し、寸法を復元する
- **Inventor へ変換**: 取り込んだ形状を「変換データ（.inventor.json）」として保存し、ビルダー（下記）で .ipt にする
- ファイルはブラウザ内だけで解析し、外部には送信しない（HTML が読み込む three.js などは、そのページの指定どおり取得する）
- three.js とフォントはインターネット上の CDN から読み込む（オフラインでは表示できない）

### 開発

```
npm install
npm test        # 評価（Python 版の正解データとの一致・三角形分割の面積・HTML の形状認識）
npm run build   # app/ → dist/ipt-viewer.html
node app/test/capture-html.mjs   # samples/html から形状を取り出し、テスト用データを作り直す（要 Playwright）
```

| ディレクトリ | 内容 |
|---|---|
| `app/src/ipt/` | .ipt の解析（OLE2 → Zstandard 展開 → SAB → B-rep → シーン JSON） |
| `app/src/viewer/` | 三角形分割・3D 表示・面の説明 |
| `app/src/extract/` | HTML を隔離した枠で動かし、three.js の形状を取り出す（フック・受け渡し・表示用データ） |
| `app/src/recognize/` | 三角形メッシュから回転体・押し出しを認識し、断面を直線・円弧に分解する |
| `app/src/export/` | Inventor 用の変換データ（断面・特徴・配置・体積と表面積の期待値）を作る |
| `app/src/ui/`, `app/src/main.js` | 仕様パネル、ファイル読み込み、画面の連動 |
| `spec/labels.json` | 表示名（Python 版と JS 版で共用） |
| `samples/html/` | 形状認識の検証に使う three.js の HTML |

## ipt_build（Inventor ビルダー、Windows）

変換データから Inventor API で部品（.ipt）と組立（.iam）を作り、Inventor が計算した体積・表面積と、
保存したファイルを読み直した外形を、変換データの期待値と照合する。手順は [docs/inventor-builder.md](docs/inventor-builder.md)。

```
pip install -r requirements.txt
python -m ipt_build 名前.inventor.json --dry-run   # Inventor を使わずに確かめる（どの OS でも可）
python -m ipt_build 名前.inventor.json             # 部品と組立を作る
```

## ipt_inspect（Python 版の解析ツール）

JS 版と同じ解析を行う参照実装。JS 版の正しさを確かめる「正解データ」を作る。

```
pip install -r requirements.txt
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt"            # 構造と形状の要約
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --json     # JSON で出力
python -m ipt_inspect "E_Plate_改_Φ54.5.ipt" --dump out # 展開したセグメント・SAB・サムネイルを保存
python -m tests.golden                                  # 正解データ tests/fixtures/ を更新
node app/test/builder-fixtures.mjs                      # ビルダーのテスト用の変換データを更新
python -m unittest discover -s tests                    # 評価（解析ツール・ビルダー）
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
