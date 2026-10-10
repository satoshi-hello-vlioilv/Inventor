// Inventor で直せる部品にするための、スケッチの拘束・寸法と名前つきの値の計画（変換データの部品ごと。DOM に依存しない）。
// ビルダー（ipt_build/inventor.py）がこの計画どおりに、幾何拘束・寸法拘束・ユーザー パラメータを Inventor に付ける。
//
//   parametricPlan(部品) → { params, constraints, dimensions, features, free } | null（近似の部品）
//     params      … ユーザー パラメータ [{ name, value, unit: "mm" | "deg", comment }]。名前は寸法の欄の id（D1.0 → D1_0）
//     constraints … 幾何拘束 [{ type: horizontal | vertical | tangent | parallel | onAxis, ... }]
//     dimensions  … 寸法拘束 [{ type: diameter | radius | length | angle | x | y, ..., value, text, expression?, name?, driven }]
//                   expression … 寸法の値の式（ユーザー パラメータの名前）。name … 式を持たない寸法のパラメータの名前
//                   driven … 参照寸法（ほかの寸法で決まる。値を見せるだけ）
//     features    … フィーチャの値の式 { distance?: "t", angle?: "a", chamfers: ["C0", …] }
//     free        … 拘束が足りない自由度の数（0 = 完全拘束）
//   solveSketch(部品, 計画, { 名前: 値 }) → 寸法を変えて拘束を解いた断面（評価用: 寸法の欄の直し方と突き合わせる）
//
// 選び方（数値で決める。形ごとの場合分けをしない）:
//   断面の点・円弧の中心・円の半径を変数にし、拘束 1 つを「0 になる式」1 本で表す。候補を下の順に並べ、
//   式の勾配（ヤコビ行列の行）がそれまでの行と独立なものだけを採る（重複する拘束は Inventor で「拘束が多すぎる」になる）。
//     1. 円弧の両端が中心から同じ距離（Inventor の円弧が元から持つ式。必ず入れる）
//     2. 幾何拘束: 水平・垂直・直線と円弧の接線・円弧どうしの接線・平行（斜めの辺）
//     3. 寸法の欄（convert/dimensions.js）の寸法: 角の丸み → 円の直径 → 回転体の直径 → 直線の長さ（丸みに接する直線は後）
//        採れなかった寸法は参照寸法にする（値は見せる。平行な辺の長さなど、ほかの寸法で決まるもの）
//     4. 位置: 原点からの横・縦の距離（外周の最初の点・穴の中心）。0 なら原点の軸の上（onAxis）
//     5. まだ自由度が残れば: 直線の向き（前の直線との角度）・全ての点の位置
//   回転体の X は半径（軸 = Y 軸）。直径の寸法は、原点からの横の距離を「直径 / 2」の式で付ける。

import { companions, dimensionsOf, placeOf } from "./dimensions.js";

const TOL = 1e-6; // 勾配の独立の判定（正規化した行の残り）
const GEOM_TOL = 1e-6; // 水平・垂直・接線・平行とみなす幅（向きの成分）
const ZERO = 1e-9; // mm: 0 とみなす値（0 の寸法は付けられないので、軸の上の拘束にする）
const H = 1e-6; // mm: 数値微分の幅

const nameOf = (id) => id.replace(/\./g, "_");
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
const len = (p) => Math.hypot(p[0], p[1]);
const unit = (p) => { const l = len(p); return [p[0] / l, p[1] / l]; };
const fmt = (v) => +v.toFixed(6);

// ---- 断面 → 変数 ----------------------------------------------------------------------------

/**
 * 断面の変数（点・円弧の中心・円の半径）。点はループの中で隣の部分と共有する（部分 i の始点 = 点 i、終点 = 点 i+1）
 * @returns {{ x: number[], point: (k, i, end) => [ix, iy], radius: (k) => i, segs: { k, i, s }[] }}
 */
