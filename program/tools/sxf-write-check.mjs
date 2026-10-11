// SXF（SFC）の書き出しの評価関数（開発用・試験と共用）: 図面の各レイアウトを SFC に書き（formats/cad2d/to-sxf.js）、読み直して、
// 書く前に画面に描いたものと突き合わせる。
//
//   node program/tools/sxf-write-check.mjs フォルダか図面 … [--ezsxf] [--out 置き場] [--verbose]
//
// 比べ方（roundTrip）: 書く前の描画（viewer2d/scene.js）を用紙の座標に写し（部分図の尺度と置き場所・用紙の左下）、ビューポートの枠で切ったものと、
// 書いた SFC を読み直した描画を比べる。書き出しの計算とは別に、描いた結果どうしで比べる:
//   線 … 色・線幅・破線の 1 周期の長さが同じ線どうしで、区切った点が相手の線の近く（用紙の 0.05 mm）にある割合（余計に書かない・書き漏らさない）
//   塗り … 塗った面で（升目の点が元・書いたものの塗りの内側かの一致）。幅のある線（ポリラインの幅）は、区間ごとの四角の塗りとして比べる
//   文字 … 行ごとに、同じ文字列が、揃え（左・中・右）の基線の点・高さ・向きで合う割合
//   点 … 位置の合う割合
// 合わない所の説明は、線・塗りが 99.9% を下回るときだけ出す（SXFW_STRICT=1 なら少しでも合わなければ出す）。
// --ezsxf: 別の読み取り（ezsxf（MIT）の to_dxf。pip install ezsxf）で書いた SFC を DXF に直し、こちらの読み直しと比べる（sxf-check.mjs と同じ比べ方）

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeShiftJis } from "../app/static/js/core/sjis.js";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { drawingToSfc, sfcNotes, sfcString } from "../app/static/js/formats/cad2d/to-sxf.js";
import { buildScene } from "../app/static/js/viewer2d/scene.js";
import { baselineOffsets, estimateTextWidth, wrapLines } from "../app/static/js/viewer2d/text.js";
import { clipped, compareDrawings, near, samples } from "./sxf-check.mjs";

const TOL = 0.05; // 図の中の mm（部分図なら図の中、用紙に直に書いた図なら用紙）
const STEP = 0.2;
const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
const inBox = (p, c) => !c || (p[0] >= c.min[0] - 1e-9 && p[0] <= c.max[0] + 1e-9 && p[1] >= c.min[1] - 1e-9 && p[1] <= c.max[1] + 1e-9);
/** 白・黒は前景色（SXF の読み手は black・white を前景色にする） */
const colourKey = (c) => (c === null || c === "#000000" || c === "#ffffff" ? "前景" : c);

/**
 * 比べる座標（図の中の mm）: 書く前の描画 → toContent、読み直した描画（用紙の座標）→ fromSheet（部分図の置き場所と尺度を戻す）。
 * 用紙の座標で比べると、縮尺 1:S の図では許す差が図の中で S 倍に甘くなり、線も密になる（plan: to-sxf.js の sheetPlan）
 */
function frames(plan) {
  const { figure, k, origin } = plan;
  if (figure) {
    const r = figure.ratio, [ax, ay] = figure.at;
    return { toContent: ([x, y]) => [x * k, y * k], fromSheet: ([x, y]) => [(x - ax) / r, (y - ay) / r], unscale: 1 / r };
  }
  return { toContent: ([x, y]) => [(x - origin[0]) * k, (y - origin[1]) * k], fromSheet: (p) => p, unscale: 1 };
}

/** 線分の並び（区切った点を作る元）。ring … 閉じる */
function segs(pts, ring = false) {
  const out = [];
  const list = ring ? [...pts, pts[0]] : pts;
  for (let i = 0; i + 1 < list.length; i++) out.push([...list[i], ...list[i + 1]]);
  return out;
}

