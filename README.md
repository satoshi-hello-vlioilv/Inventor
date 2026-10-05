# Inventor 3Dツール

Autodesk Inventor の部品（.ipt）・組立（.iam）、STEP（.stp）と、three.js で作った 3D モデル（.html）をブラウザで表示・解析し、
three.js のモデルを STEP（.stp。Inventor 不要）と Inventor の部品（.ipt）・組立（.iam）に変換する 1 つのアプリ。

Windows のデスクトップアプリ（`Inventor3DTool.exe`。Tauri・Rust の窓が画面（HTML・JavaScript・CSS）を出す）。WaveLog と同じ作りと配り方
（最上位の exe ＋ `program` フォルダ。exe は GitHub Actions が作り、本物の WebView2 で自己診断して main へ置く）。
見るだけなら準備は要らない。CAD ファイルを作るときだけ、この PC の Python を使う。

- デスクトップ版の構成・判断・評価: [docs/desktop.md](docs/desktop.md)
- アプリの構成・設計の判断・段階計画: [docs/app-architecture.md](docs/app-architecture.md)
- 形式の調査結果: [docs/ipt-format.md](docs/ipt-format.md)（部品）・[docs/iam-format.md](docs/iam-format.md)（組立・STEP との照合）
- Inventor で部品を作る手順（「Inventor で作る」・変換データ・コマンド）: [docs/inventor-builder.md](docs/inventor-builder.md)
- .stp・.ipt・.iam を Inventor なしで作れるか（技術的な検討と、いまの制約）: [docs/cad-output.md](docs/cad-output.md)

## はじめに（使い方）

1. **準備（初回のみ）**: GitHub の main を ZIP で落として展開する（`Inventor3DTool.exe` と `program` フォルダが並ぶ）。
   見るだけなら、ほかに準備は要らない。**STEP を作る・Inventor で作る**ときは Python 3.10 以上が要る
   （https://www.python.org/ から入れ、「Add python.exe to PATH」に印を付ける。WaveLog などが動く PC なら、そのまま使える）
2. **起動**: 最上位の **`Inventor3DTool.exe`** をダブルクリックする（窓がすぐ開く）
3. **終了**: 窓の × で閉じる。CAD ファイルを作っている途中なら「中止して閉じる／作り続ける」を聞く

| 操作 | 動き |
|---|---|
| `Inventor3DTool.exe` をダブルクリック | アプリを開く（2 つめは開かず、開いている窓を前に出す） |
| .ipt・.iam・.stp・.html・.inventor.json を `Inventor3DTool.exe` にドロップ（「プログラムから開く」でもよい） | そのファイルをアプリで開く（複数なら 1 つの窓にまとめ、起動画面の一覧から切り替える）。開いている間にドロップしても、同じ窓で開く。.iam は同じフォルダの .ipt も部品として使い、組み立てて表示する |
| パネルの **STEP を作る** | 取り込んだ形（または開いた変換データ）から、STEP（.stp）を作る。Inventor もライブラリも使わない（下の「CAD ファイルを作る」） |
| パネルの **Inventor で作る** | STEP に加えて、Inventor で部品（.ipt）と組立（.iam）を作り、部品ごとに体積・表面積を照合する |

- 開いたあとも、画面へのドラッグ＆ドロップ・`Ctrl`+`O`・「サンプル・使い方」で開き直せる
- 記録（うまく動かないときの手がかり）は `%LOCALAPPDATA%\Inventor3DTool\logs`（`desktop.log`: 起動・終わり方・見つけた Python、
  `builder_console.log`: 作る係のエラー出力、`install.log`: ライブラリを入れたときの出力）
- ポートは使わない（窓の中で画面とやりとりする）。Python が見つからなければ、作るボタンの下に理由と入れ方が出る
- 画面は Windows の WebView2（Windows 11 には入っている）で描く

### 配り方・更新

`Inventor3DTool.exe` と `program` フォルダを並べて置く（フォルダの名前は自由。exe だけを別の場所へ移さない。ショートカットは作ってよい）。
更新は、窓を閉じてから新しい ZIP の中身で exe と `program` を置き換える。exe は main へ GitHub Actions が置く
（Windows で作り、本物の WebView2 で自己診断を通った物だけ。作った元のコミットは `program\Inventor3DTool.build.json`）。
作業場所（記録・.pyc）は `%LOCALAPPDATA%\Inventor3DTool` にあり、`program` フォルダは動いている間も「使用中」にならない。

## CAD ファイルを作る

three.js の HTML を開くと、元のページで表示中の形を取り込み、部品ごとに「回転体」「押し出し」「近似（三角形のまま）」に分ける。

