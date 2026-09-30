// 三角形分割の評価。サンプル部品は寸法から表面積を厳密に計算できるので、面積で正しさを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { parseIpt } from "../../app/static/js/formats/ipt/index.js";
import { describeBody } from "../../app/static/js/viewer/describe.js";
import { faceGeometry } from "../../app/static/js/viewer/tessellate.js";
import { SAMPLE_NAME, readSample } from "./helpers.mjs";
import { bodyMesh, edgeDefects } from "./mesh-check.mjs";

const { scene } = parseIpt(readSample(), SAMPLE_NAME);
const body = scene.bodies[0];
// 21 × 7.5 × 2 mm、角 R3.5 × 4、穴 Φ4.5 × 2（貫通）
const [L, W, T, R, r] = [21, 7.5, 2, 3.5, 2.25];
const cap = L * W - 4 * (R * R - (Math.PI * R * R) / 4) - 2 * Math.PI * r * r;
const EXPECTED = {
  cap,
  hole: 2 * Math.PI * r * T,
  round: (Math.PI / 2) * R * T,
  total: 2 * cap + 2 * (L - 2 * R) * T + 2 * (W - 2 * R) * T + 4 * (Math.PI / 2) * R * T + 2 * 2 * Math.PI * r * T,
};
const REL_TOL = 0.005; // 円弧を折れ線で近似する分の誤差（0.5% 以内）

function measure(geometry) {
  const pos = geometry.getAttribute("position"), nor = geometry.getAttribute("normal"), idx = geometry.index.array;
  const [a, b, c, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let area = 0, misoriented = 0;
  for (let k = 0; k < idx.length; k += 3) {
    a.fromBufferAttribute(pos, idx[k]); b.fromBufferAttribute(pos, idx[k + 1]); c.fromBufferAttribute(pos, idx[k + 2]);
    const cr = b.sub(a).cross(c.sub(a));
    area += cr.length() / 2;
    if (cr.dot(n.fromBufferAttribute(nor, idx[k])) <= 0) misoriented += 1;
  }
  return { area, misoriented };
}

const faces = body.faces.map((f) => ({ face: f, ...measure(faceGeometry(f)) }));
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) / expected < REL_TOL, `${label}: ${actual.toFixed(4)} vs ${expected.toFixed(4)}`);

test("全ての面が三角形分割でき、三角形の向きが面の法線と揃っている", () => {
  assert.equal(faces.length, 12);
  for (const f of faces) assert.equal(f.misoriented, 0, `face ${f.face.id}`);
});

test("天面・底面の面積（外周から角 R と穴 2 つを除いたもの）", () => {
  const caps = faces.filter((f) => f.face.type === "plane" && Math.abs(f.face.normal[1]) === 1);
  assert.equal(caps.length, 2);
  for (const f of caps) near(f.area, EXPECTED.cap, `face ${f.face.id}`);
});

test("穴と角 R の側面積", () => {
  const { faceInfo } = describeBody(body, scene.labels);
  for (const f of faces.filter((x) => x.face.type === "cylinder")) {
    const kind = faceInfo.get(f.face.id).group.split(":")[0];
    near(f.area, EXPECTED[kind], `${kind} ${f.face.id}`);
  }
});

test("全表面積", () => {
  near(faces.reduce((s, f) => s + f.area, 0), EXPECTED.total, "total");
});

// ---- 形式によらない分割の性質（合成した面で確かめる）------------------------------------------
// 境界の点が抜けると隣の面との間に隙間ができ、面積 0 の三角形は細分が終わらなくなる。どちらも実際の STEP（ボルトの六角穴）で起きた。
// 以前の分割（earcut）は、一直線に並ぶ点を省いたり、数千点の細長い面を面全体にまたがる扇形に分けたりした（探索Part1 のローレット面）。
// 今の分割（制約付き Delaunay）でそれが起きないことを、六角穴の底と細長い帯で確かめる
const TAU = 2 * Math.PI;
const circle = (n, at) => Array.from({ length: n }, (_, i) => at((TAU * i) / n));
/** 1 つの面の分割の境界: 開いた辺（= 境界の区間）と、重なった辺の数 */
const boundaryOf = (face) => edgeDefects(bodyMesh([{ faces: [face] }]).triangles);

