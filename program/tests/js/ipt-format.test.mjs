// .ipt の読み取りの評価（ファイル構造・SAB の番号付け・位相・シーン）。
// 期待値は Inventor 上のモデル（E_Plate: 押し出し1 → 穴1 → フィレット1）と画面キャプチャ、ファイル名から読み取れる寸法。
// 形状の忠実度（閉じたソリッド・体積・ねじ・円錐）は ipt-fidelity.test.mjs が確かめる。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Topology, SLOTS } from "../../app/static/js/formats/ipt/brep.js";
import { openIpt } from "../../app/static/js/formats/ipt/container.js";
import { parseIpt, shapes } from "../../app/static/js/formats/ipt/index.js";
import { SAMPLE_NAME, readSample, sampleIpts } from "./helpers.mjs";

const TOL = 1e-6;
const near = (a, e, tol = TOL) => assert.ok(Math.abs(a - e) <= tol, `${a} ≠ ${e}`);
const nearVec = (a, e, tol = TOL) => a.forEach((v, i) => near(v, e[i], tol));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 参照スロット名 → 参照先の型として正しいか
const EXPECTED_TARGET = {
  next: (src, dst) => dst === src,
  prev: (src, dst) => dst === "coedge",
  partner: (src, dst) => dst === "coedge",
  lump: (src, dst) => dst === "lump",
  shell: (src, dst) => dst === "shell",
  face: (src, dst) => dst === "face",
  loop: (src, dst) => dst === "loop",
  coedge: (src, dst) => dst === "coedge",
  edge: (src, dst) => dst === "edge",
  start: (src, dst) => dst === "vertex",
  end: (src, dst) => dst === "vertex",
  point: (src, dst) => dst === "point",
  body: (src, dst) => dst === "body",
  surface: (src, dst) => dst.endsWith("-surface"),
  curve: (src, dst) => dst.endsWith("-curve"),
  attrib: (src, dst) => dst.endsWith("attrib"),
};

describe(`E_Plate（${SAMPLE_NAME}）`, () => {
  const { report, scene } = parseIpt(readSample(), SAMPLE_NAME);
  const solid = report.shapes.find((s) => s.segment === "PmBRepSegment").bodies[0];

  test("セグメントを全て展開し、サムネイル（512 × 512）を読む", () => {
    const names = new Set(report.segments.map((s) => s.name));
    for (const n of ["PmBRepSegment", "PmDCSegment", "PmGraphicsSegment", "PmBrowserSegment", "PmAppSegment"]) assert.ok(names.has(n), n);
    assert.ok(report.segments.every((s) => s.compressed));
    assert.deepEqual([report.thumbnail.width, report.thumbnail.height], [512, 512]);
  });

  test("ソリッドの位相と外形: 面 12・稜線 28・頂点 20、21 × 2 × 7.5", () => {
    assert.ok(solid.closed);
    assert.deepEqual([solid.faces, solid.edges, solid.vertices], [12, 28, 20]);
    assert.deepEqual(solid.surfaces, { plane: 6, cylinder: 6 });
    nearVec(solid.size, [21, 2, 7.5]);
  });

  test("穴 Φ4.5 × 2（貫通・ピッチ 13）と、種数（位相から求めた貫通穴の数）が一致する", () => {
    const holes = solid.cylinders.filter((c) => c.kind === "hole");
    assert.equal(holes.length, 2);
    for (const h of holes) {
      near(h.diameter, 4.5);
      near(h.length, 2);
      nearVec(h.axis, [0, 1, 0]);
    }
    nearVec(holes.map((h) => h.center[0]).sort((a, b) => a - b), [4, 17]);
    assert.equal(solid.genus, holes.length);
  });

  test("角 R3.5 × 4（各 90°）", () => {
    const rounds = solid.cylinders.filter((c) => c.kind === "round");
    assert.equal(rounds.length, 4);
    for (const r of rounds) {
      near(r.radius, 3.5);
      near(r.sweep_deg, 90);
    }
  });

  test("押し出しの断面（設計履歴のセグメント）: 開いた平面 1 枚、21 × 7.5", () => {
    const sheet = report.shapes.find((s) => s.segment === "PmDCSegment").bodies[0];
    assert.ok(!sheet.closed);
    assert.deepEqual(sheet.surfaces, { plane: 1 });
    nearVec(sheet.size, [21, 0, 7.5]);
  });

  test("SAB の参照は全て、スロットに合う型を指す（履歴セクションを除いた番号付けの網羅検証）", () => {
    let checked = 0;
    const unverified = [];
    for (const { doc } of shapes(openIpt(readSample()))) {
      for (const e of doc.entities) {
        (SLOTS[e.type] ?? []).forEach((slot, i) => {
          const target = doc.get(e.refs[i]);
          if (!target) return;
          if (!EXPECTED_TARGET[slot]) return unverified.push(`${e.index}:${e.type}.${slot}`);
          assert.ok(EXPECTED_TARGET[slot](e.type, target.type), `${e.index}:${e.type}.${slot} → ${target.type}`);
          checked += 1;
        });
      }
    }
    assert.ok(checked > 0);
    assert.deepEqual(unverified, []);
  });

  test("シーン: 全ての面を描け、平面の法線は外を向き、円筒の境界は曲面の上にある", () => {
    const body = scene.bodies[0];
    assert.equal(body.faces.length, 12);
    assert.deepEqual(new Set(body.faces.map((f) => f.type)), new Set(["plane", "cylinder"]));
    assert.equal(body.edges.length, 28);
    // このプレートの平面は全て外殻なので、法線は外接箱の中心から離れる向き
    const center = body.summary.bbox_min.map((lo, k) => (lo + body.summary.bbox_max[k]) / 2);
    for (const f of body.faces.filter((x) => x.type === "plane")) {
      const p = f.loops[0][0];
      assert.ok(f.normal.reduce((s, n, k) => s + n * (p[k] - center[k]), 0) > 0, `face ${f.id}`);
    }
    const cylinders = body.faces.filter((f) => f.type === "cylinder");
    const holes = cylinders.filter((f) => !f.outward), rounds = cylinders.filter((f) => f.outward);
    assert.deepEqual([holes.length, rounds.length], [2, 4]);
    for (const f of cylinders) {
      for (const p of f.loops.flat()) {
        const d = p.map((v, k) => v - f.origin[k]);
        const h = d.reduce((s, v, k) => s + v * f.axis[k], 0);
        near(dist(d, f.axis.map((a) => a * h)), f.radius, 1e-4);
      }
    }
    assert.deepEqual(new Set(holes.map((f) => f.loops.length)), new Set([2])); // 穴は軸を 1 周するループ 2 本
    assert.deepEqual(new Set(rounds.map((f) => f.loops.length)), new Set([1])); // 角 R は 1 本
  });
});

