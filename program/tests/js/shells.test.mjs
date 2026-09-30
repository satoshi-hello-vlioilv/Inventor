// 殻（convert/recognize/shells.js）と、開いた面から立体を作る処理の評価。
//   つながり: 1 つのジオメトリに重ねた形は別々の殻になる / 向き: 裏返しの形も外向きの閉じた立体になる / 厚みのない殻は立体にしない
//   縫い合わせ: 開いた円筒の壁とリングで作った筒 → 1 つの立体 / 塞ぐ: 管・端の開いた円筒は塞ぐ、表面に重ねた短く太い帯は塞がない
//   継ぎ目の刻み: 同じ線を面ごとに別の刻みで分けた形（曲線・直線、アルミコイル）→ 頂点をそろえて 1 つの立体。平行に並んだ別の縁は継がない
//   大きさ: 頂点が 5 万を超える閉じた殻、遠くの大きな床（粗い許容差）と近くの細かい形
//   自己交差: 近似の部品の元の形が自分と交わる所を数える / 断面の小さな蝶ネクタイ形の輪は取り除き、差を示す
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
import { transformPoints, weldTriangles } from "../../app/static/js/convert/recognize/mesh.js";
import { buildShells, closeOpenShells, conformSeams } from "../../app/static/js/convert/recognize/shells.js";
import { selfCrossings, untangleLoop } from "../../app/static/js/convert/recognize/geometry2d.js";
import { selfIntersections } from "../../app/static/js/convert/recognize/intersect.js";
import { describePart } from "../../app/static/js/html/describe.js";
import { coilGeometries, coilVolume } from "./coil.mjs";

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
  test("頂点が 5 万を超える閉じた球 → 閉じた殻（稜線の鍵が 2^31 を超えても判定できる）", () => {
    const { points, tris } = welded(new THREE.SphereGeometry(10, 256, 200));
    assert.ok(points.length / 3 > 50000);
    const [s] = buildShells(points, tris, TOL);
    assert.ok(s.closed);
    assert.ok(Math.abs(s.volume / ((4 / 3) * Math.PI * 1000) - 1) < 0.001, `体積 ${s.volume}`);
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

/** 三角形の符号付き体積（向きがそろっていれば、閉じた立体の体積） */
function volumeOf(points, tris) {
  let v = 0;
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]].map((i) => new THREE.Vector3(points[3 * i], points[3 * i + 1], points[3 * i + 2]));
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

describe("継ぎ目の刻みをそろえる（同じ線を面ごとに別の刻みで分けた形）", () => {
  test("壁は 48 分割・両端のリングは 64 分割の筒（曲線の継ぎ目）→ 頂点をそろえて 1 つの筒（回転体 φ100/φ60 × 200）", () => {
    const parts = recognizeSnapshot(scene(
      new THREE.CylinderGeometry(50, 50, 200, 48, 1, true), new THREE.CylinderGeometry(30, 30, 200, 48, 1, true),
      new THREE.RingGeometry(30, 50, 64).rotateX(-Math.PI / 2).translate(0, 100, 0), new THREE.RingGeometry(30, 50, 64).rotateX(Math.PI / 2).translate(0, -100, 0),
    )).parts;
    assert.equal(parts.length, 1);
    const [p] = parts;
    assert.equal(p.repair, "seamed");
    assert.equal(p.kind, "revolve", p.reason);
    assert.deepEqual([p.outerDiameter, p.innerDiameter, p.length].map((v) => +v.toFixed(3)), [100, 60, 200]);
    assert.match(describePart(p).note, /継ぎ目の刻み/);
  });
  test("面ごとに分割の数が違う 6 枚の板で作った箱（直線の継ぎ目）→ 1 つの押し出し 10 × 20 × 30", () => {
    const faces = [
      new THREE.PlaneGeometry(10, 20, 3, 5).translate(0, 0, 15), new THREE.PlaneGeometry(10, 20, 4, 2).rotateY(Math.PI).translate(0, 0, -15),
      new THREE.PlaneGeometry(30, 20, 7, 3).rotateY(Math.PI / 2).translate(5, 0, 0), new THREE.PlaneGeometry(30, 20, 2, 6).rotateY(-Math.PI / 2).translate(-5, 0, 0),
      new THREE.PlaneGeometry(10, 30, 5, 4).rotateX(-Math.PI / 2).translate(0, 10, 0), new THREE.PlaneGeometry(10, 30, 3, 9).rotateX(Math.PI / 2).translate(0, -10, 0),
    ];
    const [p, ...rest] = recognizeSnapshot(scene(...faces)).parts;
    assert.equal(rest.length, 0);
    assert.equal(p.repair, "seamed");
    assert.equal(p.kind, "prism", p.reason);
    assert.deepEqual([p.width, p.height, p.length].map((v) => +v.toFixed(3)).sort((a, b) => a - b), [10, 20, 30]);
  });
  test("平行に並んだ別の縁（同心の 2 枚の開いた円筒。頂点を半分ずらす）→ 継ぎ目にしない（曲がりの内側・たわみより遠い）", () => {
    const pieces = [new THREE.CylinderGeometry(50, 50, 100, 32, 1, true), new THREE.CylinderGeometry(49.5, 49.5, 100, 32, 1, true).rotateY(Math.PI / 32)]
      .map((g) => welded(g));
    const all = new Float64Array([...pieces[0].points, ...pieces[1].points]), base = pieces[0].points.length / 3;
    const items = [...Array.from({ length: pieces[0].tris.length / 3 }, (_, k) => [...pieces[0].tris.slice(3 * k, 3 * k + 3)]),
      ...Array.from({ length: pieces[1].tris.length / 3 }, (_, k) => [...pieces[1].tris.slice(3 * k, 3 * k + 3)].map((i) => i + base))]
      .map((tri) => ({ tri, piece: 0, local: 0 }));
    assert.equal(conformSeams(all, items, new Float64Array(all.length / 3).fill(TOL)).length, items.length, "三角形を分けない");
  });
  test("細い三角形（向かいの頂点が自分の縁のすぐ近く）→ 自分の頂点を自分の縁に入れない（三角形を潰さない）", () => {
    const points = new Float64Array([0, 0, 0, 10, 0, 0, 5, 0.0005, 0]); // 3 つ目の頂点は縁 0–1 から 0.0005（許容差の内）
    const items = [{ tri: [0, 1, 2], piece: 0, local: 0 }];
    assert.deepEqual(conformSeams(points, items, new Float64Array(3).fill(TOL)).map((it) => it.tri), [[0, 1, 2]]);
  });
  test("同心の 2 枚の開いた円筒だけ（厚み 0.5）→ これまでどおり平らな縁を塞いで筒に（継ぎ目で閉じない）", () => {
    const [p] = recognizeSnapshot(scene(new THREE.CylinderGeometry(50, 50, 200, 32, 1, true), new THREE.CylinderGeometry(49.5, 49.5, 200, 32, 1, true))).parts;
    assert.equal(p.repair, "capped");
    assert.equal(p.kind, "revolve", p.reason);
    assert.deepEqual([p.outerDiameter, p.innerDiameter].map((v) => +v.toFixed(3)), [100, 99]);
  });
  test("遠くの大きな床（座標が大きく許容差が粗い）があっても、近くの細かい筒の頂点をまとめない（許容差は元のメッシュごと）", () => {
    const small = [
      new THREE.CylinderGeometry(0.3, 0.3, 1, 48, 1, true), new THREE.CylinderGeometry(0.2, 0.2, 1, 48, 1, true),
      new THREE.RingGeometry(0.2, 0.3, 48).rotateX(-Math.PI / 2).translate(0, 0.5, 0), new THREE.RingGeometry(0.2, 0.3, 48).rotateX(Math.PI / 2).translate(0, -0.5, 0),
    ];
    const floor = new THREE.PlaneGeometry(1e5, 1e5).rotateX(-Math.PI / 2).translate(0, -0.5, 0); // 許容差 ≈ 0.05 mm > 筒の刻み 0.039 mm
    const parts = recognizeSnapshot(scene(...small, floor)).parts;
    const tube = parts.find((q) => q.kind !== "open");
    assert.equal(tube?.kind, "revolve", tube?.reason);
    assert.deepEqual([tube.outerDiameter, tube.innerDiameter, tube.length].map((v) => +v.toFixed(3)), [0.6, 0.4, 1]);
    assert.equal(parts.filter((q) => q.kind === "open").length, 1, "床だけ除外");
  });
  test("アルミコイル（HTML と同じ式・刻みは粗く）と床 → 9 つの面を 1 つの立体に。体積は設計の式と 0.2% 以内、三角形は外向き", () => {
    const floor = new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2).translate(0, -622, 0);
    const parts = recognizeSnapshot(scene(...coilGeometries({ NT: 96, NX: 16 }), floor)).parts;
    const [coil, ...others] = parts.filter((q) => q.kind !== "open");
    assert.equal(others.length, 0);
    assert.equal(parts.filter((q) => q.kind === "open").length, 1, "床だけ除外");
    assert.equal(coil.repair, "seamed");
    assert.equal(coil.sources.length, 9);
    const v = volumeOf(coil.points, coil.tris), expected = coilVolume();
    assert.ok(Math.abs(v / expected - 1) < 0.002, `体積 ${v} / 設計 ${expected}`);
  });
});

