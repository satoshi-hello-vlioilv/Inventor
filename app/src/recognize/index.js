// 形状認識の入口: 取り出したメッシュを部品ごとに「回転体」「押し出し」「メッシュ（近似）」「除外」に分類し、寸法をまとめる。
// 候補の軸は、部品自身の座標軸（手続き的に作られた形状はこれに沿うことが多い）→ ワールドの X・Y・Z の順に試す。

import { add, dot, mul, unit } from "../ipt/vec.js";
import { pointAt, prepare, transformPoints } from "./mesh.js";
import { detectPrism } from "./prism.js";
import { detectRevolve } from "./revolve.js";
import { describeSegments, fitSegments } from "./segments.js";

export const TOL = 1e-3; // mm。float32 の丸め誤差（約 1e-4 mm）より大きく、設計上の寸法差より十分小さい

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

/** 回転体として認識できたら寸法をまとめる。 */
function summarizeRevolve(fit) {
  const r = fit.profile.map((p) => p[0]), h = fit.profile.map((p) => p[1]);
  const segments = fitSegments(fit.profile, true, TOL);
  const inner = Math.min(...r);
  return {
    kind: "revolve",
    outerDiameter: 2 * Math.max(...r),
    innerDiameter: fit.closed ? 2 * inner : 0,
    length: Math.max(...h) - Math.min(...h),
    sweepDeg: fit.sector ? (fit.sector.span * 180) / Math.PI : 360,
    segments,
    profileText: describeSegments(segments),
  };
}

/** 押し出しとして認識できたら寸法をまとめる。 */
function summarizePrism(fit) {
  const us = fit.outer.map((p) => p[0]), vs = fit.outer.map((p) => p[1]);
  const outer = fitSegments(fit.outer, true, TOL);
  const holes = fit.holes.map((l) => fitSegments(l, true, TOL));
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
    profileText: describeSegments(outer) + (holes.length ? `／穴 ${holes.length}` : ""),
  };
}

/** 押し出しの候補から、断面の点が最も少なく（同数なら押し出し長が最も長い）ものを選ぶ。 */
function bestPrism(points, tris, origin, axes) {
  let best = null, reasons = [];
  for (const dir of axes) {
    const fit = detectPrism(points, tris, origin, dir, TOL);
    if (!fit.ok) { reasons.push(fit); continue; }
    const size = fit.outer.length + fit.holes.reduce((s, l) => s + l.length, 0);
    const score = [size, -(fit.h1 - fit.h0)];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { fit, score };
  }
  return { fit: best?.fit ?? null, reasons };
}

/**
 * 1 つのメッシュ（フックが送るデータ）を部品に分けて認識する。
 * @returns {object[]} 連結成分ごとの認識結果
 */
export function recognizeMesh(mesh) {
  const world = transformPoints(mesh.positions, mesh.matrix);
  const { points, components } = prepare(world, mesh.index, TOL);
  const origin = [mesh.matrix[12], mesh.matrix[13], mesh.matrix[14]];
  const axes = candidateAxes(mesh.matrix);
  return components.map((component, part) => {
    const base = {
      part,
      triangles: component.tris.length / 3,
      sourceTriangles: component.sourceTriangles,
      bbox: bbox(points, component.tris),
      localAxes: localAxes(mesh.matrix),
      points,
      tris: component.tris,
    };
    if (!component.closed) return { ...base, kind: "open", reason: "厚みのない開いた面（床・目印・半透明の表示用の面など）" };
    const reasons = [];
    for (const o of [origin, centroid(points, component.tris)]) {
      for (const dir of axes) {
        const fit = detectRevolve(points, component.tris, o, dir, TOL);
        if (fit.ok) return { ...base, fit, ...summarizeRevolve(fit) };
        reasons.push(fit.reason);
      }
    }
    const prism = bestPrism(points, component.tris, origin, axes);
    if (prism.fit) return { ...base, fit: prism.fit, ...summarizePrism(prism.fit) };
    return { ...base, kind: "mesh", reason: explain(prism.reasons, reasons) };
  });
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

/** フックが取り出したシーン全体を認識する。 */
export function recognizeSnapshot(snapshot) {
  const parts = [];
  snapshot.meshes.forEach((mesh, meshIndex) => {
    for (const result of recognizeMesh(mesh)) {
      parts.push({ id: parts.length, meshIndex, name: mesh.name, path: mesh.path, geometryType: mesh.geometryType, color: mesh.color, ...result });
    }
  });
  return { revision: snapshot.revision, parts, excluded: snapshot.excluded ?? {} };
}


