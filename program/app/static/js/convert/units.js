// three.js のシーンの単位: 座標に単位は無く、HTML ごとに「1 = 1 mm」「1 = 1 m」「32 = 1500 mm」などと決まっている。
// 認識と変換は mm で行うので、シーンの 1 単位が何 mm かを決める。大きさからの推定は目安にとどめ、画面で確かめて選んでもらう。
// DOM に依存しない（Node で評価する）。

export const UNIT_PRESETS = [
  { key: "mm", label: "mm", mm: 1 },
  { key: "cm", label: "cm", mm: 10 },
  { key: "m", label: "m", mm: 1000 },
  { key: "in", label: "inch", mm: 25.4 },
];

// 床などの平らな面を除いた全体の大きさが、これ未満なら m、以上なら mm と推定する。
// 50 は「50 mm 未満の組立」と「50 m 以上の設備」がどちらも稀なことによる境（どちらとも取れる大きさは画面で確かめる）
const METRE_BELOW = 50;

/**
 * シーン全体の大きさ（シーンの単位）。平らなメッシュ（床・板・文字）は除く（床は部品より大きく描かれることが多い）。
 * @returns {number[] | null}  [X, Y, Z] の大きさ。形が無ければ null
 */
export function sceneExtent(snapshot) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of snapshot.meshes) {
    const p = mesh.positions;
    if (!p.length) continue;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
    }
    for (const m of mesh.instances ?? [mesh.matrix]) {
      // 外接箱の 8 つの角をワールドへ
      const corners = [];
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        corners.push([0, 1, 2].map((k) => m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k]));
      }
      const size = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])) - Math.min(...corners.map((c) => c[k])));
      if (Math.min(...size) <= 1e-6 * Math.max(...size)) continue; // 平らなメッシュ
      for (const c of corners) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], c[k]);
        hi[k] = Math.max(hi[k], c[k]);
      }
    }
  }
  return Number.isFinite(lo[0]) ? hi.map((v, k) => v - lo[k]) : null;
}

/** 大きさからの推定（mm か m）。形が無ければ mm */
export function guessUnit(extent) {
  return extent && Math.max(...extent) < METRE_BELOW ? UNIT_PRESETS.find((u) => u.key === "m") : UNIT_PRESETS[0];
}

/** 大きさ（mm の並び）を同じ単位で読みやすく: 最大が 10 m 以上なら m、それ未満なら mm（「20 × 20.65 × 6 m」） */
export function formatSize(sizes) {
  const metre = Math.max(...sizes) >= 10000;
  const text = sizes.map((v) => (metre ? v / 1000 : v).toLocaleString("ja-JP", { maximumFractionDigits: metre ? 2 : v >= 100 ? 1 : 3 }));
  return `${text.join(" × ")} ${metre ? "m" : "mm"}`;
}
