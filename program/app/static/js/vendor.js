// 同梱したライブラリ（static/vendor）の入口。DOM に依存しない計算は、ライブラリをここから読む。
// 裏で計算する Worker（work/）では、画面の importmap（index.html）が効くとは限らない（Worker が importmap を読むかはブラウザの版による）。
// ここは importmap と同じファイルを相対の道で指すので、どちらから読んでも同じ 1 つのモジュールになる（画面の "three" と、ここの THREE は同じ物）。
// 同梱のライブラリ同士の読み込み（delaunator・constrainautor → robust-predicates）も相対の道に直してある（vendor/README.md）。
export * as THREE from "../vendor/three/three.module.min.js";
export { decompress } from "../vendor/fzstd/index.mjs";
export { Inflate } from "../vendor/fflate/index.js";
export { default as Delaunator } from "../vendor/delaunator/index.js";
export { default as Constrainautor } from "../vendor/constrainautor/index.mjs";