test("平面: 一直線に並ぶ境界の点も全て三角形に使う", () => {
  // 外周の下辺・上辺・左辺に途中の点、中央に穴
  const outer = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 3, 0], [1.5, 3, 0], [0, 3, 0], [0, 1.5, 0]];
  const hole = [[1, 1, 0], [1, 2, 0], [2, 2, 0], [2, 1, 0]];
  const face = { id: 1, type: "plane", normal: [0, 0, 1], loops: [outer, hole] };
  const g = faceGeometry(face);
  assert.equal(new Set(g.index.array).size, outer.length + hole.length);
  near(measure(g).area, 9 - 1, "area");
  assert.deepEqual(boundaryOf(face), { open: outer.length + hole.length, duplicated: 0 });
});

// 円錐 ρ(h) = 2 − h（先端は h = 2）。縁は h = 0 の半径 2 の円。側面積 = π・r・母線の長さ
const cone = (loops) => ({ id: 2, type: "cone", origin: [0, 0, 0], axis: [0, 0, 1], ref: [1, 0, 0], radius: 2, slope: -1, outward: true, loops });
const rim = circle(64, (t) => [2 * Math.cos(t), 2 * Math.sin(t), 0]);
const APEX = [0, 0, 2];

for (const [form, loops] of [
  ["縁の円だけ（.ipt の形）", [rim]],
  ["先端 → 継ぎ目の母線 → 縁 → 継ぎ目の母線 → 先端（STEP の形）", [[APEX, ...rim, rim[0]]]],
]) {
  test(`円錐の先端を含む面: ${form}`, () => {
    const face = cone(loops);
    const m = measure(faceGeometry(face));
    assert.equal(m.misoriented, 0);
    near(m.area, Math.PI * 2 * Math.hypot(2, 2), "側面積");
    assert.deepEqual(boundaryOf(face), { open: rim.length, duplicated: 0 }, "境界は縁だけ（先端のまわりに隙間・重なりがない）");
  });
}

test("六角穴の底（円錐と、軸に平行な 6 平面の交線が境界）: 境界の点を全て使い、細分が自然に終わる", () => {
  // 軸に平行な平面との交線は、軸に垂直な平面に写すと直線（一直線に並ぶ境界の点）になる
  const [radius, slope, apothem, per] = [0.866, 1.732, 1.5, 4];
  const corners = circle(6, (t) => [(apothem / Math.cos(Math.PI / 6)) * Math.cos(t + Math.PI / 6), (apothem / Math.cos(Math.PI / 6)) * Math.sin(t + Math.PI / 6)]);
  const loop = corners.flatMap((a, i) => {
    const b = corners[(i + 1) % 6];
    return Array.from({ length: per }, (_, k) => {
      const [x, y] = [a[0] + ((b[0] - a[0]) * k) / per, a[1] + ((b[1] - a[1]) * k) / per];
      return [x, y, (Math.hypot(x, y) - radius) / slope];
    });
  });
  const face = { id: 3, type: "cone", origin: [0, 0, 0], axis: [0, 0, 1], ref: [1, 0, 0], radius, slope, outward: false, loops: [loop] };
  const g = faceGeometry(face);
  assert.equal(measure(g).misoriented, 0);
  assert.ok(g.index.count / 3 < 2000, `${g.index.count / 3} triangles`);
  assert.deepEqual(boundaryOf(face), { open: loop.length, duplicated: 0 });
});