/**
 * 破線の 1 周期（用紙の mm）。書き出しとは別に計算する: 長さ 0 の点は 0.25 mm（SXF の既定の線種の点）。
 * すき間の無い・線の無い破線は実線（0）
 */
function dashPeriod(dashes, toPaper) {
  if (!dashes?.length || dashes.every((d) => d >= 0) || dashes.every((d) => d < 0)) return 0;
  return dashes.reduce((sum, d) => sum + (d === 0 ? 0.25 : Math.abs(d) * toPaper), 0);
}

/**
 * 線の種類の鍵: 色・線幅（1/100 mm）・破線の 1 周期（用紙の mm。相対 1e-4 の内の周期はそろえる）。
 * 書き出しが線幅・線種を近いものにまとめたとき（SXF の表の上限。知らせに出る）は、それを鍵から外して形だけ比べる
 */
function strokeKeys({ widths, types }) {
  const canon = periods();
  return (colour, lw, period) => {
    const p = canon(period);
    return `${colourKey(colour)}|${widths ? "線幅をまとめた" : lw}|${types ? "線種をまとめた" : p ? p.toPrecision(6) : "実線"}`;
  };
}

/** 破線の周期の代表（相対 1e-4 の内の周期は、先に出てきた周期にそろえる。書いた値の丸めで鍵が分かれないように） */
function periods() {
  const seen = [];
  return (v) => {
    if (!v) return 0;
    const same = seen.find((u) => Math.abs(u - v) <= 1e-4 * u);
    if (same !== undefined) return same;
    seen.push(v);
    return v;
  };
}

/** 書く前: 線（種類ごとの線分）・塗り・文字の行・点（図の中の座標。切り取りの枠も） */
function expected(scene, plan, measure, strokeKey) {
  const map = frames(plan).toContent;
  const toPaper = plan.figure ? plan.k * plan.figure.ratio : plan.k;
  const strokes = new Map(), fills = [], texts = [], points = [];
  const add = (key, list) => (strokes.get(key) ?? strokes.set(key, []).get(key)).push(...list);
  for (const s of scene.strokes) {
    for (const line of s.lines) {
      if (line.alpha < 1) continue;
      const pts = pairs(line.points);
      if (line.width > 0 && !line.weight) {
        // 幅のある線: 区間ごとの四角（縁）
        for (let i = 0; i + 1 < pts.length; i++) {
          const [a, b] = [pts[i], pts[i + 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (!(len > 0)) continue;
          const n = [(-(b[1] - a[1]) / len) * (line.width / 2), ((b[0] - a[0]) / len) * (line.width / 2)];
          const quad = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]];
          fills.push({ rings: [quad.map(map)], clip: line.clip && { min: map(line.clip.min), max: map(line.clip.max) } });
        }
        continue;
      }
      const mm = line.weight ? line.width * toPaper : s.lineweight / 100;
      const lw = Math.round((mm > 0.005 ? Math.round(mm * 100) / 100 : 0.13) * 100);
      const period = dashPeriod(s.dashes, toPaper);
      add(strokeKey(s.color, lw, period), [{ segs: segs(pts.map(map)), clip: line.clip && { min: map(line.clip.min), max: map(line.clip.max) } }]);
    }
  }
  for (const f of scene.fills) {
    if (f.alpha < 1) continue;
    fills.push({ rings: f.rings.map((r) => pairs(r).map(map)), rule: f.rule, clip: f.clip && { min: map(f.clip.min), max: map(f.clip.max) } });
  }
  for (const t of scene.texts) {
    if (!(t.height > 0) || (t.clip && !inBox([t.x, t.y], t.clip))) continue;
    if (t.height * plan.k < 5e-7) continue; // 書く高さ（小数 6 桁）が 0 の文字は書かない（SXF の決まり。知らせに出る）
    const width = (line) => (measure ? measure(t, line) : estimateTextWidth(line, t.height));
    const lines = t.mtext && t.width > 0 ? wrapLines(t.lines, t.width / (t.widthFactor || 1), width) : t.lines;
    const offsets = baselineOffsets(t, lines.length);
    const f = t.align === "center" ? 0.5 : t.align === "right" ? 1 : 0;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const up = offsets[i] * t.height;
      let h = t.height;
      if (t.fit?.mode === "aligned" && i === 0 && width(line) > 0) h *= t.fit.length / width(line);
      const at = [t.x - Math.sin(t.rotation) * up, t.y + Math.cos(t.rotation) * up];
      // Shift_JIS で 256 バイトを越える行は、越えないまとまりに分けて左から続けて並べる（SXF の上限。分け方は書き出しとは別に書く）
      const pieces = [];
      for (const ch of line) {
        const last = pieces.at(-1);
        if (last !== undefined && encodeShiftJis(sfcString(last + ch), () => "?").bytes.length <= 256) pieces[pieces.length - 1] = last + ch;
        else pieces.push(ch);
      }
      if (pieces.length === 1) {
        texts.push({ text: sfcString(line.trim()), at: map(at), f, h: h * plan.k, rotation: t.rotation });
        return;
      }
      const len = t.fit && i === 0 ? t.fit.length : width(line) * (t.widthFactor || 1);
      const total = pieces.reduce((sum, p) => sum + width(p), 0) || 1;
      let along = -f * len;
      for (const piece of pieces) {
        const p = [at[0] + Math.cos(t.rotation) * along, at[1] + Math.sin(t.rotation) * along];
        texts.push({ text: sfcString(piece.trim()), at: map(p), f: 0, h: h * plan.k, rotation: t.rotation });
        along += (width(piece) / total) * len;
      }
    });
  }
  for (const p of scene.points) if (inBox([p.x, p.y], p.clip)) points.push(map([p.x, p.y]));
  return { strokes, fills, texts, points };
}

