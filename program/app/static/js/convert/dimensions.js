// 変換データの部品の寸法を読み、直す（3D の変換データの編集）。DOM に依存しない（Node で評価する）。
//
//   dimensionsOf(部品) → [{ id, kind, label, value, unit, editable, reason, at }]
//   applyDimension(部品, id, 値) → { part: 直した部品, changed: [{ id, label, before, after }] }（直せなければ理由の Error。元の部品は変えない）
//   checkPart(部品) → 作れない理由の列（空なら作れる）
//
// 直し方（寸法 1 つを変えたとき、ほかの形をどう保つか）:
//   断面の点の集まり S を、向き v へ動かす。S に片方の端だけ入る部分が「v と平行な直線」だけなら、全ての角度が保たれる
//   （伸び縮みするのは v と平行な直線だけ）。そうでなければ、その直し方はできない。
//   - 直線の長さ … 直線の先（終点から向こう）の全ての点を、直線の向きへ動かす（縮めるなら戻す）。できなければ手前の側を試す
//   - 回転体の直径 … その円筒（同じ半径の縦の直線）の点だけを、半径の向きへ動かす
//   - 穴・円の直径 … 円の半径だけを変える
//   - 角の丸み（2 本の直線に接する円弧）… 両方の直線に接したまま、半径を変える（接点が直線の上を動く）
//   - 外形の幅・外径 … 断面を相似に拡大・縮小（全ての角度を保つ。斜めの辺が多い形の大きさはこれで直す）
//   - 厚さ（押し出し）・回転の角度・面取り … その値だけ
// 直した後に checkPart で確かめ（ループが閉じている・自分と交わらない・穴が外周の内・軸をまたがない・面取りが入る）、
// 体積と表面積の期待値（expect）と、STEP 用の三角形（mesh。厳密な面で書けない形のとき）を作り直す。

import { expectedProperties, needsStepMesh } from "./inventor.js";
import { sampleLoop, solidMesh } from "./preview.js";
import { chamferIntegrals } from "./recognize/geometry2d.js";

const EPS = 1e-6; // mm: 同じ点・平行とみなす幅
const round = (v) => Math.round(v * 1e9) / 1e9 + 0; // 動かした座標の丸め（浮動小数の誤差を残さない）
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
const len = (p) => Math.hypot(p[0], p[1]);
const unit = (p) => { const l = len(p); return [p[0] / l, p[1] / l]; };
const same = (p, q) => len(sub(p, q)) <= EPS;
const fmt = (v) => +v.toFixed(3);

/** 部品の形（体積の期待値・STEP の三角形を作る形） */
const shapeOf = (part) => ({ kind: part.kind, loops: part.sketch?.loops, revolve: part.revolve, extrude: part.extrude, chamfers: part.chamfers, mesh: part.mesh });

const SIDE = { "+Z": "上面", "-Z": "下面" };
const loopName = (k) => (k === 0 ? "外周" : `穴 ${k}`);

/** 直線の向きの呼び名（回転体は X = 半径・Y = 軸の向き） */
function orientation(s, revolve) {
  const d = sub(s.b, s.a);
  if (Math.abs(d[1]) <= EPS * len(d)) return revolve ? "半径方向の辺" : "横の辺";
  if (Math.abs(d[0]) <= EPS * len(d)) return revolve ? "軸方向の辺" : "縦の辺";
  return "斜めの辺";
}

// ---- 点を動かす ---------------------------------------------------------------------------

/**
 * 断面の点のうち inS を満たすものを v × amount だけ動かした断面。角度が保てなければ { blocked: 理由 }
 * （片方の端だけ動く部分が v と平行な直線でないとき。円弧は両端とも動くか、どちらも動かないか）
 */
