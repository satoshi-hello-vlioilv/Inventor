// 2026-10（見栄え）: 画面全体の見た目の案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-look.mjs --states empty,ipt,asm,drawing,done
// 今の画面の画像で見えたこと（look-before: ライト・ダークの全状態）:
// ① 3D の形（灰 #b4bbc3）が、舞台の灰のグラデーション（#f9fbfc → #d9e0e8）に沈む。図と地の差が小さく、形が平たく見える
// ② 右の欄は、行ごとに枠の付いたカード（形状要素・部品表・作る部品）。枠線が縦に十数本並び、読む前にうるさい
// ③ 照合の結果の升目（25 個）が濃い緑の塗りで、欄の中でいちばん重い。3D の形も同じ濃い緑
// ④ 3D の枠と右の欄が、ページの地の上にそれぞれ枠・影で浮く（枠の二重）。外側に 16px の余白が回る
// 案の中身（状態・文言・並び）は同じ。違うのは色・枠・地の扱いだけ。点数は 2026-10-look.json、決めたことは docs/ui.md。

// 光・闇の両方の地を変える（ダークは prefers-color-scheme。撮影の道具はこちらで切り替える）
const tokens = (light, dark) => `:root { ${light} }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`;

// A 明るい作業台: 舞台を白に近づけ、形を一段濃く。床に淡い影（形の下が落ち着く）
const BRIGHT = {
  css: `${tokens("--stage-top: #ffffff; --stage-bottom: #e6ebf1; --steel: #97a2ae; --edge: #1b2530;",
    "--stage-top: #34404d; --stage-bottom: #1b232c; --steel: #b8c1cb;")}
    .stage { background: radial-gradient(ellipse 60% 22% at 50% 82%, rgba(16, 32, 48, 0.10), transparent 70%), linear-gradient(180deg, var(--stage-top), var(--stage-bottom)); }`,
  ops: [],
};

// B CAD の舞台: 濃い青灰の地に明るい形（CAD の作業画面の慣例。形がいちばん目立つ）。ほかの欄は明るいまま
const CAD = {
  css: `${tokens("--stage-top: #3e4a58; --stage-bottom: #8d99a6; --steel: #d3d9df; --edge: #18202a;",
    "--stage-top: #2a333e; --stage-bottom: #141a21; --steel: #c6ced6;")}`,
  ops: [],
};

// C 静かな欄: 行のカードの枠をやめ、細い線で区切る。外形寸法・数の札は淡い地だけ（枠線を半分以下に）
const QUIET = {
  css: `.features { gap: 0; }
    .feature { border: 0; border-radius: 0; border-bottom: 1px solid var(--rule-soft); padding: 10px 6px; background: transparent; }
    .feature:hover, .feature.is-active { border-radius: 8px; border-color: transparent; }
    .feature[data-tone] { border-inline-start: 3px solid var(--tone); padding-inline-start: 10px; }
    .dims { border: 0; gap: 6px; }
    .dims div { border: 0; border-radius: 8px; background: var(--surface-2); }
    .tally-chip { border-color: transparent; background: var(--surface-2); }`,
  ops: [],
};

// D 一枚の面: ページの余白と、3D・欄の枠と影をやめ、1 本の線で区切る（枠の二重を無くす）
const FLAT = {
  css: `.app { gap: 0; padding: 0; }
    .appbar { margin-inline: 0; }
    .stage { border: 0; border-radius: 0; box-shadow: none; }
    .side { border: 0; border-inline-start: 1px solid var(--rule); border-radius: 0; box-shadow: none; }
    .source { border-radius: 0; box-shadow: none; }`,
  ops: [],
};

// E 色を絞る: 結果の升目を淡い地＋色の文字に、種類の札を無彩色に（色は「状態」と主のボタンだけに使う）
const CALM = {
  css: `.verdict-grid li:not([data-tone="wait"]) { background: color-mix(in srgb, var(--tone) 16%, var(--surface)); color: color-mix(in srgb, var(--tone) 80%, var(--ink)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 45%, transparent); }
    .verdict-grid li[data-tone="warn"], .verdict-grid li[data-tone="run"] { color: color-mix(in srgb, var(--tone) 70%, var(--ink)); }
    .kind-badge { color: var(--ink); background: var(--surface-2); }`,
  ops: [],
};

// F 濃淡で階層: 欄の地を一段濃くし、行を白い面で浮かせる（枠の線ではなく、地の明るさで区切る）
const LAYERED = {
  css: `.side { background: var(--surface-2); }
    .feature { border-color: transparent; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08); }
    .dims { border-color: transparent; background: var(--surface); }
    .dims div { border-color: var(--rule-soft); }
    .tally-chip { border-color: transparent; }
    .card { box-shadow: none; }`,
  ops: [],
};

// ---- 2 回目（1 回目は C 79.0・A 78.0・B 77.0・D 77.0 で僅差。欄の C と舞台の A は別の層を直すので重ねられる） ----
const join = (...ps) => ({ css: ps.map((p) => p.css).join("\n"), ops: ps.flatMap((p) => p.ops) });

export const PROPOSALS = [
  { key: "base", name: "現状", css: "", ops: [] },
  { key: "A", name: "A 明るい作業台", ...BRIGHT },
  { key: "B", name: "B CAD の舞台", ...CAD },
  { key: "C", name: "C 静かな欄", ...QUIET },
  { key: "D", name: "D 一枚の面", ...FLAT },
  { key: "E", name: "E 色を絞る", ...CALM },
  { key: "F", name: "F 濃淡で階層", ...LAYERED },
  { key: "G", name: "G 明るい作業台＋静かな欄", ...join(BRIGHT, QUIET) },
  { key: "H", name: "H G＋一枚の面", ...join(BRIGHT, QUIET, FLAT) },
  { key: "I", name: "I H＋色を絞る", ...join(BRIGHT, QUIET, FLAT, CALM) },
];
