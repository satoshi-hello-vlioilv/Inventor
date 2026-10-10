# CLAUDE.md

このリポジトリで作業するときの決まり。

## 返答・報告・解説は、常に日本語で書く

利用者への返答は、どんなに短くても日本語で書く。英語に戻さない。対象は次の全て:

- 返答と解説
- 途中の一言（いま何をしているか）
- 状況報告（CI の結果、PR の状態、定期確認の結果、マージ、exe の配置）
- PR の説明

## push の前に、ローカルで全ての確かめを通す

push する前に、次の 3 つ（型・構文、lint、テスト）を全てローカルで通す（green にする）。1 つでも落ちていれば push しない。
文書だけの変更でも同じ。リポジトリの最上位で実行する:

```sh
# 1. 型・構文（JavaScript・Python・Rust）
find program/app/static/js program/tests/js program/tools desktop/src -name '*.js' -o -name '*.mjs' | xargs -n1 node --check
python -m compileall -q program
(cd desktop && cargo check --all-targets)
# 2. lint（Python・Rust）
ruff check program
(cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
# 3. テスト（JavaScript・Python・Rust）
npm test
(cd program && python -m unittest discover -s tests -t .)
(cd desktop && cargo test)
```

- 型検査の道具（TypeScript・mypy）は入れていないので、JavaScript・Python は構文の確かめで代えている。入れたら差し替える。Rust はコンパイラが型を確かめる
- JavaScript の lint の設定は無い（2 は Python と Rust）
- Python のテストの一部は OpenCascade（`pip install cadquery-ocp`）が無いと飛ばす（飛ばした数が出る）。全体で約 3 分
- 窓（`desktop/`。Tauri）を Linux で作るには WebKitGTK などが要る（`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev libssl-dev`）。
  Windows 向けの部分（`#[cfg(windows)]`）を変えたときは、`rustup target add x86_64-pc-windows-msvc` のうえで
  `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings` も通す（Linux の確かめでは、その部分をコンパイルしない）
- Windows の本物の WebView2 での自己診断は CI（`.github/workflows/desktop.yml`）が行う。手元で同じ手順を試すときは [docs/desktop.md](docs/desktop.md) §7

## アプリを変えたら、版（program/version.json）を上げる

各 PC は、置き場の配る版（`program/version.json` の `version`）と自分の版を比べてそろえる。置き場は同じ番号の版を受け付けない
（もう写した PC と中身が食い違うため）。main へ入れる PR で `program/` か exe を変えたら、`version` を上げる
（小さな直し → 3 つめ、機能の追加 → 2 つめ。例 2.1.0 → 2.1.1・2.2.0）。仕組みは [docs/desktop.md](docs/desktop.md) §8

## main へ入れる準備: 配る中身を最小に保つ

置き場（Box）へ配る版は、動かすのに要る物だけにする（版ごとに置き場と全ての PC へ写すので軽く保つ）。

- 配る物は `desktop/src/update.rs` の `PAYLOAD`（exe・README.md・`program/version.json`・`program/Inventor3DTool.build.json`・`program/app`・`program/ipt_build`）。
  サンプル（`program/samples`）・試験（`program/tests`）・開発の道具（`program/tools`）・この PC の設定（`program/config`）は配らない
- `program` の直下に動かすのに要る物を足したときだけ `PAYLOAD` に足す。サンプル・試験・道具・大きなデータは足さない
- 確かめ: `cargo test` の `the_repository_payload_is_small`（配る program が 4 MB 以下・サンプルと試験を含まない）と
  `test_layout` の `test_the_distribution_is_minimal_and_released_by_ci`。画面はサンプルが無くても使えること（サンプルへの入口を出さない）
- main へ入ると CI が配る ZIP（`Inventor3DTool-版.zip`）を `--pack` で作り、版ごとに GitHub の Releases へ置く。
  版の管理の「ZIP から版を置く」では、この軽い ZIP を選ぶ（Code → Download ZIP の ZIP でも、置くときに同じ決まりで選び出す）

## レビューの指摘は、まとめて 1 回で push する

レビューの指摘を直すときは、指摘ごとに push しない。全ての指摘を直し、上の確かめを全て通してから、まとめて 1 回 push する。

## UI/UX を変えるときは、最低 5 案を画像で直接比べて選ぶ

画面の見た目・使い方（UI/UX）を改良するときは、必ず次の順で設計する。案を文章だけで採点しない。

1. 今の画面を撮り（`ui-check.mjs`）、画像を見て評価する。何が使いにくいか・分かりにくいかを、画像で見えたことを根拠に挙げる
2. 改良案を**最低 5 案**出し、案ごとに画面を撮る（`ui-variants.mjs`）
3. 画像を直接見比べて採点し（7 基準。`ui_score.py`）、1 位を選ぶ
4. 1 位と 2 位が**僅差**（僅差の幅 11 点より近い）なら、無理に選ばない。より良さそうな**複合案を 3 つ**作り、**元の案の上位 2 案**を足した 5 案を、また画像にして比べ、選び直す
5. 選び直しても僅差なら、無理に選ばない。上位の案の画像を添えて、利用者に確かめる
6. 選んだ案を作ったら、作る前と後を `ui-check.mjs` で撮って測り、画像と数で確かめる。比べた画像は比較のページ（Artifact）で見せる

```sh
node program/tools/ui-check.mjs 出力フォルダ both                                  # 今の画面（作った後の前後比較にも）
node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs --states empty,html,done   # 案ごとの画面と、全案を並べた一覧
node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs --view 1536x864      # フル HD・125% でも
python program/tools/ui_score.py 採点.json                                          # 採点・僅差の判定・次にすること
```

- 案の定義と採点は `program/tools/ui-proposals/` に比較ごとに置く（例: `2026-10-layout.mjs` と `2026-10-layout.json`）
- 案は、今の画面に案の CSS と DOM の組み替えを当てて再現する（`ui-variants.mjs` の冒頭の説明）
- 全案を並べた一覧（`sheet-状態-テーマ.png`）で全体を見る。細部（隠れる・切れる・折り返す・空く）は 1 枚ずつの画像で見る
- 撮る大きさは利用者の PC（1728×1152。既定）と、フル HD・125%（1536×864）。上位の案はダーク（`--themes light,dark`）でも見る