function moved(loops, inS, v, amount) {
  const shift = (p) => [round(p[0] + v[0] * amount), round(p[1] + v[1] * amount)];
  let blocked = null;
  const out = loops.map((loop) => loop.map((s) => {
    if (s.type === "circle") return inS(s.center) ? { ...s, center: shift(s.center) } : s;
    const ma = inS(s.a), mb = inS(s.b);
    if (ma !== mb) {
      if (s.type === "arc") blocked ??= "円弧の形が保てない";
      else if (Math.abs(cross(unit(sub(s.b, s.a)), v)) > 1e-9) blocked ??= `${s.type === "line" ? "斜めの辺" : "部分"}の角度が変わる`;
    }
    if (!ma && !mb) return s;
    const moveCenter = s.type === "arc" && ma && mb;
    return { ...s, a: ma ? shift(s.a) : s.a, b: mb ? shift(s.b) : s.b, ...(moveCenter && { center: shift(s.center) }) };
  }));
  return blocked ? { blocked } : { loops: out };
}

/** 直線の長さを変える 2 つのやり方（先の側を伸ばす・手前の側を伸ばす） */
function lengthMoves(s) {
  const u = unit(sub(s.b, s.a));
  return [
    { inS: (p) => dot(sub(p, s.b), u) >= -EPS, v: u },
    { inS: (p) => dot(sub(p, s.a), u) <= EPS, v: [-u[0], -u[1]] },
  ];
}

/** 回転体の円筒（半径 x0 の縦の直線）の点だけを動かす */
const radiusMove = (x0) => ({ inS: (p) => Math.abs(p[0] - x0) <= EPS, v: [1, 0] });

/** 直線の長さを変えるやり方のうち、角度が保てる最初のもの（無ければ理由） */
function lengthMove(loops, s) {
  let reason = null;
  for (const m of lengthMoves(s)) {
    const r = moved(loops, m.inS, m.v, 0);
    if (!r.blocked) return { move: m };
    reason ??= r.blocked;
  }
  return { reason: `この辺を伸ばすと${reason}ため、直せません` };
}

/** 断面を相似に k 倍した断面（押し出しは外周の外形の中心、回転体は軸の上の中央を中心に。回転体の軸は動かない） */
function scaled(part, k) {
  const pts = sampleLoop(part.sketch.loops[0]);
  const [xs, ys] = [pts.map((p) => p[0]), pts.map((p) => p[1])];
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const c = part.kind === "revolve" ? [0, cy] : [(Math.min(...xs) + Math.max(...xs)) / 2, cy];
  const at = (p) => [round(c[0] + (p[0] - c[0]) * k), round(c[1] + (p[1] - c[1]) * k)];
  return part.sketch.loops.map((loop) => loop.map((s) => (s.type === "circle" ? { ...s, center: at(s.center), radius: round(s.radius * k) }
    : { ...s, a: at(s.a), b: at(s.b), ...(s.center && { center: at(s.center) }) })));
}

// ---- 角の丸み ------------------------------------------------------------------------------

/** 円弧 i の前後の部分（ループの順） */
const neighbors = (loop, i) => [loop[(i - 1 + loop.length) % loop.length], loop[(i + 1) % loop.length]];

/** 2 本の直線に接する円弧なら、その角（直線どうしの交点）と、交点から両側の直線への向き。そうでなければ理由 */
function filletOf(loop, i) {
  const arc = loop[i];
  const [prev, next] = neighbors(loop, i);
  if (loop.length < 3 || prev.type !== "line" || next.type !== "line") return { reason: "両側が直線の角の丸みだけ直せます" };
  const d1 = unit(sub(prev.b, prev.a)), d2 = unit(sub(next.b, next.a));
  const r = len(sub(arc.a, arc.center));
  const tangent = Math.abs(dot(d1, sub(arc.a, arc.center))) <= 1e-6 * Math.max(1, r) && Math.abs(dot(d2, sub(arc.b, arc.center))) <= 1e-6 * Math.max(1, r);
  if (!tangent) return { reason: "両側の直線に接していない円弧は直せません" };
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return { reason: "平行な 2 本をつなぐ円弧（半円）は直せません" };
  const t = cross(sub(next.a, prev.a), d2) / den;
  const corner = [prev.a[0] + d1[0] * t, prev.a[1] + d1[1] * t];
  return { corner, back: [-d1[0], -d1[1]], forward: d2, prev, next };
}

