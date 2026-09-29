# 同梱したライブラリ

画面が読み込むライブラリを、ここに置いています（インターネットにつながらない PC でも動くように）。
どのファイルをどの名前で読むかは `app/templates/index.html` の importmap が決めます（Node の評価も同じ importmap を読みます）。

| フォルダ | ライブラリ | 版 | 取り出した元（npm） | ライセンス |
|---|---|---|---|---|
| `three/` | [three.js](https://threejs.org/) | 0.170.0 | `build/three.module.min.js`、`examples/jsm/controls/OrbitControls.js`（`addons/` に同じ並びで置く） | MIT（`three/LICENSE`） |
| `fzstd/` | [fzstd](https://github.com/101arrowz/fzstd)（Zstandard の展開。.ipt・.iam の読み取りに使う） | 0.1.1 | `esm/index.mjs` | MIT（`fzstd/LICENSE`） |

入れ替えるときは、同じ名前で置き換え、上の版を書き直してください。
