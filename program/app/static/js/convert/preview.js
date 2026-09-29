// 変換データ（.inventor.json）を開いたときの表示: Inventor が作るのと同じ断面・回転角・押し出し量・配置から、
// 3D 表示用の形（組立と同じ「部品ごとの形 × 配置」）と、部品の説明を作る。DOM に依存しない（Node で評価する）。
// 面取りは形には描かない（作る部品には付く。部品の説明に書く）。

import * as THREE from "three";
import { describeChamfers, KIND_LABEL } from "../html/describe.js";
import { arcAngles } from "./recognize/geometry2d.js";

const STEPS = 64; // 1 周の分割（表示用。弦の誤差は半径の 0.12%）
const TAU = 2 * Math.PI;
const fmt = (v) => v.toFixed(3);

/** ループ（直線・円弧・円）を折れ線の点にする（閉じた点列。最後の点は最初に戻らない）。 */
export function sampleLoop(loop) {
  const points = [];
  for (const s of loop) {
    if (s.type === "circle") {
      for (let k = 0; k < STEPS; k++) points.push([s.center[0] + s.radius * Math.cos((TAU * k) / STEPS), s.center[1] + s.radius * Math.sin((TAU * k) / STEPS)]);
    } else if (s.type === "arc") {
      const { a0, sweep, radius } = arcAngles(s);
      const n = Math.max(1, Math.ceil((Math.abs(sweep) / TAU) * STEPS));
      for (let k = 0; k < n; k++) points.push([s.center[0] + radius * Math.cos(a0 + (sweep * k) / n), s.center[1] + radius * Math.sin(a0 + (sweep * k) / n)]);
    } else {
      points.push(s.a);
    }
  }
  return points;
}

const signedArea = (pts) => pts.reduce((sum, [x0, y0], i) => { const [x1, y1] = pts[(i + 1) % pts.length]; return sum + x0 * y1 - x1 * y0; }, 0) / 2;
/** 外周は反時計回り、穴は時計回りにそろえる（どちらも、進む向きの右側が材料の外） */
const oriented = (pts, hole) => ((signedArea(pts) > 0) === !hole ? pts : [...pts].reverse());

/**
 * 1 部品の形（外向きの面・法線つき）。
 * 押し出し: 断面を Z 方向に ±長さ/2。回転: Y 軸まわりに、360° 未満なら XY 平面に対して対称に（ビルダーと同じ）。
 */
export function partGeometry(part) {
  const loops = part.sketch.loops.map((loop, i) => oriented(sampleLoop(loop), i > 0));
  const revolve = part.kind === "revolve";
  const angle = revolve ? (part.revolve.angle_deg * Math.PI) / 180 : 0;
  const full = revolve && part.revolve.angle_deg >= 360 - 1e-9;
  const steps = revolve ? Math.max(2, Math.ceil((angle / TAU) * STEPS)) : 1;
  const phi = (s) => (full ? TAU * s : Math.PI / 2 - angle / 2 + angle * s); // φ = π/2 が XY 平面（断面の位置）
  const d = revolve ? 0 : part.extrude.distance;
  // 断面の点 (x, y) と進み具合 s（0〜1）→ 3D の点、断面の法線 (nx, ny) → 3D の法線
  const at = revolve ? ([x, y], s) => [x * Math.sin(phi(s)), y, x * Math.cos(phi(s))] : ([x, y], s) => [x, y, d * (s - 0.5)];
  const normalAt = revolve ? ([nx, ny], s) => [nx * Math.sin(phi(s)), ny, nx * Math.cos(phi(s))] : ([nx, ny]) => [nx, ny, 0];

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

  // 側面（押し出しの壁・回転面）: 断面の辺ごとに、辺の法線を持つ帯を作る（辺の境目は角のまま、回転の向きには滑らか）
  for (const pts of loops) {
    pts.forEach((p0, i) => {
      const p1 = pts[(i + 1) % pts.length];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (len < 1e-12) return;
      const n2 = [(p1[1] - p0[1]) / len, -(p1[0] - p0[0]) / len]; // 進む向きの右側 = 材料の外
      const ring = [];
      for (let k = 0; k <= steps; k++) {
        const s = full && k === steps ? 0 : k / steps;
        ring.push([vertex(at(p0, s), normalAt(n2, s)), vertex(at(p1, s), normalAt(n2, s))]);
      }
      for (let k = 0; k < steps; k++) {
        const out = normalAt(n2, (k + 0.5) / steps);
        const [a, b] = ring[k], [c, e] = ring[k + 1];
        triangle(a, b, e, out);
        triangle(a, e, c, out);
      }
    });
  }

  // 端面（押し出しの両端・360° 未満の回転の両端）: 断面を穴つきで三角形に分け、外向きにそろえる
  if (!full) {
    const [outer, ...holes] = loops.map((pts) => pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    const flat = [outer, ...holes].flat();
    for (const s of [0, 1]) {
      const outward = revolve
        ? [Math.cos(phi(s)), 0, -Math.sin(phi(s))].map((v) => (s ? v : -v)) // 回転の進む向き（終わりの端）・その逆（始まりの端）
        : [0, 0, s ? 1 : -1];
      const ids = flat.map((p) => vertex(at([p.x, p.y], s), outward));
      for (const [a, b, c] of faces) triangle(ids[a], ids[b], ids[c], outward);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
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
    note: part.chamfers?.length ? "面取りは 3D の形には描いていません（作る部品には付きます）" : null,
  };
}

/**
 * 部品の一覧（パネルの行）と、3D の配置ごとの説明。
 * @returns {{ groups: object[], partInfo: Map<number, {group: string, text: string}>, counts: { parts: number, placed: number, skipped: number } }}
 */
export function describeSpec(spec) {
  let id = 0;
  const partInfo = new Map();
  const groups = spec.parts.map((part) => {
    const d = describeSpecPart(part);
    const ids = part.instances.map(() => id++);
    const group = { key: part.key, label: KIND_LABEL[d.kind], tone: "exact", ...d, ids, name: part.name };
    for (const i of ids) partInfo.set(i, { group: part.key, text: `${group.label} ${d.main} · ${part.name}` });
    return group;
  });
  const skipped = spec.skipped.reduce((sum, s) => sum + (s.count ?? 0), 0);
  return { groups, partInfo, counts: { parts: spec.parts.length, placed: id, skipped } };
}
