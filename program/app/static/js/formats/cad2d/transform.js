// 2D の図形を動かす・回す・拡大する（図面のモデル model.js の図形。2D の編集と、その評価で使う）。
//   similarity({ move, angle, center, scale }) → 変換 m（x' = a x + c y + e、y' = b x + d y + f。向きを保つ相似: 回転・平行移動・拡大）
//   transformEntity(図形, m) → 動かした図形（新しい値。元の図形は変えない）。直せない図形は EditError（理由つき）
//
// 座標の約束（model.js）: 円・円弧・ポリライン・文字・ブロック参照・ハッチング・塗り（SOLID）は、押し出しの向き（extrusion）で決まる
// 図形ごとの座標系（OCS）の値を持つ。図面の XY の面で動かすので、押し出しの向きが Z と平行（+Z か −Z）な図形だけを直す。
// −Z の図形（鏡に映した部品など）は OCS の X が図面の −X になるので、変換を OCS に移してから当てる（角度の向きも逆になる）。
// 寸法の見た目は無名のブロック（*D…。寸法の定義点と同じ図面の座標）にあるので、寸法を動かすときは、そのブロックの図形も同じ変換で動かす
// （呼ぶ側が transformEntity をブロックの図形に当てる。edit/drawing.js）。

import { ocsAxes } from "./curves.js";

export class EditError extends Error {}

const TILTED = "図面の面に平行でない（3D の向きの）図形は、まだ直せません";

export const IDENTITY2D = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** 変換の合成（先に n、次に m） */
export const compose = (m, n) => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});

/** 相似の変換: center を中心に angle（ラジアン・反時計回り）回し scale 倍し、move だけ動かす */
export function similarity({ move = [0, 0], angle = 0, center = [0, 0], scale = 1 } = {}) {
  const [cos, sin] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
  const [cx, cy] = center;
  return { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy + move[0], f: cy - sin * cx - cos * cy + move[1] };
}

export const applyPoint = (m, p) => [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f, ...(p.length > 2 ? [p[2]] : [])];
const applyVector = (m, v) => [m.a * v[0] + m.c * v[1], m.b * v[0] + m.d * v[1], ...(v.length > 2 ? [v[2]] : [])];
/** 向きだけ回す（長さを変えない: 単位の向き・接線） */
const rotateVector = (m, v) => {
  const s = scaleOf(m);
  return applyVector(m, v).map((x, i) => (i < 2 ? x / s : x));
};
export const angleOf = (m) => Math.atan2(m.b, m.a);
export const scaleOf = (m) => Math.hypot(m.a, m.b);

/** 押し出しの向きの座標系（OCS）での変換。Z と平行でなければ直せない */
function ocsTransform(m, extrusion) {
  const axes = ocsAxes(extrusion);
  if (!axes) return m;
  const [ax, ay, n] = axes;
  if (Math.abs(n[0]) > 1e-9 || Math.abs(n[1]) > 1e-9) throw new EditError(TILTED);
  // OCS → WCS の XY: [ax ay]（直交）。OCS での変換 = L⁻¹ m L（L は直交なので L⁻¹ = 転置）
  const L = { a: ax[0], b: ax[1], c: ay[0], d: ay[1], e: 0, f: 0 };
  const Lt = { a: ax[0], b: ay[0], c: ax[1], d: ay[1], e: 0, f: 0 };
  return compose(Lt, compose(m, L));
}

// 寸法の種類ごとに意味のある定義点（ほかの点は読み取りが 0 を入れているだけなので動かさない。DXF の説明書）
const DIMENSION_POINTS = { linear: ["p10", "p13", "p14"], aligned: ["p10", "p13", "p14"], ordinate: ["p10", "p13", "p14"], angular: ["p10", "p13", "p14", "p15", "p16"],
  angular3: ["p10", "p13", "p14", "p15"], diameter: ["p10", "p15"], radius: ["p10", "p15"] };
