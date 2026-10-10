// Inventor で直せる部品の計画（convert/parametric.js）の評価（開発用。試験 parametric.test.mjs と共用）。部品ごとに:
//   1. 完全拘束: 自由度が残らない（free = 0）
//   2. 食い違い無し: 今の値のまま拘束を解いても、形が動かない（拘束が今の形に合っている。Inventor で付けても形が変わらない）
//   3. 名前: パラメータの名前が Inventor で使える（英字で始まる英数字と _）・重ならない・Inventor の自動の名前（d0, d1 …）と紛れない
//   4. 直したとき: 名前つきの値（スケッチの寸法）を ±ratio 変えて拘束を解いた形を、アプリの寸法の欄の直し方（applyDimension）の形と比べる
//      （位置の違いは除く: 押し出しは平行移動、回転体は軸の向きの移動だけ）。解けない（拘束が矛盾する）値は数える
//   node program/tools/parametric-check.mjs [--ratio 0.1] 変換データ …
import fs from "node:fs";
import { applyDimension } from "../app/static/js/convert/dimensions.js";
import { parametricPlan, solveSketch } from "../app/static/js/convert/parametric.js";
import { readSpec } from "../app/static/js/convert/inventor.js";

const SAME = 1e-6; // mm: 同じ形とみなす差
const STILL = 1e-4; // mm: 今の値で解いて動いてよい幅（水平・垂直・平行とみなす向きの幅 1e-6 で、ほぼ水平な辺を水平にする分。ビルダーの外形の照合の許容 0.001 mm の 1/10）
const points = (loops) => loops.flat().flatMap((s) => (s.type === "circle" ? [s.center, [s.radius, 0]] : [s.a, s.b, ...(s.center ? [s.center] : [])]));

/** 2 つの断面の差（位置の違いを除いた、点の最大のずれ mm） */
export function shapeDifference(kind, a, b) {
  const P = points(a), Q = points(b);
  const shift = [0, 1].map((c) => (kind === "revolve" && c === 0 ? 0 : P.reduce((t, p, i) => t + p[c] - Q[i][c], 0) / P.length));
  return Math.max(...P.map((p, i) => Math.hypot(p[0] - Q[i][0] - shift[0], p[1] - Q[i][1] - shift[1])));
}

/**
 * 1 部品の計画を確かめる
 * @returns {{ plan, problems: string[], edits: { name, value, result: "same" | "differ" | "refused" | "unsolved", difference? }[] }}
 */
export function checkPlan(part, { ratio = 0.1 } = {}) {
  const plan = parametricPlan(part);
  const problems = [];
  if (!plan) return { plan, problems, edits: [] };
  if (plan.free !== 0) problems.push(`自由度が ${plan.free} 残る`);
  const still = solveSketch(part, plan);
  const moved = shapeDifference("extrude", part.sketch.loops, still.loops);
  if (still.residual > 1e-9 || moved > STILL) problems.push(`今の値で解くと形が動く（${moved.toExponential(1)} mm）`);
  const names = [...plan.params.map((p) => p.name), ...plan.dimensions.flatMap((d) => (d.name ? [d.name] : []))];
  for (const n of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n)) problems.push(`名前 ${n} は Inventor で使えない`);
    if (/^d\d+$/i.test(n)) problems.push(`名前 ${n} は Inventor の自動の名前と紛れる`);
  }
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) problems.push("名前が重なる");
  for (const d of plan.dimensions.filter((x) => x.expression)) {
    if (!plan.params.some((p) => p.name === d.expression.split(" ")[0])) problems.push(`寸法の式 ${d.expression} の名前が無い`);
  }

  const edits = [];
  for (const p of plan.params) {
    const dim = plan.dimensions.find((d) => d.expression?.split(" ")[0] === p.name);
    if (!dim || p.name.startsWith("P")) continue; // フィーチャの値（厚さ・角度・面取り）と穴の位置は、寸法の欄に無い
    const id = p.name.replace("_", ".");
    let value = null, expected = null;
    for (const k of [1 + ratio, 1 - ratio]) {
      try {
        expected = applyDimension(part, id, p.value * k).part;
        value = p.value * k;
        break;
      } catch { /* 寸法の欄で直せない値 */ }
    }
    if (value === null) { edits.push({ name: p.name, value: p.value, result: "refused" }); continue; }
    try {
      const solved = solveSketch(part, plan, { [p.name]: value });
      if (solved.residual > 1e-8) { edits.push({ name: p.name, value, result: "unsolved" }); continue; }
      const difference = shapeDifference(part.kind, expected.sketch.loops, solved.loops);
      edits.push({ name: p.name, value, result: difference <= SAME ? "same" : "differ", difference });
    } catch {
      edits.push({ name: p.name, value, result: "unsolved" });
    }
  }
  return { plan, problems, edits };
}

/** 変換データの全ての部品を確かめた集計 */
export function checkSpec(spec, options) {
  const out = { parts: 0, planned: 0, params: 0, dimensions: 0, driven: 0, problems: [], edits: { same: 0, differ: 0, refused: 0, unsolved: 0 }, details: [] };
  for (const part of spec.parts) {
    out.parts++;
    const { plan, problems, edits } = checkPlan(part, options);
    if (!plan) continue;
    out.planned++;
    out.params += plan.params.length;
    out.dimensions += plan.dimensions.filter((d) => !d.driven).length;
    out.driven += plan.dimensions.filter((d) => d.driven).length;
    out.problems.push(...problems.map((p) => `${part.key}: ${p}`));
    for (const e of edits) {
      out.edits[e.result]++;
      if (e.result !== "same") out.details.push(`${part.key} ${e.name} → ${+e.value.toFixed(3)}: ${e.result}${e.difference ? `（${e.difference.toFixed(3)} mm）` : ""}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const ratio = args[0] === "--ratio" ? Number(args.splice(0, 2)[1]) : 0.1;
  const total = { parts: 0, planned: 0, params: 0, dimensions: 0, driven: 0, problems: 0, same: 0, differ: 0, refused: 0, unsolved: 0 };
  for (const file of args) {
    const r = checkSpec(readSpec(fs.readFileSync(file, "utf8")), { ratio });
    console.log(`${file}: 部品 ${r.parts}（計画 ${r.planned}）・名前つきの値 ${r.params}・寸法 ${r.dimensions}（参照 ${r.driven}）・` +
      `直したとき 同じ ${r.edits.same}・違う ${r.edits.differ}・解けない ${r.edits.unsolved}・寸法の欄で直せない ${r.edits.refused}`);
    for (const line of [...r.problems, ...r.details]) console.log(`  ${line}`);
    for (const k of ["parts", "planned", "params", "dimensions", "driven"]) total[k] += r[k];
    total.problems += r.problems.length;
    for (const k of ["same", "differ", "refused", "unsolved"]) total[k] += r.edits[k];
  }
  console.log(`合計: 部品 ${total.parts}（計画 ${total.planned}）・名前つきの値 ${total.params}・寸法 ${total.dimensions}（参照 ${total.driven}）・問題 ${total.problems}・` +
    `直したとき 同じ ${total.same}・違う ${total.differ}・解けない ${total.unsolved}・寸法の欄で直せない ${total.refused}`);
  process.exitCode = total.problems || total.unsolved ? 1 : 0;
}
