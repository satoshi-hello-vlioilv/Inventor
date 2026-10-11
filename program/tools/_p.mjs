import fs from "node:fs";
import { readDrawing } from "../app/static/js/formats/cad2d/index.js";
const b = readDrawing(new Uint8Array(fs.readFileSync("/tmp/claude-0/-home-user-Inventor/b1ca0b8b-6a25-5e8d-8f6c-4d7e04d253ff/scratchpad/e2e/r12/o.dxf")), "o.dxf");
for (const [n, bl] of b.blocks) { const lw = bl.entities.filter((e) => e.type === "LWPOLYLINE"); if (lw.length) console.log(n, lw.length, Math.max(...lw.map((e) => e.points.length)), lw.filter(e=>e.points.length>10000).map(e=>[e.layer, e.closed, e.constWidth, JSON.stringify(e.points[0])])); }
console.log(b.failures.slice(0, 3), [...b.layers.values()].map((l) => [l.name, l.off, l.frozen]));
import { buildScene } from "../app/static/js/viewer2d/scene.js";
const sc = buildScene(b, b.layouts[0]);
console.log("broken", sc.broken, "items", sc.items.length, sc.items.filter((it) => it.entity.points?.length > 10000).map((it) => it.index));
const idx = sc.items.findIndex((it) => it.entity.points?.length > 10000);
console.log("strokes of it", sc.strokes.flatMap((s) => s.lines).filter((l) => l.item === idx).map((l) => l.points.length), "fills", sc.fills.filter((f) => f.item === idx).length);
const big = b.blocks.get("*Model_Space").entities.find((e) => e.points?.length > 10000);
const bad = big.points.map((p, i) => [i, p]).filter(([, p]) => !p.every(Number.isFinite));
console.log("bad", bad.length, bad.slice(0, 3), big.bulges?.length, big.bulges?.filter((x) => !Number.isFinite(x)).length);
