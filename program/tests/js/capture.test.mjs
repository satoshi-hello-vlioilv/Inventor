// 取り込み（html/hook.js・html/frame.js）と単位（convert/units.js）の評価。
//   フック: レンダラーを印（isWebGLRenderer。r128 には無い）ではなく働きで見分ける / インスタンス描画は置いた 1 か所ごとの行列を送る
//   単位: 平らな床を除いた大きさで推定する / 認識は mm で行い、単位を変えても同じ形として認識できる（許容差が座標の大きさに見合う）
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
import { tolerance } from "../../app/static/js/convert/recognize/mesh.js";
import { UNIT_PRESETS, formatSize, guessUnit, sceneExtent } from "../../app/static/js/convert/units.js";
import { sanitizeSnapshot } from "../../app/static/js/html/frame.js";
import { threeHook } from "../../app/static/js/html/hook.js";

/** ブラウザーの代わり: window（イベント）と親（postMessage の受け手）を用意してフックを動かす */
function runHook() {
  const sent = [];
  const saved = { window: globalThis.window, parent: globalThis.parent };
  globalThis.window = new EventTarget();
  globalThis.parent = { postMessage: (data) => sent.push(data) };
  threeHook();
  const devtools = globalThis.window.__THREE_DEVTOOLS__;
  const extract = () => {
    const event = new Event("message");
    Object.assign(event, { source: globalThis.parent, data: { type: "ipt:extract", id: 1 } });
    globalThis.window.dispatchEvent(event);
    return sent.find((m) => m.type === "ipt:scene");
  };
  const restore = () => Object.assign(globalThis, saved);
  return { sent, devtools, extract, restore };
}

describe("フック", () => {
  test("isWebGLRenderer の無いレンダラー（r128）も、描画の働き（render・getContext）で見分けて捕まえる", () => {
    const hook = runHook();
    try {
      const renderer = { render() {}, getContext() {}, getRenderTarget: () => null }; // r128 の WebGLRenderer と同じく印が無い
      hook.devtools.dispatchEvent(new CustomEvent("observe", { detail: renderer }));
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30)));
      renderer.render(scene, new THREE.PerspectiveCamera());
      assert.ok(hook.sent.some((m) => m.type === "ipt:ready"), "最初の描画を知らせる");
      const snap = hook.extract();
      assert.equal(snap.meshes.length, 1);
      assert.equal(snap.meshes[0].geometryType, "BoxGeometry");
    } finally {
      hook.restore();
    }
  });

  test("インスタンス描画（InstancedMesh）: 置いた 1 か所ごとのワールド行列を送り、認識では 1 か所ずつ部品にする", () => {
    const hook = runHook();
    try {
      const renderer = { render() {}, getContext() {} };
      hook.devtools.dispatchEvent(new CustomEvent("observe", { detail: renderer }));
      const scene = new THREE.Scene();
      const bolts = new THREE.InstancedMesh(new THREE.CylinderGeometry(4, 4, 30, 32), new THREE.MeshBasicMaterial(), 3);
      bolts.position.set(0, 100, 0);
      [0, 50, 100].forEach((x, i) => bolts.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0)));
      scene.add(bolts);
      renderer.render(scene, new THREE.PerspectiveCamera());
      const snap = sanitizeSnapshot(hook.extract());
      const [mesh] = snap.meshes;
      assert.equal(mesh.instances.length, 3);
      assert.deepEqual(mesh.instances.map((m) => [m[12], m[13], m[14]]), [[0, 100, 0], [50, 100, 0], [100, 100, 0]], "メッシュの位置 × インスタンスの位置");
      const parts = recognizeSnapshot(snap).parts;
      assert.equal(parts.length, 3);
      for (const p of parts) assert.deepEqual([p.kind, +p.outerDiameter.toFixed(3), +p.length.toFixed(3)], ["revolve", 8, 30]);
      assert.deepEqual(parts.map((p) => p.sources[0].instance), [0, 1, 2]);
    } finally {
      hook.restore();
    }
  });

  test("受け取ったデータの確かめ: インスタンスの行列が 16 個の数でなければ、そのメッシュを捨てる", () => {
    const mesh = { positions: new Float32Array(9), index: null, normals: null, matrix: new THREE.Matrix4().elements };
    assert.equal(sanitizeSnapshot({ meshes: [{ ...mesh, instances: [[1, 2, 3]] }] }).meshes.length, 0);
    assert.equal(sanitizeSnapshot({ meshes: [{ ...mesh, instances: [new THREE.Matrix4().elements] }] }).meshes.length, 1);
  });
});

