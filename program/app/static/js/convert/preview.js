// 変換データ（.inventor.json）を開いたときの表示: Inventor が作るのと同じ断面・回転角・押し出し量・配置から、
// 3D 表示用の形（組立と同じ「部品ごとの形 × 配置」）と、部品の説明を作る。DOM に依存しない（Node で評価する）。
// 面取り（押し出しの端面の縁）も描く。同じ作り方で、寸法を直した部品の STEP 用の閉じた三角形（solidMesh）も作る。

import * as THREE from "three";
import { describeChamfers, KIND_LABEL } from "../html/describe.js";
import { arcAngles, loopIntegrals, offsetIntoMaterial, reverseLoop } from "./recognize/geometry2d.js";

const STEPS = 64; // 1 周の分割（表示用。弦の誤差は半径の 0.12%）
const TAU = 2 * Math.PI;
const fmt = (v) => v.toFixed(3);

/** ループ（直線・円弧・円）を折れ線の点にする（閉じた点列。最後の点は最初に戻らない）。counts … 部分ごとの点の数（面取りの前後の輪郭で点を対応させる） */
export function sampleLoop(loop, { steps = STEPS, counts = null } = {}) {
  const points = [];
  loop.forEach((s, i) => {
    if (s.type === "circle") {
      const n = counts?.[i] ?? steps;
      for (let k = 0; k < n; k++) points.push([s.center[0] + s.radius * Math.cos((TAU * k) / n), s.center[1] + s.radius * Math.sin((TAU * k) / n)]);
    } else if (s.type === "arc") {
      const { a0, sweep, radius } = arcAngles(s);
      const n = counts?.[i] ?? Math.max(1, Math.ceil((Math.abs(sweep) / TAU) * steps));
      for (let k = 0; k < n; k++) points.push([s.center[0] + radius * Math.cos(a0 + (sweep * k) / n), s.center[1] + radius * Math.sin(a0 + (sweep * k) / n)]);
    } else {
      points.push(s.a);
    }
  });
  return points;
}

/** 部分ごとの点の数（sampleLoop と同じ数え方） */
const sampleCounts = (loop, steps) => loop.map((s) => (s.type === "circle" ? steps : s.type === "arc" ? Math.max(1, Math.ceil((Math.abs(arcAngles(s).sweep) / TAU) * steps)) : 1));

/** 外周は反時計回り、穴は時計回りにそろえる（どちらも、進む向きの右側が材料の外） */
const orientLoop = (loop, hole) => ((loopIntegrals(loop).area > 0) === !hole ? loop : reverseLoop(loop));
const signedArea = (pts) => pts.reduce((sum, [x0, y0], i) => { const [x1, y1] = pts[(i + 1) % pts.length]; return sum + x0 * y1 - x1 * y0; }, 0) / 2;
/** 点の列の向きも同じ規則にそろえる（円は向きを持たないので、点にしてから逆にする） */
const orientPts = (pts, hole) => ((signedArea(pts) > 0) === !hole ? pts : [...pts].reverse());

/**
 * 押し出しの 1 つのループの、端面の側ごとの輪郭。面取りがあれば、縁を材料側へずらした輪郭を、部分が消える深さで区切って並べる
 * （区切りの中では部分ごとに点が 1 対 1 で、面取り面は直線の部分なら平らな四角形になる）。
 * @returns {{ base: number[][], ends: { [side]: { depth, pts, stages: [{ from, to, bottom, top }] } } }}
 *   pts … 端面の輪郭の点、stages … 面取り面の帯（深さ from の点 bottom → 深さ to の点 top）
 */
