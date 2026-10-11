// マルチ引出線・表の描き方を、AutoCAD が図形に添えた見本の描画（代理図形）と突き合わせる（開発用）。
//   node --import ./program/tests/js/importmap.mjs program/tools/annotation-check.mjs ファイル.dxf … [--list]
// 答え: proxy_graphics.py（ezdxf）が代理図形を DXF に書き出したもの（図形のハンドルが画層の名前）。
// 図形ごとに比べる値:
//   線: 答えの線の上の点のうち、こちらの線の近く（許す差 = 図形の大きさの 0.5%・文字の高さの 5% の大きい方）にある割合（再現）と、その逆（適合）
//   文字: 語の並びが同じか・1 行目の基線の位置の差（文字の高さを単位に。横の差は左揃えのときだけ）
// 文字の枠・下線は文字の幅で決まり、幅は字形で変わる（こちらは見積もり）。その分の差は、線の再現・適合に少し出る。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drawingFromDxf } from "../app/static/js/formats/cad2d/from-dxf.js";
import { buildScene } from "../app/static/js/viewer2d/scene.js";
import { baselineOffsets, estimateTextWidth } from "../app/static/js/viewer2d/text.js";
import { near, samples } from "./sxf-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** 場面の、図形ごと（item → ハンドル）の線分と文字 */
function byHandle(scene, handleOf) {
  const out = new Map();
  const entry = (h) => out.get(h) ?? out.set(h, { segs: [], texts: [] }).get(h);
  const push = (item, p) => {
    const h = handleOf(item);
    if (h === undefined) return;
    for (let i = 0; i + 3 < p.length; i += 2) entry(h).segs.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  };
  for (const s of scene.strokes) for (const line of s.lines) push(line.item, line.points);
  for (const f of scene.fills) for (const r of f.rings) push(f.item, [...r, r[0], r[1]]);
  for (const t of scene.texts) {
    const h = handleOf(t.item);
    if (h !== undefined) entry(h).texts.push(t);
  }
  return out;
}

/** 文字の 1 行目の左の基線（揃えと行の位置から。幅は見積もり） */
function firstBaseline(t) {
  const w = estimateTextWidth(t.lines[0] ?? "", t.height) * (t.widthFactor || 1);
  const dx = t.align === "center" ? -w / 2 : t.align === "right" ? -w : 0;
  const dy = baselineOffsets(t, t.lines.length)[0] * t.height;
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return [t.x + c * dx - s * dy, t.y + s * dx + c * dy];
}

const words = (texts) => texts.flatMap((t) => t.lines.join(" ").split(/\s+/)).filter(Boolean).join(" ");

export function checkFile(file) {
  const dir = mkdtempSync(join(tmpdir(), "annot-"));
  const oracleFile = join(dir, "oracle.dxf");
  execFileSync("python3", ["-I", join(here, "proxy_graphics.py"), file, oracleFile], { stdio: ["ignore", "pipe", "inherit"] });
  const drawing = drawingFromDxf(readFileSync(file)), oracle = drawingFromDxf(readFileSync(oracleFile));
  const oracleScene = buildScene(oracle, oracle.layouts.find((l) => l.model), { shown: new Set(oracle.layers.keys()) });
  const want = byHandle(oracleScene, (i) => oracleScene.items[i]?.layer?.replace(/^H/, ""));
  const results = [];
  for (const layout of drawing.layouts) {
    const scene = buildScene(drawing, layout, { shown: new Set(drawing.layers.keys()) });
    const got = byHandle(scene, (i) => {
      const it = scene.items[i];
      return it && want.has(it.handle) && it.viewport === undefined ? it.handle : undefined; // ビューポートの中に描いたモデルは除く
    });
    for (const [handle, mine] of got) {
      const ans = want.get(handle);
      const entity = scene.items.find((it) => it.handle === handle)?.entity;
      const all = [...ans.segs, ...mine.segs];
      const xs = all.flatMap((s) => [s[0], s[2]]), ys = all.flatMap((s) => [s[1], s[3]]);
      const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
      const h = Math.max(0, ...ans.texts.map((t) => t.height));
      const tol = Math.max(size * 0.005, h * 0.05);
      const recall = ans.segs.length ? near(samples(ans.segs, tol), mine.segs, tol) : 1;
      const precision = mine.segs.length ? near(samples(mine.segs, tol), ans.segs, tol) : ans.segs.length ? 0 : 1;
      const sameWords = words(ans.texts) === words(mine.texts);
      // 1 行目の基線の位置の差（文字の高さが単位）: 縦は常に、横は左揃えのときだけ（中央・右揃えは、字形で変わる文字の幅が入る）
      let offset = null;
      if (ans.texts.length && mine.texts.length) {
        const [a, b] = [ans.texts[0], mine.texts[0]];
        const p = firstBaseline(b), c = Math.cos(b.rotation), s = Math.sin(b.rotation);
        const along = (a.x - p[0]) * c + (a.y - p[1]) * s, across = -(a.x - p[0]) * s + (a.y - p[1]) * c;
        offset = Math.hypot(b.align === "left" ? along : 0, across) / (a.height || 1);
      }
      results.push({ handle, type: entity?.type, recall, precision, sameWords, offset, words: [words(ans.texts), words(mine.texts)] });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = process.argv.includes("--list");
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  let n = 0, good = 0;
  for (const file of files) {
    const results = checkFile(file);
    for (const r of results) {
      n++;
      const ok = r.recall > 0.97 && r.precision > 0.97 && r.sameWords && (r.offset === null || r.offset < 0.5);
      if (ok) good++;
      if (list || !ok) {
        console.log(`${file.split("/").pop()} ${r.type} ${r.handle} 再現 ${pct(r.recall)} 適合 ${pct(r.precision)} 文字 ${r.sameWords ? "同じ" : `違う [${r.words[0]}] ⇔ [${r.words[1]}]`}` +
          ` 位置の差 ${r.offset === null ? "—" : `${r.offset.toFixed(2)} 字`}`);
      }
    }
  }
  console.log(`合う ${good} / ${n}`);
}