/** 読み直した描画（用紙の座標 → 図の中の座標。破線の周期は用紙の mm のまま） */
function actual(scene, plan, strokeKey) {
  const { fromSheet, unscale } = frames(plan);
  const strokes = new Map(), fills = [];
  for (const s of scene.strokes) {
    const period = s.dashes?.length ? s.dashes.reduce((a, d) => a + Math.abs(d), 0) : 0;
    const key = strokeKey(s.color, s.lineweight, period);
    for (const line of s.lines) (strokes.get(key) ?? strokes.set(key, []).get(key)).push({ segs: segs(pairs(line.points).map(fromSheet)) });
  }
  for (const f of scene.fills) fills.push({ rings: f.rings.map((r) => pairs(r).map(fromSheet)), rule: f.rule });
  const texts = scene.texts.map((t) => {
    const len = t.fit?.length ?? 0;
    const f = t.fit ? 0 : t.align === "center" ? 0.5 : t.align === "right" ? 1 : 0;
    const [x, y] = fromSheet([t.x, t.y]);
    return { text: t.lines.join("\n").trim(), x, y, len: len * unscale, f, h: t.height * unscale, rotation: t.rotation };
  });
  return { strokes, fills, texts, points: scene.points.map((p) => fromSheet([p.x, p.y])) };
}


/**
 * 2 つの線分の集まりの一致 → { hitA（元の点のうち書いたものの線の近くにある数）, hitB（書いたものの点のうち元の線の近くにある数）, na, nb }。
 * 線分は切り取りの枠と、用紙のまわり（area。構築線のような長い線を、見える所だけにする）で切ってから比べる
 */
function match(a, b, area) {
  const cut = (list) => list.map(({ segs: s, clip }) => clipped(clipped(s, clip), area));
  const sa = cut(a), sb = cut(b);
  // 区切る間隔: 0.2 mm、線の長い図では全体で約 50 万点になるように
  const length = [...sa, ...sb].flat().reduce((sum, [x0, y0, x1, y1]) => sum + Math.hypot(x1 - x0, y1 - y0), 0);
  const step = Math.max(STEP, length / 5e5);
  const pa = sa.flatMap((s) => samples(s, step)), pb = sb.flatMap((s) => samples(s, step));
  return { hitA: near(pa, sb.flat(), TOL) * pa.length, hitB: near(pb, sa.flat(), TOL) * pb.length, na: pa.length, nb: pb.length };
}

