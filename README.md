# Inventor

Autodesk Inventor の部品（.ipt）・組立（.iam）、STEP（.stp）と、three.js で書かれた HTML の 3D モデルをブラウザで表示・解析し、
three.js のモデルを Inventor の部品（.ipt）に変換するツール。

- 構造の調査結果: [docs/ipt-format.md](docs/ipt-format.md)（部品）・[docs/iam-format.md](docs/iam-format.md)（組立・STEP との照合）
- アプリの構成と段階計画: [docs/app-architecture.md](docs/app-architecture.md)
- Inventor で .ipt を作る手順: [docs/inventor-builder.md](docs/inventor-builder.md)

## 配布フォルダ（使う人に渡すもの）

[`Inventor部品ビューア/`](Inventor部品ビューア) を **フォルダごと** 渡す（ZIP にして渡してよい）。

```
Inventor部品ビューア/
├─ Inventor部品ビューア.vbs   ← 起動ファイル（これだけを使う）
└─ アプリ本体/                ← 中身（開かなくてよい）
   ├─ 起動.bat                 起動の振り分け（VBS が黒い画面を出さずに実行する）
   ├─ ipt-viewer.html          ビューア（HTML・JavaScript・CSS。単体で動く）
   ├─ ipt_build/               Inventor で部品を作るビルダー（Python）
   ├─ ipt_inspect/             .ipt の解析（ビルダーが作った部品の確認に使う）
   └─ requirements.txt         ビルダーが使う Python のライブラリ
```

| 操作 | 動き |
|---|---|
| 起動ファイルをダブルクリック | ビューアを開く（Microsoft Edge のアプリ画面。無ければ既定のブラウザー） |
| .ipt・.iam・.stp・.html を起動ファイルにドロップ | そのファイルをビューアで開く（複数なら 1 つのウィンドウにまとめ、起動画面の一覧から切り替える）。.iam は同じフォルダの .ipt も一緒に送り、組み立てて表示する |
| 変換データ（.inventor.json）を起動ファイルにドロップ | 確認のダイアログのあと、Inventor で部品（.ipt）と組立（.iam）を作る。進み具合と結果は HTML のページに出る（要 Python 3.10 以上） |

- 起動ファイル（VBS）は「黒い画面を出さない」ためだけにあり、処理はすべて `アプリ本体\起動.bat` にある。
  VBScript が使えない環境では 起動.bat を直接使ってもよい（黒い画面が出るだけ）
- ビューアは起動画面で「ファイルを開く（ドラッグ＆ドロップ）」「サンプルで試す」「変換の流れ」を示す。
  開いたあとも、画面へのドラッグ＆ドロップ・`Ctrl`+`O`・「サンプル・使い方」で開き直せる
- **.ipt**: ブラウザ内で解析し、形状と寸法（外形・穴・外径・R・ねじ・円錐）を表示する。ねじは Inventor が面に付けた情報から
  呼び（M6×1 など）・等級・ねじ長さを示す。材質・密度（iProperties）が分かれば体積と質量も示す。
  対応している面は平面・円筒・円錐・トーラスで、それ以外は稜線だけを表示する
- **.iam（組立）**: 部品の参照と配置を読み、参照先の .ipt（一緒に受け取ったもの・サンプル）で組み立てる。部品表（部品名・数・外形・材質・質量）の
  行にカーソルを合わせると 3D の部品を強調し、押すとその部品を開く。見つからない部品は一覧に出し、その .ipt をドロップすると組立に加わる
- **STEP（.stp・.step）**: 部品の形状と組立の配置を全て含むので、単独で表示できる（部品が 1 つなら部品として、2 つ以上なら組立として）
- **.html（three.js）**: 元のページを隔離した枠の中で動かし、表示中の 3D モデルを取り出す。部品ごとに「回転体」
  「押し出し（端面の縁の等距離面取りを含む）」「近似（三角形のまま）」に分類し、寸法を復元する
- **Inventor へ変換**: 取り込んだ形状を「変換データ（.inventor.json）」として保存し、起動ファイルにドロップして .ipt にする
- ファイルはブラウザ内だけで解析し、外部には送信しない（HTML が読み込む three.js などは、そのページの指定どおり取得する）
- three.js とフォントはインターネット上の CDN から読み込む（オフラインでは表示できない）

