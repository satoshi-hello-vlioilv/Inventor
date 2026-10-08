// SXF（.sfc・.p21）の読み取りの評価（開発用）: こちらの読み取り（formats/sxf → cad2d/from-sxf.js）で描くものを、別の答えと突き合わせる。
//   node program/tools/sxf-check.mjs [--tol 0.05] フォルダ …
//   フォルダの中の組を比べる:
//     「名前.sfc」と「名前.dxf」… DXF は別の読み取り（ezsxf（MIT）の to_dxf）が SFC を書き直したもの。DXF の読み取りは AutoCAD の値で確かめてある
//     「名前.sfc」と「名前.p21」… 同じ CAD が同じ図面を 2 つの書き方で書いたもの（P21 の読み取りを SFC で確かめる）
//   比べ方（compareDrawings）は試験（tests/js/sxf.test.mjs）と共用。jww-check.mjs と同じく、線と塗りの縁を細かく区切った点が
//   相手の線の近く（既定 0.05 mm）にあるかの割合（余計に描かない・描き漏らさない）と、同じ文字列が近い位置にあるかを出す。
// ezsxf と読みの違うところ（どちらが正しいかは仕様の原典で確かめられていない）は、比べる前に除く:
//   矢印 … ezsxf は「尺度 × 10」を部分図の中の長さにする（用紙では縮尺倍に小さくなる）。こちらは用紙の mm。--arrows で含める

import fs from "node:fs";
import path from "node:path";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { buildScene } from "../app/static/js/viewer2d/scene.js";

/** 線と塗りの縁の線分 [x0, y0, x1, y1] */
function segments(scene) {
  const out = [];
  const closed = (ring) => [...ring, ring[0], ring[1]];
  const polylines = [...scene.strokes.flatMap((s) => s.lines.map((line) => line.points)), ...scene.fills.flatMap((f) => f.rings.map(closed))];
  for (const p of polylines) for (let i = 0; i + 3 < p.length; i += 2) out.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  return out;
}

/** 線分を間隔 step で区切った点 */
function samples(segs, step) {
  const out = [];
  for (const [x0, y0, x1, y1] of segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

/** 点 a のうち、線分 b のどれかの近く（tol）にあるものの割合（線分を格子の升に配って探す。点どうしで比べると、区切りのずれが差に見える） */
function near(a, b, tol) {
  if (!a.length) return b.length ? 0 : 1;
  const cell = Math.max(tol * 4, 0.5), grid = new Map();
  for (const s of b) {
    const [x0, x1] = [Math.min(s[0], s[2]) - tol, Math.max(s[0], s[2]) + tol], [y0, y1] = [Math.min(s[1], s[3]) - tol, Math.max(s[1], s[3]) + tol];
    const cells = (Math.floor(x1 / cell) - Math.floor(x0 / cell) + 1) * (Math.floor(y1 / cell) - Math.floor(y0 / cell) + 1);
    if (cells > 4096) { // 長い線分は、通る升だけに配る
      const n = Math.ceil(Math.hypot(s[2] - s[0], s[3] - s[1]) / cell) + 1;
      const keys = new Set();
      for (let k = 0; k <= n; k++) {
        const x = s[0] + ((s[2] - s[0]) * k) / n, y = s[1] + ((s[3] - s[1]) * k) / n;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.add(`${Math.floor(x / cell) + dx},${Math.floor(y / cell) + dy}`);
      }
      for (const k of keys) (grid.get(k) ?? grid.set(k, []).get(k)).push(s);
      continue;
    }
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) (grid.get(`${cx},${cy}`) ?? grid.set(`${cx},${cy}`, []).get(`${cx},${cy}`)).push(s);
    }
  }
  const distance = ([x, y], [x0, y0, x1, y1]) => {
    const dx = x1 - x0, dy = y1 - y0, l = dx * dx + dy * dy;
    const t = l > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / l)) : 0;
    return Math.hypot(x0 + dx * t - x, y0 + dy * t - y);
  };
  let hit = 0;
  for (const q of a) if ((grid.get(`${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`) ?? []).some((s) => distance(q, s) <= tol)) hit++;
  return hit / a.length;
}

