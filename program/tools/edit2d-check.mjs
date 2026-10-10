// 2D の図形を動かす・回す・拡大する（formats/cad2d/transform.js）の評価関数（開発用・試験と共用）。
//
//   node program/tools/edit2d-check.mjs フォルダか図面 … [--verbose]
//
// 図面の全てのレイアウトの全ての図形について、図形を変換 m で動かして描いたもの（viewer2d/scene.js）と、元の図形を描いた結果の点
// （線・塗り・文字の位置と向きと高さ・点・画像）を m で動かしたものが一致するかを見る。描き方は直す側と独立（描く側の計算を通す）ので、
// 合えば動かし方が正しい。変換は 3 つ: 平行移動・点のまわりの回転（30°）・回転＋拡大（2 倍）＋移動。
// 寸法は、見た目のブロックの図形も同じ変換で動かす（edit/drawing.js と同じ扱い）。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { EditError, applyPoint, angleOf, editableReason, scaleOf, similarity, transformEntity } from "../app/static/js/formats/cad2d/transform.js";
import { buildScene } from "../app/static/js/viewer2d/scene.js";

export const TRANSFORMS = {
  移動: similarity({ move: [123.25, -56.5] }),
  回転: similarity({ angle: Math.PI / 6, center: [10, 20] }),
  "回転・拡大・移動": similarity({ angle: 2.2, center: [-3, 7], scale: 2, move: [40, 5] }),
};

/** 1 つの図形だけを置いたレイアウトの図面（表とブロックは元のまま。寸法の見た目のブロックだけ差し替えられる） */
function single(drawing, layout, entity, dimensionBlock = null) {
  const blocks = new Map(drawing.blocks);
  blocks.set(layout.block, { ...drawing.blocks.get(layout.block), entities: [entity] });
  if (dimensionBlock) blocks.set(entity.block, dimensionBlock);
  return { ...drawing, blocks };
}

/** 描いた結果: 線と塗りの輪は点の列、文字は [x, y, 角度, 高さ]、点・画像の角は [x, y] */
function rendered(scene) {
  const runs = [];
  for (const s of scene.strokes) for (const line of s.lines) runs.push(["線", pairs(line.points)]);
  for (const f of scene.fills) for (const ring of f.rings) runs.push(["塗り", pairs(ring)]);
  const marks = [];
  for (const t of scene.texts) marks.push(["文字", t.x, t.y, t.rotation, t.height]);
  for (const p of scene.points) marks.push(["点", p.x, p.y]);
  for (const img of scene.images) marks.push(["画像", img.matrix[4], img.matrix[5]], ["画像", img.matrix[4] + img.matrix[0], img.matrix[5] + img.matrix[1]]);
  return { runs, marks };
}
const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);

const TAU = 2 * Math.PI;
const near = (a, b) => Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI) < 1e-9;

/** 点から折れ線の集まりまでの距離と、いちばん近い区間の長さ */
function nearest(p, runs) {
  let best = { d: Infinity, len: 0 };
  for (const [, pts] of runs) {
    if (pts.length === 1) {
      const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
      if (d < best.d) best = { d, len: 0 };
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const v = [b[0] - a[0], b[1] - a[1]], len2 = v[0] ** 2 + v[1] ** 2;
      const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / len2)) : 0;
      const d = Math.hypot(p[0] - a[0] - t * v[0], p[1] - a[1] - t * v[1]);
      if (d < best.d) best = { d, len: Math.sqrt(len2) };
    }
  }
  return best;
}
const same2 = (p, q, unit) => Math.abs(p[0] - q[0]) <= unit && Math.abs(p[1] - q[1]) <= unit;

/**
 * 2 つの描いた結果が同じ形か。
 *   文字・点・画像: 位置（広がりの 1e-7 の内）・角度・高さが一致
 *   線と塗り: 開いた線の両端は一致し、全ての点が相手の折れ線の上にある。曲線は描く側が刻むので、刻み方が変換で変わる（円はいつも
 *   角度 0 から刻む・PDF の曲線は長さで刻む）。許す差は、いちばん近い区間の長さの 10%（円を 64 に刻んだときの弦の高さは区間の 1.2%）
 *   模様のハッチングの線（patterned）: 境界にちょうど触れる線（の破線）が丸めで出入りするので、点の 5%（少なくとも 8）まで合わなくてよい
 */