describe("元の形の自己交差（近似の部品で知らせる）", () => {
  const tube = (points, radius) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", 0), 96, radius, 16, false);
  test("急に曲がる管（曲がりの半径より太い）→ 交わる所を数え、説明に書く", () => {
    const [p] = recognizeSnapshot(scene(tube([[0, 0, 0], [100, 0, 0], [0, 10, 0]], 8))).parts;
    assert.equal(p.kind, "mesh");
    assert.ok(p.intersections > 0, `${p.intersections}`);
    assert.match(describePart(p).note, /元の形が自分と交わる所がある/);
  });
  test("同じ平面の上の重なり（丸い面取りの輪郭が折り返した端面）→ 数える。縁で接するだけ・離れているものは数えない", () => {
    const count = (...tris) => selfIntersections(new Float64Array(tris.flat(2)), tris.map((_, i) => [3 * i, 3 * i + 1, 3 * i + 2]).flat(), TOL);
    const base = [[0, 0, 5], [10, 0, 5], [0, 10, 5]];
    assert.equal(count(base, [[2, 2, 5], [12, 2, 5], [2, 12, 5]]), 1, "辺どうしが交わる");
    assert.equal(count(base, [[1, 1, 5], [3, 1, 5], [1, 3, 5]]), 1, "内側に含まれる");
    assert.equal(count(base, [[10, 0, 5], [0, 10, 5], [10, 10, 5]].map((p) => p.map((v, k) => (k < 2 ? v + 1e-4 : v)))), 0, "斜めの縁で接するだけ（許容差より浅い）");
    assert.equal(count(base, [[20, 0, 5], [30, 0, 5], [20, 10, 5]]), 0, "離れている");
    assert.equal(count(base, [[2, 2, 5.5], [12, 2, 5.5], [2, 12, 5.5]]), 0, "平行な別の平面");
  });
  test("ゆるく曲がる管（半径 100 の円弧に沿う太さ 5 の管）・箱 → 交わりなし", () => {
    const arc = Array.from({ length: 9 }, (_, i) => [100 * Math.cos((Math.PI * i) / 16), 100 * Math.sin((Math.PI * i) / 16), 0]);
    const [p] = recognizeSnapshot(scene(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc.map((q) => new THREE.Vector3(...q))), 96, 5, 16, false))).parts;
    assert.equal(p.intersections, undefined);
    const [box] = recognizeSnapshot(scene(new THREE.BoxGeometry(10, 20, 30))).parts;
    assert.equal(box.intersections, undefined);
  });
});

