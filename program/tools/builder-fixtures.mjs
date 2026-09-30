// ビルダー（Python）のテストに使う変換データを、JS 版の出力から作る。
//   npm run fixtures:builder   … tests/fixtures/builder/ を更新する
// export.test.mjs は、保存済みのファイルが現在の出力と一致することを確かめる。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";
import { buildInventorSpec, formatSpec } from "../app/static/js/convert/inventor.js";
import { recognizeMesh, recognizeSnapshot } from "../app/static/js/convert/recognize/index.js";
import { ROOT, readHtmlFixture } from "../tests/js/helpers.mjs";

export const BUILDER_FIXTURES = path.join(ROOT, "tests/fixtures/builder");
const SOURCE = (file, revision) => ({ file, revision, capturedAt: "fixture" });

/** three.js の ExtrudeGeometry で作った「21 × 7.5 × 2 の板に Φ4.5 の穴 2 つ」（サンプル ipt と同じ寸法）。 */
export function plateWithHoles() {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(21, 0); s.lineTo(21, 7.5); s.lineTo(0, 7.5); s.lineTo(0, 0);
  for (const x of [4, 17]) { const h = new THREE.Path(); h.absarc(x, 3.75, 2.25, 0, Math.PI * 2, true); s.holes.push(h); }
  const g = new THREE.ExtrudeGeometry(s, { depth: 2, bevelEnabled: false, curveSegments: 48 });
  const matrix = new THREE.Matrix4().elements;
  const parts = recognizeMesh({ positions: g.attributes.position.array, index: g.index?.array ?? null, matrix })
    .map((p, id) => ({ id, meshIndex: 0, ...p }));
  return { revision: "170", parts, excluded: {} };
}

export function builderFixtures() {
  const html = (name, file, revision, unit = 1) => buildInventorSpec(SOURCE(file, revision), recognizeSnapshot(readHtmlFixture(name), { unit }));
  return {
    "spacer-t50": html("LS4_parts_viewer.spacer-t50", "LS4_parts_viewer.html", "180"),
    finger: html("LS4_parts_viewer.finger", "LS4_parts_viewer.html", "180"),
    blade: html("LS4_parts_viewer.blade", "LS4_parts_viewer.html", "180"),
    reel: html("spool_reel_assembly_v2.reel", "spool_reel_assembly_v2.html", "160"),
    "plate-holes": buildInventorSpec(SOURCE("plate_holes.html", "170"), plateWithHoles()),
    // 1 単位 = 1 m。端を塞いだ管（近似の部品、三角形のまま）・柱・球の組立
    wire: html("メッセンジャーワイヤー方式.wire", "メッセンジャーワイヤー方式.html", "160", 1000),
  };
}

export const fixtureText = formatSpec;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(BUILDER_FIXTURES, { recursive: true });
  for (const [name, spec] of Object.entries(builderFixtures())) {
    fs.writeFileSync(path.join(BUILDER_FIXTURES, `${name}.inventor.json`), fixtureText(spec));
    console.log(`${name}: parts ${spec.parts.length}, instances ${spec.parts.reduce((s, p) => s + p.instances.length, 0)}`);
  }
}
