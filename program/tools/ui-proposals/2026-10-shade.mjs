// 2026-10（3D の陰影）: 光の強さの案（viewer.js が読む --light-ambient・--light-key・--light-fill と、形の色 --steel）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-shade.mjs --states ipt,asm,done --themes light,dark
// 今の画面の画像で見えたこと: 部品の大きな平面が同じ明るさの灰で塗られ、向きの違う面（上面と側面）の差が小さい。面の境は稜線だけで分かる。
// 作り終えると形全体が濃い緑になり、陰影がさらに読みにくい。点数は 2026-10-shade.json。

const light = (ambient, key, fill, extra = "") => ({ css: `:root { --light-ambient: ${ambient}; --light-key: ${key}; --light-fill: ${fill}; ${extra} }`, ops: [] });

export const PROPOSALS = [
  { key: "base", name: "現状（空と地 1.6・主 1.8）", css: "", ops: [] },
  { key: "A", name: "A 主を強く・全体を弱く", ...light(1.0, 2.6, 0) },
  { key: "B", name: "B 主＋左の補い", ...light(1.0, 2.0, 0.8) },
  { key: "C", name: "C 補いを強く（面の差を最大）", ...light(0.8, 2.2, 1.2) },
  { key: "D", name: "D B＋形を明るく", ...light(1.0, 2.0, 0.8, "--steel: #a9b3be;") },
  { key: "E", name: "E 全体を弱く・主だけ", ...light(0.7, 2.8, 0) },
  { key: "F", name: "F B＋作り終えた緑を淡く", ...light(1.0, 2.0, 0.8, "--ok: #3d9a5c;") },
  // ---- 2 回目（1 回目は C 80.5・B 79.5 で僅差）。3D の一致の色は --mark-ok だけを変える（画面の文字の --ok は変えない） ----
  { key: "G", name: "G C＋3D の一致の緑を明るく", ...light(0.8, 2.2, 1.2, "--mark-ok: #3f9d5f;") },
  { key: "H", name: "H C＋主を強く（締まり）", ...light(0.7, 2.5, 1.1) },
  { key: "I", name: "I G＋H", ...light(0.7, 2.5, 1.1, "--mark-ok: #3f9d5f;") },
];