test("数千点が一直線に並ぶ細長い帯（ローレット面の展開図の形）: 境界の点を全て使い、帯の端から端へまたがる三角形を作らない", () => {
  const n = 4000;
  const bottom = Array.from({ length: n + 1 }, (_, i) => [(40 * i) / n, 0, 0]);
  const top = bottom.map(([x]) => [x, 0.05, 0]).reverse();
  const loop = [...bottom, ...top];
  const face = { id: 4, type: "plane", normal: [0, 0, 1], loops: [loop] };
  const g = faceGeometry(face);
  assert.equal(new Set(g.index.array).size, loop.length);
  near(measure(g).area, 40 * 0.05, "area");
  assert.deepEqual(boundaryOf(face), { open: loop.length, duplicated: 0 });
  const pos = g.getAttribute("position"), idx = g.index.array;
  let widest = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const xs = [0, 1, 2].map((e) => pos.getX(idx[k + e]));
    widest = Math.max(widest, Math.max(...xs) - Math.min(...xs));
  }
  assert.ok(widest <= 2 * (40 / n) + 1e-9, `三角形の幅 ${widest}（点の間隔 ${40 / n}）`);
});

// ---- 自由曲面（B スプライン）-----------------------------------------------------------------------
// 円筒を有理 2 次の B スプライン（1 周 9 個の制御点）で表すと、形が厳密に分かる。
// 境界は STEP と同じく「下の円 → 継ぎ目 → 上の円（逆向き）→ 継ぎ目」の 1 本のループ（継ぎ目の上の点は u = 0 と 1 の両方に当たる）
const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];
const HALF = Math.SQRT1_2;
function nurbsCylinder(radius, height, flip) {
  const points = RING.map(([x, y]) => [[radius * x, radius * y, 0], [radius * x, radius * y, height]]);
  const weights = RING.map((_, i) => (i % 2 ? [HALF, HALF] : [1, 1]));
  const bottom = circle(64, (t) => [radius * Math.cos(t), radius * Math.sin(t), 0]);
  const top = bottom.map(([x, y]) => [x, y, height]);
  const loop = [...bottom, bottom[0], top[0], ...top.slice(1).reverse(), top[0], bottom[0]];
  return {
    id: 5, type: "bspline", degree: [2, 1], flip, points, weights,
    knots: [[0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1], [0, 0, 1, 1]],
    loops: [loop],
  };
}

test("自由曲面: 有理 B スプラインの円筒を、円筒と同じ細かさで分割する（継ぎ目・重み・向き）", () => {
  const [radius, height] = [5, 8];
  for (const flip of [false, true]) {
    const face = nurbsCylinder(radius, height, flip);
    const g = faceGeometry(face);
    assert.ok(g, "分割できる");
    const m = measure(g);
    assert.equal(m.misoriented, 0);
    // 側面積 2πrh から、1 周 64 分割の折れ線で近似した分（(2π/64)² / 6 ≈ 0.16%）以内
    near(m.area, TAU * radius * height, "側面積");
    // 全ての点が曲面の上（半径 radius・高さ 0〜height）。三角形の中心の離れは、円弧の刻みの弦の垂れの 2.5 倍以内
    const pos = g.getAttribute("position"), nor = g.getAttribute("normal"), idx = g.index.array;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      assert.ok(Math.abs(Math.hypot(v.x, v.y) - radius) < 1e-6 && v.z > -1e-9 && v.z < height + 1e-9, `点 ${v.toArray()}`);
      // 法線は flip しなければ外向き（∂S/∂u × ∂S/∂v）、flip なら内向き
      n.fromBufferAttribute(nor, i);
      assert.ok((n.x * v.x + n.y * v.y) * (flip ? -1 : 1) > 0, "法線の向き");
    }
    const sag = radius * (1 - Math.cos(Math.PI / 64));
    for (let k = 0; k < idx.length; k += 3) {
      const c = [0, 1, 2].reduce((s, e) => s.add(v.fromBufferAttribute(pos, idx[k + e]).clone()), new THREE.Vector3()).divideScalar(3);
      assert.ok(radius - Math.hypot(c.x, c.y) <= 2.5 * sag, `三角形の中心が曲面から ${radius - Math.hypot(c.x, c.y)} 離れている`);
    }
    // 境界は下と上の円（継ぎ目は同じ位置の点どうしなので、溶接すると閉じる）
    assert.deepEqual(boundaryOf(face), { open: 128, duplicated: 0 });
  }
});
