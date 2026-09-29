// ipt ビューアの忠実度の評価。samples/ipt の全ての .ipt について、次の 2 つを確かめる。
//   形状 … 面ごとに三角形分割した結果をつなぎ合わせると、ソリッドとして閉じた（隙間・はみ出し・重なりのない）曲面になり、
//          曲面の三角形は解析曲面の上にあり、体積が「端面の面積 × 厚さ」（角柱状の部品）や寸法から求めた厳密値と一致する
//   仕様 … ファイル名と Inventor のサムネイルから読み取れる寸法・ねじが、要約（パネルに出す値）に現れる
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { parseIpt } from "../src/ipt/index.js";
import { describeBody } from "../src/viewer/describe.js";
import { faceGeometry } from "../src/viewer/tessellate.js";
import { readSample, sampleIpts } from "./helpers.mjs";

const WELD = 1e4; // 頂点の同一視（0.1 µm 単位に丸める）
const SURFACE_TOL = 0.003; // 曲面からの離れ（半径比）。円弧を π/32 刻みの弦で近似する分（約 0.12%）に余裕を持たせる
// 体積の差（外接箱の体積に対する比）。円を π/32 刻みの弦で近似すると、円の面積は最大 (π/32)²/6 ≈ 0.16% 変わる。
// 円の面積の合計は外接箱の断面積を超えないので、差は外接箱の体積の 0.16% 以内に収まる
// （側面の内側は曲面上の点で細分するので、端面（弦の多角形）× 厚さとも、厳密値とも、この範囲で異なる）
const VOLUME_TOL = 0.002;