function extrudeOutlines(loop, k, chamfers, steps) {
  const hole = k > 0;
  const oriented = orientLoop(loop, hole);
  const counts = sampleCounts(oriented, steps);
  const circle = oriented.length === 1 && oriented[0].type === "circle";
  const sample = (outline, n) => (circle ? orientPts : (pts) => pts)(sampleLoop(outline, { counts: n }), hole);
  const base = sample(oriented, counts);
  const ends = {};
  for (const side of ["-Z", "+Z"]) {
    const depth = Math.max(0, ...chamfers.filter((c) => c.loop === k && c.side === side).map((c) => c.distance));
    if (!depth) {
      ends[side] = { depth: 0, pts: base, stages: [] };
      continue;
    }
    const shifted = offsetIntoMaterial(oriented, depth, hole);
    if (!shifted) throw new Error(`ループ ${k} の面取り ${depth} mm の輪郭を作れません`);
    const ring = (alive, at) => {
      const outline = shifted.outlineAt(alive, at);
      return sample(outline, outline.map((s) => counts[s.source]));
    };
    const stages = shifted.stages.map(({ alive, from, to }) => ({ from, to, bottom: ring(alive, from), top: ring(alive, to) }));
    ends[side] = { depth, pts: sample(shifted.loop, shifted.stages.at(-1).alive.map((i) => counts[i])), stages };
  }
  return { base, ends };
}

/**
 * 1 部品の形（外向きの面・法線つきの三角形）。
 * 押し出し: 断面を Z 方向に ±長さ/2。面取りは端面の縁を 45° で削る（ビルダーと同じ）。回転: Y 軸まわりに、360° 未満なら XY 平面に対して対称に。
 * @returns {{ positions: number[], normals: number[], index: number[] }}
 */
