# Inventor 3Dツール

Autodesk Inventor の部品（.ipt）・組立（.iam）、STEP（.stp）と、three.js で作った 3D モデル（.html）をブラウザで表示・解析し、
three.js のモデルを Inventor の部品（.ipt）・組立（.iam）に変換する 1 つのアプリ。

画面（HTML・JavaScript・CSS）と Python（Flask）のサーバーで動く。WaveLog・転写距離・ピッチ解析と同じ形
（最上位の `Start.vbs` ＋ `program` フォルダ、Python と Flask だけで動く）にそろえてある。

- アプリの構成・設計の判断・段階計画: [docs/app-architecture.md](docs/app-architecture.md)
- 形式の調査結果: [docs/ipt-format.md](docs/ipt-format.md)（部品）・[docs/iam-format.md](docs/iam-format.md)（組立・STEP との照合）
- Inventor で部品を作る手順: [docs/inventor-builder.md](docs/inventor-builder.md)

## はじめに（使い方）

1. **準備（初回のみ）**: Python 3.10 以上と Flask を入れる（WaveLog などが動く PC なら、そのまま使える）。
   Flask が入っていなければ、起動したときに「入れますか？」と尋ねる
2. **起動**: 最上位の **`Start.vbs`** をダブルクリックする。すぐに起動画面が開き、準備ができるとそのままアプリに切り替わる
   （Microsoft Edge があればアドレスバーの無いアプリの窓、無ければ既定のブラウザー）
3. **終了**: 画面（窓・タブ）を閉じる。十数秒でサーバーも止まる

| 操作 | 動き |
|---|---|
| `Start.vbs` をダブルクリック | アプリを開く（起動画面 → アプリ。サーバーが動いていれば、それを使う） |
| .ipt・.iam・.stp・.html を `Start.vbs` にドロップ | そのファイルをアプリで開く（複数なら 1 つの窓にまとめ、起動画面の一覧から切り替える）。.iam は同じフォルダの .ipt も部品として使い、組み立てて表示する |
| 変換データ（.inventor.json）を `Start.vbs` にドロップ | 確認のダイアログのあと、Inventor で部品（.ipt）と組立（.iam）を作る。進み具合と結果は HTML のページに出る |
| `program\stop.bat` | 明示的に止める（program フォルダを入れ替える前など） |
| `program\start.bat` | 診断起動: 起動しないときに、Python・Flask・ポートの確認と起動の段階をその窓に出す（ファイルをドロップしてもよい） |

- 開いたあとも、画面へのドラッグ＆ドロップ・`Ctrl`+`O`・「サンプル・使い方」で開き直せる
- 記録（うまく動かないときの手がかり）は `%LOCALAPPDATA%\Inventor3DTool\logs`（launcher.log・app.log・server_console.log）
- ポートは 57840（`program\config\appsettings.json` で変えられる）。この PC の中（127.0.0.1）からだけ受け付ける

### 配り方・更新

`Start.vbs` と `program` フォルダを並べて置く（フォルダの名前は自由）。更新は `program\stop.bat` で止めてから `program` を入れ替える
（git で取り込む場合も同じ）。止め忘れても、次の起動で「動いているサーバーが今のファイルと違う」ことに気づき、止めて起動し直す。
作業場所（記録・受け渡し・.pyc）は `%LOCALAPPDATA%\Inventor3DTool` にあり、`program` フォルダは動いている間も「使用中」にならない。

## リポジトリの見取り図

リポジトリには**ソースだけ**を置く（ビルドも生成物も無い。ブラウザは `program/app/static` のファイルをそのまま読む）。

```mermaid
flowchart LR
  VBS["Start.vbs<br/>（入口）"] --> SA["program/start_app.py<br/>launch_guard.py（起動の係）"]
  SA -- "起動画面" --> LOAD["program/loading.html"]
  SA -- "起動・確かめ" --> SRV["program/server.py<br/>app/（Flask）"]
  SA -- "変換データ" --> B
  LOAD -. "準備ができたら切り替え" .-> UI
  SRV -- "画面・サンプル・<br/>ドロップされたファイル" --> UI
  subgraph js["program/app/static/js（ブラウザで動く）"]
    F["formats/ 読み取り<br/>.ipt・.iam・STEP"] --> M["model/ 形式によらない形<br/>面・稜線・寸法の要約"]
    H["html/ three.js の HTML から<br/>形状を取り出す"] --> C["convert/ 形状の認識と<br/>Inventor 用の変換データ"]
    M --> V["viewer/ 3D 表示"]
    C --> V
    V --> UI["ui/・main.js 画面"]
  end
  C -- "変換データ（.inventor.json）" --> B["program/ipt_build<br/>（Python・Inventor API）"] --> OUT[".ipt・.iam"]
  OUT -. "アプリで開いて確かめる" .-> F
```

| 場所 | 中身 |
|---|---|
| `Start.vbs` | **入口**（これだけを使う。Python を探し、`program\start_app.py` を窓なしで起動する） |
| `program/start_app.py`・`launch_guard.py` | 起動の係: ドロップされたファイルの記録・起動画面・サーバーの起動と確かめ・部品を作る係の起動 |
| `program/server.py`・`app/` | サーバー（Flask）: 画面（`templates/`・`static/`）を配り、サンプル・受け取ったファイルを渡し、画面が閉じたら止まる |
| `program/settings.py`・`config/appsettings.json` | アプリの印・ポート・作業場所（答えは 1 か所） |
| `program/local_app.py`・`process_manager.py`・`handoff.py`・`app_build.py` | 動いているサーバーへ尋ねる・止める、ファイルの受け渡し、プログラムの指紋 |
| `program/loading.html`・`start.bat`・`stop.bat`・`requirements.txt` | 起動画面・診断起動・停止・必要なライブラリ（Flask） |
| `program/ipt_build/` | Inventor で部品を作るビルダー（Python。Inventor の操作に使うライブラリは中の `requirements.txt`） |
| `program/samples/` | サンプルの置き場（起動画面のサンプル一覧兼、評価の題材） |
| `program/tests/` | 評価。Python（`test_*.py`: サーバー・起動の係・配る形・ビルダー）と JavaScript（`js/`） |
| `program/tools/` | 開発用の道具（ファイルの中身の調査・テスト用データの作成） |
| `docs/`・`package.json` | 設計と調査の記録、JavaScript の評価の実行（開発用） |

