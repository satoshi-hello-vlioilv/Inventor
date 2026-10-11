// 新旧の図面を比べた結果（formats/cad2d/compare.js）を、1 つの描くもの（scene.js の形）に重ねる。表示は DrawingViewer のまま使える。
//   compareScene(olderScene, newerScene, result, palette) → 描くもの ＋ { sides: [{ side: "newer"|"older", status, compared }] }
//     新版の図形を、比べた結果の色で描く（同じ = 控えめな色・足した・変わった）。旧版からは、消した図形と、変わった図形の前の形を足す
//     palette … { same, added, changed, removed, before }（"#rrggbb"。before は変わった図形の前の形）
//     sides[i] … 描くものの図形 i（items[i]）がどちらの版の図形か、その比べた結果（status）と、結果の項目（compared）
//   旧版の図形の番号は、新版の図形の後ろに続ける（指した図形 → sides で結果の項目が分かる）。

const KINDS = ["strokes", "fills", "texts", "points", "images", "regions", "snaps"];

/** 図形 → 比べた結果の項目（版ごと） */
function itemsBySide(result) {
  const older = new Map(), newer = new Map();
  for (const x of result.items) {
    if (x.older) older.set(x.older, x);
    if (x.newer) newer.set(x.newer, x);
  }
  return { older, newer };
}

/**
 * 重ねた描くもの
 * @param {object} olderScene 旧版の描くもの（buildScene）
 * @param {object} newerScene 新版の描くもの
 * @param {{ items }} result compareDrawings の結果
 * @param {{ same, added, changed, removed, before }} palette
 */
export function compareScene(olderScene, newerScene, result, palette) {
  const by = itemsBySide(result);
  const sides = [];
  const colorOf = { same: palette.same, added: palette.added, changed: palette.changed, removed: palette.removed };
  // 描くものの図形の番号 → 新しい番号と色（描かない図形は null）
  const plan = (scene, side, offset) => scene.items.map((it, i) => {
    // ビューポートの中の図形・ブロックの中の図形も、レイアウトに直に置かれた図形（entity）の単位で比べた結果を引く
    const compared = by[side].get(it.entity) ?? null;
    const status = compared?.status ?? "same";
    if (side === "older" && status !== "removed" && status !== "changed") return null; // 旧版からは、消した図形と前の形だけ
    sides[offset + i] = { side, status, compared };
    return { index: offset + i, color: side === "older" && status === "changed" ? palette.before : colorOf[status] };
  });
  const newerPlan = plan(newerScene, "newer", 0);
  const olderPlan = plan(olderScene, "older", newerScene.items.length);

  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  const strokes = new Map();
  let z = 0;
  const take = (scene, p, under) => {
    for (const s of scene.strokes) {
      for (const line of s.lines) {
        const to = p[line.item];
        if (!to) continue;
        const key = `${to.color}|${s.lineweight}|${s.dashes?.join(",") ?? ""}`;
        if (!strokes.has(key)) strokes.set(key, { color: to.color, lineweight: s.lineweight, dashes: s.dashes, lines: [] });
        strokes.get(key).lines.push({ ...line, item: to.index, z: (line.z ?? 0) + z });
      }
    }
    for (const kind of ["fills", "texts", "points"]) {
      for (const x of scene[kind] ?? []) {
        const to = p[x.item];
        if (to) out[kind].push({ ...x, item: to.index, color: to.color, z: (x.z ?? 0) + z, ...(kind === "fills" && { alpha: Math.min(x.alpha ?? 1, under ? 0.35 : 0.6) }) });
      }
    }
    // 画像（PDF）は色を変えられないので、そのまま（消した・前の形の画像は描かない）
    if (!under) for (const x of scene.images ?? []) if (p[x.item]) out.images.push({ ...x, item: p[x.item].index, z: (x.z ?? 0) + z });
    for (const kind of ["regions", "snaps"]) for (const x of scene[kind] ?? []) if (p[x.item]) out[kind].push({ ...x, item: p[x.item].index });
    z += 1e6;
  };
  take(olderScene, olderPlan, true); // 旧版の消した図形・前の形を下に、新版を上に描く
  take(newerScene, newerPlan, false);
  out.strokes = [...strokes.values()];

  const items = [...newerScene.items, ...olderScene.items];
  const boxes = [newerScene.extents, olderScene.extents].filter(Boolean);
  const extents = boxes.length ? { min: [Math.min(...boxes.map((b) => b.min[0])), Math.min(...boxes.map((b) => b.min[1]))],
    max: [Math.max(...boxes.map((b) => b.max[0])), Math.max(...boxes.map((b) => b.max[1]))] } : null;
  const layers = new Map(newerScene.layers);
  for (const [name, n] of olderScene.layers) layers.set(name, Math.max(layers.get(name) ?? 0, n));
  return { ...out, items, sides, extents, layers, broken: newerScene.broken, unsupported: newerScene.unsupported,
    ordered: true, exact: Boolean(newerScene.exact), paper: newerScene.paper ?? olderScene.paper ?? null };
}