/** 点が塗りの内側か（rule: "nonzero" は回る数、ほかは偶奇。画面の描き方と同じ） */
function insideFill([x, y], f) {
  if (f.clip && !inBox([x, y], f.clip)) return false;
  let winding = 0, crossings = 0;
  for (const r of f.rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        crossings++;
        winding += yj < yi ? 1 : -1;
      }
    }
  }
  return f.rule === "nonzero" ? winding !== 0 : crossings % 2 === 1;
}

/**
 * 塗った面の一致: 升目の点が、元の塗りのどれか・書いた塗りのどれかの内側かを調べる → { a（元で塗った点）, b（書いた方で塗った点）, both }。
 * 輪郭の線で比べると、ビューポートの枠で切った縁（元には無い線）が差に見えるので、面で比べる。升目は全ての塗りの外形の面積から決める
 */
function matchAreas(a, b, area) {
  const boxOf = (f) => {
    const box = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
    for (const r of f.rings) for (const [x, y] of r) {
      box.min = [Math.min(box.min[0], x), Math.min(box.min[1], y)];
      box.max = [Math.max(box.max[0], x), Math.max(box.max[1], y)];
    }
    for (const c of [f.clip, area].filter(Boolean)) box.min = [Math.max(box.min[0], c.min[0]), Math.max(box.min[1], c.min[1])], box.max = [Math.min(box.max[0], c.max[0]), Math.min(box.max[1], c.max[1])];
    return box.min[0] <= box.max[0] && box.min[1] <= box.max[1] ? box : null;
  };
  const all = [...a, ...b].map((f) => ({ f, box: boxOf(f) })).filter((x) => x.box);
  const total = all.reduce((sum, { box }) => sum + (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]), 0);
  const cell = Math.max(0.05, Math.sqrt(total / 2e5));
  const cells = new Set();
  for (const { box } of all) {
    for (let i = Math.floor(box.min[0] / cell); i <= Math.floor(box.max[0] / cell); i++) {
      for (let j = Math.floor(box.min[1] / cell); j <= Math.floor(box.max[1] / cell); j++) cells.add(i * 1e7 + j);
    }
  }
  const boxesA = a.map(boxOf), boxesB = b.map(boxOf);
  const hit = (list, boxes, p) => list.some((f, i) => boxes[i] && inBox(p, boxes[i]) && insideFill(p, f));
  let na = 0, nb = 0, both = 0;
  for (const key of cells) {
    const i = Math.round(key / 1e7), j = key - i * 1e7;
    const p = [(i + 0.382) * cell, (j + 0.382) * cell]; // 升の中の半端な位置（きりのよい座標の縁にちょうど乗らないように）
    const ia = hit(a, boxesA, p), ib = hit(b, boxesB, p);
    na += ia;
    nb += ib;
    both += ia && ib;
  }
  return { a: na, b: nb, both };
}

const TAU = 2 * Math.PI;
const sameAngle = (a, b) => Math.abs((((a - b) % TAU) + TAU + Math.PI) % TAU - Math.PI) < 1e-6;

