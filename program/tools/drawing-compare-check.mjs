// 図面の比べ（formats/cad2d/compare.js）の評価関数（開発用。試験 tests/js/compare2d.test.mjs が使う）。
//
//   node --import ./program/tests/js/importmap.mjs program/tools/drawing-compare-check.mjs [図面のファイル…]
//
// 同じ図面を 2 回読み、片方（新版）に決まった直し（edit/drawing.js の命令: 動かす・回す・消す・写す・画層を変える・文字を変える）を
// 当てて比べる。直した図形を全て見つけたか（見落とし）・直していない図形に印を付けなかったか（誤り）を、図形ごとに数える。
// 答えは「どの図形を直したか」（比べる仕組みとは別に、直す前に覚えておく）。
// ハンドルの扱いを変えて 3 通りに比べる:
//   keep     … ハンドルのまま（AutoCAD で直した図面）。直した図形の分け方（changed の中身・removed・added）も確かめる
//   renumber … 新版のハンドルを、旧版のハンドルを混ぜて振り直す（別のソフトで書き出した図面。同じ番号が別の図形を指す）
//   none     … 両方ともハンドル無し（PDF・Jw_cad・SXF。読み取りが順に振る番号は当てにならない）
// 同じ中身の図形が 2 つ以上あると、ハンドル無しではどちらを直したか見分けられないので、そういう図形は直す相手に選ばない。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
import { compareDrawings } from "../app/static/js/formats/cad2d/compare.js";
import { DrawingEdits } from "../app/static/js/edit/drawing.js";
import { similarity, transformEntity } from "../app/static/js/formats/cad2d/transform.js";

export const MODES = ["keep", "renumber", "none"];
const TEXTS = new Set(["TEXT", "MTEXT"]);

/** 決まった乱数（mulberry32） */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const layoutEntities = (d) => d.blocks.get(d.layouts[0].block).entities;
/** ハンドルを除いた中身（同じ中身の図形を見分けるため。比べる仕組みとは別の簡単な方法） */
const body = (e) => JSON.stringify(e, (k, v) => (k === "handle" ? undefined : ArrayBuffer.isView(v) ? v.length : v));

/** 図面の広がり（動かす量の物差し） */
function extent(entities) {
  let lo = Infinity, hi = -Infinity;
  const visit = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    else if (Array.isArray(v)) v.forEach(visit);
  };
  for (const e of entities) for (const k of ["a", "b", "p", "center", "points"]) if (e[k]) visit(e[k]);
  return Number.isFinite(hi - lo) && hi > lo ? hi - lo : 100;
}

/**
 * 新版に直しを当てる → 答え { older: Map<旧版の図形, 種類>, newer: Map<新版の図形, 種類> }（直していない図形は入らない）
 * 種類: moved・rotated・removed・layer・text・copied
 */
export function applyEdits(older, newer, seed = 1) {
  const rand = random(seed);
  const A = layoutEntities(older), B = layoutEntities(newer);
  const edits = new DrawingEdits();
  edits.open(newer);
  const counts = new Map();
  for (const e of A) counts.set(body(e), (counts.get(body(e)) ?? 0) + 1);
  // 直す相手: 直せる・中身が 1 つだけの図形（旧版と新版は同じ順に読める）
  const movable = (e) => {
    try {
      return edits.reason([e]) === null && Boolean(transformEntity(e, similarity({ move: [1, 0] })));
    } catch {
      return false; // 直せない向き（図面の面に平行でない図形）など
    }
  };
  const candidates = B.map((e, i) => i).filter((i) => counts.get(body(A[i])) === 1 && movable(B[i]));
  for (let i = candidates.length - 1; i > 0; i--) {
    const k = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[k]] = [candidates[k], candidates[i]];
  }
  const take = (n, ok = () => true) => {
    const out = [];
    for (let k = 0; k < candidates.length && out.length < n; k++) if (ok(B[candidates[k]])) out.push(...candidates.splice(k--, 1));
    return out;
  };
  const size = extent(A);
  const answer = { older: new Map(), newer: new Map() };
  const mark = (indexes, kind) => indexes.forEach((i) => { answer.older.set(A[i], kind); answer.newer.set(B[i], kind); });

  const moved = take(3);
  if (moved.length) edits.move(moved.map((i) => B[i]), [size * 0.137, -size * 0.071]);
  mark(moved, "moved");
  const rotated = take(2);
  for (const i of rotated) edits.rotate([B[i]], [size * 0.31, size * 0.27], 0.4);
  mark(rotated, "rotated");
  const otherLayer = (e) => [...newer.layers.values()].find((l) => l.name !== e.layer && !l.locked)?.name;
  const relayered = take(2, (e) => Boolean(otherLayer(e)));
  for (const i of relayered) edits.setLayer([B[i]], otherLayer(B[i]));
  mark(relayered, "layer");
  const retexted = take(2, (e) => TEXTS.has(e.type) && typeof e.text === "string");
  for (const i of retexted) edits.setText(B[i], `${B[i].text}（改）`);
  mark(retexted, "text");
  const copied = take(2);
  if (copied.length) for (const c of edits.copy(copied.map((i) => B[i]), [size * 0.213, size * 0.059])) answer.newer.set(c, "copied");
  const removed = take(3);
  for (const i of removed) answer.older.set(A[i], "removed");
  if (removed.length) edits.remove(removed.map((i) => B[i]));
  return answer;
}

