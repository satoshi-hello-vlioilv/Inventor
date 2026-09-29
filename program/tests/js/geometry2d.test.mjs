// 断面の幾何量の評価: 材料側へのずらし（面取り後の輪郭）と、面取りで削られる体積・面積を、手計算の式と照合する。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chamferIntegrals, insideSection, loopIntegrals, offsetIntoMaterial, reverseLoop } from "../../app/static/js/convert/recognize/geometry2d.js";

const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} ≠ ${b}（差 ${a - b}）`);
const area = (loop) => Math.abs(loopIntegrals(loop).area);
const polygon = (pts) => pts.map((a, i) => ({ type: "line", a, b: pts[(i + 1) % pts.length] }));
const SQRT2 = Math.SQRT2;

/** 数値積分（シンプソン則、区切り点で分けて細かく）: 式から求めた「削られる面積」を独立に積分する。 */
function simpson(f, cuts, steps = 2000) {
  let total = 0;
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]], h = (b - a) / steps;
    let s = f(a) + f(b);
    for (let i = 1; i < steps; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
    total += (s * h) / 3;
  }
  return total;
}

// 角を c だけ 45° に切り落とした正方形 [0, a]²（右上の角）
const cutSquare = (a, c) => polygon([[0, 0], [a, 0], [a, a - c], [a - c, a], [0, a]]);

// 角 R の長方形 w × h（直線と接する円弧の並び）
function roundedRect(w, h, r) {
  const arc = (a, b, center) => ({ type: "arc", a, b, center, ccw: true });
  return [
    { type: "line", a: [r, 0], b: [w - r, 0] }, arc([w - r, 0], [w, r], [w - r, r]),
    { type: "line", a: [w, r], b: [w, h - r] }, arc([w, h - r], [w - r, h], [w - r, h - r]),
    { type: "line", a: [w - r, h], b: [r, h] }, arc([r, h], [0, h - r], [r, h - r]),
    { type: "line", a: [0, h - r], b: [0, r] }, arc([0, r], [r, 0], [r, r]),
  ];
}

describe("材料側へずらした輪郭の面積（留め継ぎ）", () => {
  const cases = [
    ["正方形の外周を内側へ", polygon([[0, 0], [10, 0], [10, 10], [0, 10]]), false, (s) => (10 - 2 * s) ** 2],
    ["正方形の穴を外側へ（角は尖ったまま広がる）", polygon([[0, 0], [10, 0], [10, 10], [0, 10]]), true, (s) => (10 + 2 * s) ** 2],
    ["円の外周", [{ type: "circle", center: [3, 4], radius: 7 }], false, (s) => Math.PI * (7 - s) ** 2],
    ["円の穴", [{ type: "circle", center: [3, 4], radius: 7 }], true, (s) => Math.PI * (7 + s) ** 2],
    ["角 R2 の長方形（R がずらし量より大きい間は R − s の円弧）", roundedRect(20, 12, 2), false,
      (s) => (20 - 2 * s) * (12 - 2 * s) - (4 - Math.PI) * Math.max(2 - s, 0) ** 2],
    ["角を切り落とした正方形の外周（切り口は s = c/(2−√2) で消える）", cutSquare(10, 0.5), false,
      (s) => (10 - 2 * s) ** 2 - Math.max(0.5 - (2 - SQRT2) * s, 0) ** 2 / 2],
    ["角を切り落とした正方形の穴（切り口は広がる）", cutSquare(10, 0.5), true,
      (s) => (10 + 2 * s) ** 2 - (0.5 + (2 - SQRT2) * s) ** 2 / 2],
  ];
  for (const [label, loop, isHole, expected] of cases) {
    test(label, () => {
      for (const s of [0, 0.1, 0.4, 1, 2.5, 3]) {
        for (const l of [loop, reverseLoop(loop)]) {
          const shifted = offsetIntoMaterial(l, s, isHole);
          assert.ok(shifted, `s = ${s}`);
          near(area(shifted.loop), expected(s), 1e-9 * expected(0), `s = ${s}`);
        }
      }
    });
  }

  test("消える部分の距離（事象）を返す", () => {
    const { events, loop } = offsetIntoMaterial(cutSquare(10, 0.5), 1, false);
    assert.equal(events.length, 1);
    near(events[0], 0.5 / (2 - SQRT2), 1e-12, "切り口が消える距離");
    assert.equal(loop.length, 4);
    const rounded = offsetIntoMaterial(roundedRect(20, 12, 2), 3, false);
    assert.deepEqual(rounded.events.map((e) => +e.toFixed(9)), [2, 2, 2, 2]);
    assert.ok(rounded.loop.every((s) => s.type === "line"));
  });

  test("継ぎ目は隣の部分と一致し、ループは閉じたまま", () => {
    for (const [, loop, isHole] of cases) {
      const { loop: out } = offsetIntoMaterial(loop, 0.7, isHole);
      if (out.length === 1) continue;
      out.forEach((s, i) => assert.deepEqual(out[(i + 1) % out.length].a, s.b));
    }
  });
});

describe("面取りで削られる体積と端面の面積", () => {
  test("円の穴 R・C d: 体積 π(R d² + d³/3)、端面 π((R+d)² − R²)", () => {
    const [R, d] = [100, 1];
    const c = chamferIntegrals([{ type: "circle", center: [0, 0], radius: R }], d, true);
    near(c.volume, Math.PI * (R * d * d + d ** 3 / 3), 1e-9, "体積");
    near(c.face, Math.PI * ((R + d) ** 2 - R * R), 1e-9, "端面");
  });
  test("円の外周 R・C d: 体積 π(R d² − d³/3)", () => {
    const c = chamferIntegrals([{ type: "circle", center: [5, 5], radius: 120 }], 1.5, false);
    near(c.volume, Math.PI * (120 * 1.5 ** 2 - 1.5 ** 3 / 3), 1e-9, "体積");
  });
  test("部分が途中で消える場合も、式を数値積分した値と一致する", () => {
    const shapes = [
      [cutSquare(10, 0.5), false, (s) => 100 - 0.125 - ((10 - 2 * s) ** 2 - Math.max(0.5 - (2 - SQRT2) * s, 0) ** 2 / 2), [0, 0.5 / (2 - SQRT2), 1]],
      [roundedRect(20, 12, 0.5), false, (s) => 240 - (4 - Math.PI) * 0.25 - ((20 - 2 * s) * (12 - 2 * s) - (4 - Math.PI) * Math.max(0.5 - s, 0) ** 2), [0, 0.5, 1]],
    ];
    for (const [loop, isHole, removed, cuts] of shapes) {
      const c = chamferIntegrals(loop, 1, isHole);
      near(c.volume, simpson(removed, cuts), 1e-9, "体積");
      near(c.face, removed(1), 1e-9, "端面");
    }
  });
});

describe("断面の内外判定", () => {
  const section = [[{ type: "circle", center: [0, 0], radius: 120 }], reverseLoop(roundedRect(20, 12, 2).map((s) => ({
    ...s, a: [s.a[0] - 10, s.a[1] - 6], b: [s.b[0] - 10, s.b[1] - 6], ...(s.center && { center: [s.center[0] - 10, s.center[1] - 6] }),
  })))];
  test("外周の内側かつ穴の外側だけが断面", () => {
    assert.equal(insideSection([50, 0], section), true);
    assert.equal(insideSection([0, 0], section), false); // 穴の中
    assert.equal(insideSection([9.9, 5.9], section), true); // 穴の角 R の外（材料側）
    assert.equal(insideSection([9.0, 5.0], section), false); // 穴の角 R の内
    assert.equal(insideSection([130, 0], section), false);
  });
});