/** ジオメトリを置いたシーン（取り出したデータと同じ形） */
const snapshotOf = (...items) => ({
  meshes: items.map(([g, object = new THREE.Object3D()]) => {
    object.updateMatrixWorld(true);
    return { positions: g.getAttribute("position").array, index: g.index?.array ?? null, matrix: object.matrixWorld.elements, name: "", path: [], geometryType: g.type };
  }),
});

describe("単位", () => {
  test("大きさは平らな床を除いて測る。50 未満なら m、以上なら mm と推定する", () => {
    const floor = new THREE.PlaneGeometry(1000, 1000);
    const small = snapshotOf([floor], [new THREE.BoxGeometry(20, 9, 20)]); // クレーン（m で作った 20 m の設備）
    assert.deepEqual(sceneExtent(small).map((v) => +v.toFixed(6)), [20, 9, 20]);
    assert.equal(guessUnit(sceneExtent(small)).key, "m");
    assert.equal(guessUnit(sceneExtent(snapshotOf([new THREE.BoxGeometry(240, 240, 5)]))).key, "mm"); // 丸刃（mm）
    assert.equal(guessUnit(null).key, "mm");
  });

  test("単位を変えると、同じ形を mm で認識する（1 = 1 m の円柱 → φ600 × 12960 mm）", () => {
    const pole = [new THREE.CylinderGeometry(0.3, 0.3, 12.96, 48)];
    const [m] = recognizeSnapshot(snapshotOf(pole), { unit: 1000 }).parts;
    assert.deepEqual([m.kind, +m.outerDiameter.toFixed(3), +m.length.toFixed(3)], ["revolve", 600, 12960]);
    const [raw] = recognizeSnapshot(snapshotOf(pole)).parts;
    assert.deepEqual([raw.kind, +raw.outerDiameter.toFixed(3), +raw.length.toFixed(3)], ["revolve", 0.6, 12.96], "1 = 1 mm のままなら小さな円柱");
  });

  test("許容差は座標の大きさに見合う: 最小 0.001 mm、float32 の丸め幅の 8 倍が大きければそれ", () => {
    const I = new THREE.Matrix4().elements;
    assert.equal(tolerance(new Float32Array([1, 2, 3]), I, 1, 1e-3), 1e-3);
    const far = tolerance(new Float32Array([20, 0, 0]), I, 1000, 1e-3); // 1 = 1 m、20 m 先の点
    assert.ok(Math.abs(far - 8 * 2 ** -23 * 20000) < 1e-12, `${far}`);
    const scaled = tolerance(new Float32Array([20, 0, 0]), new THREE.Matrix4().makeScale(2, 2, 2).elements, 1000, 1e-3);
    assert.ok(Math.abs(scaled - 2 * far) < 1e-12, "拡大した行列の分だけ大きくする");
  });

  test("大きさの表示: 3 つを同じ単位で。最大が 10 m 以上なら m、それ未満は mm", () => {
    assert.equal(formatSize([20000, 20650, 6000]), "20 × 20.65 × 6 m");
    assert.equal(formatSize([1500, 557, 4.5]), "1,500 × 557 × 4.5 mm");
    assert.deepEqual(UNIT_PRESETS.map((u) => u.mm), [1, 10, 1000, 25.4]);
  });
});