describe("断面の自己交差", () => {
  const line = (a, b) => ({ type: "line", a, b });
  const polygon = (...pts) => pts.map((p, i) => line(p, pts[(i + 1) % pts.length]));
  test("小さな蝶ネクタイ形の輪（2 本先の直線が交わる）→ 交点で継いで取り除き、元の形との差を返す", () => {
    // 四角形の下辺に、1 mm ほどの折れ（下辺 → 戻る → また進む）
    const loop = polygon([0, 0], [10, 0], [9, -0.5], [9.5, 0.5], [20, 0], [20, 10], [0, 10]);
    assert.equal(selfCrossings([loop]), 1);
    const { loop: clean, removed, deviation } = untangleLoop(loop);
    assert.equal(removed, 1);
    assert.equal(selfCrossings([clean]), 0);
    assert.ok(deviation > 0.4 && deviation < 1.2, `${deviation}`);
    assert.equal(clean.length, loop.length - 1, "交わる 2 本の間の 1 本を捨てる");
  });
  test("交わらない断面・穴のある断面 → 0", () => {
    assert.equal(selfCrossings([polygon([0, 0], [10, 0], [10, 10], [0, 10]), polygon([3, 3], [3, 6], [6, 6], [6, 3])]), 0);
    assert.equal(untangleLoop(polygon([0, 0], [10, 0], [10, 10], [0, 10])).removed, 0);
  });
});
