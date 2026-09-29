// 組立（.iam）と STEP の評価。
//   STEP … 読み取り（書式・単位・構造）、全ての部品が閉じたソリッドとして描けること、同じ部品の .ipt の解析結果と一致すること、
//          ボルトの軸が組み付け先の穴の軸と一致すること（配置の変換が正しいことを、形から独立に確かめる）
//   .iam … 参照・出現・配置が、同じ組立を書き出した STEP と一致すること。参照先の部品を samples/ipt から解決できること
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIamScene, parseIam } from "../../app/static/js/formats/iam/index.js";
import { parseIpt } from "../../app/static/js/formats/ipt/index.js";
import { decodeString, parseStep } from "../../app/static/js/formats/step/p21.js";
import { parseStepFile } from "../../app/static/js/formats/step/index.js";
import { describeAssembly } from "../../app/static/js/viewer/describe.js";
import { partGeometry } from "../../app/static/js/viewer/tessellate.js";
import { readSample, readSampleFile, sampleIams, sampleIpts, sampleSteps } from "./helpers.mjs";
import { bodyMesh, DEVIATION_LIMIT, edgeDefects, FACE_TRIANGLE_LIMIT, signedVolume, surfaceDeviation } from "./mesh-check.mjs";

const MATRIX_TOL = 1e-9; // mm。.iam（cm の倍精度）と STEP（mm の 15 桁）の配置の差
const AXIS_TOL = 1e-6; // mm。ボルトと穴の軸のずれ
const VOLUME_TOL = 0.002; // 同じ形を別の形式から分割したときの体積の差（外接箱の体積に対する比）