/** 1 つのレイアウトを書いて読み直す → { precision, recall, texts: [合う, 元], points: [合う, 元], notes, bytes, failures } */
export function roundTrip(drawing, layout, { measure = null } = {}) {
  const shown = new Set(drawing.layers.keys());
  const { bytes, notes, plan } = drawingToSfc(drawing, layout, { measure, now: new Date("2026-10-10T00:00:00Z") });
  const back = readDrawing(bytes, "書き出し.sfc");
  const key = strokeKeys(notes); // 書く前と読み直しで共有する（破線の周期の代表）
  const before = expected(buildScene(drawing, layout), plan, measure, key);
  const after = actual(buildScene(back, back.layouts[0], { shown: new Set(back.layers.keys()) }), plan, key);
  const failures = [];
  const { width: W, height: H } = plan.sheet;
  const { fromSheet } = frames(plan);
  const area = { min: fromSheet([-W, -H]), max: fromSheet([2 * W, 2 * H]) }; // 用紙のまわり（図の中の座標）
  // 線: 種類ごと
  let hitW = 0, nW = 0, hitE = 0, nE = 0;
  const keys = new Set([...before.strokes.keys(), ...after.strokes.keys()]);
  for (const key of keys) {
    const exp = before.strokes.get(key) ?? [], act = after.strokes.get(key) ?? [];
    const m = match(exp, act, area);
    // 元の点（枠の中）が書いたものにあるか・書いたものの点が元にあるか
    hitE += m.hitB; nE += m.nb; // 書いたもの → 元
    hitW += m.hitA; nW += m.na; // 元 → 書いたもの
    if (m.na && m.hitA < m.na * (process.env.SXFW_STRICT ? 1 : 0.999)) failures.push(`線 ${key}: 元の ${(100 * m.hitA / m.na).toFixed(1)}% だけ書けた（書いたものに ${act.length} 本）`);
    if (m.nb && m.hitB < m.nb * (process.env.SXFW_STRICT ? 1 : 0.999)) failures.push(`線 ${key}: 書いたものの ${(100 * m.hitB / m.nb).toFixed(1)}% だけ元にある（元に ${exp.length} 本）`);
  }
  const fm = matchAreas(before.fills, after.fills, area);
  hitW += fm.both; nW += fm.a; hitE += fm.both; nE += fm.b;
  if (fm.a && fm.both < fm.a * (process.env.SXFW_STRICT ? 1 : 0.999)) failures.push(`塗り: 元の面の ${(100 * fm.both / fm.a).toFixed(1)}% だけ書けた`);
  if (fm.b && fm.both < fm.b * (process.env.SXFW_STRICT ? 1 : 0.999)) failures.push(`塗り: 書いた面の ${(100 * fm.both / fm.b).toFixed(1)}% だけ元にある`);
  // 文字: 揃えの基線の点・高さ・向き
  const used = new Set();
  let textHit = 0;
  for (const t of before.texts) {
    const i = after.texts.findIndex((u, j) => {
      if (used.has(j) || u.text !== t.text || !sameAngle(u.rotation, t.rotation) || Math.abs(u.h - t.h) > 1e-4 * Math.max(1, t.h)) return false;
      const d = (t.f - u.f) * u.len;
      return Math.hypot(u.x + d * Math.cos(u.rotation) - t.at[0], u.y + d * Math.sin(u.rotation) - t.at[1]) <= 1e-3 * Math.max(1, t.h);
    });
    if (i >= 0) {
      used.add(i);
      textHit++;
    } else if (failures.length < 50) failures.push(`文字「${t.text.slice(0, 20)}」(${t.at.map((v) => v.toFixed(2)).join(", ")}) が合わない`);
  }
  const pointHit = before.points.filter((p) => after.points.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4)).length;
  return {
    precision: nE ? hitE / nE : 1, recall: nW ? hitW / nW : 1, samples: [nW, nE],
    texts: [textHit, before.texts.length, after.texts.length], points: [pointHit, before.points.length, after.points.length],
    notes, plan, bytes, back, failures,
  };
}

