// U3D の読み取りの評価（開発用）: U3D と、それを作った元の文章（IDTF。同じ名前の .idtf）を突き合わせる。
//   node program/tools/u3d-check.mjs フォルダか .u3d …
// IDTF のメッシュ（位置・面）と、読んだメッシュ（段階的なメッシュを組み立て直したもの）を比べる:
//   位置の数・面の数、位置の誤差（量子化の内か）、面（三角形）が全て同じ位置の組か・向きが同じか。
//   IDTF の潰れた面（同じ位置を 2 度使う面）は、書き出すときに取り除かれるので比べない。
// U3D は位置を量子化し、段階的なメッシュでは位置の順も並べ替えるので、位置は近いもの同士を対応させて比べる。

import fs from "node:fs";
import path from "node:path";
import { readU3dMeshes } from "../app/static/js/formats/u3d/index.js";

/** IDTF → 資源の名前 → { positions, faces } */
export function parseIdtf(text) {
  const meshes = new Map();
  const re = /RESOURCE_NAME\s+"([^"]*)"\s*\n\s*MODEL_TYPE\s+"MESH"([\s\S]*?)(?=\n\s*RESOURCE\s+\d+\s*\{|\n\}\s*$|\nRESOURCE_LIST|\nMODIFIER|\nNODE|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2];
    const list = (name) => {
      const at = body.search(new RegExp(`\\b${name}\\s*\\{`));
      if (at < 0) return [];
      const start = body.indexOf("{", at) + 1;
      return body.slice(start, body.indexOf("}", start)).trim().split(/\s+/).filter(Boolean).map(Number);
    };
    const p = list("MODEL_POSITION_LIST"), f = list("MESH_FACE_POSITION_LIST");
    const positions = [], faces = [];
    for (let i = 0; i + 2 < p.length; i += 3) positions.push([p[i], p[i + 1], p[i + 2]]);
    for (let i = 0; i + 2 < f.length; i += 3) faces.push([f[i], f[i + 1], f[i + 2]]);
    meshes.set(m[1], { positions, faces });
  }
  return meshes;
}

/** 読んだメッシュと IDTF のメッシュを比べる */
export function compareMesh(decoded, expected) {
  const tol = Math.max(decoded.q?.position ?? 0, 1e-6);
  // 位置の対応: 読んだ位置ごとに、IDTF の最も近い位置（格子に分けて探す）
  const cell = tol * 4;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  expected.positions.forEach((p, i) => {
    const k = key(...p);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  let maxError = 0;
  const map = decoded.positions.map((p) => {
    let best = -1, bestD = Infinity;
    const [cx, cy, cz] = p.map((v) => Math.floor(v / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        const q = expected.positions[i];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < bestD) (bestD = d), (best = i);
      }
    }
    if (best >= 0) maxError = Math.max(maxError, bestD);
    return best;
  });
  // 同じ座標の位置（形の継ぎ目などで重なる位置）は 1 つの組にする（どちらに対応しても同じ三角形）
  const classOf = new Map();
  const classes = expected.positions.map((p) => {
    const k = p.join(",");
    if (!classOf.has(k)) classOf.set(k, classOf.size);
    return classOf.get(k);
  });
  // 三角形: 位置の組（並びの回転は同じとみる。向きが逆なら reversed）
  const canon = (t) => {
    const i = t.indexOf(Math.min(...t));
    return [t[i], t[(i + 1) % 3], t[(i + 2) % 3]].join(",");
  };
  // 同じ位置を 2 度使う潰れた面は、U3D に書き出すときに取り除かれる（比べない）
  const faces = expected.faces.filter((f) => new Set(f).size === 3);
  const want = new Map();
  for (const t of faces.map((f) => f.map((i) => classes[i]))) want.set(canon(t), (want.get(canon(t)) ?? 0) + 1);
  let same = 0, reversed = 0, missing = 0;
  for (const face of decoded.faces) {
    const t = face.p.map((i) => (map[i] < 0 ? -1 : classes[map[i]]));
    if (t.includes(-1)) {
      missing++;
      continue;
    }
    const k = canon(t), r = canon([t[0], t[2], t[1]]);
    if (want.get(k)) (want.set(k, want.get(k) - 1), same++);
    else if (want.get(r)) (want.set(r, want.get(r) - 1), reversed++);
    else missing++;
  }
  return { positions: [decoded.positions.length, expected.positions.length], faces: [decoded.faces.length, faces.length], same, reversed, missing, maxError, tol,
    degenerate: expected.faces.length - faces.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).flatMap((a) => (fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((n) => /\.u3d$/i.test(n)).map((n) => path.join(a, n)) : [a]));
  let total = 0, ok = 0;
  console.log("ファイル\tメッシュ\t位置（読んだ / IDTF）\t面（読んだ / IDTF）\t同じ面\t向きが逆\t合わない\t位置の最大誤差 / 量子化");
  for (const file of files) {
    const idtf = file.replace(/\.u3d$/i, ".idtf");
    if (!fs.existsSync(idtf)) continue;
    let decoded;
    try {
      decoded = readU3dMeshes(new Uint8Array(fs.readFileSync(file)));
    } catch (error) {
      console.log(`${path.basename(file)}\t失敗: ${error.message}`);
      continue;
    }
    const expected = parseIdtf(fs.readFileSync(idtf, "utf8"));
    for (const [name, mesh] of decoded.meshes) {
      const want = expected.get(name);
      if (!want) continue;
      const r = compareMesh(mesh, want);
      total++;
      if (r.same === r.faces[1] && !r.missing) ok++;
      console.log(`${path.basename(file)}\t${name}\t${r.positions.join(" / ")}\t${r.faces.join(" / ")}\t${r.same}\t${r.reversed}\t${r.missing}\t${r.maxError.toExponential(2)} / ${r.tol.toExponential(2)}` +
        (decoded.warnings.length ? `\t${decoded.warnings.join("・")}` : ""));
    }
  }
  console.log(`\n面が全て一致したメッシュ: ${ok} / ${total}`);
}
