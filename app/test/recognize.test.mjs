// 形状認識の評価。
// (1) 実際の HTML（samples/html）から取り出した形状が、各 HTML のソースに書かれた寸法どおりに認識されること
// (2) three.js 標準の形状クラスで作った部品も正しく認識されること（特定の HTML に依存しない一般性の確認）
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { recognizeMesh, recognizeSnapshot } from "../src/recognize/index.js";
import { readHtmlFixture } from "./helpers.mjs";

const near = (actual, expected, label, tol = 1e-3) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} ≠ ${expected}`);
const sorted = (a) => [...a].sort((x, y) => x - y);
const solids = (name) => recognizeSnapshot(readHtmlFixture(name)).parts.filter((p) => p.kind !== "open");
const count = (segments, type) => segments.filter((s) => s.type === type).length;

function expectRevolve(part, { od, id, length, lines, arcs = 0, sweep = 360 }) {
  assert.equal(part.kind, "revolve", part.reason);
  near(part.outerDiameter, od, "外径");
  near(part.innerDiameter, id, "内径");
  near(part.length, length, "長さ");
  near(part.sweepDeg, sweep, "回転角", 1e-2);
  if (lines !== undefined) assert.equal(count(part.segments, "line"), lines, "直線の数");
  assert.equal(count(part.segments, "arc"), arcs, "円弧の数");
}

describe("LS-4 部品 3D ビューア（three.js r180）", () => {
  test("スペーサー 標準形 T10: 回転体 φ240/φ200、C1 × 4", () => {
    const [p] = solids("LS4_parts_viewer.spacer-t10");
    expectRevolve(p, { od: 240, id: 200, length: 10, lines: 8 });
  });
  test("スペーサー 軽量形 T50: 逃がし溝の R2 を円弧として復元", () => {
    const [p] = solids("LS4_parts_viewer.spacer-t50");
    expectRevolve(p, { od: 240, id: 200, length: 50, lines: 12, arcs: 2 });
    for (const arc of p.segments.filter((s) => s.type === "arc")) near(arc.radius, 2, "溝の R");
  });
  test("ゴムリング（赤・幅 50）: 回転体 φ322/φ241", () => {
    const [p] = solids("LS4_parts_viewer.rubber");
    expectRevolve(p, { od: 322, id: 241, length: 50, lines: 4 });
  });
  test("ベークライトフィンガー: 八角形断面 560 × 20 を W10 押し出し", () => {
    const [p] = solids("LS4_parts_viewer.finger");
    assert.equal(p.kind, "prism", p.reason);
    assert.equal(p.shape, "8 角形");
    assert.deepEqual(sorted([p.width, p.height]).map((v) => +v.toFixed(3)), [20, 560]);
    near(p.length, 10, "押し出し長");
  });
  test("丸刃: 面取りで高さが 4 段になるため近似（メッシュ）。外形は φ240 × 厚み 5", () => {
    const [p] = solids("LS4_parts_viewer.blade");
    assert.equal(p.kind, "mesh");
    assert.match(p.reason, /4 段/);
    assert.deepEqual(sorted(p.bbox.size).map((v) => +v.toFixed(3)), [5, 240, 240]);
  });
});

describe("スプール／リール組立ビューア（three.js r160）", () => {
  test("鉄スプール W1400: 回転体 φ557/φ507。床と刻印は開いた面として除外", () => {
    const all = recognizeSnapshot(readHtmlFixture("spool_reel_assembly_v2.steel")).parts;
    assert.equal(all.filter((p) => p.kind === "open").length, 2);
    expectRevolve(all.find((p) => p.kind === "revolve"), { od: 557, id: 507, length: 1400, lines: 10 });
  });
  test("紙管 φ298 × 肉厚 10: 回転体 φ318/φ298、C1 × 4", () => {
    expectRevolve(solids("spool_reel_assembly_v2.paper")[0], { od: 318, id: 298, length: 1400, lines: 8 });
  });
  test("ゴムスリーブ: 回転体 φ587/φ480、長さ 1623", () => {
    expectRevolve(solids("spool_reel_assembly_v2.rubber")[0], { od: 587, id: 480, length: 1623, lines: 8 });
  });
  test("リール φ508: 459 部品を全て正確な形状として認識（近似 0）", () => {
    const parts = solids("spool_reel_assembly_v2.reel");
    assert.equal(parts.length, 459);
    assert.equal(parts.filter((p) => p.kind === "mesh").length, 0);
    const full = parts.filter((p) => p.kind === "revolve" && p.sweepDeg === 360);
    const sector = parts.filter((p) => p.kind === "revolve" && p.sweepDeg < 360);
    const hex = parts.filter((p) => p.kind === "prism" && p.shape === "6 角形");
    const box = parts.filter((p) => p.kind === "prism" && p.shape === "四角形");
    assert.deepEqual([full.length, sector.length, hex.length, box.length], [10, 48, 8, 393]);
    // 軸・段付き部の直径（ソースの THR_D・OB_D・ST_D・DRUM_OD・COL_D・SH_D・HUB_D）
    assert.deepEqual([...new Set(full.map((p) => +p.outerDiameter.toFixed(3)))].sort((a, b) => a - b), [56, 160, 220, 250, 350, 420]);
    // 扇形の角度: セグメント π/2−2·(15/254)、スパイダー・ウエッジ π/2−0.10、油溝 π/2−0.20
    const deg = (rad) => +((rad * 180) / Math.PI).toFixed(2);
    assert.deepEqual([...new Set(sector.map((p) => +p.sweepDeg.toFixed(2)))].sort(), [deg(Math.PI / 2 - 0.2), deg(Math.PI / 2 - 2 * (15 / 254)), deg(Math.PI / 2 - 0.1)].sort());
    for (const p of hex) near(p.width * p.height > 0 ? Math.max(p.width, p.height) : 0, 26, "ボルト頭の対角");
  });
  test("組立（リール＋ゴムスリーブ＋鉄スプール）: 近似 0、スリーブは拡径後の φ615/φ508", () => {
    const parts = solids("spool_reel_assembly_v2.assy");
    assert.equal(parts.filter((p) => p.kind === "mesh").length, 0);
    expectRevolve(parts.find((p) => p.kind === "revolve" && Math.abs(p.length - 1623) < 1e-3), { od: 615, id: 508, length: 1623, lines: 8 });
  });
});

describe("three.js 標準の形状クラス", () => {
  const recognize = (geometry, object = new THREE.Object3D()) => {
    object.updateMatrixWorld(true);
    return recognizeMesh({ positions: geometry.attributes.position.array, index: geometry.index?.array ?? null, matrix: object.matrixWorld.elements });
  };
  test("CylinderGeometry（回転・移動あり）→ 中実の回転体", () => {
    const o = new THREE.Object3D();
    o.position.set(10, -20, 30);
    o.rotation.set(0.3, 0.7, -0.2);
    const [p] = recognize(new THREE.CylinderGeometry(15, 15, 40, 48), o);
    expectRevolve(p, { od: 30, id: 0, length: 40 });
  });
  test("CylinderGeometry（分割 6）→ 六角柱の押し出し", () => {
    const [p] = recognize(new THREE.CylinderGeometry(13, 13, 24, 6));
    assert.equal(p.kind, "prism");
    assert.equal(p.shape, "6 角形");
  });
  test("BoxGeometry → 長方形の押し出し（最も長い辺の方向に押し出す）", () => {
    const [p] = recognize(new THREE.BoxGeometry(24, 12, 1740));
    assert.equal(p.kind, "prism");
    near(p.length, 1740, "押し出し長");
    assert.deepEqual(sorted([p.width, p.height]).map((v) => +v.toFixed(3)), [12, 24]);
  });
  test("LatheGeometry（段付き軸の断面）→ 回転体", () => {
    const profile = [[0, 0], [10, 0], [10, 20], [6, 20], [6, 50], [0, 50]].map(([x, y]) => new THREE.Vector2(x, y));
    const [p] = recognize(new THREE.LatheGeometry(profile, 64));
    expectRevolve(p, { od: 20, id: 0, length: 50 });
  });
  test("TorusGeometry → 断面が円の回転体", () => {
    const [p] = recognize(new THREE.TorusGeometry(50, 5, 32, 96));
    assert.equal(p.kind, "revolve");
    assert.equal(p.segments.length, 1);
    assert.equal(p.segments[0].type, "circle");
    near(p.segments[0].radius, 5, "断面の半径", 0.05);
    near(p.outerDiameter, 110, "外径", 0.1);
  });
  test("ExtrudeGeometry（穴 2 つ）→ 押し出し、穴は円として復元", () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(21, 0); s.lineTo(21, 7.5); s.lineTo(0, 7.5); s.lineTo(0, 0);
    for (const x of [4, 17]) { const h = new THREE.Path(); h.absarc(x, 3.75, 2.25, 0, Math.PI * 2, true); s.holes.push(h); }
    const [p] = recognize(new THREE.ExtrudeGeometry(s, { depth: 2, bevelEnabled: false, curveSegments: 48 }));
    assert.equal(p.kind, "prism", p.reason);
    near(p.length, 2, "押し出し長");
    assert.equal(p.holes, 2);
    for (const hole of p.segments.holes) {
      assert.equal(hole[0].type, "circle");
      near(hole[0].radius, 2.25, "穴の半径", 0.01);
    }
  });
});
