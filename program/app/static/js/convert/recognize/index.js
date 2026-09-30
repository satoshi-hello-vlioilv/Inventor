// 形状認識の入口: 取り出したメッシュを部品ごとに「回転体」「押し出し」「メッシュ（近似）」「除外」に分類し、寸法をまとめる。
// 座標は mm（シーンの 1 単位 = unit mm）。部品は「閉じた殻」（shells.js）: 1 つのメッシュの中の閉じた殻のほか、
// 開いた面をメッシュをまたいで縫い合わせたもの・平らな縁を塞いだものも部品にする。
// 候補の軸は、部品自身の座標軸（手続き的に作られた形状はこれに沿うことが多い）→ ワールドの X・Y・Z の順に試す。

import { add, cross, dot, mul, sub, unit } from "../../core/vec.js";
import { pointAt, tolerance, transformPoints, weldTriangles } from "./mesh.js";
import { detectPrism } from "./prism.js";
import { detectRevolve } from "./revolve.js";
import { describeSegments, fitSegments } from "./segments.js";
import { selfCrossings, untangleLoop } from "./geometry2d.js";
import { selfIntersections } from "./intersect.js";
import { buildShells, closeOpenShells } from "./shells.js";
import { featureOf, maxDeviation, reverseDeviation } from "../inventor.js";

export const TOL = 1e-3; // mm。許容差の最小値。float32 の丸め誤差（座標 1000 mm で約 1e-4 mm）より大きく、設計上の寸法差より十分小さい

const WORLD_AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** メッシュ自身の座標軸（ワールド座標での向き）。 */
const localAxes = (matrix) => [0, 4, 8].map((k) => unit([matrix[k], matrix[k + 1], matrix[k + 2]]));

function candidateAxes(matrix) {
  const local = localAxes(matrix);
  const axes = [];
  for (const a of [...local, ...WORLD_AXES]) if (!axes.some((b) => Math.abs(dot(a, b)) > 1 - 1e-9)) axes.push(a);
  return axes;
}

function centroid(points, tris) {
  const used = [...new Set(tris)];
  const s = used.reduce((acc, i) => add(acc, pointAt(points, i)), [0, 0, 0]);
  return mul(s, 1 / used.length);
}

function bbox(points, tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of tris) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], points[3 * i + k]);
      hi[k] = Math.max(hi[k], points[3 * i + k]);
    }
  }
  return { min: lo, max: hi, size: hi.map((v, k) => v - lo[k]) };
}

/**
 * 断面の小さな自己交差（元のメッシュの折れでできた蝶ネクタイ形の輪）を取り除く。取り除いた数と、元の形との差を記録する
 * @returns {{ loops: object[][], untangled: { count: number, deviation: number } | null }}
 */
function untangle(loops) {
  let count = 0, deviation = 0;
  const out = loops.map((loop) => {
    const r = untangleLoop(loop);
    count += r.removed;
    deviation = Math.max(deviation, r.deviation);
    return r.loop;
  });
  return { loops: out, untangled: count ? { count, deviation } : null };
}

/** 回転体として認識できたら寸法をまとめる。 */
function summarizeRevolve(fit, tol) {
  const r = fit.profile.map((p) => p[0]), h = fit.profile.map((p) => p[1]);
  const { loops: [segments], untangled } = untangle([fitSegments(fit.profile, true, tol)]);
  const inner = Math.min(...r);
  return {
    kind: "revolve",
    outerDiameter: 2 * Math.max(...r),
    innerDiameter: fit.closed ? 2 * inner : 0,
    length: Math.max(...h) - Math.min(...h),
    sweepDeg: fit.sector ? (fit.sector.span * 180) / Math.PI : 360,
    segments,
    untangled,
    profileText: describeSegments(segments),
  };
}

/** 押し出しとして認識できたら寸法をまとめる。 */
function summarizePrism(fit) {
  const us = fit.outer.map((p) => p[0]), vs = fit.outer.map((p) => p[1]);
  const { loops: [outer, ...holes], untangled } = untangle([fit.segments.outer, ...fit.segments.holes]);
  const lines = outer.filter((s) => s.type === "line").length;
  const shape = outer.length === 1 && outer[0].type === "circle" ? `円 φ${(2 * outer[0].radius).toFixed(3)}`
    : lines === outer.length && lines === 4 ? "四角形" : lines === outer.length ? `${lines} 角形` : describeSegments(outer);
  return {
    kind: "prism",
    length: fit.h1 - fit.h0,
    width: Math.max(...us) - Math.min(...us),
    height: Math.max(...vs) - Math.min(...vs),
    shape,
    holes: holes.length,
    segments: { outer, holes },
    untangled,
    chamfers: fit.chamfers,
    profileText: describeSegments(outer) + (holes.length ? `／穴 ${holes.length}` : ""),
  };
}

