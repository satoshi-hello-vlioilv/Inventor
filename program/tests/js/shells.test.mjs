// 殻（convert/recognize/shells.js）と、開いた面から立体を作る処理の評価。
//   つながり: 1 つのジオメトリに重ねた形は別々の殻になる / 向き: 裏返しの形も外向きの閉じた立体になる / 厚みのない殻は立体にしない
//   縫い合わせ: 開いた円筒の壁とリングで作った筒 → 1 つの立体 / 塞ぐ: 管・端の開いた円筒は塞ぐ、表面に重ねた短く太い帯は塞がない
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
import { transformPoints, weldTriangles } from "../../app/static/js/convert/recognize/mesh.js";
import { buildShells, closeOpenShells } from "../../app/static/js/convert/recognize/shells.js";

const TOL = 1e-3;
const I = new THREE.Matrix4().elements;
/** ジオメトリ → 統合した頂点と三角形 */
const welded = (g) => weldTriangles(transformPoints(g.getAttribute("position").array, I), g.index?.array ?? null, TOL);
/** 複数のジオメトリを 1 つにまとめる（頂点は共有しない。重ねて描いたのと同じ） */
function merged(...geometries) {
  const pos = [], idx = [];
  for (const g of geometries) {
    const base = pos.length / 3;
    pos.push(...g.getAttribute("position").array);
    const index = g.index?.array ?? Array.from({ length: g.getAttribute("position").count }, (_, i) => i);
    for (const i of index) idx.push(base + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}
/** 三角形の向きを全て裏返す */
function inverted(g) {
  const out = g.clone();
  const idx = out.index.array;
  for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  return out;
}
/** ジオメトリをそれぞれ別のメッシュとして取り出したシーン */
const scene = (...geometries) => ({
  meshes: geometries.map((g) => ({ positions: g.getAttribute("position").array, index: g.index?.array ?? null, matrix: I, name: "", path: [], geometryType: g.type })),
});

describe("殻に分ける", () => {
  test("稜線で接する 2 つの箱（1 つのジオメトリ）→ 2 つの閉じた殻", () => {
    const a = new THREE.BoxGeometry(10, 10, 10).translate(5, 5, 5), b = new THREE.BoxGeometry(10, 10, 10).translate(15, 15, 5);
    const { points, tris } = welded(merged(a, b));
    const shells = buildShells(points, tris, TOL);
    assert.equal(shells.length, 2);
    for (const s of shells) {
      assert.ok(s.closed);
      assert.ok(Math.abs(s.volume - 1000) < 1e-6, `体積 ${s.volume}`);
    }
  });
  test("裏返しに作った箱 → 外向きにそろえた閉じた殻（体積が正）", () => {
    const { points, tris } = welded(inverted(new THREE.BoxGeometry(10, 20, 30)));
    const [s] = buildShells(points, tris, TOL);
    assert.ok(s.closed);
    assert.ok(Math.abs(s.volume - 6000) < 1e-6, `体積 ${s.volume}`);
  });
  test("一部の三角形だけ裏返った球 → 向きをそろえて閉じた殻", () => {
    const g = new THREE.SphereGeometry(10, 24, 12);
    const idx = g.index.array;
    for (let k = 0; k < idx.length; k += 6) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]]; // 1 枚おきに裏返す
    const { points, tris } = welded(g);
    const [s] = buildShells(points, tris, TOL);
    assert.ok(s.closed);
    assert.ok(s.volume > 0.95 * (4 / 3) * Math.PI * 1000, `体積 ${s.volume}`); // 24 × 12 分割の多面体は球より 3% 小さい
  });
  test("表と裏の 2 枚の平面（厚み 0）→ 閉じていても立体にしない", () => {
    const plane = new THREE.PlaneGeometry(100, 100);
    const { points, tris } = welded(merged(plane, inverted(plane)));
    const shells = buildShells(points, tris, TOL);
    assert.ok(shells.every((s) => !s.closed));
  });
});

describe("開いた面から立体を作る", () => {
  const pipe = () => [
    new THREE.CylinderGeometry(50, 50, 200, 48, 1, true), // 外壁（端が開いた円筒）
    new THREE.CylinderGeometry(30, 30, 200, 48, 1, true), // 内壁（外向きの法線のまま = 筒としては裏返し）
    new THREE.RingGeometry(30, 50, 48).rotateX(-Math.PI / 2).translate(0, 100, 0), // 上端
    new THREE.RingGeometry(30, 50, 48).rotateX(Math.PI / 2).translate(0, -100, 0), // 下端
  ];

  test("開いた円筒の外壁・内壁と両端のリング（別々のメッシュ）→ 縫い合わせて 1 つの筒（回転体 φ100/φ60 × 200）", () => {
    const parts = recognizeSnapshot(scene(...pipe())).parts;
    assert.equal(parts.length, 1);
    const [p] = parts;
    assert.equal(p.kind, "revolve", p.reason);
    assert.equal(p.repair, "stitched");
    assert.equal(p.sources.length, 4, "4 つのメッシュから作った");
    assert.deepEqual([p.outerDiameter, p.innerDiameter, p.length].map((v) => +v.toFixed(3)), [100, 60, 200]);
  });
  test("端の開いた管（TubeGeometry）→ 両端を塞いで立体に", () => {
    const path = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 50, 0), new THREE.Vector3(200, 0, 30)]);
    const [p] = recognizeSnapshot(scene(new THREE.TubeGeometry(path, 64, 5, 16, false))).parts;
    assert.notEqual(p.kind, "open");
    assert.equal(p.repair, "capped");
    assert.equal(p.caps > 0, true);
  });
  test("長い端の開いた円筒だけ → 塞いで中実の円柱に（表示では中が見えない形）", () => {
    const [p] = recognizeSnapshot(scene(new THREE.CylinderGeometry(10, 10, 100, 48, 1, true))).parts;
    assert.equal(p.kind, "revolve", p.reason);
    assert.equal(p.repair, "capped");
    assert.equal(p.innerDiameter, 0);
  });
  test("短く太い帯（表面に重ねた刻印など）→ 塞ぐ面積が元の面より大きいので塞がない", () => {
    const [p] = recognizeSnapshot(scene(new THREE.CylinderGeometry(270, 270, 9, 96, 1, true))).parts;
    assert.equal(p.kind, "open");
    assert.match(p.reason, /塞ぐと形の大半が推測になる/);
  });
  test("床（平面）→ 厚みのない面として除外", () => {
    const [p] = recognizeSnapshot(scene(new THREE.PlaneGeometry(1000, 1000))).parts;
    assert.equal(p.kind, "open");
    assert.match(p.reason, /厚みのない面/);
  });
  test("縫い合わせの記録: 4 つの開いた殻がどれも 1 つの立体の元になり、立体にならなかったものは無い", () => {
    const pieces = pipe().map((g) => ({ ...welded(g), tol: TOL }));
    const { solids, open } = closeOpenShells(pieces);
    assert.equal(solids.length, 1);
    assert.deepEqual([...solids[0].members.keys()].sort(), [0, 1, 2, 3]);
    assert.deepEqual(open, []);
  });
});