describe("samples/ipt の全ファイル", () => {
  const samples = sampleIpts();

  test("形状の単位は全て 1 = 10 mm（Inventor の内部単位 cm。ビルダーの mm → cm の換算の前提を、実物のファイルで確かめる）", () => {
    for (const name of samples) {
      const { report } = parseIpt(readSample(name), name);
      for (const s of report.shapes) assert.equal(s.mm_per_unit, 10, `${name} ${s.segment}`);
    }
  });

  test("稜線の点列は始点 → 終点の順で頂点に一致し、ループの中でコエッジが途切れず閉じる", () => {
    for (const name of samples) {
      for (const { doc } of shapes(openIpt(readSample(name)))) {
        const topo = new Topology(doc);
        for (const body of topo.bodies()) {
          for (const face of topo.faces(body)) {
            for (const loop of topo.loops(face)) {
              const runs = topo.chain(topo.ref(loop, "coedge")).map((coedge) => {
                const e = topo.ref(coedge, "edge");
                const { points } = topo.edge(e);
                assert.ok(dist(points[0], topo.vertexPoint(topo.ref(e, "start"))) < TOL, name);
                assert.ok(dist(points.at(-1), topo.vertexPoint(topo.ref(e, "end"))) < TOL, name);
                return coedge.bools[0] ? [...points].reverse() : points;
              });
              runs.forEach((run, i) => assert.ok(dist(run.at(-1), runs[(i + 1) % runs.length][0]) < TOL, `${name} face ${face.index}`));
            }
          }
        }
      }
    }
  });

  test("A1: 切り欠きで分かれた外周 Φ54.5 は、角 R ではなく 1 つの外径（2 面・半周超）として示す", () => {
    const name = samples.find((n) => n.startsWith("A1_"));
    const s = parseIpt(readSample(name), name).report.shapes.find((x) => x.segment === "PmBRepSegment").bodies[0];
    const outer = s.cylinders.filter((c) => c.diameter === 54.5);
    assert.deepEqual(outer.map((c) => [c.kind, c.face_ids.length]), [["boss", 2]]);
    near(outer[0].sweep_deg, 269.889083);
  });

  test("B: 両ネジの M6 は、1 つの穴の両端に 12 mm ずつ（ねじの呼び・等級・種類も読む）", () => {
    const name = samples.find((n) => n.startsWith("B_"));
    const s = parseIpt(readSample(name), name).report.shapes.find((x) => x.segment === "PmBRepSegment").bodies[0];
    const threads = s.cylinders.filter((c) => c.thread);
    assert.ok(threads.every((c) => c.thread.class === "6H" && c.thread.type === "ISO Metric profile"));
    assert.deepEqual(threads.filter((c) => c.thread.designation === "M6x1").map((c) => c.thread.lengths), [[12, 12], [12, 12]]);
  });
});