/** 角の丸みを半径 r にした円弧と、両側の直線の新しい端 */
function filletAt({ corner, back, forward }, r) {
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(back, forward)))); // 角の開き
  const t = r / Math.tan(theta / 2);
  const bis = unit([back[0] + forward[0], back[1] + forward[1]]);
  const at = (d, k) => [round(corner[0] + d[0] * k), round(corner[1] + d[1] * k)];
  return { a: at(back, t), b: at(forward, t), center: at(bis, r / Math.sin(theta / 2)) };
}

// ---- 寸法の一覧 ----------------------------------------------------------------------------

/**
 * 部品の寸法の一覧（表示の順: 形 → 断面 → 面取り）。
 * @returns {{ id, kind, label, value, unit, editable, reason?, at? }[]}
 *   at … 断面のどこか（{ loop, seg }。3D・断面の図で強調する）、reason … 直せない理由
 */
export function dimensionsOf(part) {
  if (part.kind === "mesh") return [];
  const out = [];
  const revolve = part.kind === "revolve";
  const loops = part.sketch.loops;
  if (revolve) out.push({ id: "a", kind: "angle", label: "回転の角度", value: part.revolve.angle_deg, unit: "°", editable: true });
  else out.push({ id: "t", kind: "thickness", label: "厚さ", value: part.extrude.distance, unit: "mm", editable: true });

  const outer = sampleLoop(loops[0]);
  const xs = outer.map((p) => p[0]);
  out.push({ id: "S", kind: "scale", label: revolve ? "外径（形を保って拡大・縮小）" : "外形の幅（形を保って拡大・縮小）",
    value: revolve ? 2 * Math.max(...xs) : Math.max(...xs) - Math.min(...xs), unit: "mm", editable: true });

  const radii = new Set();
  loops.forEach((loop, k) => loop.forEach((s, i) => {
    const at = { loop: k, seg: i };
    if (s.type === "circle") {
      out.push({ id: `D${k}.${i}`, kind: "diameter", label: k > 0 ? "穴の直径" : "直径", value: 2 * s.radius, unit: "mm", editable: true, at });
      return;
    }
    if (s.type === "arc") {
      const f = filletOf(loop, i);
      const r = len(sub(s.a, s.center));
      out.push({ id: `R${k}.${i}`, kind: "radius", label: "角の丸み", value: r, unit: "mm", editable: !f.reason, ...(f.reason && { reason: f.reason }), at });
      return;
    }
    const name = orientation(s, revolve);
    if (revolve && name === "軸方向の辺") {
      const x = s.a[0];
      if (x > EPS && !radii.has(x.toFixed(6))) {
        radii.add(x.toFixed(6));
        const r = moved(loops, radiusMove(x).inS, [1, 0], 0);
        out.push({ id: `D${k}.${i}`, kind: "diameter", label: "直径", value: 2 * x, unit: "mm", editable: !r.blocked,
          ...(r.blocked && { reason: `この直径を変えると${r.blocked}ため、直せません` }), at });
      }
    }
    if (revolve && name === "半径方向の辺") return; // 回転体の半径方向の長さは、直径の差で直す（同じことを 2 か所に出さない）
    const m = lengthMove(loops, s);
    out.push({ id: `L${k}.${i}`, kind: "length", label: name, value: len(sub(s.b, s.a)), unit: "mm", editable: !m.reason, ...(m.reason && { reason: m.reason }), at });
  }));

  (part.chamfers ?? []).forEach((c, i) => {
    out.push({ id: `C${i}`, kind: "chamfer", label: `面取り（${loopName(c.loop)}の縁・${SIDE[c.side]}）`, value: c.distance, unit: "mm", editable: true, at: { loop: c.loop } });
  });
  return out;
}

// ---- 直す ----------------------------------------------------------------------------------

