// 編集の土台（edit/）の評価: 取り消し・やり直し（まとめる・覚える数・保存した時点）と、選んでいるもの
import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "../../app/static/js/edit/history.js";
import { Selection } from "../../app/static/js/edit/selection.js";

/** 値 1 つを直す命令（取り消しで前の値に戻る） */
function setter(state, value, key = "v") {
  const before = state.v;
  return { label: `v を ${value} に`, key, apply: () => { state.v = value; }, revert: () => { state.v = before; } };
}

test("取り消し・やり直し: 行う → 戻す → やり直す。新しく行うと、やり直しの列は消える", () => {
  const state = { v: 0 };
  let changes = 0;
  const history = new History({ onChange: () => changes++ });
  assert.deepEqual([history.canUndo, history.canRedo, history.undo(), history.redo()], [false, false, false, false]);
  history.run(setter(state, 1));
  history.run(setter(state, 2));
  assert.equal(history.undoLabel, "v を 2 に");
  assert.ok(history.undo());
  assert.deepEqual([state.v, history.redoLabel, history.canRedo], [1, "v を 2 に", true]);
  assert.ok(history.redo());
  assert.equal(state.v, 2);
  history.undo();
  history.run(setter(state, 5));
  assert.deepEqual([state.v, history.canRedo], [5, false]);
  history.undo();
  history.undo();
  assert.equal(state.v, 0);
  assert.equal(changes, 8);
});

test("取り消し・やり直し: 同じものを続けて直すと 1 つにまとめ（打ち続けた数の欄）、取り消すと最初の値へ戻る", () => {
  const state = { v: 10 };
  const history = new History();
  for (const v of [1, 12, 120]) history.run(setter(state, v, "長さ"), { merge: true });
  history.run(setter(state, 7, "幅"), { merge: true });
  assert.equal(state.v, 7);
  history.undo();
  assert.equal(state.v, 120);
  history.undo();
  assert.deepEqual([state.v, history.canUndo], [10, false]);
  history.redo();
  assert.equal(state.v, 120);
});

test("取り消し・やり直し: 覚える数を超えたら古いものから忘れる", () => {
  const state = { v: 0 };
  const history = new History({ limit: 3 });
  for (let v = 1; v <= 5; v++) history.run(setter(state, v, String(v)));
  let undone = 0;
  while (history.undo()) undone++;
  assert.deepEqual([undone, state.v], [3, 2]);
});

test("保存した時点: 変わったか（dirty）は、取り消して保存したときに戻れば消え、保存した命令にはまとめない", () => {
  const state = { v: 0 };
  const history = new History({ limit: 3 });
  assert.equal(history.dirty, false);
  history.run(setter(state, 1, "長さ"), { merge: true });
  assert.equal(history.dirty, true);
  history.markSaved();
  assert.equal(history.dirty, false);
  history.run(setter(state, 2, "長さ"), { merge: true }); // 保存した命令とはまとめない（まとめると、保存した時点に戻れない）
  assert.equal(history.dirty, true);
  history.undo();
  assert.deepEqual([state.v, history.dirty], [1, false]);
  history.undo();
  assert.equal(history.dirty, true);
  history.redo();
  assert.equal(history.dirty, false);
  // 保存の後で、別の命令に置き換わったら（取り消して別の値）変わった
  history.undo();
  history.run(setter(state, 9, "幅"));
  assert.equal(history.dirty, true);
  // 覚える数を超えて保存した時点を忘れても、変わったと答える
  history.markSaved();
  for (let v = 0; v < 4; v++) history.run(setter(state, v, String(v)));
  while (history.undo());
  assert.equal(history.dirty, true);
  history.clear();
  assert.deepEqual([history.dirty, history.canUndo, history.canRedo], [false, false, false]);
});

test("選んでいるもの: 選び直す・足す・切り替える・外す。変わったときだけ知らせる", () => {
  const seen = [];
  const selection = new Selection({ onChange: (s) => seen.push(s.items) });
  assert.equal(selection.set([3, 1]), true);
  assert.equal(selection.set([1, 3]), false); // 同じ集まり
  selection.add([2, 3]);
  selection.toggle(1);
  selection.toggle(9);
  assert.deepEqual([selection.size, selection.has(1), selection.has(9)], [3, false, true]);
  selection.clear();
  assert.equal(selection.clear(), false);
  assert.deepEqual(seen, [[3, 1], [3, 1, 2], [3, 2], [3, 2, 9], []]);
});
