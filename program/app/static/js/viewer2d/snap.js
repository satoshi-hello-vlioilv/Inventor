// 測るときに吸い付く点を探す（DOM に依存しない）。scene.js の snaps（端点・中点・中心・四分点・点）と、近くの線分どうしの交点。
//   const snapper = new SnapIndex(scene, hit)   … hit は viewer2d/hit.js の HitIndex（交点を求める線分を借りる）
//   snapper.find(x, y, tolerance) → { x, y, kind, item } | null（tolerance は図面の単位。吸い付く点が無ければ、線の上の一番近い点 kind "near"）
//   measure(a, b, scale) → { distance, dx, dy, angle }（scale … 画層の縮尺（実寸 = 図面の長さ × scale）。angle は +x から反時計回りの度 0〜360 未満）
// 選ぶ順: 近さ（許容に対する比）に、点の種類の重み（端点・交点・中心・点 0、中点 0.2、四分点 0.3）を足した小さいもの。

import { distanceToSegment } from "./hit.js";

export const SNAP_LABEL = { end: "端点", mid: "中点", center: "中心", quad: "四分点", node: "点", int: "交点", near: "線上" };
const WEIGHT = { end: 0, int: 0, center: 0, node: 0, mid: 0.2, quad: 0.3 };
const GRID = 256;
const MAX_SEGMENTS = 400; // 交点を求める線分の数の上限（込み入った所で重くしない）

export class SnapIndex {
  constructor(scene, hit) {
    this.hit = hit;
    this.snaps = scene.snaps ?? [];
    const ext = scene.extents ?? { min: [0, 0], max: [1, 1] };
    this.min = ext.min;
    this.cell = Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1], 1e-9) / GRID;
    this.cells = new Map();
    this.snaps.forEach((s, index) => {
      const k = this.#key(...this.#cellOf(s.x, s.y));
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)).push(index);
    });
  }

  #cellOf(x, y) {
    return [Math.floor((x - this.min[0]) / this.cell), Math.floor((y - this.min[1]) / this.cell)];
  }

  #key(i, j) {
    return i * 100003 + j;
  }

  find(x, y, tolerance) {
    let best = null, bestScore = Infinity;
    const consider = (px, py, kind, item) => {
      const d = Math.hypot(px - x, py - y);
      if (d > tolerance) return;
      const score = d / tolerance + WEIGHT[kind];
      if (score < bestScore) [best, bestScore] = [{ x: px, y: py, kind, item }, score];
    };
    const inside = (clip) => !clip || (x >= clip.min[0] && x <= clip.max[0] && y >= clip.min[1] && y <= clip.max[1]);
    const [i0, j0] = this.#cellOf(x - tolerance, y - tolerance);
    const [i1, j1] = this.#cellOf(x + tolerance, y + tolerance);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) <= 4096) {
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (const index of this.cells.get(this.#key(i, j)) ?? []) {
            const s = this.snaps[index];
            if (inside(s.clip)) consider(s.x, s.y, s.kind, s.item);
          }
        }
      }
    } else for (const s of this.snaps) if (inside(s.clip)) consider(s.x, s.y, s.kind, s.item);
    // 交点: 近くを通る線分どうし（同じ線の中の線分どうしは除く: 曲線を細かく刻んだ線分の継ぎ目を交点にしない）
    const near = this.hit.segmentsNear(x, y, tolerance)
      .filter((g) => inside(g[7]) && distanceToSegment(x, y, g[0], g[1], g[2], g[3]) <= tolerance).slice(0, MAX_SEGMENTS);
    for (let a = 0; a < near.length; a++) {
      for (let b = a + 1; b < near.length; b++) {
        if (near[a][5] === near[b][5]) continue;
        const p = intersect(near[a], near[b]);
        if (p) consider(p[0], p[1], "int", near[a][4]);
      }
    }
    if (best) return best;
    // 吸い付く点が無ければ、一番近い線の上の点
    let nearest = null, nearestDistance = Infinity;
    for (const g of near) {
      const [ax, ay, bx, by] = g;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const p = [ax + dx * t, ay + dy * t], d = Math.hypot(p[0] - x, p[1] - y);
      if (d < nearestDistance) [nearest, nearestDistance] = [{ x: p[0], y: p[1], kind: "near", item: g[4] }, d];
    }
    return nearest;
  }
}

/** 2 つの線分の交点（端を含む。平行なら null） */
function intersect([ax, ay, bx, by], [cx, cy, dx, dy]) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  const e = 1e-9;
  return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e ? [ax + rx * t, ay + ry * t] : null;
}

/** 2 点の間（a → b） */
export function measure(a, b, scale = 1) {
  const dx = (b.x - a.x) * scale, dy = (b.y - a.y) * scale;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { distance: Math.hypot(dx, dy), dx, dy, angle };
}