const points = (m, list) => list?.map((p) => applyPoint(m, p));

/** 文字（TEXT・ATTDEF・ATTRIB）: 挿入点・合わせる点は OCS、回転・高さ */
function text(e, m) {
  const o = ocsTransform(m, e.extrusion);
  return { ...e, p: applyPoint(o, e.p), align: e.align ? applyPoint(o, e.align) : e.align, rotation: (e.rotation ?? 0) + angleOf(o), height: (e.height ?? 0) * scaleOf(m) };
}

/** ハッチングの境界の辺（OCS）。時計回りの円弧・楕円弧は角度を補角（−角度）で持つ（DXF の約束）ので、回す向きも逆 */
function hatchEdge(edge, o) {
  const turn = angleOf(o), s = scaleOf(o);
  switch (edge.kind) {
    case "line": return { ...edge, a: applyPoint(o, edge.a), b: applyPoint(o, edge.b) };
    case "arc": {
      const d = edge.ccw === false ? -turn : turn;
      return { ...edge, center: applyPoint(o, edge.center), radius: edge.radius * s, start: edge.start + d, end: edge.end + d };
    }
    case "ellipse": return { ...edge, center: applyPoint(o, edge.center), major: applyVector(o, edge.major) };
    case "spline": return { ...edge, controls: points(o, edge.controls), fit: points(o, edge.fit) };
    default: return edge;
  }
}

