# CLAUDE.md

このリポジトリで作業するときの決まり。

## push の前に、ローカルで全ての確かめを通す

push する前に、次の 3 つ（型・構文、lint、テスト）を全てローカルで通す（green にする）。1 つでも落ちていれば push しない。
文書だけの変更でも同じ。リポジトリの最上位で実行する:

```sh
# 1. 型・構文（JavaScript・Python）
find program/app/static/js program/tests/js program/tools -name '*.js' -o -name '*.mjs' | xargs -n1 node --check
python -m compileall -q program
# 2. lint（Python）
ruff check program
# 3. テスト（JavaScript・Python）
npm test
(cd program && python -m unittest discover -s tests -t .)
```

- 型検査の道具（TypeScript・mypy）は入れていないので、1 は構文の確かめで代えている。入れたら差し替える
- JavaScript の lint の設定は無い（2 は Python だけ）
- Python のテストの一部は OpenCascade（`pip install cadquery-ocp`）が無いと飛ばす（飛ばした数が出る）。全体で約 3 分

## レビューの指摘は、まとめて 1 回で push する

レビューの指摘を直すときは、指摘ごとに push しない。全ての指摘を直し、上の確かめを全て通してから、まとめて 1 回 push する。