const stem = (file) => file.replace(/\.[^.]+$/, "");
const tally = (items) => items.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
const sameArray = (a, b, tol = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const withoutThread = ({ thread, face_ids, ...c }) => c; // STEP には、ねじ（Inventor の属性）と面の番号が無い

describe("STEP の書式（ISO 10303-21）", () => {
  test("文字列の制御記号を復号する（UTF-16・引用符・行の折り返し）", () => {
    assert.equal(decodeString("\\X2\\92FC30018EDF92FC\\X0\\"), "鋼、軟鋼");
    assert.equal(decodeString("it''s"), "it's");
    assert.equal(decodeString("\\X2\\03A6\\X0\\5\n4.5"), "Φ54.5");
    assert.equal(decodeString("\\X\\E9"), "é");
  });
  test("複合エンティティ・型付きの値・参照・列挙・省略を読む", () => {
    const step = parseStep(`ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP214'));\nENDSEC;\nDATA;\n#1=(A(1.,'x')B(#2,.T.,$,*));\n#2=M('n',LENGTH_MEASURE(2.5E0),(1,2));\nENDSEC;\nEND-ISO-10303-21;`);
    assert.deepEqual(step.get(1).parts, [{ type: "A", args: [1, "x"] }, { type: "B", args: [{ ref: 2 }, { enum: "T" }, null, undefined] }]);
    assert.deepEqual(step.get(2).args, ["n", { type: "LENGTH_MEASURE", args: [2.5] }, [1, 2]]);
    assert.equal(step.header.schema, "AP214");
  });
});

for (const name of sampleSteps()) {
  describe(name, () => {
    const { scene } = parseStepFile(new TextDecoder().decode(readSampleFile("stp", name)), name);
    const partName = (inst) => scene.parts[inst.part].name;

    test("組立の構造: 部品 10 種類・39 か所（部品表の個数）", () => {
      assert.equal(scene.root, "Assembly_全体_Φ54.5");
      assert.equal(scene.parts.length, 10);
      assert.deepEqual(tally(scene.instances.map(partName)), {
        "A3_円筒_両切欠き＋片ネジ_Φ54.5_M4あり": 1, "A1_円筒_両切欠き＋片ネジ_Φ54.5": 2, "A2_円筒_両切欠き＋両ネジ_Φ54.5_側面穴2つ": 1,
        "F_円筒_片切欠き＋両ネジ_100㎜_Φ54.5_M4あり": 1, "C2_円板_切欠きあり＋スリットあり＋ネジなし_Φ54.5_M4ボルト穴": 1,
        "C1_円板_切欠きあり＋スリットあり＋ネジなし_Φ54.5": 4, "D_円板_切欠きなし＋スリットなし＋ネジなし_Φ54.5_M4ボルト穴": 1,
        "E_Plate_改_Φ54.5": 8, "JIS B 1176 - M4 x 8 - 0.7": 18, "JIS B 1176 - M4 x 40 - 0.7": 2,
      });
    });

    test("ボルトの軸と頭は全周の円筒（STEP が頂点で分けて持つ円弧も、同じ円なら足して数える）", () => {
      for (const p of scene.parts.filter((x) => x.name.startsWith("JIS B 1176"))) {
        const cyl = p.bodies[0].summary.cylinders;
        assert.deepEqual(cyl.map((c) => [c.diameter, c.sweep_deg]).sort((a, b) => a[0] - b[0]), [[4, 360], [7, 360]], p.name);
      }
    });

    test("描く稜線は面と面の境界だけ（同じ面が 2 回使う継ぎ目は描かない）", () => {
      const key = (a, b) => [a, b].map((q) => q.map((v) => v.toFixed(4)).join(",")).sort().join("|");
      for (const p of scene.parts) {
        const facesOf = new Map(); // 境界の区間 → それを使う面
        for (const f of p.bodies[0].faces) {
          for (const loop of f.loops) {
            loop.slice(1).forEach((q, i) => {
              const k = key(loop[i], q);
              if (!facesOf.has(k)) facesOf.set(k, new Set());
              facesOf.get(k).add(f.id);
            });
          }
        }
        const seams = p.bodies[0].edges.filter((line) => facesOf.get(key(line[0], line[1]))?.size !== 2);
        assert.equal(seams.length, 0, `${p.name}: 境界でない稜線 ${seams.length} 本`);
      }
    });

    test("材質と密度（単位つきで g/cm³ → g/mm³）", () => {
      for (const p of scene.parts) {
        assert.equal(p.material, "鋼、軟鋼", p.name);
        assert.ok(Math.abs(p.density_g_per_mm3 - 0.00785) < 1e-12, `${p.name}: ${p.density_g_per_mm3}`);
      }
    });

    for (const part of scene.parts) {
      test(`${part.name}: 閉じたソリッドとして描ける（全ての面・表裏・曲面の上・細分が自然に終わる）`, () => {
        const s = part.bodies[0].summary;
        assert.ok(s.closed);
        const { triangles, missing, largest } = bodyMesh(part.bodies);
        assert.deepEqual(missing, []);
        assert.ok(largest <= FACE_TRIANGLE_LIMIT, `1 面の三角形 ${largest}`);
        assert.deepEqual(edgeDefects(triangles), { open: 0, duplicated: 0 });
        assert.ok(signedVolume(triangles) > 0);
        const worst = surfaceDeviation(triangles);
        assert.ok(worst <= DEVIATION_LIMIT, `設計上の弦の誤差の ${worst.toFixed(2)} 倍`);
      });
    }

    test("同じ部品の .ipt と、外形・座標の範囲・円筒・円錐・面の数・種数・材質・体積が一致する", () => {
      let compared = 0;
      for (const part of scene.parts) {
        const file = sampleIpts().find((n) => stem(n) === part.name);
        if (!file) continue;
        const ipt = parseIpt(readSample(file), file);
        const a = ipt.scene.bodies[0].summary, b = part.bodies[0].summary;
        for (const key of ["size", "bbox_min", "bbox_max"]) assert.ok(sameArray(a[key], b[key]), `${part.name} ${key}: ${a[key]} / ${b[key]}`);
        assert.deepEqual(b.cylinders.map(withoutThread), a.cylinders.map(withoutThread), `${part.name} 円筒`);
        assert.deepEqual(b.cones.map(withoutThread), a.cones.map(withoutThread), `${part.name} 円錐`);
        assert.equal(b.faces, a.faces, `${part.name} 面の数`);
        assert.equal(b.genus, a.genus, `${part.name} 種数`);
        // .ipt の iProperties（PID 20・61）が STEP の材質・密度（単位つき）と一致する = 密度の単位は g/cm³
        assert.equal(ipt.properties.material, part.material);
        assert.ok(Math.abs(ipt.properties.density_g_per_cm3 / 1000 - part.density_g_per_mm3) < 1e-12);
        const envelope = b.size[0] * b.size[1] * b.size[2];
        const [va, vb] = [partGeometry(ipt.scene.bodies).volume, partGeometry(part.bodies).volume];
        assert.ok(Math.abs(va - vb) <= VOLUME_TOL * envelope, `${part.name} 体積 ${va} / ${vb}`);
        compared += 1;
      }
      assert.equal(compared, 8, "自作の部品 8 種類を照合する");
    });

    test("全てのボルトの軸が、組み付け先の部品の穴の軸と一直線になる（配置の変換の検証）", () => {
      const line = (inst, c) => {
        const m = inst.matrix, p = c.center, d = c.axis;
        const at = [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
        const dir = [0, 1, 2].map((r) => m[r * 4] * d[0] + m[r * 4 + 1] * d[1] + m[r * 4 + 2] * d[2]);
        return { at, dir };
      };
      const coaxial = (a, b) => {
        const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = (u) => Math.hypot(...u);
        const diff = [0, 1, 2].map((k) => b.at[k] - a.at[k]);
        return len(cross(a.dir, b.dir)) < 1e-9 && len(cross(diff, a.dir)) < AXIS_TOL;
      };
      const isScrew = (inst) => partName(inst).startsWith("JIS B 1176");
      const holes = scene.instances.filter((i) => !isScrew(i)).flatMap((inst) => scene.parts[inst.part].bodies[0].summary.cylinders.filter((c) => c.kind === "hole").map((c) => line(inst, c)));
      const screws = scene.instances.filter(isScrew);
      assert.equal(screws.length, 20);
      for (const inst of screws) {
        const shank = scene.parts[inst.part].bodies[0].summary.cylinders[0];
        assert.ok(holes.some((h) => coaxial(line(inst, shank), h)), `${inst.name} の軸に一致する穴がない`);
      }
    });

    test("組立の説明: 部品表・外形・質量（全ての部品の密度が分かる）", () => {
      const volumes = scene.parts.map((p) => partGeometry(p.bodies).volume);
      const d = describeAssembly(scene, volumes);
      assert.equal(d.groups.length, 10);
      assert.equal(d.groups.reduce((n, g) => n + g.count, 0), 39);
      assert.ok(d.totals.massComplete && d.totals.mass > 0);
      // 外形（稜線の点を組立の座標にして囲んだもの）が、表示用の三角形の頂点を囲んだものと一致する（弦の近似の分だけ差がありうる）
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const inst of scene.instances) {
        for (const { p } of bodyMesh(scene.parts[inst.part].bodies, inst.matrix).triangles) {
          for (const v of p) v.toArray().forEach((x, k) => { lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); });
        }
      }
      assert.ok(sameArray(d.size, hi.map((v, k) => v - lo[k]), 0.05), `${d.size} / ${hi.map((v, k) => v - lo[k])}`);
    });
  });
}