function buildSolid(part, steps) {
  const revolve = part.kind === "revolve";
  const angle = revolve ? (part.revolve.angle_deg * Math.PI) / 180 : 0;
  const full = revolve && part.revolve.angle_deg >= 360 - 1e-9;
  const turns = revolve ? Math.max(2, Math.ceil((angle / TAU) * steps)) : 1;
  const phi = (s) => (full ? TAU * s : Math.PI / 2 - angle / 2 + angle * s); // φ = π/2 が XY 平面（断面の位置）
  const half = revolve ? 0 : part.extrude.distance / 2;

  const positions = [], normals = [], index = [];
  const vertex = (p, n) => (positions.push(...p), normals.push(...n), positions.length / 3 - 1);
  const pos = (i) => positions.slice(3 * i, 3 * i + 3);
  /** 三角形を、決めた外向き（outward）に合わせた向きで加える（面積の無い三角形は加えない） */
  const triangle = (a, b, c, outward) => {
    const [pa, pb, pc] = [pos(a), pos(b), pos(c)];
    const u = pb.map((v, k) => v - pa[k]), w = pc.map((v, k) => v - pa[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
    if (Math.hypot(...n) < 1e-12) return;
    index.push(...(dot >= 0 ? [a, b, c] : [a, c, b]));
  };
  /** 帯: 点の列 from → to（同じ数）を、進む向きの右側を外にして四角形でつなぐ（rings … [輪郭の点 → 3D の点・法線]） */
  const band = (pts, rings, closed = true) => {
    pts.forEach((p0, i) => {
      if (!closed && i === pts.length - 1) return;
      const j = (i + 1) % pts.length;
      const p1 = pts[j];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (len < 1e-12) return;
      const n2 = [(p1[1] - p0[1]) / len, -(p1[0] - p0[0]) / len]; // 進む向きの右側 = 材料の外
      const ring = rings.map((at) => [vertex(...at(i, n2)), vertex(...at(j, n2))]);
      for (let k = 0; k + 1 < ring.length; k++) {
        const out = rings[k](i, n2, k + 0.5)[1];
        const [a, b] = ring[k], [c, e] = ring[k + 1];
        triangle(a, b, e, out);
        triangle(a, e, c, out);
      }
    });
  };

  if (revolve) {
    const pts = sampleLoop(orientLoop(part.sketch.loops[0], false), { steps });
    const at = ([x, y], s) => [x * Math.sin(phi(s)), y, x * Math.cos(phi(s))];
    const normalAt = ([nx, ny], s) => [nx * Math.sin(phi(s)), ny, nx * Math.cos(phi(s))];
    const rings = Array.from({ length: turns + 1 }, (_, k) => {
      const s = full && k === turns ? 0 : k / turns;
      return (i, n2, mid) => [at(pts[i], s), normalAt(n2, mid === undefined ? s : (k + 0.5) / turns)];
    });
    band(pts, rings);
    if (!full) {
      for (const s of [0, 1]) {
        const outward = [Math.cos(phi(s)), 0, -Math.sin(phi(s))].map((v) => (s ? v : -v)); // 回転の進む向き（終わりの端）・その逆（始まりの端）
        cap([pts], (p) => at(p, s), outward, vertex, triangle);
      }
    }
    return { positions, normals, index };
  }

  const chamfers = part.chamfers ?? [];
  const outlines = part.sketch.loops.map((loop, k) => extrudeOutlines(loop, k, chamfers, steps));
  for (const { base, ends } of outlines) {
    const lo = -half + ends["-Z"].depth, hi = half - ends["+Z"].depth;
    // 側面（壁）: 面取りの残りの高さ
    band(base, [(i, n2) => [[...base[i], lo], [...n2, 0]], (i, n2) => [[...base[i], hi], [...n2, 0]]]);
    // 面取り面（45°）: 壁の縁（深さ 0）→ 端面の輪郭（深さ = 面取り）。深さ t の高さは、端面から面取り − t だけ内側
    for (const [side, edge, sz] of [["+Z", hi, 1], ["-Z", lo, -1]]) {
      const tilt = (n2) => [n2[0] / Math.SQRT2, n2[1] / Math.SQRT2, sz / Math.SQRT2];
      for (const { from, to, bottom, top } of ends[side].stages) {
        band(bottom, [(i, n2) => [[...bottom[i], edge + sz * from], tilt(n2)], (i, n2) => [[...top[i], edge + sz * to], tilt(n2)]]);
      }
    }
  }
  // 端面: 輪郭（面取りがあればずらした輪郭）を穴つきで三角形に分ける
  for (const [side, z] of [["-Z", -half], ["+Z", half]]) {
    cap(outlines.map((o) => o.ends[side].pts), ([x, y]) => [x, y, z], [0, 0, Math.sign(z)], vertex, triangle);
  }
  return { positions, normals, index };
}

/** 平らな端面: 外周と穴の点の列を三角形に分け、外向きにそろえる */
function cap(loops, at, outward, vertex, triangle) {
  const [outer, ...holes] = loops.map((pts) => pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
  const ids = [outer, ...holes].flat().map((p) => vertex(at([p.x, p.y]), outward));
  for (const [a, b, c] of faces) triangle(ids[a], ids[b], ids[c], outward);
}

/** 1 部品の 3D 表示の形（外向きの面・法線つき。断面の辺の境目は角のまま、回転の向きには滑らか） */
export function partGeometry(part, { steps = STEPS } = {}) {
  if (part.kind === "mesh") return meshGeometry(part.mesh);
  const { positions, normals, index } = buildSolid(part, steps);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

/**
 * 1 部品の閉じた三角形（頂点を共有する。変換データの mesh と同じ形 { positions, triangles }）。
 * 寸法を直した部品の、STEP 用の代わりの形（面取り付きの押し出しなど）に使う。表示の形と同じ作り方で、同じ位置の頂点を 1 つにまとめる
 */
export function solidMesh(part, { steps = STEPS } = {}) {
  if (part.kind === "mesh") return part.mesh;
  const { positions, index } = buildSolid(part, steps);
  const ids = new Map(), out = [], remap = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const p = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]].map((v) => Math.round(v * 1e6) / 1e6 + 0);
    const key = p.join(",");
    if (!ids.has(key)) {
      ids.set(key, ids.size);
      out.push(...p);
    }
    remap.push(ids.get(key));
  }
  const triangles = [];
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [index[k], index[k + 1], index[k + 2]].map((i) => remap[i]);
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { positions: out, triangles };
}

/** 近似の部品（三角形のまま）の形。三角形ごとの法線で、面を平らに見せる */
function meshGeometry({ positions, triangles }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles.flatMap((i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]), 3));
  geometry.setIndex(triangles.map((_, k) => k));
  geometry.computeVertexNormals();
  return geometry;
}

