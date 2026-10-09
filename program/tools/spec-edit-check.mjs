// 変換データの寸法の直し（convert/dimensions.js）の評価（開発用）: 変換データの全ての部品の全ての寸法を ±割合 だけ変えてみて、
//   - 直せた寸法: その値になった・作れる形（checkPart）・閉じた三角形の体積と表面積が、厳密な期待値と合う（細かく分けて比べる）・
//     元の値に戻すと元の断面に戻る（取り消しと同じ）
//   - 直せなかった寸法: 理由（角度が保てない・形が崩れるなど）を数える
//   node program/tools/spec-edit-check.mjs [--ratio 0.1] [--steps 1024] [--out 直した変換データの置き場] 変換データ …
// --out を付けると、直した部品ごとの変換データを書き出す（Python のビルダーの確かめ `python -m ipt_build --check` に渡せる）
import fs from "node:fs";
import path from "node:path";
import { applyDimension, dimensionsOf } from "../app/static/js/convert/dimensions.js";
import { expectedProperties, formatSpec, readSpec } from "../app/static/js/convert/inventor.js";
import { solidMesh } from "../app/static/js/convert/preview.js";

/** 閉じた三角形の体積・表面積と、相手のいない辺の数 */
export function meshFacts({ positions, triangles }) {
  const at = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  const directed = new Set();
  let volume = 0, area = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const [a, b, c] = v.map(at);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = b.map((x, k) => x - a[k]), w = c.map((x, k) => x - a[k]);
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    for (let i = 0; i < 3; i++) directed.add(`${v[i]}>${v[(i + 1) % 3]}`);
  }
  const open = [...directed].filter((k) => { const [x, y] = k.split(">"); return !directed.has(`${y}>${x}`); }).length;
  return { volume, area, open };
}

const shapeOf = (part) => ({ kind: part.kind, loops: part.sketch?.loops, revolve: part.revolve, extrude: part.extrude, chamfers: part.chamfers });
const sameLoops = (a, b) => JSON.stringify(a.sketch?.loops ?? null, (k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v)) ===
  JSON.stringify(b.sketch?.loops ?? null, (k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v));

/**
 * 1 部品の全ての寸法を value × (1 ± ratio) にしてみる。steps … 三角形に分ける細かさ（1 周の分割）、tol … 体積・表面積の差の許容（比）
 * @returns {{ tried, done, refused: Map<理由, 数>, failures: string[], edited: object[] }}
 */
export function checkPart(part, { ratio = 0.1, steps = 1024, tol = 1e-4 } = {}) {
  const out = { tried: 0, done: 0, refused: new Map(), failures: [], edited: [] };
  for (const dim of dimensionsOf(part)) {
    for (const sign of [1, -1]) {
      const value = dim.value * (1 + sign * ratio);
      const label = `${part.key} ${dim.id}（${dim.label} ${+dim.value.toFixed(3)} → ${+value.toFixed(3)}）`;
      out.tried++;
      let next;
      try {
        next = applyDimension(part, dim.id, value).part;
      } catch (error) {
        const why = error.message.replace(/[\d.]+ mm/g, "… mm").replace(/[\d.]+°/g, "…°");
        out.refused.set(why, (out.refused.get(why) ?? 0) + 1);
        continue;
      }
      const got = dimensionsOf(next).find((d) => d.id === dim.id)?.value;
      if (!(Math.abs(got - value) <= 1e-6 * Math.max(1, value))) out.failures.push(`${label}: 値が ${got}`);
      const exact = expectedProperties(shapeOf(next));
      const facts = meshFacts(solidMesh(next, { steps }));
      if (facts.open) out.failures.push(`${label}: 三角形が閉じていない（${facts.open} 辺）`);
      const dv = Math.abs(facts.volume - exact.volume) / exact.volume, da = Math.abs(facts.area - exact.area) / exact.area;
      if (dv > tol || da > tol) out.failures.push(`${label}: 体積 ${dv.toExponential(1)}・表面積 ${da.toExponential(1)} の差`);
      if (Math.abs(next.expect.volume - exact.volume) > 1e-5 * exact.volume) out.failures.push(`${label}: 期待値の体積が作り直されていない`);
      if (next.mesh && meshFacts(next.mesh).open) out.failures.push(`${label}: STEP 用の三角形が閉じていない`);
      try {
        const back = applyDimension(next, dim.id, dim.value).part;
        if (!sameLoops(back, part) || JSON.stringify([back.extrude, back.revolve, back.chamfers]) !== JSON.stringify([part.extrude, part.revolve, part.chamfers])) {
          out.failures.push(`${label}: 元の値に戻しても元の形に戻らない`);
        }
      } catch (error) {
        out.failures.push(`${label}: 元の値に戻せない（${error.message}）`);
      }
      out.done++;
      out.edited.push({ dim: dim.id, value, part: next });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const take = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
  const ratio = Number(take("--ratio", "0.1")), steps = Number(take("--steps", "1024")), outDir = take("--out", null);
  let tried = 0, done = 0, failures = [];
  const refused = new Map();
  for (const file of args) {
    const spec = readSpec(fs.readFileSync(file, "utf8"));
    for (const part of spec.parts) {
      const r = checkPart(part, { ratio, steps, tol: steps >= 1024 ? 1e-4 : 2e-3 });
      tried += r.tried; done += r.done; failures.push(...r.failures.map((f) => `${path.basename(file)} ${f}`));
      for (const [why, n] of r.refused) refused.set(why, (refused.get(why) ?? 0) + n);
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const e of r.edited) {
          const name = `${path.basename(file, ".inventor.json")}_${part.key}_${e.dim.replace(".", "-")}_${e.value.toFixed(3)}.inventor.json`;
          fs.writeFileSync(path.join(outDir, name), formatSpec({ ...spec, parts: [e.part] }));
        }
      }
    }
  }
  console.log(`試した ${tried}・直せた ${done}・直せなかった ${tried - done}・誤り ${failures.length}`);
  for (const [why, n] of [...refused].sort((a, b) => b[1] - a[1])) console.log(`  直せない ${n}: ${why}`);
  for (const f of failures.slice(0, 30)) console.log(`  誤り: ${f}`);
  process.exitCode = failures.length ? 1 : 0;
}