function variables(loops) {
  const x = [];
  const add = (...v) => v.map((value) => x.push(value) - 1);
  const points = [], centers = [], radii = [];
  loops.forEach((loop, k) => {
    if (loop.length === 1 && loop[0].type === "circle") {
      const s = loop[0];
      points[k] = [];
      centers[k] = [add(s.center[0], s.center[1])];
      radii[k] = add(s.radius)[0];
      return;
    }
    points[k] = loop.map((s) => add(s.a[0], s.a[1]));
    centers[k] = loop.map((s) => (s.type === "arc" ? add(s.center[0], s.center[1]) : null));
  });
  const point = (k, i, end) => {
    if (end === "center") return centers[k][loops[k].length === 1 && loops[k][0].type === "circle" ? 0 : i];
    const n = loops[k].length;
    return points[k][end === "a" ? i : (i + 1) % n];
  };
  const segs = loops.flatMap((loop, k) => loop.map((s, i) => ({ k, i, s })));
  /** 部分 [k, i] の変数（両端・中心・半径） */
  const segVars = ([k, i]) => {
    const s = loops[k][i];
    if (s.type === "circle") return [...point(k, i, "center"), radii[k]];
    return [...point(k, i, "a"), ...point(k, i, "b"), ...(s.type === "arc" ? point(k, i, "center") : [])];
  };
  return { x, point, radius: (k) => radii[k], segs, segVars };
}

/** 拘束の計画の 1 項目の式が使う変数の番号（勾配は、その変数でだけ求める） */
function dependencies(item, vars) {
  const out = new Set();
  for (const seg of [...(item.seg ? [item.seg] : []), ...(item.segs ?? [])]) vars.segVars(seg).forEach((j) => out.add(j));
  if (item.point) vars.point(item.point.loop, item.point.seg, item.point.end).forEach((j) => out.add(j));
  return [...out];
}

/** 変数から断面を作り直す（解いた後の形） */
function loopsFrom(loops, vars, x) {
  const at = (ref) => [x[ref[0]], x[ref[1]]];
  return loops.map((loop, k) => loop.map((s, i) => {
    if (s.type === "circle") return { ...s, center: at(vars.point(k, 0, "center")), radius: x[vars.radius(k)] };
    const out = { ...s, a: at(vars.point(k, i, "a")), b: at(vars.point(k, i, "b")) };
    if (s.type === "arc") out.center = at(vars.point(k, i, "center"));
    return out;
  }));
}

// ---- 拘束の式 -------------------------------------------------------------------------------

/** 拘束の計画の 1 項目 → 0 になる式 f(x)（値 value を target で置き換えられる） */
function equation(item, vars) {
  const P = (ref) => (x) => [x[ref[0]], x[ref[1]]];
  const ends = ([k, i]) => [P(vars.point(k, i, "a")), P(vars.point(k, i, "b"))];
  const dir = (seg) => { const [a, b] = ends(seg); return (x) => sub(b(x), a(x)); };
  const center = ([k, i]) => P(vars.point(k, i, "center"));
  const ref = (r) => P(vars.point(r.loop, r.seg, r.end));
  switch (item.type) {
    case "arc": { const [a, b] = ends(item.seg), c = center(item.seg); return () => (x) => len(sub(a(x), c(x))) - len(sub(b(x), c(x))); }
    case "horizontal": { const d = dir(item.seg); return () => (x) => unit(d(x))[1]; }
    case "vertical": { const d = dir(item.seg); return () => (x) => unit(d(x))[0]; }
    case "parallel": { const [d1, d2] = item.segs.map(dir); return () => (x) => cross(unit(d1(x)), unit(d2(x))); }
    case "tangent": {
      // 接点（共有する端）で: 直線の向き ⟂ 円弧の半径、円弧どうしは 2 つの中心と接点が一直線
      const [s1, s2] = item.segs, at = ref(item.point);
      const radial = (seg) => { const c = center(seg); return (x) => unit(sub(at(x), c(x))); };
      const isLine = (seg) => !item.arcs.some(([k, i]) => k === seg[0] && i === seg[1]);
      if (isLine(s1) || isLine(s2)) {
        const [line, arc] = isLine(s1) ? [s1, s2] : [s2, s1];
        const d = dir(line), r = radial(arc);
        return () => (x) => dot(unit(d(x)), r(x));
      }
      const r1 = radial(s1), r2 = radial(s2);
      return () => (x) => cross(r1(x), r2(x));
    }
    case "onAxis": { const p = ref(item.point), c = item.axis === "y" ? 0 : 1; return () => (x) => p(x)[c]; }
    case "diameter": { const ir = vars.radius(item.seg[0]); return (v) => (x) => 2 * x[ir] - v; }
    case "radius": { const [a] = ends(item.seg), c = center(item.seg); return (v) => (x) => len(sub(a(x), c(x))) - v; }
    case "length": { const [a, b] = ends(item.seg); return (v) => (x) => len(sub(b(x), a(x))) - v; }
    case "angle": {
      // 2 本の直線の向きの角度（item.segs[1] が無ければ X 軸から）。符号つき（反時計回り）
      const d1 = dir(item.segs[0]), d2 = item.segs[1] ? dir(item.segs[1]) : () => [1, 0];
      return (v) => (x) => { const a = d2(x), b = d1(x); return Math.atan2(cross(a, b), dot(a, b)) - (v * Math.PI) / 180; };
    }
    case "x": case "y": { const p = ref(item.point), c = item.type === "x" ? 0 : 1, s = item.sign; return (v) => (x) => s * p(x)[c] - v; }
    default: throw new Error(`拘束の種類 ${item.type} は扱えません`);
  }
}