/** 押し出しの候補から、断面の点が最も少なく（同数なら押し出し長が最も長い）ものを選ぶ。 */
function bestPrism(points, tris, origin, axes, tol) {
  let best = null, reasons = [];
  for (const dir of axes) {
    const fit = detectPrism(points, tris, origin, dir, tol);
    if (!fit.ok) { reasons.push(fit); continue; }
    const size = fit.outer.length + fit.holes.reduce((s, l) => s + l.length, 0);
    const score = [size, -(fit.h1 - fit.h0)];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { fit, score };
  }
  return { fit: best?.fit ?? null, reasons };
}

/** 閉じた殻 1 つを認識する（回転体 → 押し出し → 近似）。 */
function recognizeSolid(points, tris, origin, axes, tol) {
  const reasons = [];
  for (const o of [origin, centroid(points, tris)]) {
    for (const dir of axes) {
      const fit = detectRevolve(points, tris, o, dir, tol);
      if (fit.ok) return { fit, ...summarizeRevolve(fit, tol) };
      reasons.push(fit.reason);
    }
  }
  const prism = bestPrism(points, tris, origin, axes, tol);
  if (prism.fit) return { fit: prism.fit, ...summarizePrism(prism.fit) };
  return { kind: "mesh", reason: explain(prism.reasons, reasons) };
}

const VERIFY_TOL = 4; // 元の形との差の許容（長さの許容差の倍数）

/**
 * 安全網: 認識した寸法から作る形（変換データの形。寸法の丸めを含む）と元のメッシュが一致するかを、両方向で確かめる。
 *   元 → 作る形: 元の全ての頂点が、作る形の面の上にある（maxDeviation）
 *   作る形 → 元: 作る形の角に元の頂点があり、元の端面の縁が作る形の輪郭の上にある（reverseDeviation。作る形が広がっていないか）
 * 差が許容（許容差の 4 倍。面取りの角・取り除いた断面の重なりは、示した差を加える）を超えたら、正確な形とせず近似にする。
 * 断面が自分と交わる（元の形が重なっている）ものは、立体にできないので近似にし、理由を示す。
 * 認識の判定を通り抜けた誤り（丸めの誤り、判定の見落とし）を、作る前に止める。
 */
export function verify(part) {
  const checked = verifyExact(part);
  // 近似の部品（三角形のまま）: 元の形が自分と交わる所を数える（CAD の立体として正しくないので知らせる）
  if (checked.kind !== "mesh") return checked;
  const intersections = selfIntersections(checked.points, checked.tris, checked.tol);
  return intersections ? { ...checked, intersections } : checked;
}

function verifyExact(part) {
  if (part.kind !== "revolve" && part.kind !== "prism") return part;
  const loops = part.kind === "revolve" ? [part.segments] : [part.segments.outer, ...part.segments.holes];
  const crossings = selfCrossings(loops);
  if (crossings) {
    return { ...part, kind: "mesh", fit: null, feature: null, reason: `断面が自分と ${crossings} か所で交わる（元の形が重なっていて、立体にできない）` };
  }
  const corner = Math.max(0, ...(part.chamfers ?? []).map((c) => c.cornerDeviation));
  const allowed = VERIFY_TOL * part.tol + corner + (part.untangled?.deviation ?? 0); // 取り除いた重なりは、示した差まで許す
  let feature = null, deviation = Infinity;
  try {
    feature = featureOf(part);
    deviation = Math.max(maxDeviation(part, feature), reverseDeviation(part, feature, Math.max(allowed * 4, 1)));
  } catch {
    // 形を作れない（面取りの輪郭が作れないなど）→ 近似
  }
  if (deviation <= allowed) return { ...part, feature, deviation };
  const how = Number.isFinite(deviation) ? `最大 ${deviation.toFixed(3)} mm` : "形を作れない";
  return { ...part, kind: "mesh", fit: null, feature: null, reason: `認識した寸法で作る形が元の形と合わない（${how}）` };
}

/**
 * 認識できなかった理由。押し出しの判定で最も惜しかった軸（高さの段数が最少）の理由を優先し、
 * 無ければ回転体の判定で最も多く出た理由を使う。
 */