function sameRendering(expected, actual, size, patterned) {
  const unit = Math.max(size, 1) * 1e-7;
  if (expected.marks.length !== actual.marks.length) return `文字・点の数 ${expected.marks.length} / ${actual.marks.length}`;
  const used = new Set();
  for (const r of expected.marks) {
    const i = actual.marks.findIndex((q, k) => !used.has(k) && q[0] === r[0] && Math.abs(q[1] - r[1]) <= unit && Math.abs(q[2] - r[2]) <= unit &&
      (r[3] === undefined || near(q[3], r[3])) && (r[4] === undefined || Math.abs(q[4] - r[4]) <= 1e-9 * Math.max(1, r[4])));
    if (i < 0) return `${r[0]} (${r.slice(1).map((v) => Number(v.toFixed(6))).join(", ")}) が、動かした図形の描画に無い`;
    used.add(i);
  }
  for (const [from, to, label] of [[expected, actual, "元の描画を動かした点"], [actual, expected, "動かした図形の描画の点"]]) {
    let missed = 0, total = 0, first = null;
    for (const [kind, pts] of from.runs) {
      const others = to.runs.filter(([k]) => k === kind);
      const open = pts.length > 1 && !same2(pts[0], pts.at(-1), unit);
      for (const [index, p] of pts.entries()) {
        total++;
        const end = open && (index === 0 || index === pts.length - 1);
        const ok = end
          ? others.some(([, q]) => same2(p, q[0], 10 * unit) || same2(p, q.at(-1), 10 * unit))
          : (({ d, len }) => d <= 10 * unit + 0.1 * len)(nearest(p, others));
        if (!ok) {
          missed++;
          first ??= `${label} ${kind}${end ? "の端" : ""} (${p.map((v) => Number(v.toFixed(6))).join(", ")}) が、もう片方の描画の上に無い`;
        }
      }
    }
    if (missed > (patterned ? Math.max(0.05 * total, 8) : 0)) return `${first}（${missed}/${total}）`;
  }
  return null;
}

/** 図面の全ての図形を変換で試す → { tried, ok, refused: Map<理由, 数>, failures: [[handle, type, 変換, 説明]] } */
export function checkDrawing(drawing) {
  const result = { tried: 0, ok: 0, refused: new Map(), failures: [] };
  for (const layout of drawing.layouts) {
    const block = drawing.blocks.get(layout.block);
    for (const e of block?.entities ?? []) {
      const reason = editableReason(e);
      if (reason) {
        result.refused.set(reason, (result.refused.get(reason) ?? 0) + 1);
        continue;
      }
      let before;
      try {
        before = buildScene(single(drawing, layout, e), layout);
      } catch {
        continue; // 描けない図形（壊れた値）は評価の外
      }
      if (before.broken || !before.extents) continue;
      const size = Math.max(before.extents.max[0] - before.extents.min[0], before.extents.max[1] - before.extents.min[1], 1);
      for (const [name, m] of Object.entries(TRANSFORMS)) {
        result.tried++;
        let moved, dimBlock = null;
        try {
          moved = transformEntity(e, m);
          if (e.type === "DIMENSION" && drawing.blocks.has(e.block)) {
            const b = drawing.blocks.get(e.block);
            dimBlock = { ...b, entities: b.entities.map((child) => transformEntity(child, m)) };
          }
        } catch (error) {
          if (!(error instanceof EditError)) throw error;
          result.refused.set(error.message, (result.refused.get(error.message) ?? 0) + 1);
          continue;
        }
        const after = buildScene(single(drawing, layout, moved, dimBlock), layout);
        const s = scaleOf(m), turn = angleOf(m);
        const original = rendered(before);
        const expected = {
          runs: original.runs.map(([kind, pts]) => [kind, pts.map((p) => applyPoint(m, p))]),
          marks: original.marks.map(([kind, x, y, rotation, height]) => [kind, ...applyPoint(m, [x, y]), ...(rotation === undefined ? [] : [rotation + turn, height * s])]),
        };
        const problem = sameRendering(expected, rendered(after), size * s + Math.hypot(m.e, m.f), e.type === "HATCH" && !e.solid && e.lines?.length > 0);
        if (problem) result.failures.push([e.handle, e.type, name, problem]);
        else result.ok++;
      }
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = args.filter((a) => !a.startsWith("--")).flatMap((a) => (fs.statSync(a).isDirectory() ? walk(a) : [a])).filter((f) => /\.(dwg|dxf|jww|sfc|p21|pdf)$/i.test(f));
  const total = { tried: 0, ok: 0, failures: 0 };
  const refused = new Map();
  const failedKinds = new Map();
  for (const file of files) {
    let drawing;
    try {
      drawing = readDrawing(new Uint8Array(fs.readFileSync(file)), file);
    } catch {
      continue;
    }
    const r = checkDrawing(drawing);
    total.tried += r.tried;
    total.ok += r.ok;
    total.failures += r.failures.length;
    for (const [k, n] of r.refused) refused.set(k, (refused.get(k) ?? 0) + n);
    for (const [, type, name] of r.failures) failedKinds.set(`${type} ${name}`, (failedKinds.get(`${type} ${name}`) ?? 0) + 1);
    console.log(`${path.relative(process.cwd(), file)}  ${r.ok}/${r.tried}${r.failures.length ? `  合わない ${r.failures.length}` : ""}`);
    for (const [handle, type, name, problem] of r.failures.slice(0, verbose ? Infinity : 3)) console.log(`  ${type} #${handle} ${name}: ${problem}`);
  }
  console.log(`\n合計: ${total.ok}/${total.tried} が一致・合わない ${total.failures}`);
  for (const [k, n] of [...failedKinds].sort((a, b) => b[1] - a[1])) console.log(`  合わない ${k}: ${n}`);
  for (const [k, n] of refused) console.log(`  直さない: ${k} ${n}`);
}