/** 別の読み取り（ezsxf の to_dxf）で SFC を DXF に直し、こちらの読み直しと比べる（ezsxf が無ければ null） */
export function viaEzsxf(bytes, back, sheet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sxfw-"));
  const sfc = path.join(dir, "out.sfc"), dxf = path.join(dir, "out.dxf");
  fs.writeFileSync(sfc, bytes);
  // 読みの警告（決まりに反して捨てた図形など）は、捨てずに数えて出す
  const script = "import sys, json, ezsxf; w = ezsxf.parse_sfc(open(sys.argv[1], 'rb').read())['warnings']; ezsxf.to_dxf(sys.argv[1], sys.argv[2], strict=True); print(json.dumps(w))";
  const r = spawnSync("python3", ["-I", "-c", script, sfc, dxf], { encoding: "utf8" });
  try {
    if (r.status !== 0) return /No module named 'ezsxf'/.test(r.stderr) ? null : { error: r.stderr.trim().split("\n").at(-1) };
    const other = readDrawing(new Uint8Array(fs.readFileSync(dxf)), "out.dxf");
    const warnings = JSON.parse(r.stdout.trim().split("\n").at(-1) || "[]").map((w) => w.message ?? String(w));
    return { ...compareDrawings(back, other, { area: { min: [-sheet.width, -sheet.height], max: [2 * sheet.width, 2 * sheet.height] } }), warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const out = option("--out");
  const verbose = args.includes("--verbose"), ez = args.includes("--ezsxf");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out").flatMap((a) => (fs.statSync(a).isDirectory() ? walk(a) : [a]))
    .filter((f) => /\.(dwg|dxf|jww|sfc|p21|pdf)$/i.test(f));
  if (out) fs.mkdirSync(out, { recursive: true });
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  let worst = { precision: 1, recall: 1, texts: 1, points: 1 }, total = 0, failed = 0;
  for (const file of files) {
    let drawing;
    try {
      drawing = readDrawing(new Uint8Array(fs.readFileSync(file)), file);
    } catch {
      continue;
    }
    for (const layout of drawing.layouts) {
      total++;
      let r;
      try {
        r = roundTrip(drawing, layout);
      } catch (error) {
        failed++;
        console.log(`${path.relative(process.cwd(), file)} [${layout.name}]  失敗: ${error.stack}`);
        continue;
      }
      const ratio = ([hit, n]) => (n ? hit / n : 1);
      worst = { precision: Math.min(worst.precision, r.precision), recall: Math.min(worst.recall, r.recall), texts: Math.min(worst.texts, ratio(r.texts)),
        points: Math.min(worst.points, ratio(r.points)) };
      const sheet = r.plan.sheet;
      let line = `${path.relative(process.cwd(), file)} [${layout.name}]  余計に書かない ${pct(r.precision)}・書き漏らさない ${pct(r.recall)}・文字 ${r.texts[0]}/${r.texts[1]}・点 ${r.points[0]}/${r.points[1]}` +
        `  用紙 ${sheet.type === 9 ? `${sheet.width}×${sheet.height}` : `A${sheet.type}`}${r.plan.figure ? ` 1:${Math.round(1 / r.plan.figure.ratio)}` : ""}  ${(r.bytes.length / 1024).toFixed(0)} KB`;
      if (ez) {
        const e = viaEzsxf(r.bytes, r.back, r.plan.sheet);
        line += e === null ? "  ezsxf なし" : e.error ? `  ezsxf 失敗: ${e.error}` :
          `  ezsxf ${pct(e.precision)}/${pct(e.recall)} 文字 ${e.texts.join("/")}${e.warnings.length ? `  ezsxf の警告 ${e.warnings.length}: ${e.warnings[0]}` : ""}`;
      }
      console.log(line);
      for (const f of r.failures.slice(0, verbose ? Infinity : 3)) console.log(`  ${f}`);
      if (verbose) for (const n of sfcNotes(r.notes)) console.log(`  ・${n}`);
      if (out) fs.writeFileSync(path.join(out, `${path.basename(file).replace(/\.[^.]+$/, "")}_${layout.name.replace(/[\\/:*?"<>|]/g, "_")}.sfc`), r.bytes);
    }
  }
  console.log(`\n${total} レイアウト（失敗 ${failed}）: 最も低い 余計に書かない ${pct(worst.precision)}・書き漏らさない ${pct(worst.recall)}・` +
    `文字 ${pct(worst.texts)}・点 ${pct(worst.points)}`);
}