1. **単位を確かめる**: 「取り込み結果」の **シーンの 1 単位**。three.js の座標に単位は無く、HTML ごとに「1 = 1 mm」「1 = 1 m」
   「32 = 1500 mm」などと違う。大きさから推定した単位と、実寸での全体の大きさが出るので、実物と違えば選び直す
   （mm・cm・m・inch・任意の長さ。HTML ごとに覚える）
2. **作る**: パネルの「CAD ファイルを作る」で
   - **STEP を作る**（.stp・Inventor 不要）: すべての部品と組立を STEP にする。STEP は Inventor で開けば .ipt・.iam になる
   - **Inventor で作る**（.ipt・.iam・.stp）: STEP に加えて、Inventor で部品と組立を作る。回転体・押し出しは寸法を編集できる部品
     （回転・押し出し・面取りのフィーチャ）、近似の部品は STEP を開いた立体になる。初めてのときは、Inventor の操作に使う Python の
     ライブラリ（pywin32）を「入れて作る」かを尋ねる（インターネットから入れる。1 分ほど）
   - この PC に Inventor が見つからなければ、STEP のほうを勧める（Inventor のボタンも押せる）
3. **結果を見る**: STEP の行（厳密な面か、三角形の面か）と、Inventor で作ったときは部品ごとに照合の結果
   （**一致**（緑）・**不一致**（琥珀）・**失敗**（赤。理由を添える））が並ぶ。**保存先を開く** でフォルダを開く。途中でやめるときは **中止**

保存先は `ドキュメント\Inventor 3Dツール\<HTML の名前>_cad`（同じ名前があれば「 (2)」…。前の結果を上書きしない）。
STEP（.stp）・部品（.ipt）・組立（.iam）・照合の結果（`build-report.json`）・作ったときの変換データの写し（`.inventor.json`）が入る
（近似の部品を Inventor で開くための部品ごとの STEP は `step` フォルダ）。保存先の親フォルダは `program\config\appsettings.json` の
`build.output_dir` で変えられる。作っている間に別のファイルを開いても続く（窓を閉じるときは、中止して閉じるかを聞く）。
Inventor に接続できなかったときも、STEP は残る（理由を表示する）。

### 取り込めるもの・作れるもの

| 元の形 | 扱い |
|---|---|
| 回転体（円柱・円錐・球・トーラス・溝のある円板・扇形・たる形など） | 正確に認識し、STEP では厳密な面（たる形は三角形）、Inventor では回転のフィーチャ |
| 押し出し（多角形・円弧・穴・端面の等距離の面取り） | 同上（押し出しと面取りのフィーチャ）。面取り付きは STEP では三角形 |
| 開いた面の組み合わせ（円筒の壁とリングの筒など）・端の開いた管・継ぎ目の刻みが面ごとに違う形（アルミコイルなど） | 縫い合わせ・平らな縁を塞ぐ・継ぎ目の頂点をそろえて立体にする（部品の説明に書く） |
| それ以外（段付き・横穴・曲がった管・丸い面取りなど） | 近似（三角形のまま）で STEP・.ipt・.iam に入れる。元の形が自分と交わる所があれば知らせる |
| 床・板・文字などの厚みのない面、線・点 | 除外（「除外したもの」に理由と数を出す） |

どの部品も、変換のたびに「認識した寸法で作る形」と元の形が一致するかを両方向で確かめ、合わなければ近似に回す。
.ipt・.iam を Inventor なしで作らない理由と、残っている制約は [docs/cad-output.md](docs/cad-output.md)。

## 変換データ（.inventor.json）の使い方

**変換データ**は、取り込んだ形を作るための設計図（JSON）。部品ごとに、断面（直線・円弧・円）・回転か押し出しか・面取り、
近似の部品は三角形（mesh）、配置（どこに何個置くか）と、照合に使う体積・表面積の期待値を持つ。同じ形の部品は 1 つにまとめる
（例: リールは 459 個 → 25 種類）。「STEP を作る」「Inventor で作る」も、内部ではこの変換データを使っている。ファイルとして使うのは次のとき:

| 使う場面 | 手順 |
|---|---|
| **Inventor の無い PC で取り込み、Inventor のある PC で作る** | 取り込んだ PC で「CAD ファイルを作る」→「あとで別の PC で作るとき（変換データを保存）」→ **変換データを保存**。そのファイルを Inventor のある PC に持っていき、アプリで開く（画面か `Inventor3DTool.exe` にドロップ）→ **Inventor で作る**（STEP だけなら、取り込んだ PC で **STEP を作る** でよい） |
| 作ったものの記録・作り直し | 保存先に置かれる写し（`<名前>.inventor.json`）を開けば、同じ形をもう一度作れる |
| 中身を確かめる | アプリで開くと、作る形を 3D で表示し、部品ごとの種類・寸法・数を並べる（面取りは形には描かず、説明に書く） |
| コマンドで作る・Inventor を使わずに確かめる | `program` フォルダで `python -m ipt_build 名前.inventor.json`（`--step-only` で STEP だけ、`--dry-run` で何も作らずに期待値を確かめる）。[docs/inventor-builder.md](docs/inventor-builder.md) §2-3 |

