// 図面の 3D ソリッドの一覧の木（viewer/describe.js の describeSolidTree。利用者が選んだ案 H）の評価:
//   1. 同じブロックの参照は、向きが違って外形の大きさが変わっても、形のデータが同じなら 1 行（×n）にまとまる
//   2. ブロックに入っていない立体は 1 つの枝に入り、外形の対角の大きい順（平らな大きい面も前）、同じ大きさは 1 行（×n）
//   3. 入れ子のブロック・ブロックが無い図面（枝を作らない）・葉の id が全ての立体をちょうど 1 回ずつ含む
//   4. 消す: 枝を消すと、まとめた全ての参照の立体が消える（hiddenIds）
// 実物の確かめ（Autodesk の見本の DWG。リポジトリには入れない）は docs/ui.md §18
import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenIds } from "../../app/static/js/ui/tree.js";
import { describeSolidTree } from "../../app/static/js/viewer/describe.js";

/** 部品と行（describeMeshes の groups の形）を作る。solids: [label, path, size, shape] */
function scene(solids) {
  const parts = solids.map(([label, path, size, shape], i) => ({ name: label, faces: 12, ids: [`3d:${i}:0`], solid: { label, layer: "0", path, size, shape } }));
  const groups = parts.map((p, i) => ({ key: `mesh:${i}`, ids: p.ids }));
  return { parts, groups };
}
const ref = (block, handle, index = 0) => ({ block, handle, index });
const leaves = (nodes) => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n]));
const ids = (nodes) => leaves(nodes).flatMap((n) => n.ids).sort();

test("同じブロックの参照は、向きで外形が変わっても形のデータが同じなら 1 行（×n）", () => {
  const s = scene([
    ["3D ソリッド 1", [ref("Seat", "A1")], [356, 438, 239], 0],
    ["3D ソリッド 2", [ref("Seat", "A1")], [50, 50, 412], 1],
    ["3D ソリッド 3", [ref("Seat", "A2")], [510, 538, 239], 0], // 回した椅子（外形は違うが同じ形のデータ）
    ["3D ソリッド 4", [ref("Seat", "A2")], [50, 50, 412], 1],
    ["3D ソリッド 5", [ref("Table", "B1")], [621, 621, 650], 2],
  ]);
  const { nodes, outside } = describeSolidTree(s);
  assert.equal(outside, null, "ブロックの外の立体が無ければ、その枝を作らない");
  assert.deepEqual(nodes.map((n) => `${n.name} ×${n.count} ${n.sub}`), ["Seat ×2 ブロック · 中のソリッド 2", "Table ×1 ブロック · 中のソリッド 1"]);
  assert.deepEqual(nodes[0].children.map((c) => c.ids), [["3d:0:0", "3d:2:0"], ["3d:1:0", "3d:3:0"]], "ブロックの中の行は、まとめた全ての参照の立体を持つ");
  assert.deepEqual(ids(nodes), s.parts.flatMap((p) => p.ids).sort());
});

test("ブロックの外: 1 つの枝に、外形の対角の大きい順（平らな大きい面も前）、同じ大きさは 1 行", () => {
  const s = scene([
    ["3D ソリッド 1", [], [233, 283, 195], 0],
    ["平面サーフェス 2", [], [18459, 13278, 0], 1], // 体積は 0 だが大きい地面
    ["3D ソリッド 3", [], [233, 283, 195], 2],
    ["3D ソリッド 4", [], [340, 340, 340], 3],
    ["3D ソリッド 5", [ref("Lamp", "C1")], [42, 914, 42], 4],
  ]);
  const { nodes, outside } = describeSolidTree(s);
  const loose = nodes.find((n) => n.key === outside);
  assert.equal(loose.name, "ブロックに入っていないソリッド");
  assert.equal(loose.sub, "4 個 · 大きさ 3 種類 · 大きい順");
  assert.deepEqual(loose.children.map((c) => `${c.name}${c.count ? ` ×${c.count}` : ""}`), ["18,459 × 13,278 × 0 mm", "340 × 340 × 340 mm", "233 × 283 × 195 mm ×2"]);
  assert.equal(loose.children[2].sub, "3D ソリッド 2 個 · 同じ大きさ");
  assert.deepEqual(ids(nodes), s.parts.flatMap((p) => p.ids).sort());
});

test("入れ子のブロック: 中のブロックも木になり、数は親 1 つあたり。消すと、まとめた全ての立体が消える", () => {
  const s = scene([
    ["3D ソリッド 1", [ref("Room", "R1"), ref("Chair", "C1")], [500, 500, 900], 0],
    ["3D ソリッド 2", [ref("Room", "R1"), ref("Chair", "C2")], [500, 500, 900], 0],
    ["3D ソリッド 3", [ref("Room", "R1")], [4000, 3000, 10], 1],
    ["3D ソリッド 4", [ref("Room", "R2"), ref("Chair", "C3")], [500, 500, 900], 0],
    ["3D ソリッド 5", [ref("Room", "R2"), ref("Chair", "C4")], [500, 500, 900], 0],
    ["3D ソリッド 6", [ref("Room", "R2")], [4000, 3000, 10], 1],
    ["3D ソリッド 7", [], [8000, 6000, 3000], 2],
  ]);
  const { nodes, outside } = describeSolidTree(s);
  const room = nodes[0];
  assert.deepEqual([room.name, room.count, room.sub], ["Room", 2, "ブロック · 中のソリッド 3"]);
  assert.deepEqual(room.children.map((c) => `${c.name}${c.count ? ` ×${c.count}` : ""}`), ["Chair ×2", "3D ソリッド 3"]);
  assert.deepEqual(ids(nodes), s.parts.flatMap((p) => p.ids).sort());
  const state = { open: new Set([outside]), hidden: new Set([room.key]) };
  assert.deepEqual(hiddenIds(nodes, state).sort(), ["3d:0:0", "3d:1:0", "3d:2:0", "3d:3:0", "3d:4:0", "3d:5:0"]);
});

test("3D ソリッドでない部品（3D の PDF）は木にしない", () => {
  assert.equal(describeSolidTree({ groups: [{ key: "mesh:0", ids: ["3d:0:0"] }], parts: [{ name: "Box", faces: 12, ids: ["3d:0:0"] }] }), null);
});
