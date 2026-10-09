// 組立の構成の木（viewer/describe.js の describeStructure）と、消した行から消える部品（ui/tree.js の hiddenIds）の評価:
//   1. サブ組立のある STEP（Assembly_XY2）: 木の形・数（親 1 つあたり）・id（まとめた全ての出現）が、出現の道筋から数えた答えと合う
//   2. 全てのサンプルの組立: 木の葉の id を全て集めると、出現の全てがちょうど 1 回ずつ出る（数え漏れ・二重がない）
//   3. 消す: 親を消すと中の全ての部品が消え、葉を消すとその部品だけが消える。消した行を戻すと元に戻る
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIamScene, parseIam } from "../../app/static/js/formats/iam/index.js";
import { parseStepFile } from "../../app/static/js/formats/step/index.js";
import { hiddenIds } from "../../app/static/js/ui/tree.js";
import { describeAssembly, describeStructure } from "../../app/static/js/viewer/describe.js";
import { readSample, readSampleFile, sampleIams, sampleIpts, sampleSteps } from "./helpers.mjs";

const stepScene = (name) => parseStepFile(new TextDecoder().decode(readSampleFile("stp", name)), name).scene;
const structure = (scene) => describeStructure(scene, describeAssembly(scene, scene.parts.map(() => null)).groups);
const leaves = (nodes) => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n]));
const find = (nodes, name) => nodes.find((n) => n.name === name);
const sorted = (ids) => [...ids].sort((a, b) => a - b);

test("サブ組立のある STEP: 木の形・数（親 1 つあたり）・まとめた全ての出現の id", () => {
  const scene = stepScene("Assembly_XY2.stp");
  const { nodes, depth } = structure(scene);
  assert.equal(depth, 2);
  assert.deepEqual(nodes.map((n) => `${n.name} ×${n.count} (${n.children.map((c) => `${c.name} ×${c.count}`).join(", ")})`).sort(),
    ["Assembly_X2 ×2 (Part3_A_X ×1)", "Assembly_Y2 ×2 (Part3_A_Y ×1)", "JIS B 1176 - メートル M4 x 6 ×12 ()", "Plate ×6 ()"]);
  // 行の id は、道筋にその行の名前を通る出現の全て（出現の道筋から独立に数えた答え）
  for (const node of nodes) {
    const expected = scene.instances.filter((inst) => inst.path[0].replace(/:\d+$/, "") === node.name).map((inst) => inst.id);
    assert.deepEqual(sorted(node.ids), sorted(expected), node.name);
    for (const child of node.children) assert.deepEqual(sorted(child.ids), sorted(expected), `${node.name} の中の ${child.name}`);
  }
  // 部品の行は部品表の行（同じ部品の番号）を持つ。サブ組立の行は持たない
  for (const leaf of leaves(nodes)) assert.equal(leaf.group?.index, leaf.part, leaf.name);
  assert.ok(nodes.filter((n) => n.children.length).every((n) => n.group === null && n.part === null));
  assert.equal(new Set(leaves(nodes).concat(nodes).map((n) => n.key)).size, 6, "行の key は重ならない");
});

test("全てのサンプルの組立: 葉の id を集めると、全ての出現がちょうど 1 回ずつ出る", () => {
  const scenes = sampleSteps().map((name) => [name, stepScene(name)]);
  const available = new Set(sampleIpts());
  const resolve = (ref) => (available.has(ref.file) ? { name: ref.file, bytes: readSample(ref.file) } : null);
  for (const name of sampleIams()) scenes.push([name, buildIamScene(parseIam(readSampleFile("iam", name), name), name, resolve)]);
  assert.ok(scenes.length >= 3);
  for (const [name, scene] of scenes) {
    const { nodes, depth } = structure(scene);
    // 葉の id: まとめた行は全ての出現を持つので、数（×n）を掛けずに集めれば出現の数になる
    assert.deepEqual(sorted(leaves(nodes).flatMap((n) => n.ids)), sorted(scene.instances.map((i) => i.id)), name);
    assert.equal(depth, Math.max(1, ...scene.instances.map((i) => i.path?.length ?? 1)), `${name} の深さ`);
  }
});

test("消す: 親を消すと中の全てが消え、葉を消すとその部品だけ。戻すと元に戻る", () => {
  const scene = stepScene("Assembly_XY2.stp");
  const { nodes } = structure(scene);
  const state = { open: new Set(), hidden: new Set() };
  assert.deepEqual(hiddenIds(nodes, state), []);
  const x2 = find(nodes, "Assembly_X2"), plate = find(nodes, "Plate");
  state.hidden.add(x2.key);
  assert.deepEqual(sorted(hiddenIds(nodes, state)), sorted(x2.ids));
  state.hidden.add(x2.children[0].key); // 親が消えているので、子を消しても重ならない
  assert.deepEqual(sorted(hiddenIds(nodes, state)), sorted(x2.ids));
  state.hidden.add(plate.key);
  assert.deepEqual(sorted(hiddenIds(nodes, state)), sorted([...x2.ids, ...plate.ids]));
  state.hidden.delete(x2.key); // 親を戻しても、自分で消した子は消えたまま
  assert.deepEqual(sorted(hiddenIds(nodes, state)), sorted([...x2.children[0].ids, ...plate.ids]));
  state.hidden.clear();
  assert.deepEqual(hiddenIds(nodes, state), []);
});