変換データではない JSON や、アプリより新しい版の変換データは、理由を示して開かない。

## リポジトリの見取り図

リポジトリには**ソース**と、CI が作って置く exe（`Inventor3DTool.exe`）だけを置く。画面は `program/app` のファイルをそのまま読む（画面のビルドは無い）。

```mermaid
flowchart LR
  EXE["Inventor3DTool.exe<br/>（desktop/。Rust・Tauri の窓）"] -- "画面・サンプル・<br/>ドロップされたファイル" --> UI
  subgraph js["program/app/static/js（ブラウザで動く）"]
    F["formats/ 読み取り<br/>.ipt・.iam・STEP"] --> M["model/ 形式によらない形<br/>面・稜線・寸法の要約"]
    H["html/ three.js の HTML から<br/>形状を取り出す"] --> C["convert/ 形状の認識と<br/>変換データ"]
    M --> V["viewer/ 3D 表示"]
    C --> V
    V --> UI["ui/・main.js 画面"]
  end
  C -- "変換データ（.inventor.json）<br/>「STEP を作る」「Inventor で作る」" --> EXE
  EXE -- "python -m ipt_build --events<br/>（作るときだけ）" --> B["program/ipt_build<br/>（この PC の Python）"]
  B -- "直接書く（Inventor 不要）" --> STP[".stp"]
  B -- "Inventor API" --> OUT[".ipt・.iam"]
  STP -. "アプリで開いて確かめる" .-> F
  OUT -. "アプリで開いて確かめる" .-> F
```

| 場所 | 中身 |
|---|---|
| `Inventor3DTool.exe` | **入口**（これだけを使う。main へは CI が置く。作った元は `program/Inventor3DTool.build.json`） |
| `desktop/` | 窓（Rust・Tauri）: 画面とサンプルを配り、受け取ったファイルを渡し、「CAD ファイルを作る」の仕事を受け持つ（`src/jobs.rs`）。1 つだけ起動。`cargo build` で exe を作る（[docs/desktop.md](docs/desktop.md)） |
| `program/app/` | 画面（`index.html`・`static/`）。窓が配る |
| `program/config/appsettings.json` | 「CAD ファイルを作る」の保存先（`build.output_dir`。空ならドキュメント\Inventor 3Dツール） |
| `program/ipt_build/` | CAD ファイルを作るビルダー（Python。窓が作るときだけ別のプロセスで動かす。コマンドでも使える）。STEP は標準ライブラリだけで書き（`p21.py`・`brep.py`・`step.py`）、.ipt・.iam は Inventor で作る（操作に使うライブラリは中の `requirements.txt`） |
| `program/samples/` | サンプルの置き場（起動画面のサンプル一覧兼、評価の題材） |
| `program/tests/` | 評価。Python（`test_*.py`: 配る形・ビルダー・STEP）と JavaScript（`js/`）。窓の評価は `desktop/` の `cargo test` |
| `program/tools/` | 開発用の道具（ファイルの中身の調査・テスト用データの作成・書き出した STEP の形状カーネルでの確かめ・アイコンの絵） |
| `.github/workflows/desktop.yml` | Windows で exe を作り、自己診断し、main へ置く |
| `docs/`・`package.json`・`CLAUDE.md` | 設計と調査の記録、JavaScript の評価の実行（開発用）、作業の決まり |

### 画面のソース（`program/app/static/js/`）

| フォルダ | 役割 | 画面（DOM）に依存 |
|---|---|:-:|
| `core/` | ベクトル・行列・数値の道具、表示名（`labels.json`） | — |
| `formats/` | ファイルの読み取り。`ipt/`（OLE2 → Zstandard → SAB → B-rep）・`iam/`（参照・出現・配置）・`step/`（ISO 10303-21）。入口は `open.js`（形式の判定と、表示・変換で共通に使う「モデル」への読み込み） | — |
| `model/` | 形式によらない形（面・稜線）: 曲線の計算、寸法の要約（穴・外径・R・ねじ・円錐）、表示用の面のデータ | — |
| `html/` | three.js の HTML を隔離した枠で動かし、表示中の形状を取り出す（フック・受け渡し・表示用データ） | ✓ |
| `convert/` | 実寸の単位（`units.js`）。三角形メッシュを立体に閉じ（`recognize/shells.js`）、回転体・押し出し（面取りを含む）を認識して元の形と照らし合わせ（`recognize/`）、変換データを作る（`inventor.js`）。変換データを開いたときの 3D と説明（`preview.js`） | — |
| `viewer/` | 三角形分割・3D 表示・面と部品の説明 | ✓ |
| `ui/` | 画面の部品: 仕様パネル・起動画面・ファイルの受け付け・変換の節（`convert.js`）・シーンの単位（`units.js`）・「CAD ファイルを作る」（`build.js`）・exe の名前 | ✓ |
| `desktop.js` | 窓とのやりとり: サンプル・exe へドロップされたファイル（開いたままのドロップを含む）・「CAD ファイルを作る」 | ✓ |
| `main.js` | 入口。ファイルを読み、表示し、3D ⇄ パネルを連動させる | ✓ |