/** 式 f の、変数 x での勾配（数値微分。使う変数 deps でだけ）→ Map<変数の番号, 値> */
function gradient(f, x, deps) {
  const g = new Map();
  for (const j of deps) {
    const v = x[j];
    x[j] = v + H; const fp = f(x);
    x[j] = v - H; const fm = f(x);
    x[j] = v;
    const d = (fp - fm) / (2 * H);
    if (d !== 0) g.set(j, d);
  }
  return g;
}

/**
 * 互いに独立な行の集まり（疎な行の掃き出し。軸の行は軸の列が 1 で、ほかの軸の列は 0）。
 * add は、正規化した行を軸の行で消した残りが TOL より大きければ、新しい軸の行にして true
 */
class RowSpace {
  constructor() { this.pivots = new Map(); }
  add(row) {
    let norm = 0;
    for (const v of row.values()) norm += v * v;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return false;
    const r = new Map([...row].map(([j, v]) => [j, v / norm]));
    for (const [c, p] of this.pivots) {
      const v = r.get(c);
      if (!v) continue;
      for (const [j, w] of p) r.set(j, (r.get(j) ?? 0) - v * w);
      r.delete(c);
    }
    let best = -1, size = 0;
    for (const [j, v] of r) if (Math.abs(v) > size) [best, size] = [j, Math.abs(v)];
    if (size <= TOL) return false;
    const inv = 1 / r.get(best);
    const p = new Map();
    for (const [j, v] of r) if (j !== best && Math.abs(v * inv) > 1e-14) p.set(j, v * inv);
    p.set(best, 1);
    for (const q of this.pivots.values()) {
      const v = q.get(best);
      if (!v) continue;
      for (const [j, w] of p) if (j !== best) q.set(j, (q.get(j) ?? 0) - v * w);
      q.delete(best);
    }
    this.pivots.set(best, p);
    return true;
  }
  get rank() { return this.pivots.size; }
}

// ---- 候補 ------------------------------------------------------------------------------------

/** 寸法の文字の置き場所（断面の外形の大きさに比例して少し離す） */
function textAt(p, normal, size) {
  const n = len(normal) > 0 ? unit(normal) : [0, 1];
  return [fmt(p[0] + n[0] * size * 0.06), fmt(p[1] + n[1] * size * 0.06)];
}