for (const name of sampleIams()) {
  describe(name, () => {
    const iam = parseIam(readSampleFile("iam", name), name);
    const stepName = sampleSteps().find((n) => stem(n) === stem(name));

    test("参照するファイル: 部品 10 種類（Content Center の部品は表示名つき）", () => {
      assert.equal(iam.references.length, 10);
      assert.ok(iam.references.every((r) => r.file.endsWith(".ipt")));
      assert.deepEqual(iam.references.filter((r) => r.display).map((r) => r.display), ["JIS B 1176 - メートル M4 x 8", "JIS B 1176 - メートル M4 x 40"]);
    });

    test("出現と配置が同じ数で対応し、全ての出現の参照先が分かる", () => {
      assert.equal(iam.occurrences.length, 39);
      assert.ok(iam.report.paired);
      assert.ok(iam.occurrences.every((o) => o.reference !== null && o.matrix));
    });

    if (stepName) {
      test("出現の名前・並び・部品・配置が、同じ組立の STEP と一致する", () => {
        const { scene } = parseStepFile(new TextDecoder().decode(readSampleFile("stp", stepName)), stepName);
        assert.deepEqual(iam.occurrences.map((o) => o.name), scene.instances.map((i) => i.name), "出現の名前と並び（組立のブラウザーの順）");
        for (const o of iam.occurrences) {
          const inst = scene.instances.find((i) => i.name === o.name);
          assert.equal(iam.references[o.reference].stem, scene.parts[inst.part].name, o.name);
          assert.ok(sameArray(o.matrix, inst.matrix, MATRIX_TOL), `${o.name}: ${o.matrix} / ${inst.matrix}`);
        }
      });
    }

    test("参照先の部品を samples/ipt から解決する（無いのは Content Center のボルト 2 種類）", () => {
      const available = new Set(sampleIpts());
      const scene = buildIamScene(iam, name, (ref) => (available.has(ref.file) ? { name: ref.file, bytes: readSample(ref.file) } : null));
      assert.deepEqual(scene.parts.filter((p) => p.missing).map((p) => p.file), ["JIS B 1176 - M4 x 8 - 0.7.ipt", "JIS B 1176 - M4 x 40 - 0.7.ipt"]);
      assert.equal(scene.instances.length, 39);
      assert.ok(scene.parts.filter((p) => !p.missing).every((p) => p.material === "鋼、軟鋼" && p.density_g_per_mm3 === 0.00785));
      const d = describeAssembly(scene, scene.parts.map((p) => (p.missing ? null : partGeometry(p.bodies).volume)));
      assert.deepEqual(d.missing.map((g) => g.count), [18, 2]);
      assert.equal(d.totals.massComplete, false, "見つからない部品があれば、質量の合計は「除く」と示す");
    });
  });
}

test(".iam: 配置を読めなかった出現は原点に置き、部品を特定できない出現だけを「置けない」とする", () => {
  const references = [{ path: "C:\\a\\p.ipt", file: "p.ipt", stem: "p", display: null }];
  const moved = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const occurrences = [
    { name: "p:1", reference: 0, matrix: moved },
    { name: "p:2", reference: 0, matrix: null },
    { name: "q:1", reference: null, matrix: moved },
  ];
  const scene = buildIamScene({ references, occurrences }, "a.iam", () => null);
  assert.deepEqual(scene.instances.map((i) => [i.name, i.matrix[3]]), [["p:1", 5], ["p:2", 0]]);
  assert.deepEqual(scene.unplaced, ["q:1"]);
});