/** 面ごとの三角形分割を 1 つの三角形の集合にまとめる。 */
function bodyMesh(body) {
  const ids = new Map();
  const key = (v) => `${Math.round(v.x * WELD)},${Math.round(v.y * WELD)},${Math.round(v.z * WELD)}`;
  const vertexId = (v) => {
    const k = key(v);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const triangles = [];
  const missing = [];
  for (const face of body.faces) {
    const geometry = faceGeometry(face);
    if (!geometry) {
      missing.push(`${face.id}:${face.type}`);
      continue;
    }
    const pos = geometry.getAttribute("position"), idx = geometry.index.array;
    const corner = (k) => new THREE.Vector3().fromBufferAttribute(pos, idx[k]);
    for (let k = 0; k < idx.length; k += 3) {
      const p = [corner(k), corner(k + 1), corner(k + 2)];
      triangles.push({ face, p, v: p.map(vertexId) });
    }
  }
  return { triangles, missing };
}

/** 辺の使われ方。閉じた向き付け可能な曲面なら、全ての辺が逆向きの 2 枚の三角形に 1 回ずつ使われる。 */
function edgeDefects(triangles) {
  const directed = new Map();
  for (const { v } of triangles) {
    if (new Set(v).size < 3) continue; // 退化した三角形（円錐の頂点など）は辺を持たない
    for (let i = 0; i < 3; i++) {
      const k = `${v[i]}>${v[(i + 1) % 3]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let open = 0, duplicated = 0;
  for (const [k, n] of directed) {
    const [a, b] = k.split(">");
    if (n > 1) duplicated += 1;
    if (!directed.has(`${b}>${a}`)) open += 1;
  }
  return { open, duplicated };
}

const signedVolume = (triangles) => triangles.reduce((s, { p: [a, b, c] }) => s + a.dot(new THREE.Vector3().crossVectors(b, c)) / 6, 0);
const triangleArea = ([a, b, c]) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;

/** 回転面（円筒・円錐）の三角形の重心が、曲面からどれだけ離れているか（半径比の最大値）。 */
function surfaceDeviation(triangles) {
  let worst = 0;
  for (const { face, p } of triangles) {
    if (face.type !== "cylinder" && face.type !== "cone") continue;
    const c = p[0].clone().add(p[1]).add(p[2]).divideScalar(3).sub(new THREE.Vector3(...face.origin));
    const axis = new THREE.Vector3(...face.axis);
    const h = c.dot(axis);
    const rho = c.clone().addScaledVector(axis, -h).length();
    const expected = face.radius + (face.slope ?? 0) * h;
    worst = Math.max(worst, Math.abs(rho - expected) / Math.max(expected, face.radius, 1e-9));
  }
  return worst;
}

// ---- 仕様（ファイル名とサムネイルから読み取れること）----------------------------
// threads: ねじの呼び → か所数、holes: ねじのない穴の径 → 数、outer: 外径、thickness: 厚さ（Z）、cones: 円錐の頂角、
// volume: 寸法から求めた厳密な体積（mm³）
const SPEC = {
  A1: { threads: { "M4x0.7": 4, "M6x1": 2, "M8x1.25": 2 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  A2: { threads: { "M4x0.7": 4, "M6x1": 2, "M8x1.25": 4 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  A3: { threads: { "M4x0.7": 6, "M8x1.25": 2 }, holes: { 6.6: 2 }, outer: 54.5, cones: [118, 118] },
  B: { threads: { "M4x0.7": 4, "M6x1": 2 }, holes: {}, outer: 54.5, cones: [] },
  C1: { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 3, cones: [] },
  "C1-2": { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 2, cones: [] },
  "C1-3": { threads: {}, holes: { 6.6: 2 }, outer: 54.5, thickness: 1, cones: [] },
  C2: { threads: {}, holes: { 4.5: 2 }, outer: 54.5, thickness: 3, cones: [] },
  // Φ54.5 × 3、穴 Φ4.5 × 2、角窓 35 × 35（サムネイルの角窓。寸法は直線の稜線の頂点から読んだ値）
  D: { threads: {}, holes: { 4.5: 2 }, outer: 54.5, thickness: 3, cones: [], volume: 3 * (Math.PI * (27.25 ** 2 - 2 * 2.25 ** 2) - 35 * 35) },
  // 21 × 7.5 × 2、角 R3.5 × 4、穴 Φ4.5 × 2
  E: { threads: {}, holes: { 4.5: 2 }, cones: [], volume: 2 * (21 * 7.5 - 4 * (3.5 ** 2 - (Math.PI * 3.5 ** 2) / 4) - 2 * Math.PI * 2.25 ** 2) },
};
const tally = (items, keyOf) => items.reduce((m, x) => ({ ...m, [keyOf(x)]: (m[keyOf(x)] ?? 0) + 1 }), {});

for (const name of sampleIpts()) {
  describe(name, () => {
    const { scene } = parseIpt(readSample(name), name);
    const body = scene.bodies[0];
    const s = body.summary;
    const { triangles, missing } = bodyMesh(body);
    const envelope = s.size[0] * s.size[1] * s.size[2];
    const nearVolume = (actual, expected) => assert.ok(Math.abs(actual - expected) <= VOLUME_TOL * envelope, `${actual} vs ${expected}`);

    test("全ての面を三角形分割できる（稜線だけの面がない）", () => assert.deepEqual(missing, []));

    test("稜線は全て 2 点以上の折れ線で、閉じた稜線は円周をたどる", () => {
      const short = body.edges.filter((line) => new Set(line.map((p) => p.join())).size < 2);
      assert.equal(short.length, 0, `点の足りない稜線 ${short.length} 本`);
    });

    test("面をつなぐと閉じたソリッドになる（隙間・はみ出し・重なりがない）", () => {
      assert.ok(s.closed);
      assert.deepEqual(edgeDefects(triangles), { open: 0, duplicated: 0 });
    });

    test("体積が正（面の表裏が外向きに揃っている）", () => assert.ok(signedVolume(triangles) > 0));

    test("円筒・円錐の三角形は解析曲面の上にある", () => {
      const worst = surfaceDeviation(triangles);
      assert.ok(worst <= SURFACE_TOL, `最大の離れ ${(worst * 100).toFixed(3)}%`);
    });

    const spec = SPEC[name.split("_")[0]];
    if (!spec) return;

    if (spec.thickness !== undefined) {
      test(`角柱の体積 = 端面の面積 × 厚さ ${spec.thickness}`, () => {
        assert.ok(Math.abs(s.size[2] - spec.thickness) < 1e-6, `厚さ ${s.size[2]}`);
        const cap = triangles.filter(({ face }) => face.type === "plane" && face.normal[2] === 1).reduce((a, t) => a + triangleArea(t.p), 0);
        nearVolume(signedVolume(triangles), cap * spec.thickness);
      });
    }

    if (spec.volume !== undefined) {
      test(`体積が寸法から求めた厳密値 ${spec.volume.toFixed(3)} mm³ と一致する`, () => {
        nearVolume(signedVolume(triangles), spec.volume);
      });
    }

    test("ねじ（呼びと数）", () => {
      const threads = s.cylinders.filter((c) => c.thread);
      assert.deepEqual(tally(threads, (c) => c.thread.designation), spec.threads);
      for (const c of threads) {
        assert.equal(c.kind, "hole", "ねじは全てめねじ（穴）");
        assert.ok(c.thread.lengths.every((l) => l > 0 && l <= c.length + 1e-6), `ねじ長さ ${c.thread.lengths} ≤ 穴の長さ ${c.length}`);
      }
    });

    test("ねじのない穴（径と数）", () => {
      assert.deepEqual(tally(s.cylinders.filter((c) => c.kind === "hole" && !c.thread), (c) => c.diameter), spec.holes);
    });

    if (spec.outer) {
      test(`外径 Φ${spec.outer}（角R ではなく外径として示す）`, () => {
        const outer = s.cylinders.filter((c) => c.diameter === spec.outer);
        assert.ok(outer.length > 0 && outer.every((c) => c.kind === "boss"), JSON.stringify(outer.map((c) => c.kind)));
      });
    }

    test("円錐（頂角）", () => {
      assert.deepEqual(s.cones.map((c) => Math.round(c.angle_deg)), spec.cones);
    });

    test("全ての円筒・円錐の面に説明がある（カーソルを合わせると寸法が出る）", () => {
      const { faceInfo } = describeBody(body, scene.labels);
      const curved = body.faces.filter((f) => f.type === "cylinder" || f.type === "cone");
      assert.deepEqual(curved.filter((f) => !faceInfo.get(f.id)?.group).map((f) => f.id), []);
    });
  });
}