/** 配置（原点と X・Y・Z 軸）→ 4×4 行列（行優先。組立の表示と同じ形） */
const matrixOf = ({ origin, x, y, z }) => [x[0], y[0], z[0], origin[0], x[1], y[1], z[1], origin[1], x[2], y[2], z[2], origin[2], 0, 0, 0, 1];

/** 3D 表示の形: 部品ごとの形を 1 回だけ作り、配置の数だけ置く（viewer の組立の表示と同じ）。配置の番号は describeSpec と同じ */
export function previewScene(spec) {
  let id = 0;
  return {
    parts: spec.parts.map((part) => ({ geometry: partGeometry(part) })),
    instances: spec.parts.flatMap((part, i) => part.instances.map((frame) => ({ part: i, matrix: matrixOf(frame), id: id++ }))),
  };
}

const SEGMENT_LABEL = { line: "直線", arc: "円弧", circle: "円" };

/** 1 部品の説明（見出しの寸法・補足）。取り込んだ HTML の部品と同じ書き方にする */
function describeSpecPart(part) {
  if (part.kind === "mesh") {
    const p = part.mesh.positions;
    const size = [0, 1, 2].map((k) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = k; i < p.length; i += 3) [lo, hi] = [Math.min(lo, p[i]), Math.max(hi, p[i])];
      return hi - lo;
    });
    return { kind: "mesh", main: size.map(fmt).join(" × "), sub: `三角形 ${part.mesh.triangles.length / 3} 枚のまま（円は多角形）` };
  }
  const pts = part.sketch.loops.flatMap(sampleLoop);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const counts = {};
  for (const s of part.sketch.loops.flat()) counts[s.type] = (counts[s.type] ?? 0) + 1;
  const section = `断面 ${Object.entries(counts).map(([k, n]) => `${SEGMENT_LABEL[k] ?? k} ${n}`).join("・")}`;
  if (part.kind === "revolve") {
    const deg = part.revolve.angle_deg;
    const sector = deg < 360 - 1e-6;
    const inner = Math.min(...xs);
    return {
      kind: sector ? "sector" : "revolve",
      main: `φ${fmt(2 * Math.max(...xs))} × ${fmt(Math.max(...ys) - Math.min(...ys))}`,
      sub: [inner > 1e-6 ? `内径 φ${fmt(2 * inner)}` : "中実", sector ? `${deg.toFixed(2)}°` : null, section].filter(Boolean).join(" · "),
    };
  }
  const holes = part.sketch.loops.length - 1;
  return {
    kind: "prism",
    main: `${fmt(Math.max(...xs) - Math.min(...xs))} × ${fmt(Math.max(...ys) - Math.min(...ys))} × ${fmt(part.extrude.distance)}`,
    sub: [`${section}${holes ? `（穴 ${holes}）` : ""}`, ...describeChamfers(part.chamfers ?? [])].join(" · "),
  };
}

/**
 * 部品の一覧（パネルの行）と、3D の配置ごとの説明。
 * @returns {{ groups: object[], partInfo: Map<number, {group: string, text: string}>, counts: { parts: number, placed: number, skipped: number, approx: number } }}
 */
export function describeSpec(spec) {
  let id = 0;
  const partInfo = new Map();
  const groups = spec.parts.map((part) => {
    const d = describeSpecPart(part);
    const ids = part.instances.map(() => id++);
    const group = { key: part.key, label: KIND_LABEL[d.kind], tone: d.kind === "mesh" ? "approx" : "exact", ...d, ids, name: part.name };
    for (const i of ids) partInfo.set(i, { group: part.key, text: `${group.label} ${d.main} · ${part.name}` });
    return group;
  });
  const skipped = spec.skipped.reduce((sum, s) => sum + (s.count ?? 0), 0);
  return { groups, partInfo, counts: { parts: spec.parts.length, placed: id, skipped, approx: spec.parts.filter((p) => p.kind === "mesh").length } };
}