/** 寸法 id を value にした断面・値（確かめる前） */
function edited(part, dim, value) {
  const next = structuredClone(part);
  if (dim.kind === "thickness") next.extrude.distance = value;
  else if (dim.kind === "angle") next.revolve.angle_deg = value;
  else if (dim.kind === "chamfer") next.chamfers[Number(dim.id.slice(1))].distance = value;
  else if (dim.kind === "scale") next.sketch.loops = scaled(part, value / dim.value);
  else {
    const { loop: k, seg: i } = dim.at;
    const loops = next.sketch.loops;
    const s = loops[k][i];
    if (dim.kind === "diameter" && s.type === "circle") s.radius = value / 2;
    else if (dim.kind === "diameter") {
      const r = moved(loops, radiusMove(s.a[0]).inS, [1, 0], value / 2 - s.a[0]);
      if (r.blocked) throw new Error(`この直径を変えると${r.blocked}ため、直せません`);
      next.sketch.loops = r.loops;
    } else if (dim.kind === "length") {
      const { move, reason } = lengthMove(loops, s);
      if (reason) throw new Error(reason);
      next.sketch.loops = moved(loops, move.inS, move.v, value - dim.value).loops;
    } else if (dim.kind === "radius") {
      const f = filletOf(loops[k], i);
      if (f.reason) throw new Error(f.reason);
      const arc = filletAt(f, value);
      const loop = loops[k];
      const [p, n] = [(i - 1 + loop.length) % loop.length, (i + 1) % loop.length];
      loop[p] = { ...loop[p], b: arc.a };
      loop[i] = { ...loop[i], ...arc };
      loop[n] = { ...loop[n], a: arc.b };
    }
    // 直線が縮んで消えた・向きが逆になったなら、その直し方はできない
    part.sketch.loops.forEach((loop, kk) => loop.forEach((before, ii) => {
      const after = next.sketch.loops[kk][ii];
      if (before.type !== "line") return;
      const d0 = sub(before.b, before.a), d1 = sub(after.b, after.a);
      if (len(d1) <= EPS || dot(d0, d1) <= 0) throw new Error(`${loopName(kk)}の${orientation(before, part.kind === "revolve")}（${fmt(len(d0))} mm）が無くなるため、この値にはできません`);
    }));
  }
  return next;
}

/** 期待値（体積・表面積）と、STEP 用の三角形（厳密な面で書けない形なら作り直す。書ける形なら外す） */
function refreshed(part) {
  const shape = shapeOf(part);
  const { mesh, ...rest } = part;
  const next = needsStepMesh(shape) ? { ...rest, mesh: solidMesh(rest) } : rest;
  const expect = expectedProperties(shapeOf({ ...next, mesh: undefined }));
  return { ...next, expect: { volume: Math.round(expect.volume * 1e6) / 1e6, area: Math.round(expect.area * 1e6) / 1e6 } };
}

/**
 * 寸法 id を value にした部品（元の部品は変えない）。
 * @returns {{ part: object, changed: { id, label, before, after }[] }} changed … 一緒に変わったほかの寸法（平行な辺の長さなど）
 * @throws {Error} 直せない寸法・作れない形になる値（利用者に見せる理由）
 */