function candidates(part, vars) {
  const loops = part.sketch.loops;
  const revolve = part.kind === "revolve";
  const all = loops.flat().flatMap((s) => (s.type === "circle" ? [[s.center[0] - s.radius, s.center[1] - s.radius], [s.center[0] + s.radius, s.center[1] + s.radius]] : [s.a, s.b]));
  const size = Math.max(1, Math.hypot(Math.max(...all.map((p) => p[0])) - Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[1]))));
  const mid = (s) => (s.type === "line" ? [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2] : s.a);
  const geometric = [], fallback = [];
  const lines = vars.segs.filter(({ s }) => s.type === "line");
  const arcs = vars.segs.filter(({ s }) => s.type === "arc").map(({ k, i }) => [k, i]);

  // 1. 円弧の両端が中心から同じ距離（必ず入る）
  const inherent = arcs.map((seg) => ({ type: "arc", seg }));

  // 2. 幾何拘束
  const slanted = [];
  for (const { k, i, s } of lines) {
    const u = unit(sub(s.b, s.a));
    if (Math.abs(u[1]) <= GEOM_TOL) geometric.push({ type: "horizontal", seg: [k, i] });
    else if (Math.abs(u[0]) <= GEOM_TOL) geometric.push({ type: "vertical", seg: [k, i] });
    else {
      const twin = slanted.find((t) => Math.abs(cross(t.u, u)) <= GEOM_TOL);
      if (twin) geometric.push({ type: "parallel", segs: [twin.seg, [k, i]] });
      slanted.push({ u, seg: [k, i] });
    }
  }
  loops.forEach((loop, k) => {
    if (loop.length < 2) return;
    loop.forEach((s, i) => {
      const next = loop[(i + 1) % loop.length], j = (i + 1) % loop.length;
      if (s.type === "line" && next.type === "line") return;
      const p = s.b;
      const radial = (seg) => unit(sub(p, seg.center));
      const tangentDir = (seg) => unit(sub(seg.b, seg.a));
      let ok;
      if (s.type === "line") ok = Math.abs(dot(tangentDir(s), radial(next))) <= GEOM_TOL;
      else if (next.type === "line") ok = Math.abs(dot(tangentDir(next), radial(s))) <= GEOM_TOL;
      else ok = Math.abs(cross(radial(s), radial(next))) <= GEOM_TOL;
      if (ok) geometric.push({ type: "tangent", segs: [[k, i], [k, j]], point: { loop: k, seg: i, end: "b" }, arcs: arcs.filter(([kk, ii]) => kk === k && (ii === i || ii === j)) });
    });
  });

  // 3. 寸法の欄の寸法。順: 丸み → 直径 → 長さ（ループの順）に見て、まだ「一緒に変わる側」でない直せる寸法を駆動の側にし、
  // それを寸法の欄で直したときに一緒に変わる寸法（companions: 平行な相手の辺・丸みに接する直線など）を参照の側（最後）へ回す。
  // こうすると Inventor で駆動寸法を変えたときの形が、寸法の欄で直した形と同じになる。直せない寸法は、その間（参照の側より前）
  const dims = dimensionsOf(part);
  const fromDims = [];
  const rank = { radius: 0, diameter: 1, length: 2 };
  const follower = new Set();
  const order = new Map();
  for (const d of dims.filter((x) => x.at && x.at.seg !== undefined && x.kind in rank).sort((a, b) => rank[a.kind] - rank[b.kind])) {
    if (!d.editable) { order.set(d.id, 1); continue; }
    if (follower.has(d.id)) continue;
    order.set(d.id, 0);
    for (const k of [1.1, 0.9]) {
      const ids = companions(part, d.id, d.value * k);
      if (!ids) continue;
      ids.filter((id) => !order.has(id)).forEach((id) => follower.add(id));
      break;
    }
  }
  for (const id of follower) if (!order.has(id)) order.set(id, 2);
  for (const d of dims) {
    if (!d.at || d.at.seg === undefined || !(d.kind in rank)) continue;
    const { loop: k, seg: i } = d.at;
    const s = loops[k][i];
    const place = placeOf(d, part);
    const comment = place.startsWith("穴") && d.label.startsWith("穴の") ? `${place}${d.label.slice(1)}` : `${place}の${d.label}`; // 穴 1の直径
    const base = { id: d.id, comment, editable: d.editable, order: (order.get(d.id) ?? 1) * 10 + rank[d.kind] };
    if (d.kind === "diameter" && s.type === "circle") {
      fromDims.push({ ...base, type: "diameter", seg: [k, i], value: d.value, text: textAt(s.center, [1, 1], s.radius * 2 + size * 0.2) });
    } else if (d.kind === "diameter") {
      // 回転体の直径: 同じ半径の縦の直線の全ての端を、原点からの横の距離（直径 / 2）で
      const x0 = s.a[0];
      vars.segs.filter(({ s: t }) => t.type === "line" && Math.abs(t.a[0] - x0) <= ZERO && Math.abs(t.b[0] - x0) <= ZERO).forEach(({ k: kk, i: ii, s: t }, n) => {
        fromDims.push({ ...base, id: n === 0 ? d.id : `${d.id}#${n}`, type: "x", sign: 1, point: { loop: kk, seg: ii, end: "a" }, value: x0, half: true, text: textAt(mid(t), [0, -1], size) });
      });
    } else if (d.kind === "radius") {
      fromDims.push({ ...base, type: "radius", seg: [k, i], value: d.value, text: textAt(s.a, sub(s.a, s.center), size) });
    } else {
      const n = sub(s.b, s.a);
      fromDims.push({ ...base, type: "length", seg: [k, i], value: d.value, text: textAt(mid(s), [n[1], -n[0]], size) });
    }
  }
  fromDims.sort((a, b) => a.order - b.order);

  // 4. 位置（原点からの横・縦の距離。0 なら原点の軸の上）。穴の位置は名前つきの値（user: 名前の頭・label: コメント）、ほかはパラメータの名前（name）だけ
  const position = (point, p, { user, label, name }) => ["x", "y"].map((axis, c) => {
    if (Math.abs(p[c]) <= ZERO) return { type: "onAxis", axis: axis === "x" ? "y" : "x", point };
    const AX = axis.toUpperCase();
    const dim = { type: axis, sign: Math.sign(p[c]), point, value: Math.abs(p[c]), text: textAt(p, c === 0 ? [0, -1] : [-1, 0], size) };
    return user ? { ...dim, id: `${user}${AX}`, comment: `${label}の位置 ${AX}`, editable: true } : { ...dim, name: `${name}${AX}` };
  });
  const positions = [];
  loops.forEach((loop, k) => {
    const circle = loop.length === 1 && loop[0].type === "circle";
    const p = circle ? loop[0].center : loop[0].a;
    const point = { loop: k, seg: 0, end: circle ? "center" : "a" };
    if (k === 0) positions.push(...position(point, p, { name: "P0" }).filter((c) => !revolve || c.type !== "x")); // 回転体の半径は直径の寸法で
    else positions.push(...position(point, p, { user: `P${k}`, label: `穴 ${k}` }));
  });
  // 回転体: 軸の上の点は X = 0
  if (revolve) loops.forEach((loop, k) => loop.forEach((s, i) => { if (Math.abs(s.a[0]) <= ZERO) positions.push({ type: "onAxis", axis: "y", point: { loop: k, seg: i, end: "a" } }); }));

  // 2b. 直線の向き（前の直線との角度。水平・垂直・平行で決まらない斜めの辺。寸法の欄の直し方は角度を保つので、長さより先）
  const angles = [];
  lines.forEach(({ k, i, s }) => {
    const loop = loops[k], prev = loop[(i - 1 + loop.length) % loop.length];
    const segs = prev.type === "line" && prev !== s ? [[k, i], [k, (i - 1 + loop.length) % loop.length]] : [[k, i]];
    const d1 = sub(s.b, s.a), d2 = segs[1] ? sub(prev.b, prev.a) : [1, 0];
    angles.push({ type: "angle", segs, value: (Math.atan2(cross(d2, d1), dot(d2, d1)) * 180) / Math.PI, name: `A${k}_${i}`, text: textAt(s.a, d1, size) });
  });
  // 5. まだ自由度が残れば（点の位置）
  vars.segs.forEach(({ k, i, s }) => {
    if (s.type === "circle") return;
    for (const [end, p] of [["a", s.a], ...(s.type === "arc" ? [["center", s.center]] : [])]) {
      fallback.push(...position({ loop: k, seg: i, end }, p, { name: `Q${k}_${i}${end === "center" ? "C" : ""}` }));
    }
  });
  return { inherent, geometric, angles, fromDims, positions, fallback };
}