const texts = (scene) => scene.texts.map((t) => ({ text: t.lines.join("\n").trim(), x: t.x, y: t.y, h: t.height, rotation: t.rotation,
  width: t.fit?.length ?? null, align: ALIGN[t.align] ?? 0, valign: VALIGN[t.valign] ?? 0 }));
const ALIGN = { left: 0, center: 0.5, right: 1 }, VALIGN = { baseline: 0, bottom: 0, middle: 0.5, top: 1 };

/**
 * 文字 t（幅の分かるもの: SXF は幅に合わせて描く）の外形で、u の揃え（左・中・右 × 下・中・上）の点が u の位置にあるか。
 * 揃えの書き方は読み取りごとに違う（ezsxf の DXF は SXF の基準点の揃えのまま書く）ので、外形の同じ点で比べる
 */
function sameText(t, u) {
  if (u.text !== t.text) return false;
  const w = t.width ?? 0, c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const dx = (u.align - t.align) * w, dy = (u.valign - t.valign) * t.h;
  return Math.hypot(t.x + dx * c - dy * s - u.x, t.y + dx * s + dy * c - u.y) <= Math.max(t.h * 0.2, 0.5);
}

/** 比べる図面: 最初のレイアウト（紙が無ければモデル）。arrows: false なら SXF の矢印（PATH の arrow）を除く */
function sceneOf(drawing, { arrows }) {
  if (!arrows) {
    for (const b of drawing.blocks.values()) b.entities = b.entities.filter((e) => !e.arrow);
  }
  const layout = drawing.layouts.find((l) => !l.model) ?? drawing.layouts[0];
  return buildScene(drawing, layout, { shown: new Set(drawing.layers.keys()) });
}

/** 2 つの図面を比べる → { precision, recall, points: [a, b], texts: [一致, a, b] } */
export function compareDrawings(a, b, { tol = 0.05, arrows = false } = {}) {
  const sa = sceneOf(a, { arrows }), sb = sceneOf(b, { arrows });
  const step = 0.2;
  const ga = segments(sa), gb = segments(sb);
  const pa = samples(ga, step), pb = samples(gb, step);
  const ta = texts(sa).filter((t) => t.text), tb = texts(sb).filter((t) => t.text);
  const textHit = ta.filter((t) => tb.some((u) => sameText(t, u))).length;
  return { precision: near(pa, gb, tol), recall: near(pb, ga, tol), points: [pa.length, pb.length], texts: [textHit, ta.length, tb.length] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tolAt = args.indexOf("--tol");
  const tol = tolAt >= 0 ? Number(args.splice(tolAt, 2)[1]) : 0.05;
  const arrowsAt = args.indexOf("--arrows");
  const arrows = arrowsAt >= 0 && Boolean(args.splice(arrowsAt, 1));
  console.log("図面\t相手\t余計に描かない\t描き漏らさない\t点（SFC / 相手）\t文字（一致 / SFC / 相手）");
  for (const dir of args) {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(.*)\.sfc$/i);
      if (!m) continue;
      for (const ext of ["dxf", "p21"]) {
        const other = fs.readdirSync(dir).find((n) => n.toLowerCase() === `${m[1]}.${ext}`.toLowerCase());
        if (!other) continue;
        try {
          const read = (n) => readDrawing(new Uint8Array(fs.readFileSync(path.join(dir, n))), n);
          const r = compareDrawings(read(name), read(other), { tol, arrows });
          const pct = (v) => `${(v * 100).toFixed(1)}%`;
          console.log(`${name}\t${ext.toUpperCase()}\t${pct(r.precision)}\t${pct(r.recall)}\t${r.points.join(" / ")}\t${r.texts.join(" / ")}`);
        } catch (error) {
          console.log(`${name}\t${ext.toUpperCase()}\t失敗: ${error.message}`);
        }
      }
    }
  }
}
