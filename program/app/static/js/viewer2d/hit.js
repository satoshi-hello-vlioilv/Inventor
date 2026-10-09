// 指した点に近い図形を探す索引（DOM に依存しない）。scene.js の描くもの（線・塗り・文字・点）から作る。
//   const index = new HitIndex(scene); index.find(x, y, tolerance) → items の番号 | null・index.has(番号) → 描いた（指せる）図形か（隠した画層の図形は false）
// 線分は一様な格子に入れる（格子の幅は外形の 1/256）。格子を多くまたぐ長い線分（放射線など）は別に持ち、毎回調べる。
// 近さ: 線分・点は距離、文字は内側なら 0、塗り（ハッチング・塗り潰し）は内側なら許容の半分（境界の線のほうを先に拾う）。
// 同じ近さなら後に描いたもの（上にあるもの）を選ぶ。

const GRID = 256;
const MAX_CELLS = 1024; // 1 本の線分が入る格子の数の上限（越えたら「長い線分」として毎回調べる）

export class HitIndex {
  constructor(scene) {
    const ext = scene.extents ?? { min: [0, 0], max: [1, 1] };
    this.min = ext.min;
    this.cell = Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1], 1e-9) / GRID;
    this.cells = new Map();
    this.long = [];
    this.segments = []; // [x0, y0, x1, y1, item, order]
    this.areas = []; // { item, order, rings, box, clip? }（塗り・文字の外形）
    this.drawn = new Set(); // 線・塗り・文字・点のどれかを描いた図形の番号
    let order = 0;
    for (const s of scene.strokes) {
      for (const line of s.lines) {
        const p = line.points;
        const pad = (line.width ?? 0) / 2;
        for (let i = 0; i + 3 < p.length; i += 2) this.#addSegment([p[i], p[i + 1], p[i + 2], p[i + 3], line.item, order, pad, line.clip]);
        order++;
      }
    }
    for (const f of [...scene.fills, ...(scene.regions ?? [])]) this.#addArea(f.item, order++, f.rings, f.clip, 0.5);
    for (const t of scene.texts) this.#addArea(t.item, order++, [textOutline(t)], t.clip, 0);
    for (const pt of scene.points) this.#addSegment([pt.x, pt.y, pt.x, pt.y, pt.item, order++, 0, pt.clip]);
  }

  #key(i, j) {
    return i * 100003 + j;
  }

  has(item) {
    return this.drawn.has(item);
  }

  #addSegment(seg) {
    this.drawn.add(seg[4]);
    const index = this.segments.length;
    this.segments.push(seg);
    const [i0, j0] = this.#cellOf(Math.min(seg[0], seg[2]), Math.min(seg[1], seg[3]));
    const [i1, j1] = this.#cellOf(Math.max(seg[0], seg[2]), Math.max(seg[1], seg[3]));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) {
      this.long.push(index);
      return;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.#key(i, j);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(index);
      }
    }
  }

  /** 塗り・文字の外形。inside: 内側のときの近さ（許容に対する比） */
  #addArea(item, order, rings, clip, inside) {
    // 外形（点が多い塗りでも、引数の並べ過ぎにならないように数えて求める）
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < x0) x0 = r[i];
        if (r[i] > x1) x1 = r[i];
        if (r[i + 1] < y0) y0 = r[i + 1];
        if (r[i + 1] > y1) y1 = r[i + 1];
      }
    }
    if (!(x0 <= x1)) return;
    this.drawn.add(item);
    this.areas.push({ item, order, rings, clip, inside, box: [x0, y0, x1, y1] });
  }

  #cellOf(x, y) {
    return [Math.floor((x - this.min[0]) / this.cell), Math.floor((y - this.min[1]) / this.cell)];
  }

  /** (x, y) の周り radius の内を通るかもしれない線分 [ax, ay, bx, by, item, …]（格子で絞るだけ。交点を求めるのに使う） */
  segmentsNear(x, y, radius) {
    const [i0, j0] = this.#cellOf(x - radius, y - radius);
    const [i1, j1] = this.#cellOf(x + radius, y + radius);
    const found = new Set(this.long);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) <= 4 * MAX_CELLS) {
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const index of this.cells.get(this.#key(i, j)) ?? []) found.add(index);
    }
    return [...found].map((index) => this.segments[index]);
  }

  /** (x, y) から tolerance（図面の単位）の内で最も近い図形の番号 */
  find(x, y, tolerance) {
    let best = null, bestDistance = Infinity, bestOrder = -1;
    const consider = (item, distance, order) => {
      if (distance > tolerance) return;
      if (distance < bestDistance - 1e-12 || (Math.abs(distance - bestDistance) <= 1e-12 && order > bestOrder)) {
        best = item;
        bestDistance = distance;
        bestOrder = order;
      }
    };
    const inside = (clip) => !clip || (x >= clip.min[0] && x <= clip.max[0] && y >= clip.min[1] && y <= clip.max[1]);
    const [i0, j0] = this.#cellOf(x - tolerance, y - tolerance);
    const [i1, j1] = this.#cellOf(x + tolerance, y + tolerance);
    const seen = new Set();
    const check = (index) => {
      if (seen.has(index)) return;
      seen.add(index);
      const [ax, ay, bx, by, item, order, pad, clip] = this.segments[index];
      if (inside(clip)) consider(item, Math.max(0, distanceToSegment(x, y, ax, ay, bx, by) - pad), order);
    };
    if ((i1 - i0 + 1) * (j1 - j0 + 1) <= 4 * MAX_CELLS) {
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const index of this.cells.get(this.#key(i, j)) ?? []) check(index);
    } else for (const list of this.cells.values()) for (const index of list) check(index);
    for (const index of this.long) check(index);
    for (const a of this.areas) {
      if (x < a.box[0] || x > a.box[2] || y < a.box[1] || y > a.box[3] || !inside(a.clip)) continue;
      if (insideRings(x, y, a.rings)) consider(a.item, a.inside * tolerance, a.order);
    }
    return best;
  }
}

export function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

/** 偶奇の規則で内側か（rings: [Float64Array(x, y, …)]） */
export function insideRings(x, y, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

/** 文字の外形の見積もり（回転した四角。幅 = 文字数 × 高さ × 0.8 × 幅の係数） */
export function textOutline(t) {
  const lines = t.lines.length || 1;
  const longest = Math.max(1, ...t.lines.map((l) => [...l].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 1.6 : 1), 0)));
  const w = t.fit?.length ?? (t.width > 0 ? Math.min(t.width, longest * t.height * 0.8) : longest * t.height * 0.8) * (t.widthFactor || 1);
  const lineHeight = t.height * (t.mtext ? (5 / 3) * (t.lineSpacing || 1) : 1);
  const h = t.height + lineHeight * (lines - 1);
  const x0 = t.align === "center" ? -w / 2 : t.align === "right" ? -w : 0;
  const top = t.valign === "top" ? 0 : t.valign === "middle" ? h / 2 : t.valign === "bottom" ? h : t.height;
  const corners = [[x0, top], [x0 + w, top], [x0 + w, top - h], [x0, top - h]];
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation), m = t.mirror ? -1 : 1;
  const out = new Float64Array(8);
  corners.forEach(([u, v], i) => {
    out[i * 2] = t.x + c * u * m - s * v;
    out[i * 2 + 1] = t.y + s * u * m + c * v;
  });
  return out;
}