/** 図形の種類 → 動かし方（m は図面の座標の変換。OCS の図形は ocsTransform で移す） */
const TRANSFORMS = {
  LINE: (e, m) => ({ ...e, a: applyPoint(m, e.a), b: applyPoint(m, e.b) }),
  POINT: (e, m) => ({ ...e, p: applyPoint(m, e.p) }),
  CIRCLE: (e, m) => ({ ...e, center: applyPoint(ocsTransform(m, e.extrusion), e.center), radius: e.radius * scaleOf(m) }),
  ARC: (e, m) => {
    const o = ocsTransform(m, e.extrusion);
    return { ...e, center: applyPoint(o, e.center), radius: e.radius * scaleOf(m), start: e.start + angleOf(o), end: e.end + angleOf(o) };
  },
  ELLIPSE: (e, m) => ({ ...e, center: applyPoint(m, e.center), major: applyVector(m, e.major) }),
  LWPOLYLINE: (e, m) => {
    const o = ocsTransform(m, e.extrusion), s = scaleOf(m);
    return { ...e, points: e.points.map((p) => applyPoint(o, p)), widths: e.widths?.map(([a, b]) => [a * s, b * s]), constWidth: (e.constWidth ?? 0) * s };
  },
  POLYLINE: (e, m) => {
    const o = e.kind === "2d" ? ocsTransform(m, e.extrusion) : m;
    return { ...e, vertices: e.vertices.map((v) => ({ ...v, p: applyPoint(o, v.p) })) };
  },
  SPLINE: (e, m) => ({ ...e, controls: points(m, e.controls), fit: points(m, e.fit),
    startTangent: e.startTangent && rotateVector(m, e.startTangent), endTangent: e.endTangent && rotateVector(m, e.endTangent) }),
  TEXT: text,
  ATTDEF: text,
  ATTRIB: text,
  MTEXT: (e, m) => ({ ...e, p: applyPoint(m, e.p), direction: rotateVector(m, e.direction ?? [1, 0, 0]), height: (e.height ?? 0) * scaleOf(m), width: (e.width ?? 0) * scaleOf(m) }),
  INSERT: (e, m) => {
    const o = ocsTransform(m, e.extrusion), s = scaleOf(m);
    return { ...e, p: applyPoint(o, e.p), rotation: (e.rotation ?? 0) + angleOf(o), scale: (e.scale ?? [1, 1, 1]).map((k) => k * s),
      columnSpacing: (e.columnSpacing ?? 0) * s, rowSpacing: (e.rowSpacing ?? 0) * s, attribs: e.attribs?.map((a) => transformEntity(a, m)) };
  },
  DIMENSION: (e, m) => {
    const out = { ...e, textMid: applyPoint(ocsTransform(m, e.extrusion), e.textMid ?? [0, 0, 0]) };
    for (const key of DIMENSION_POINTS[e.kind] ?? ["p10", "p13", "p14", "p15", "p16"]) if (e[key]) out[key] = applyPoint(m, e[key]);
    if (Number.isFinite(e.measurement) && ["linear", "aligned", "diameter", "radius", "ordinate"].includes(e.kind)) out.measurement = e.measurement * scaleOf(m);
    return out;
  },
  HATCH: (e, m) => {
    const o = ocsTransform(m, e.extrusion), turn = angleOf(o), s = scaleOf(o);
    const loops = e.loops.map((l) => (l.points ? { ...l, points: points(o, l.points) } : { ...l, edges: l.edges.map((edge) => hatchEdge(edge, o)) }));
    return { ...e, loops, angle: (e.angle ?? 0) + turn, scale: (e.scale ?? 1) * s,
      lines: e.lines?.map((l) => ({ ...l, angle: l.angle + turn, base: applyPoint(o, l.base), offset: applyVector(o, l.offset), dashes: l.dashes.map((d) => d * s) })) };
  },
  SOLID: (e, m) => ({ ...e, points: points(ocsTransform(m, e.extrusion), e.points) }),
  "3DFACE": (e, m) => ({ ...e, points: points(m, e.points) }),
  LEADER: (e, m) => ({ ...e, points: points(m, e.points) }),
  RAY: (e, m) => ({ ...e, p: applyPoint(m, e.p), direction: rotateVector(m, e.direction) }),
  XLINE: (e, m) => ({ ...e, p: applyPoint(m, e.p), direction: rotateVector(m, e.direction) }),
  PATH: (e, m) => ({ ...e, width: (e.width ?? 0) * scaleOf(m), dashes: e.dashes?.map((d) => d * scaleOf(m)), clip: undefined,
    subpaths: e.subpaths.map((sp) => {
      const pts = [];
      for (let i = 0; i + 1 < sp.points.length; i += 2) pts.push(...applyPoint(m, [sp.points[i], sp.points[i + 1]]));
      return { ...sp, points: pts, curves: (sp.curves ?? []).map(([i, x1, y1, x2, y2]) => [i, ...applyPoint(m, [x1, y1]), ...applyPoint(m, [x2, y2])]) };
    }) }),
  IMAGE: (e, m) => {
    const [a, b, c, d, x, y] = e.matrix;
    const r = compose(m, { a, b, c, d, e: x, f: y });
    return { ...e, matrix: [r.a, r.b, r.c, r.d, r.e, r.f], clip: undefined };
  },
};

const REFUSE = { VIEWPORT: "ビューポート（紙のレイアウトの窓）は、まだ直せません", ACIS: "3D の立体は、2D では直せません" };

/** 直せるか（直せなければ理由） */
export function editableReason(e) {
  if (TRANSFORMS[e.type]) return null;
  return REFUSE[e.type] ?? `${e.type} は、まだ直せません`;
}

/** 図形を動かした新しい図形（元の図形は変えない）。向きを変える変換（鏡映）は受け付けない（円弧の向き・文字の向きの扱いが別に要る） */
export function transformEntity(e, m) {
  if (m.a * m.d - m.b * m.c <= 0) throw new EditError("鏡に映す変換は、まだ使えません");
  const reason = editableReason(e);
  if (reason) throw new EditError(reason);
  // 押し出しの向きが Z と平行でない図形（立てた面の文字など）は、図面の XY の面の変換では直せない（OCS を持たない種類も同じ）
  const n = e.extrusion;
  if (n && (Math.abs(n[0]) > 1e-9 || Math.abs(n[1]) > 1e-9)) throw new EditError(TILTED);
  return TRANSFORMS[e.type](e, m);
}