## サンプル

| フォルダ | 内容 |
|---|---|
| [`samples/ipt/`](samples/ipt) | .ipt（部品）のサンプルの置き場。置いたファイルはビューアのサンプルと解析の評価に使う（詳しくは中の README） |
| [`samples/iam/`](samples/iam) | .iam（組立）のサンプルの置き場。参照する部品は samples/ipt のものを使って組み立てる |
| [`samples/stp/`](samples/stp) | STEP（.stp・.step）のサンプルの置き場。同じ部品の .ipt・同じ組立の .iam との照合にも使う |
| [`samples/html/`](samples/html) | 形状認識の検証に使う three.js の HTML（ビューアのサンプルにもなる） |

## 開発

```
npm install
npm test        # 評価（解析の一致・三角形分割・組立と STEP の照合・形状認識・変換データ・配布フォルダ）
npm run build   # app/ → Inventor部品ビューア/アプリ本体/ipt-viewer.html（samples のファイルを埋め込む）
node app/test/capture-html.mjs    # samples/html から形状を取り出し、テスト用データを作り直す（要 Playwright）
node app/test/launcher-wine.mjs   # 起動ファイル（VBS・起動.bat）の動作確認（要 Wine・Playwright）
```

| ディレクトリ | 内容 |
|---|---|
| `app/src/ipt/` | .ipt の解析（OLE2 → Zstandard 展開 → SAB → B-rep → シーン JSON）、iProperties（材質・密度） |
| `app/src/iam/` | .iam の解析（ファイル参照・出現名・配置）と、参照先の .ipt を使った組立のシーン |
| `app/src/step/` | STEP の解析（ISO 10303-21 の書式 → B-rep・組立の配置・単位・材質） |
| `app/src/viewer/` | 三角形分割・3D 表示・面の説明 |
| `app/src/extract/` | HTML を隔離した枠で動かし、three.js の形状を取り出す（フック・受け渡し・表示用データ） |
| `app/src/recognize/` | 三角形メッシュから回転体・押し出し（面取りを含む）を認識し、断面を直線・円弧に分解する |
| `app/src/export/` | Inventor 用の変換データ（断面・特徴・配置・体積と表面積の期待値）を作る |
| `app/src/ui/`, `app/src/main.js`, `app/index.html` | 起動画面、仕様パネル、ファイル読み込み、画面の連動 |
| `Inventor部品ビューア/アプリ本体/ipt_inspect/labels.json` | 表示名（Python 版と JS 版で共用） |
| `tests/` | Python の評価（`tests/__init__.py` がアプリ本体を import パスに加える） |

### Python（ビルダー・解析ツール）

Python のコードは配布フォルダの `アプリ本体` にある（配布物と開発で同じものを使う）。

```
pip install -r "Inventor部品ビューア/アプリ本体/requirements.txt"
python -m unittest discover -s tests       # 評価（解析ツール・ビルダー）
python -m tests.golden                     # samples/ipt の全 .ipt の正解データ tests/fixtures/ipt/ を更新
node app/test/builder-fixtures.mjs         # ビルダーのテスト用の変換データを更新

cd "Inventor部品ビューア/アプリ本体"
python -m ipt_build 名前.inventor.json --dry-run                     # Inventor を使わずに確かめる（どの OS でも可）
python -m ipt_inspect "../../samples/ipt/E_Plate_改_Φ54.5.ipt"        # .ipt の構造と形状の要約（--json・--dump も可）
```

出力例（`ipt_inspect`、抜粋）:

```
形状データ（ASM/ACIS SAB）
  [PmBRepSegment] ASM 231.3.1.65535 NT / Mon Mar 23 21:51:14 2026 / 1 単位 = 10 mm / エンティティ 405（履歴 6）
    ボディ#1  ソリッド  面 12（円筒 6・平面 6）  稜線 28  頂点 20  種数 2
      外形寸法  21.000 × 2.000 × 7.500 mm  （X×Y×Z）
      穴       Φ4.500  長さ 2.000  360°  軸 Y  中心 (4.000, 1.000, -3.750)
      角R      R3.500  長さ 2.000  90°  軸 Y  中心 (3.500, 1.000, -4.000)
```