/**
 * 違いのまとまり（近くの違いを 1 つにまとめ、図面の改訂の印のように番号を振る）→ [{ number, items, box: { min, max }, statuses }]
 *   boundsOf(items) … 描いた結果の外形（DrawingViewer の boundsOf）。gap … まとめる距離（図面の座標。外形どうしの隙間がこれ以下なら 1 つ）
 *   並びは左上から右下へ（図面を読む順）
 */
export function differenceRegions(scene, boundsOf, gap) {
  const boxes = [];
  scene.sides.forEach((side, i) => {
    if (!side || side.status === "same") return;
    const box = boundsOf([i]);
    if (box) boxes.push({ items: [i], box, statuses: new Set([side.status]) });
  });
  const near = (a, b) => a.min[0] - gap <= b.max[0] && b.min[0] - gap <= a.max[0] && a.min[1] - gap <= b.max[1] && b.min[1] - gap <= a.max[1];
  // 重なる・近いまとまりを、変わらなくなるまで合わせる
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!near(boxes[i].box, boxes[j].box)) continue;
        const [a, b] = [boxes[i], boxes[j]];
        a.items.push(...b.items);
        b.statuses.forEach((s) => a.statuses.add(s));
        a.box = { min: [Math.min(a.box.min[0], b.box.min[0]), Math.min(a.box.min[1], b.box.min[1])], max: [Math.max(a.box.max[0], b.box.max[0]), Math.max(a.box.max[1], b.box.max[1])] };
        boxes.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  const rows = (r) => Math.round(-(r.box.max[1]) / Math.max(gap * 4, 1e-9)); // 上の行から
  boxes.sort((a, b) => rows(a) - rows(b) || a.box.min[0] - b.box.min[0]);
  return boxes.map((r, k) => ({ number: k + 1, ...r }));
}

/** 改訂雲（外形の周りを、外へふくらむ弧でつないだ線）の点の並び [x, y, x, y, …]。arc … 弧の弦の長さ（図面の座標） */
export function cloudOutline({ min, max }, arc) {
  const pad = arc * 0.6;
  const corners = [[min[0] - pad, min[1] - pad], [max[0] + pad, min[1] - pad], [max[0] + pad, max[1] + pad], [min[0] - pad, max[1] + pad]];
  const out = [];
  for (let k = 0; k < 4; k++) {
    const [a, b] = [corners[k], corners[(k + 1) % 4]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / arc));
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const [nx, ny] = [uy, -ux]; // 外向き（反時計回りの辺の右）
    for (let s = 0; s < n; s++) {
      const [p, q] = [[a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n], [a[0] + ((b[0] - a[0]) * (s + 1)) / n, a[1] + ((b[1] - a[1]) * (s + 1)) / n]];
      const h = (len / n) * 0.35; // ふくらみ
      for (let t = 0; t < 6; t++) {
        const u = t / 6, bump = Math.sin(Math.PI * u) * h;
        out.push(p[0] + (q[0] - p[0]) * u + nx * bump, p[1] + (q[1] - p[1]) * u + ny * bump);
      }
    }
  }
  out.push(out[0], out[1]);
  return out;
}