### 画面のソース（`program/app/static/js/`）

| フォルダ | 役割 | 画面（DOM）に依存 |
|---|---|:-:|
| `core/` | ベクトル・行列・数値の道具、表示名（`labels.json`） | — |
| `formats/` | ファイルの読み取り。`ipt/`（OLE2 → Zstandard → SAB → B-rep）・`iam/`（参照・出現・配置）・`step/`（ISO 10303-21）。入口は `open.js`（形式の判定と、表示・変換で共通に使う「モデル」への読み込み） | — |
| `model/` | 形式によらない形（面・稜線）: 曲線の計算、寸法の要約（穴・外径・R・ねじ・円錐）、表示用の面のデータ | — |
| `html/` | three.js の HTML を隔離した枠で動かし、表示中の形状を取り出す（フック・受け渡し・表示用データ） | ✓ |
| `convert/` | 三角形メッシュから回転体・押し出し（面取りを含む）を認識し（`recognize/`）、Inventor 用の変換データを作る（`inventor.js`） | — |
| `viewer/` | 三角形分割・3D 表示・面と部品の説明 | ✓ |
| `ui/` | 画面の部品: 仕様パネル・起動画面・ファイルの受け付け・変換の節・起動ファイルの名前 | ✓ |
| `server.js` | ローカルサーバーとのやりとり: サンプル・起動ファイルから届いたファイル・「画面が開いている」の知らせ | ✓ |
| `main.js` | 入口。ファイルを読み、表示し、3D ⇄ パネルを連動させる | ✓ |

three.js と fzstd（Zstandard の展開）は `static/vendor/` に同梱し、`templates/index.html` の importmap で読む（インターネットは要らない）。

## できること

- **.ipt**: 形状と寸法（外形・穴・外径・R・ねじ・円錐）を表示する。ねじは Inventor が面に付けた情報から呼び（M6×1 など）・等級・ねじ長さを示す。
  材質・密度（iProperties）が分かれば体積と質量も示す。対応している面は平面・円筒・円錐・トーラスで、それ以外は稜線だけを表示する
- **.iam（組立）**: 部品の参照と配置を読み、参照先の .ipt（一緒に受け取ったもの・同じフォルダのもの・サンプル）で組み立てる。部品表（部品名・数・外形・材質・質量）の
  行にカーソルを合わせると 3D の部品を強調し、押すとその部品を開く。見つからない部品は一覧に出し、その .ipt をドロップすると組立に加わる
- **STEP（.stp・.step）**: 部品の形状と組立の配置を全て含むので、単独で表示できる（部品が 1 つなら部品として、2 つ以上なら組立として）
- **.html（three.js）**: 元のページを隔離した枠の中で動かし、表示中の 3D モデルを取り出す。部品ごとに「回転体」
  「押し出し（端面の縁の等距離面取りを含む）」「近似（三角形のまま）」に分類し、寸法を復元する
- **Inventor へ変換**: 取り込んだ形状を「変換データ（.inventor.json）」として保存し、`Start.vbs` にドロップして .ipt にする
- ファイルはこの PC の中だけで解析し、外部には送信しない（HTML が読み込む three.js などは、そのページの指定どおり取得する）。
  書体（IBM Plex）は読み込めたときだけ使い、つながらない PC では Yu Gothic UI などで表示する

## サンプル

| フォルダ | 内容 |
|---|---|
| [`program/samples/ipt/`](program/samples/ipt) | .ipt（部品）。アプリのサンプルと解析の評価に使う（詳しくは中の README） |
| [`program/samples/iam/`](program/samples/iam) | .iam（組立）。参照する部品は samples/ipt のものを使って組み立てる |
| [`program/samples/stp/`](program/samples/stp) | STEP（.stp・.step）。同じ部品の .ipt・同じ組立の .iam との照合にも使う |
| [`program/samples/html/`](program/samples/html) | 形状認識の検証に使う three.js の HTML（アプリのサンプルにもなる） |

## 開発

Python の評価（program フォルダで。サーバー・起動の係・配る形・ビルダー。本物のサーバーを起動する通しの評価を含む）:

```
cd program
python -m unittest discover -s tests -t .
python -m ipt_build 名前.inventor.json --dry-run    # Inventor を使わずに変換データを確かめる（どの OS でも可）
```

JavaScript の評価と道具（リポジトリの最上位で。Node.js 22 以上。npm で入れるものは無い）:

```
npm test                 # 読み取り・三角形分割・組立と STEP の照合・形状認識・変換データ
npm run inspect -- program/samples/ipt/E_Plate_改_Φ54.5.ipt [--dump 出力先]   # .ipt・.iam の中身を調べる（形式の調査の再現）
npm run fixtures:html    # samples/html から形状を取り出し、テスト用データを作り直す（要 Playwright）
npm run fixtures:builder # ビルダーのテスト用の変換データ（program/tests/fixtures/builder）を作り直す
```

画面を手元で確かめるときは `Start.vbs`（Windows 以外では `python program/start_app.py`）で起動し、表示された URL を開く。