// ---- 計画 ------------------------------------------------------------------------------------

/** 部品の拘束・寸法・名前つきの値の計画。近似の部品は null */
export function parametricPlan(part) {
  if (part.kind === "mesh" || !part.sketch) return null;
  const loops = part.sketch.loops;
  const vars = variables(loops);
  const x = Float64Array.from(vars.x);
  const space = new RowSpace();
  const take = (item) => {
    const f = equation(item, vars)(item.value);
    return space.add(gradient(f, x, dependencies(item, vars)));
  };
  const { inherent, geometric, angles, fromDims, positions, fallback } = candidates(part, vars);
  inherent.forEach(take);
  const constraints = geometric.filter(take);
  const dimensions = angles.filter(take).map((c) => ({ ...clean(c), driven: false }));
  const params = [];
  const param = (id, value, unit, comment) => {
    const name = nameOf(id);
    if (!params.some((p) => p.name === name)) params.push({ name, value: fmt(value), unit, comment });
    return name;
  };
  for (const d of fromDims) {
    const ok = take(d);
    const { order, editable, comment, id, ...item } = d;
    if (!ok) {
      if (!id.includes("#")) dimensions.push({ ...clean(item), driven: true });
      continue;
    }
    const base = id.split("#")[0];
    const value = item.half ? d.value * 2 : d.value;
    if (editable) {
      const name = param(base, value, "mm", comment);
      dimensions.push({ ...clean(item), expression: item.half ? `${name} / 2` : name, driven: false });
    } else dimensions.push({ ...clean(item), name: id.includes("#") ? undefined : nameOf(base), driven: false });
  }
  for (const c of positions) {
    if (!take(c)) continue;
    if (c.type === "onAxis") constraints.push(c);
    else if (c.id) dimensions.push({ ...clean(c), expression: param(c.id, c.value, "mm", c.comment), driven: false });
    else dimensions.push({ ...clean(c), driven: false });
  }
  for (const c of fallback) {
    if (space.rank >= x.length) break;
    if (!take(c)) continue;
    if (c.type === "onAxis") constraints.push(c);
    else dimensions.push({ ...clean(c), driven: false });
  }

  // フィーチャの値
  const features = { chamfers: [] };
  const all = dimensionsOf(part);
  for (const d of all) {
    if (d.id === "t") features.distance = param("t", d.value, "mm", "厚さ（押し出しの長さ。XY 平面に対して対称）");
    else if (d.id === "a" && d.value < 360) features.angle = param("a", d.value, "deg", "回転の角度（XY 平面に対して対称）");
    else if (d.kind === "chamfer") features.chamfers.push(param(d.id, d.value, "mm", d.label));
  }
  return { params, constraints: constraints.map(clean), dimensions, features, free: x.length - space.rank };
}

