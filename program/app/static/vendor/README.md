# 同梱したライブラリ

画面が読み込むライブラリを、ここに置いています（インターネットにつながらない PC でも動くように）。
どのファイルをどの名前で読むかは `app/index.html` の importmap が決めます（Node の評価も同じ importmap を読みます）。

| フォルダ | ライブラリ | 版 | 取り出した元（npm） | ライセンス |
|---|---|---|---|---|
| `three/` | [three.js](https://threejs.org/) | 0.170.0 | `build/three.module.min.js`、`examples/jsm/controls/OrbitControls.js`（`addons/` に同じ並びで置く） | MIT（`three/LICENSE`） |
| `fzstd/` | [fzstd](https://github.com/101arrowz/fzstd)（Zstandard の展開。.ipt・.iam の読み取りに使う） | 0.1.1 | `esm/index.mjs` | MIT（`fzstd/LICENSE`） |
| `fflate/` | [fflate](https://github.com/101arrowz/fflate)（Deflate の展開。PDF の FlateDecode に使う） | 0.8.2 | `esm/browser.js`（`index.js` の名前で置く） | MIT（`fflate/LICENSE`） |
| `delaunator/` | [Delaunator](https://github.com/mapbox/delaunator)（Delaunay 三角形分割。面の表示用の分割に使う） | 5.1.0 | `index.js` | ISC（`delaunator/LICENSE`） |
| `constrainautor/` | [Constrainautor](https://github.com/kninnug/Constrainautor)（Delaunator の分割に境界の辺を入れる。制約付き Delaunay） | 4.1.0 | `lib/Constrainautor.mjs` | ISC（`constrainautor/LICENSE`） |
| `robust-predicates/` | [robust-predicates](https://github.com/mourner/robust-predicates)（丸め誤差の無い幾何の判定。上の 2 つが使う） | 3.0.3 | `index.js`・`esm/*.js` | Unlicense（`robust-predicates/LICENSE`） |

入れ替えるときは、同じ名前で置き換え、上の版を書き直してください。

**読み方（2.10.0〜）**: アプリのコードは、ライブラリを `js/vendor.js` から読みます（importmap と同じファイルを相対の道で指す）。
裏で計算する Worker（`js/work/`）では importmap が効くとは限らないためです。同じ理由で、同梱のライブラリ同士の読み込みも
相対の道に直してあります。入れ替えたら、次の 2 行を同じように直してください。

- `delaunator/index.js`: `from 'robust-predicates'` → `from '../robust-predicates/index.js'`
- `constrainautor/index.mjs`: `from 'robust-predicates'` → `from '../robust-predicates/index.js'`

`three/addons/` の OrbitControls は画面（3D の表示）だけが使い、importmap の `three` で読みます（同じファイルなので 1 つのモジュール）。
