// Jw_cad の図面（.jww）の読み取りの評価（開発用）: Jw_cad 自身が同じ図面を書き出した DXF と、形と文字を突き合わせる。
//   node program/tools/jww-check.mjs [--tol 0.05] フォルダ …（「名前.jww」と「名前.dxf」の組。.gz で圧縮したものも読む）
//   比べ方（compareJww）は試験（tests/js/jww.test.mjs）と共用
// こちらの読み取り（formats/jww → cad2d/from-jww.js）と、DXF の読み取り（AutoCAD の値と突き合わせて確かめたもの）で、
// それぞれ描くもの（viewer2d/scene.js）を作り、次を比べる:
//   線: 線と塗りの縁を細かく区切った点が、相手の線の近く（既定 0.05 mm）にあるかの割合（余計に描かない・描き漏らさない）。
//       Jw_cad の DXF は楕円を 10° ごとの線分で書く（半径 20 mm で弦のずれ 0.08 mm）ので、楕円は --tol 0.1 で比べる
//   文字: 同じ文字列が、近い位置（文字の高さの内）にあるか
// Jw_cad の DXF は曲線の塗りを縁の線にし、輪の内側の縁と扇形の中心への線を書かない（塗りは Jw_cad の画面の絵で確かめる）。
// 補助線は専用の画層 ADD_LINE に書く（こちらも「補助線（印刷しない）」の画層にまとめて描く）
// Jw_cad の DXF は用紙の左下が原点（JWW は用紙の中心）で、画層グループ 0 の縮尺を掛けた長さ（実寸）で書く。
// JWW の座標（用紙の mm）を用紙の半分ずらし、その縮尺を掛けて比べる（表示は用紙の mm のまま）。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { readJww } from "../app/static/js/formats/jww/index.js";
import { buildScene } from "../app/static/js/viewer2d/scene.js";

export const read = (file) => {
  const bytes = fs.readFileSync(file);
  return new Uint8Array(file.endsWith(".gz") ? zlib.gunzipSync(bytes) : bytes);
};

/** 線と塗りの縁を間隔 step で区切った点（座標は (p + shift) × k）。Jw_cad の DXF は曲線の塗りを縁の線で書くので、塗りも縁で比べる */
function samples(scene, step, shift = [0, 0], k = 1) {
  const out = [];
  const closed = (ring) => [...ring, ring[0], ring[1]];
  const polylines = [...scene.strokes.flatMap((s) => s.lines.map((line) => line.points)), ...scene.fills.flatMap((f) => f.rings.map(closed))];
  for (const p of polylines) {
    {
      for (let i = 0; i + 3 < p.length; i += 2) {
        const [x0, y0, x1, y1] = [(p[i] + shift[0]) * k, (p[i + 1] + shift[1]) * k, (p[i + 2] + shift[0]) * k, (p[i + 3] + shift[1]) * k];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
        for (let k = 0; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
      }
    }
  }
  return out;
}

/** 点 a のうち、点 b の近く（tol）にあるものの割合（格子に分けて探す） */
function near(a, b, tol) {
  if (!a.length) return b.length ? 0 : 1;
  const cell = tol * 2, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const [x, y] of b) {
    const k = key(x, y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, y]);
  }
  let hit = 0;
  for (const [x, y] of a) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) {
      for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(q[0] - x, q[1] - y) <= tol) (found = true);
    }
    if (found) hit++;
  }
  return hit / a.length;
}

const texts = (scene, shift = [0, 0], k = 1) =>
  scene.texts.map((t) => ({ text: t.lines.join("\n"), x: (t.x + shift[0]) * k, y: (t.y + shift[1]) * k, h: t.height * k }));

/** JWW と、Jw_cad がそれを書き出した DXF を比べる → { precision, recall, points: [JWW, DXF], texts: [一致, JWW, DXF], fills: [JWW, DXF] } */
export function compareJww(jwwBytes, dxfBytes, { tol = 0.05 } = {}) {
  const jw = readDrawing(jwwBytes, "a.jww"), dx = readDrawing(dxfBytes, "a.dxf");
  const a = buildScene(jw, jw.layouts[0], { shown: new Set(jw.layers.keys()) }); // Jw_cad の DXF は隠した画層も書く
  const b = buildScene(dx, dx.layouts.find((l) => l.model) ?? dx.layouts[0]);
  const paper = jw.layouts[0].paper;
  const shift = [-paper.min[0], -paper.min[1]]; // 用紙の中心 → 左下
  const k = readJww(jwwBytes).groups[0].scale || 1;
  const step = 0.2;
  const pa = samples(a, step, shift, k), pb = samples(b, step);
  const ta = texts(a, shift, k), tb = texts(b);
  const textHit = ta.filter((t) => tb.some((u) => u.text === t.text && Math.hypot(u.x - t.x, u.y - t.y) <= Math.max(t.h, 0.5))).length;
  return { precision: near(pa, pb, tol), recall: near(pb, pa, tol), points: [pa.length, pb.length], texts: [textHit, ta.length, tb.length], fills: [a.fills.length, b.fills.length] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tolAt = args.indexOf("--tol");
  const tol = tolAt >= 0 ? Number(args.splice(tolAt, 2)[1]) : 0.05;
  const pairs = [];
  for (const dir of args) {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(.*)\.jww(\.gz)?$/i);
      if (!m) continue;
      const dxf = [`${m[1]}.dxf`, `${m[1]}.dxf.gz`].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
      if (dxf) pairs.push([path.join(dir, name), dxf]);
    }
  }
  console.log("図面\t余計に描かない\t描き漏らさない\t点（JWW / DXF）\t文字（一致 / JWW / DXF）\t塗り（JWW / DXF）");
  for (const [jww, dxf] of pairs) {
    try {
      const r = compareJww(read(jww), read(dxf), { tol });
      const pct = (v) => `${(v * 100).toFixed(1)}%`;
      console.log(`${path.basename(jww)}\t${pct(r.precision)}\t${pct(r.recall)}\t${r.points.join(" / ")}\t${r.texts.join(" / ")}\t${r.fills.join(" / ")}`);
    } catch (error) {
      console.log(`${path.basename(jww)}\t失敗: ${error.message}`);
    }
  }
}
