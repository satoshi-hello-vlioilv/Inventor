// 形状認識の評価。
// (1) 実際の HTML（samples/html）から取り出した形状が、各 HTML のソースに書かれた寸法どおりに認識されること
// (2) three.js 標準の形状クラスで作った部品も正しく認識されること（特定の HTML に依存しない一般性の確認）
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { recognizeMesh, recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
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
  test("丸刃 パターン B: 外径 φ240・内径 φ200＋キー溝 幅 20 × 深さ 6 を厚み 5 で押し出し、内径側の縁に C1（両面）", () => {
    const [p] = solids("LS4_parts_viewer.blade");
    assert.equal(p.kind, "prism", p.reason);
    assert.equal(p.shape, "円 φ240.000");
    near(p.length, 5, "厚み");
    const [hole] = p.segments.holes;
    near(hole.find((s) => s.type === "arc").radius, 100, "内径の半径");
    // キー溝: 最も長い直線が溝の底（中心から IN_R + depth = 106）。溝の側壁の点は底の向きに ±KEY_W/2
    const floor = hole.filter((s) => s.type === "line").sort((a, b) => Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]))[0];
    const along = [floor.b[0] - floor.a[0], floor.b[1] - floor.a[1]].map((v, _, d) => v / Math.hypot(...d));
    const normal = [-along[1], along[0]];
    near(Math.abs(floor.a[0] * normal[0] + floor.a[1] * normal[1]), 106, "溝の底までの距離");
    const key = hole.flatMap((s) => [s.a, s.b]).filter(([x, y]) => Math.abs(x * normal[0] + y * normal[1]) > 100.5);
    near(Math.max(...key.map(([x, y]) => Math.abs(x * along[0] + y * along[1]))), 10, "溝幅の半分");
    // 面取り: 穴の縁だけ、両面とも C1（外周の刃先は面取りなし）
    assert.deepEqual(p.chamfers.map((c) => [c.loop, c.side]).sort(), [[1, -1], [1, 1]]);
    for (const c of p.chamfers) near(c.distance, 1, "面取り");
    // 元の HTML は面取りの外側の輪郭を「同じ角度で再サンプリング」して作るため、キー溝の角付近だけ CAD の留め継ぎと差が出る
    for (const c of p.chamfers) assert.ok(c.cornerDeviation > 1e-3 && c.cornerDeviation < 0.2, `角の差 ${c.cornerDeviation}`);
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
  describe("ExtrudeGeometry の面取り（bevel）", () => {
    // 40 × 20 の板に φ10 の穴。three.js の bevel は輪郭を bevelSize だけ外へ広げた側壁と、元の輪郭の端面をつなぐ。
    // 穴は重複点のない 96 角形で作る（absarc の全周は始点と終点が 2e-15 ずれて重複点が残り、bevel がその点を外へ
    // 飛ばしてメッシュに細いトゲができる。その場合は正しく「側面の形が分岐している」として近似になる）
    const plate = (options) => {
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(40, 0); s.lineTo(40, 20); s.lineTo(0, 20); s.lineTo(0, 0);
      const ring = Array.from({ length: 96 }, (_, i) => new THREE.Vector2(20 + 5 * Math.cos((-2 * Math.PI * i) / 96), 10 + 5 * Math.sin((-2 * Math.PI * i) / 96)));
      s.holes.push(new THREE.Path(ring));
      return recognize(new THREE.ExtrudeGeometry(s, { depth: 10, bevelEnabled: true, curveSegments: 48, ...options }))[0];
    };
    test("直線の面取り（bevelSegments 1・幅と深さが同じ）→ 押し出し＋外周と穴の縁に C1（両面）", () => {
      const p = plate({ bevelSegments: 1, bevelSize: 1, bevelThickness: 1 });
      assert.equal(p.kind, "prism", p.reason);
      assert.deepEqual(sorted([p.width, p.height]).map((v) => +v.toFixed(3)), [22, 42]);
      near(p.length, 12, "押し出し長（厚み 10 ＋ 面取り 1 × 2）");
      near(p.segments.holes[0][0].radius, 4, "穴の半径（側壁は輪郭を 1 広げた位置）", 0.01);
      assert.deepEqual(p.chamfers.map((c) => [c.loop, c.side]).sort(), [[0, -1], [0, 1], [1, -1], [1, 1]]);
      for (const c of p.chamfers) {
        near(c.distance, 1, "面取り");
        assert.ok(c.cornerDeviation <= 1e-3, `角の差 ${c.cornerDeviation}（three.js の bevel は留め継ぎ）`);
      }
    });
    test("幅と深さが違う面取り → 未対応として近似（理由を示す）", () => {
      const p = plate({ bevelSegments: 1, bevelSize: 1, bevelThickness: 2 });
      assert.equal(p.kind, "mesh");
      assert.match(p.reason, /不等辺の面取り/);
    });
    test("丸い面取り（bevelSegments 3）→ 等距離の面取りではないので近似", () => {
      const p = plate({ bevelSegments: 3, bevelSize: 1, bevelThickness: 1 });
      assert.equal(p.kind, "mesh");
    });
  });
});