/** 計画に残さない作業用の値を除く */
function clean(item) {
  const { arcs, half, ...rest } = item;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}

// ---- 解く（評価用） --------------------------------------------------------------------------

/** 連立一次方程式 A x = b（部分ピボットのガウスの消去法）。解けなければ null */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const out = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * out[j];
    out[r] = s / M[r][r];
  }
  return out;
}

/**
 * 計画の拘束を解いた断面（名前つきの値 values を変えて）。Inventor がパラメータを変えたときに作り直す形の見積もり
 * （Inventor と同じく、拘束の式を今の形から近い解へ解く: ニュートン法。完全拘束なら解は 1 つ）
 * @returns {{ loops, residual }} 解けなければ Error
 */
export function solveSketch(part, plan, values = {}) {
  const loops = part.sketch.loops;
  const vars = variables(loops);
  const x = Float64Array.from(vars.x);
  const resolve = (d) => {
    if (!d.expression) return d.value;
    const [name, half] = d.expression.split(" / ");
    const v = values[name] ?? plan.params.find((p) => p.name === name).value;
    return half ? v / Number(half) : v;
  };
  const items = [...loops.flatMap((loop, k) => loop.flatMap((s, i) => (s.type === "arc" ? [{ type: "arc", seg: [k, i] }] : []))),
    ...plan.constraints.map((c) => (c.type === "tangent" ? { ...c, arcs: arcsOf(loops, c.segs) } : c)),
    ...plan.dimensions.filter((d) => !d.driven)];
  const fs = items.map((it) => equation(it, vars)(it.type in { arc: 1, horizontal: 1, vertical: 1, parallel: 1, tangent: 1, onAxis: 1 } ? 0 : resolve(it)));
  let residual = Infinity;
  for (let iter = 0; iter < 60; iter++) {
    const f = fs.map((fn) => fn(x));
    residual = Math.max(...f.map(Math.abs));
    if (residual < 1e-10) break;
    const all = [...x.keys()];
    const J = fs.map((fn) => { const g = gradient(fn, x, all); return all.map((j) => g.get(j) ?? 0); });
    // 正規方程式（完全拘束なら正方で同じ解）
    const n = x.length;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? 1e-12 : 0)));
    const b = Array.from({ length: n }, (_, i) => -J.reduce((s, row, r) => s + row[i] * f[r], 0));
    const dx = solveLinear(A, b);
    if (!dx) throw new Error("拘束が解けません");
    for (let j = 0; j < n; j++) x[j] += dx[j];
  }
  return { loops: loopsFrom(loops, vars, x), residual };
}

const arcsOf = (loops, segs) => segs.filter(([k, i]) => loops[k][i].type === "arc");