three.js・fzstd（Zstandard の展開）・Delaunator と Constrainautor（面の表示用の制約付き Delaunay 分割）は `static/vendor/` に同梱し、`app/index.html` の importmap で読む（インターネットは要らない）。

## できること

- **.ipt**: 形状と寸法（外形・穴・外径・R・ねじ・円錐）を表示する。ねじは Inventor が面に付けた情報から呼び（M6×1 など）・等級・ねじ長さを示す。
  材質・密度（iProperties）が分かれば体積と質量も示す。対応している面は平面・円筒・円錐・トーラスで、それ以外は稜線だけを表示する
- **.iam（組立）**: 部品の参照と配置を読み、参照先の .ipt（一緒に受け取ったもの・同じフォルダのもの・サンプル）で組み立てる。部品表（部品名・数・外形・材質・質量）の
  行にカーソルを合わせると 3D の部品を強調し、押すとその部品を開く。見つからない部品は一覧に出し、その .ipt をドロップすると組立に加わる
- **STEP（.stp・.step）**: 部品の形状と組立の配置を全て含むので、単独で表示できる（部品が 1 つなら部品として、2 つ以上なら組立として）
- **.html（three.js）**: 元のページを隔離した枠の中で動かし、表示中の 3D モデルを取り出す（インスタンス描画を含む）。シーンの単位を
  実寸（mm）に直し、開いた面は縫い合わせ・縁を塞いで立体にし、部品ごとに「回転体」「押し出し（端面の縁の等距離面取りを含む）」
  「近似（三角形のまま）」に分類して寸法を復元する
- **STEP を作る**: 取り込んだ形状から、Inventor なしで STEP（.stp）を作る（上の「CAD ファイルを作る」）
- **Inventor で作る**: STEP に加えて、Inventor で部品（.ipt）と組立（.iam）を作り、部品ごとに照合する。
  Inventor の無い PC では変換データ（.inventor.json）として保存し、Inventor のある PC で開いて作ることもできる
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

push の前に通す確かめ（型・構文、lint、テスト）は [CLAUDE.md](CLAUDE.md) にまとめてある。

窓の評価と exe（desktop フォルダで。Rust と、Python が要る。Linux では WebKitGTK も。[docs/desktop.md](docs/desktop.md) §7）:

```
cd desktop
cargo test                 # 作る仕事（本物の別のプロセス＋Inventor の代替オブジェクト）・画面を配る・受け取ったファイル・孫まで止める
cargo build --release      # target/release/Inventor3DTool.exe（main へ置くのは CI）
```

Python の評価（program フォルダで。配る形・ビルダー・STEP）:

```
cd program
python -m unittest discover -s tests -t .
python -m ipt_build 名前.inventor.json --step-only  # STEP だけを作る（どの OS でも可）
python -m ipt_build 名前.inventor.json --dry-run    # 何も作らずに変換データを確かめる（どの OS でも可）
```

書き出した STEP を形状カーネル（OpenCascade）でも確かめるには、開発用に `pip install cadquery-ocp` を入れる
（入っていなければ、その評価だけ飛ばす。アプリには要らない）。`python tools/check_step.py 名前.stp` で 1 つのファイルも確かめられる。

JavaScript の評価と道具（リポジトリの最上位で。Node.js 22 以上。npm で入れるものは無い）:

```
npm test                 # 読み取り・三角形分割・組立と STEP の照合・形状認識・変換データ・書き出した STEP の読み戻し（要 Python）
npm run inspect -- program/samples/ipt/E_Plate_改_Φ54.5.ipt [--dump 出力先]   # .ipt・.iam の中身を調べる（形式の調査の再現）
npm run fixtures:html    # samples/html から形状を取り出し、テスト用データを作り直す（要 Playwright）
npm run fixtures:builder # ビルダーのテスト用の変換データ（program/tests/fixtures/builder）を作り直す
```

画面を手元で確かめるときは `desktop` フォルダで `cargo run`（画面のファイルは `program/app` から読むので、直したら窓を開き直すだけで効く）。
