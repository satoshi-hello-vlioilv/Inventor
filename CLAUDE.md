# CLAUDE.md

このリポジトリで作業するときの決まり。

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

## レビューの指摘は、まとめて 1 回で push する

レビューの指摘を直すときは、指摘ごとに push しない。全ての指摘を直し、上の確かめを全て通してから、まとめて 1 回 push する。