function explain(prismFailures, revolveReasons) {
  const closest = prismFailures.filter((f) => f.levels).sort((a, b) => a.levels - b.levels)[0];
  if (closest) return `回転体・押し出しのどちらにも当てはまらない（${closest.reason}）`;
  const count = new Map();
  for (const r of revolveReasons) count.set(r, (count.get(r) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0];
  return top ? `回転体・押し出しのどちらにも当てはまらない（${top[0]}）` : "形状を判定できない";
}

/** 全ての三角形が同じ平面の向きか（床・板・文字の面） */
function isFlat(points, tris) {
  let first = null;
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]].map((i) => pointAt(points, i));
    const n = unit(cross(sub(b, a), sub(c, a)));
    if (!first) first = n;
    else if (Math.abs(dot(n, first)) < 1 - 1e-6) return false;
  }
  return true;
}

const OPEN_REASON = {
  flat: "厚みのない面（床・板・文字・目印など）",
  open: "閉じていない面（縁が平らでない、または塞ぐと形の大半が推測になる）",
};

/**
 * フックが取り出したシーン全体を認識する。
 * @param {{ meshes: object[], revision?: string, excluded?: object }} snapshot
 * @param {{ unit?: number }} [options]  unit: シーンの 1 単位が何 mm か
 * @returns {{ revision, parts: object[], excluded: object, unit: number }}
 *   部品は sources（元のメッシュ・インスタンス・三角形の番号）を持つ。縫い合わせた部品は複数の元を持ち、
 *   塞いだ部品は tris の末尾 caps 枚が塞いだ三角形（元のメッシュに無い）
 */
export function recognizeSnapshot(snapshot, { unit = 1 } = {}) {
  const parts = [];
  const open = []; // 開いた殻（メッシュをまたいで縫い合わせる候補）
  const push = (part) => parts.push(verify({ id: parts.length, ...part }));
  snapshot.meshes.forEach((mesh, meshIndex) => {
    (mesh.instances ?? [mesh.matrix]).forEach((matrix, instance) => {
      const tol = tolerance(mesh.positions, matrix, unit, TOL);
      const { points, tris, source } = weldTriangles(transformPoints(mesh.positions, matrix, unit), mesh.index, tol);
      const origin = [matrix[12] * unit, matrix[13] * unit, matrix[14] * unit];
      // placement: 元のメッシュの位置と向き（mm）。近似の部品を、元のメッシュの座標系で変換データに書くのに使う
      const placement = { origin, axes: localAxes(matrix) };
      const context = { meshIndex, name: mesh.name, path: mesh.path, geometryType: mesh.geometryType, color: mesh.color, localAxes: placement.axes, placement, tol };
      for (const shell of buildShells(points, tris, tol)) {
        const sources = [{ mesh: meshIndex, instance, triangles: Int32Array.from(shell.source, (t) => source[t]) }];
        const base = { ...context, sources, caps: 0, repair: null, triangles: shell.tris.length / 3, bbox: bbox(points, shell.tris), points, tris: shell.tris };
        if (shell.closed) push({ ...base, ...recognizeSolid(points, shell.tris, origin, candidateAxes(matrix), tol) });
        else open.push({ base, origin, matrix, points, tris: shell.tris, tol, source: sources[0] });
      }
    });
  });

  // 開いた面: メッシュをまたいで縫い合わせ、平らな縁を塞ぎ、継ぎ目の刻みをそろえて立体にする。立体にならないものは除外
  const { solids, open: rest } = closeOpenShells(open);
  for (const solid of solids) {
    const first = open[Math.min(...solid.members.keys())];
    const sources = [...solid.members].map(([i, local]) => ({ ...open[i].source, triangles: Int32Array.from(local, (t) => open[i].source.triangles[t]) }));
    const repair = solid.caps ? "capped" : solid.seams ? "seamed" : "stitched";
    push({
      ...first.base, sources, caps: solid.caps, repair, triangles: solid.tris.length / 3, bbox: bbox(solid.points, solid.tris), points: solid.points, tris: solid.tris,
      ...recognizeSolid(solid.points, solid.tris, first.origin, candidateAxes(first.matrix), first.tol),
    });
  }
  for (const i of rest) {
    const { base, points, tris } = open[i];
    push({ ...base, kind: "open", reason: OPEN_REASON[isFlat(points, tris) ? "flat" : "open"], points, tris });
  }
  return { revision: snapshot.revision, parts, excluded: snapshot.excluded ?? {}, unit };
}

/** 1 つのメッシュ（フックが送るデータ）を認識する（評価・道具用）。 */
export const recognizeMesh = (mesh, options) => recognizeSnapshot({ meshes: [mesh] }, options).parts;