// 利用者が追加した設備の HTML。単位は HTML ごとに違うので、ソースの定数から決めた単位で認識する
const partsOf = (name, unit) => recognizeSnapshot(readHtmlFixture(name), { unit }).parts;
const byKind = (parts) => parts.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {});

describe("2 号機（three.js r160、32 単位 = 1500 mm）", () => {
  const parts = partsOf("2号機.mill", 1500 / 32);
  test("コイル: 開いた円筒の外壁・内壁と両端のリング（4 メッシュ）を縫い合わせ、φ1500/φ508 × 1400 と φ560/φ508 × 1400", () => {
    const coils = parts.filter((p) => p.repair === "stitched");
    assert.equal(coils.length, 2);
    for (const c of coils) assert.equal(c.sources.length, 4);
    const [large, small] = coils.sort((a, b) => b.outerDiameter - a.outerDiameter);
    expectRevolve(large, { od: 1500, id: 508, length: 1400, lines: 4 }); // REAL_MAX_DIA・REAL_CORE_ID・REAL_WIDTH
    expectRevolve(small, { od: 560, id: 508, length: 1400, lines: 4 }); // REAL_MIN_DIA
  });
  test("ロール: ワーク φ550・バックアップ φ1350・ガイド φ200（ソースの定数）。除外は床だけ", () => {
    const diameters = new Set(parts.filter((p) => p.kind === "revolve").map((p) => +p.outerDiameter.toFixed(3)));
    for (const d of [550, 1350, 200]) assert.ok(diameters.has(d), `φ${d}`);
    assert.deepEqual(parts.filter((p) => p.kind === "open").map((p) => p.geometryType), ["PlaneGeometry"]);
    assert.equal(byKind(parts).mesh, undefined, "近似なし");
  });
  test("単位を変えても（1 = 1 mm のまま）同じ形として認識する（φ32 のコイル）", () => {
    const raw = partsOf("2号機.mill", 1);
    assert.deepEqual(byKind(raw), byKind(parts));
    assert.ok(raw.some((p) => p.repair === "stitched" && Math.abs(p.outerDiameter - 32) < 1e-3));
  });
});

describe("クレーン外観（three.js r160、1 単位 = 1 m）", () => {
  const parts = partsOf("クレーン外観R10.crane", 1000);
  test("巻上げ胴 φ1200 × 2500・モーター φ800 × 1200・車輪 φ600 × 200 × 4、桁は 20 m の押し出し", () => {
    expectRevolve(parts.find((p) => p.kind === "revolve" && Math.abs(p.outerDiameter - 1200) < 1e-3), { od: 1200, id: 0, length: 2500, lines: 4 });
    expectRevolve(parts.find((p) => p.kind === "revolve" && Math.abs(p.outerDiameter - 800) < 1e-3), { od: 800, id: 0, length: 1200, lines: 4 });
    assert.equal(parts.filter((p) => p.kind === "revolve" && Math.abs(p.outerDiameter - 600) < 1e-3 && Math.abs(p.length - 200) < 1e-3).length, 4);
    assert.equal(parts.filter((p) => p.kind === "prism" && Math.abs(p.length - 20000) < 1e-3).length, 2);
  });
  test("フックの管（TubeGeometry）は両端を塞いで立体に（近似）。除外は床だけ", () => {
    const hook = parts.find((p) => p.geometryType === "TubeGeometry");
    assert.equal(hook.repair, "capped");
    assert.equal(hook.kind, "mesh");
    assert.deepEqual(parts.filter((p) => p.kind === "open").map((p) => p.geometryType), ["PlaneGeometry"]);
  });
});

describe("メッセンジャーワイヤー（three.js r160、1 単位 = 1 m）", () => {
  test("電線の管 12 本は両端を塞いで立体に。柱 φ600 × 12960・端の球 φ700", () => {
    const parts = partsOf("メッセンジャーワイヤー方式.wire", 1000);
    const tubes = parts.filter((p) => p.geometryType === "TubeGeometry");
    assert.equal(tubes.length, 12);
    for (const t of tubes) assert.equal(t.repair, "capped");
    assert.equal(parts.filter((p) => p.kind === "revolve" && Math.abs(p.outerDiameter - 600) < 1e-3 && Math.abs(p.length - 12960) < 1e-3).length, 2);
    expectRevolve(parts.find((p) => p.geometryType === "SphereGeometry"), { od: 700, id: 0, length: 700, lines: 1, arcs: 1 });
  });
});

describe("タイヤ（three.js r128）", () => {
  test("r128 でも取り込める。トレッドの六角タイル 584 個は同じ押し出し、タイヤ本体は回転体 2 つ", () => {
    const parts = partsOf("タイヤシミュレータR2.tire", 100);
    const hex = parts.filter((p) => p.kind === "prism" && p.shape === "6 角形");
    assert.equal(hex.length, 584);
    assert.equal(new Set(hex.map((p) => [p.width, p.height, p.length].map((v) => v.toFixed(3)).join())).size, 1);
    assert.equal(parts.filter((p) => p.kind === "revolve").length, 2);
  });
});