/** ハンドルの扱いを変える（renumber・none） */
function rehandle(older, newer, mode, seed) {
  if (mode === "keep") return;
  const B = layoutEntities(newer);
  if (mode === "none") {
    for (const d of [older, newer]) { d.format = "pdf"; for (const e of layoutEntities(d)) e.handle = ""; }
    return;
  }
  // 旧版のハンドルを混ぜて振り直す（同じ番号が別の図形を指す）
  const rand = random(seed + 7);
  const handles = layoutEntities(older).map((e) => e.handle).filter(Boolean);
  for (let i = handles.length - 1; i > 0; i--) {
    const k = Math.floor(rand() * (i + 1));
    [handles[i], handles[k]] = [handles[k], handles[i]];
  }
  B.forEach((e, i) => (e.handle = handles[i] ?? `F${i.toString(16)}`));
}

/** 1 つの図面を、1 つの扱いで評価する → { misses, errors, wrongKind, edited, total, counts, notes } */
export async function checkCompare(bytes, name, mode = "keep", seed = 1) {
  const older = await readDrawing(bytes, name), newer = await readDrawing(bytes, name);
  const answer = applyEdits(older, newer, seed);
  rehandle(older, newer, mode, seed);
  const result = compareDrawings(older, newer);
  const flagged = { older: new Map(), newer: new Map() };
  for (const item of result.items) {
    if (item.older) flagged.older.set(item.older, item);
    if (item.newer) flagged.newer.set(item.newer, item);
  }
  let misses = 0, errors = 0, wrongKind = 0;
  const notes = [];
  for (const side of ["older", "newer"]) {
    for (const e of layoutEntities(side === "older" ? older : newer)) {
      const item = flagged[side].get(e);
      const kind = answer[side].get(e);
      const marked = item && item.status !== "same";
      if (kind && !marked) { misses++; notes.push(`見落とし（${side}・${kind}）: ${e.type} ${e.handle}`); }
      if (!kind && marked) { errors++; notes.push(`誤り（${side}・${item.status}）: ${e.type} ${e.handle}`); }
      if (kind && marked && mode === "keep" && result.byHandle && !kindAgrees(kind, item)) { wrongKind++; notes.push(`分け方（${kind} → ${item.status} ${item.changes ?? ""}）: ${e.type}`); }
    }
  }
  return { misses, errors, wrongKind, edited: answer.older.size + answer.newer.size, total: result.items.length, counts: result.counts, notes };
}

/** ハンドルのままのときの分け方の答え */
function kindAgrees(kind, item) {
  switch (kind) {
    case "moved": case "rotated": return item.status === "changed" && item.changes.includes("shape");
    case "layer": return item.status === "changed" && item.changes.join() === "props";
    case "text": return item.status === "changed" && item.changes.includes("text");
    case "removed": return item.status === "removed";
    case "copied": return item.status === "added";
    default: return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    for (const mode of MODES) {
      const r = await checkCompare(bytes, path.basename(file), mode);
      console.log(`${path.basename(file)} ${mode}: 直した ${r.edited}・見落とし ${r.misses}・誤り ${r.errors}・分け方の違い ${r.wrongKind}`, JSON.stringify(r.counts));
      for (const n of r.notes.slice(0, 8)) console.log("  ", n);
    }
  }
}