export function applyDimension(part, id, value) {
  const dims = dimensionsOf(part);
  const dim = dims.find((d) => d.id === id);
  if (!dim) throw new Error(`寸法 ${id} がありません`);
  if (!dim.editable) throw new Error(dim.reason);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${dim.label}は 0 より大きい数にしてください`);
  if (dim.kind === "angle" && value > 360) throw new Error("回転の角度は 360° までです");
  const next = edited(part, dim, value);
  const problems = checkPart(next);
  if (problems.length) throw new Error(problems[0]);
  const after = new Map(dimensionsOf(next).map((d) => [d.id, d]));
  const changed = dims.filter((d) => d.id !== id && after.has(d.id) && Math.abs(after.get(d.id).value - d.value) > 1e-9)
    .map((d) => ({ id: d.id, label: d.label, before: d.value, after: after.get(d.id).value }));
  return { part: refreshed(next), changed };
}

// ---- 作れる形か -----------------------------------------------------------------------------

/** 2 本の線分が、端点を除く内側で交わるか */
function crosses(p1, p2, p3, p4) {
  const d = cross(sub(p2, p1), sub(p4, p3));
  if (Math.abs(d) < 1e-15) return false;
  const t = cross(sub(p3, p1), sub(p4, p3)) / d, u = cross(sub(p3, p1), sub(p2, p1)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** 点が折れ線の内側か（偶奇） */
function inside([x, y], pts) {
  let odd = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

/** 部品が作れる形か。作れない理由の列（利用者に見せる文） */
export function checkPart(part) {
  if (part.kind === "mesh") return [];
  const problems = [];
  const loops = part.sketch.loops;
  if (part.kind === "extrude" && !(part.extrude.distance > 0)) problems.push("厚さは 0 より大きくしてください");
  if (part.kind === "revolve" && !(part.revolve.angle_deg > 0 && part.revolve.angle_deg <= 360)) problems.push("回転の角度は 0° より大きく 360° までです");
  loops.forEach((loop, k) => {
    if (loop.length === 1 && loop[0].type === "circle") {
      if (!(loop[0].radius > EPS)) problems.push(`${loopName(k)}の直径は 0 より大きくしてください`);
      return;
    }
    loop.forEach((s, i) => {
      if (!same(s.b, loop[(i + 1) % loop.length].a)) problems.push(`${loopName(k)}の ${i + 1} 番目の部分が次とつながっていません`);
      if (s.type === "arc" && Math.abs(len(sub(s.a, s.center)) - len(sub(s.b, s.center))) > 1e-6 * Math.max(1, len(sub(s.a, s.center)))) {
        problems.push(`${loopName(k)}の円弧の両端が中心から同じ距離にありません`);
      }
    });
  });
  if (problems.length) return problems;

  // 断面の線どうし（同じループの隣を除く）が交わらない・穴は外周の内側で、ほかの穴の外
  const polys = loops.map((loop) => sampleLoop(loop));
  const edges = polys.map((pts) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]));
  search: for (let a = 0; a < edges.length; a++) {
    for (let b = a; b < edges.length; b++) {
      for (let i = 0; i < edges[a].length; i++) {
        for (let j = a === b ? i + 2 : 0; j < edges[b].length; j++) {
          if (a === b && i === 0 && j === edges[a].length - 1) continue;
          if (crosses(...edges[a][i], ...edges[b][j])) {
            problems.push(a === b ? `${loopName(a)}の線が自分と交わります` : `${loopName(a)}と${loopName(b)}の線が交わります`);
            break search;
          }
        }
      }
    }
  }
  polys.slice(1).forEach((pts, h) => {
    if (!inside(pts[0], polys[0])) problems.push(`${loopName(h + 1)}が外周の外に出ます`);
    if (polys.slice(1).some((other, o) => o !== h && inside(pts[0], other))) problems.push(`${loopName(h + 1)}がほかの穴と重なります`);
  });
  if (part.kind === "revolve" && Math.min(...polys.flat().map((p) => p[0])) < -EPS) problems.push("断面が回転の軸をまたぎます（半径が負になります）");

  // 面取り: 厚さの半分より小さく（ビルダーの決まり。ipt_build/spec.py）、縁をずらした輪郭が作れる
  (part.chamfers ?? []).forEach((c) => {
    if (part.kind === "extrude" && !(c.distance < part.extrude.distance / 2)) {
      problems.push(`${loopName(c.loop)}の縁の面取り ${fmt(c.distance)} mm は、厚さ ${fmt(part.extrude.distance)} mm の半分より小さくしてください`);
    } else if (!chamferIntegrals(loops[c.loop], c.distance, c.loop > 0)) problems.push(`${loopName(c.loop)}の縁の面取り ${fmt(c.distance)} mm が大きすぎます（輪郭が作れません）`);
  });
  return [...new Set(problems)];
}
