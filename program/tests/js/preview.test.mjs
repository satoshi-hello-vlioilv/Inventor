// 変換データ（.inventor.json）の表示（convert/preview.js）の評価。
//   形: 閉じた外向きの立体で、体積が変換データの期待値（Inventor が作るはずの形）と一致する（面取りは描かないので除いて比べる）
//   置き方: 配置の数と位置、部品の説明
//   読み込み: 変換データではないもの・読めない版を、理由を添えて断る
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { expectedProperties, readSpec } from "../../app/static/js/convert/inventor.js";
import { describeSpec, partGeometry, previewScene } from "../../app/static/js/convert/preview.js";
import { ROOT } from "./helpers.mjs";

const FIXTURES = path.join(ROOT, "tests/fixtures/builder");
const fixtures = fs.readdirSync(FIXTURES).filter((n) => n.endsWith(".json")).sort();
const load = (name) => readSpec(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const WELD = 1e5;

/** 三角形の集合: 符号付き体積・辺の使われ方（閉じた向き付け可能な面なら、全ての辺が逆向きの 2 枚に 1 回ずつ）・法線の向き */
function inspect(geometry) {
  const pos = geometry.getAttribute("position"), nor = geometry.getAttribute("normal"), idx = geometry.index.array;
  const ids = new Map();
  const at = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const weld = (p) => {
    const k = p.map((v) => Math.round(v * WELD)).join(",");
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const directed = new Map();
  let volume = 0, against = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map(at);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = b.map((v, k) => v - a[k]), w = c.map((v, k) => v - a[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const vn = [nor.getX(idx[t]), nor.getY(idx[t]), nor.getZ(idx[t])]; // 頂点の法線（表示の陰影に使う）
    if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] <= 0) against += 1;
    const v = [a, b, c].map(weld);
    if (new Set(v).size < 3) continue;
    for (let i = 0; i < 3; i++) {
      const key = `${v[i]}>${v[(i + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0, duplicated = 0;
  for (const [key, n] of directed) {
    const [x, y] = key.split(">");
    if (n > 1) duplicated += 1;
    if (!directed.has(`${y}>${x}`)) open += 1;
  }
  return { volume, open, duplicated, against, triangles: idx.length / 3 };
}

/** Z の範囲（押し出しは ±長さ/2、回転は ±同じ値 = どちらも XY 平面に対して対称。ビルダーの「対称」と同じ） */
function zRange(geometry) {
  const pos = geometry.getAttribute("position");
  const zs = Array.from({ length: pos.count }, (_, i) => pos.getZ(i));
  return [Math.min(...zs), Math.max(...zs)];
}

/** 面取りを除いた期待値（表示は面取りを描かない） */
const expectedVolume = (part) => expectedProperties({ kind: part.kind, loops: part.sketch.loops, revolve: part.revolve, extrude: part.extrude }).volume;

describe("変換データの部品の形", () => {
  for (const name of fixtures) {
    test(`${name}: 全ての部品が閉じた外向きの立体で、体積が期待値と 0.5% 以内で一致`, () => {
      for (const part of load(name).parts) {
        const r = inspect(partGeometry(part));
        assert.deepEqual([r.open, r.duplicated], [0, 0], `${part.key}: 閉じていない（隙間・重なり）`);
        assert.equal(r.against, 0, `${part.key}: 法線と三角形の向きが逆のものがある`);
        const expect = expectedVolume(part);
        assert.ok(r.volume > 0, `${part.key}: 裏返っている（体積 ${r.volume}）`);
        assert.ok(Math.abs(r.volume - expect) / expect < 5e-3, `${part.key}: 体積 ${r.volume} / 期待値 ${expect}`);
        const [lo, hi] = zRange(partGeometry(part));
        const half = part.kind === "extrude" ? part.extrude.distance / 2 : hi;
        assert.ok(Math.abs(lo + half) < 1e-9 && Math.abs(hi - half) < 1e-9, `${part.key}: Z が ${lo}〜${hi}（XY 平面に対して対称のはず）`);
      }
    });
  }

  test("部分回転（XY 平面に対して対称）と、穴のある押し出しの両端", () => {
    const ring = [
      { type: "line", a: [10, -5], b: [20, -5] }, { type: "line", a: [20, -5], b: [20, 5] },
      { type: "line", a: [20, 5], b: [10, 5] }, { type: "line", a: [10, 5], b: [10, -5] },
    ];
    const sector = { kind: "revolve", sketch: { loops: [ring] }, revolve: { angle_deg: 90 } };
    const r = inspect(partGeometry(sector));
    assert.deepEqual([r.open, r.duplicated, r.against], [0, 0, 0]);
    assert.ok(Math.abs(r.volume - expectedVolume(sector)) / expectedVolume(sector) < 5e-3, `扇形 ${r.volume}`);
    const [lo, hi] = zRange(partGeometry(sector));
    assert.ok(Math.abs(lo + hi) < 1e-9, "XY 平面に対して対称（ビルダーの回転と同じ）");

    const plate = {
      kind: "extrude", extrude: { distance: 4 },
      sketch: { loops: [ring.map((s) => ({ ...s, a: [s.a[0] * 3 - 40, s.a[1] * 3], b: [s.b[0] * 3 - 40, s.b[1] * 3] })), [{ type: "circle", center: [5, 0], radius: 3 }]] },
    };
    const p = inspect(partGeometry(plate));
    assert.deepEqual([p.open, p.duplicated, p.against], [0, 0, 0]);
    assert.ok(Math.abs(p.volume - expectedVolume(plate)) / expectedVolume(plate) < 5e-3, `穴あきの板 ${p.volume}`);
  });
});

describe("置き方と説明", () => {
  test("配置ごとに 1 つ、変換データの原点と軸で置く（番号は説明と同じ）", () => {
    const spec = load("reel.inventor.json");
    const scene = previewScene(spec);
    const placed = spec.parts.reduce((n, p) => n + p.instances.length, 0);
    assert.equal(scene.parts.length, spec.parts.length);
    assert.equal(scene.instances.length, placed);
    const first = spec.parts[0].instances[0];
    const m = scene.instances[0].matrix;
    assert.deepEqual([m[3], m[7], m[11]], first.origin, "移動は行優先の 4 列目");
    assert.deepEqual([m[0], m[4], m[8]], first.x, "X 軸は 1 列目");
    const d = describeSpec(spec);
    assert.deepEqual(d.counts, { parts: 25, placed, skipped: spec.skipped.reduce((n, s) => n + s.count, 0) });
    assert.deepEqual(d.groups.flatMap((g) => g.ids), scene.instances.map((i) => i.id), "3D の配置の番号とパネルの行が対応する");
  });

  test("面取りは説明に書き、形に描いていないことを添える", () => {
    const [group] = describeSpec(load("blade.inventor.json")).groups;
    assert.equal(group.label, "押し出し");
    assert.match(group.sub, /面取り C1（穴の縁・両面）/);
    assert.match(group.note, /描いていません/);
    const [revolve] = describeSpec(load("spacer-t50.inventor.json")).groups;
    assert.match(revolve.main, /^φ\d+\.\d{3} × \d+\.\d{3}$/);
  });
});

describe("変換データの読み込み", () => {
  test("変換データではないもの・読めない版・単位を、理由を添えて断る", () => {
    const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, "finger.inventor.json"), "utf8"));
    for (const [text, reason] of [
      ["not json", /JSON として読めません/],
      [JSON.stringify({ ...base, format: "other" }), /変換データ（format: inventor-builder）ではありません/],
      [JSON.stringify({ ...base, version: 99 }), /version 99/],
      [JSON.stringify({ ...base, units: "inch" }), /mm のみ/],
    ]) assert.throws(() => readSpec(text), reason);
    assert.equal(readSpec(JSON.stringify(base)).parts.length, 1);
  });
});
