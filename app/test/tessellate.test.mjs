// 三角形分割の評価。サンプル部品は寸法から表面積を厳密に計算できるので、面積で正しさを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { parseIpt } from "../src/ipt/index.js";
import { describeBody } from "../src/viewer/describe.js";
import { faceGeometry } from "../src/viewer/tessellate.js";
import { SAMPLE_NAME, readSample } from "./helpers.mjs";

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
