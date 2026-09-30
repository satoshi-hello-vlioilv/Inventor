// Inventor 用の変換データ（JSON）を作る。ビルダー（builder/ipt_build。Python）がこれを読み、Inventor API で .ipt を作る。
//
// 部品ごとのローカル座標系（mm）:
//   回転体   … 断面を XY 平面に「x = 半径、y = 軸方向」で描き、Y 軸まわりに回す。部分回転は XY 平面に対して対称
//   押し出し … 断面を XY 平面に描き、Z 方向に押し出す。XY 平面に対して対称。
//              端面（Z = ±長さ/2）の縁の面取りは chamfers に「どのループの、どちらの端面の縁を、何 mm」で並べる
// 対称にするのは、Inventor の回転・押し出しの「正方向」の解釈に左右されない形にするため。
// 同じ形の部品は 1 つにまとめ、取り込んだシーン内の配置（instances）を並べる。

import { add, cross, dot, length, mul, sub } from "../core/vec.js";
import { pointAt } from "./recognize/mesh.js";
import { chamferIntegrals, distanceToLoop, insideSection, loopIntegrals, offsetIntoMaterial } from "./recognize/geometry2d.js";

export const FORMAT = "inventor-builder";
export const VERSION = 2; // 2: 押し出しの面取り（chamfers）を追加

/** float32 由来の誤差を除く: 0.001 mm の格子から 0.0001 mm 以内なら格子に合わせ、それ以外は 0.000001 mm に丸める。 */
export function snapValue(v) {
  const r3 = Math.round(v * 1e3) / 1e3;
  return (Math.abs(v - r3) <= 1e-4 ? r3 : Math.round(v * 1e6) / 1e6) + 0;
}
const snapPoint = (p) => p.map(snapValue);
const snapUnit = (v) => v.map((c) => Math.round(c * 1e9) / 1e9 + 0);

function snapLoop(loop) {
  return loop.map((s) =>
    s.type === "circle" ? { type: "circle", center: snapPoint(s.center), radius: snapValue(s.radius) }
      : s.type === "arc" ? { type: "arc", a: snapPoint(s.a), b: snapPoint(s.b), center: snapPoint(s.center), ccw: s.ccw }
        : { type: "line", a: snapPoint(s.a), b: snapPoint(s.b) });
}

/** 断面の 2 次元座標を角度 alpha だけ回した座標系で表し直す。 */
function rotateLoop(loop, alpha) {
  const [c, s] = [Math.cos(alpha), Math.sin(alpha)];
  const r = ([x, y]) => [x * c + y * s, -x * s + y * c];
  return loop.map((seg) => ({ ...seg, ...(seg.a && { a: r(seg.a), b: r(seg.b) }), ...(seg.center && { center: r(seg.center) }) }));
}

function revolveFeature(part) {
  const { axis, frame: [u, v], sector } = part.fit;
  const t = sector ? sector.start + sector.span / 2 : 0; // 部分回転は扇形の中央を X 軸にする
  const x = add(mul(u, Math.cos(t)), mul(v, Math.sin(t)));
  return {
    kind: "revolve",
    loops: [snapLoop(part.segments)],
    revolve: { angle_deg: snapValue(part.sweepDeg) },
    frame: { origin: axis.origin, x, y: axis.dir, z: cross(x, axis.dir) },
  };
}

function extrudeFeature(part) {
  const { axis, frame: [u, v], h0, h1 } = part.fit;
  const z = axis.dir;
  // 断面の向きを部品自身の座標軸に揃える（回転して配置された同じ部品を同じ形として扱うため）
  const hint = part.localAxes.find((a) => Math.abs(dot(a, z)) < 1 - 1e-6) ?? u;
  const projected = sub(hint, mul(z, dot(hint, z)));
  const x = mul(projected, 1 / length(projected));
  const alpha = Math.atan2(dot(x, v), dot(x, u));
  const loops = [part.segments.outer, ...part.segments.holes].map((l) => snapLoop(rotateLoop(l, alpha)));
  const chamfers = (part.chamfers ?? [])
    .map((c) => ({ loop: c.loop, side: c.side > 0 ? "+Z" : "-Z", distance: snapValue(c.distance) }))
    .sort((a, b) => a.loop - b.loop || a.side.localeCompare(b.side));
  return {
    kind: "extrude",
    loops,
    extrude: { distance: snapValue(h1 - h0) },
    ...(chamfers.length && { chamfers }),
    frame: { origin: add(axis.origin, mul(z, (h0 + h1) / 2)), x, y: cross(z, x), z },
  };
}

/** 認識結果から、ローカル座標系での形状定義を作る（近似・除外の部品は null）。 */
export function featureOf(part) {
  if (part.kind === "revolve") return revolveFeature(part);
  if (part.kind === "prism") return extrudeFeature(part);
  return null;
}

/**
 * 形状定義から体積（mm³）と表面積（mm²）を厳密に計算する。Inventor が作った部品の検証に使う。
 * 面取り（等距離 d）は、削られる体積を引き、端面の面積を削られた分だけ減らし、45° の面取り面（端面に投影した面積の √2 倍）を
 * 加え、側壁をその縁の長さ × d だけ短くする。
 */
export function expectedProperties(feature) {
  if (feature.kind === "revolve") {
    const deg = feature.revolve.angle_deg;
    const theta = (deg * Math.PI) / 180;
    const I = loopIntegrals(feature.loops[0]);
    return { volume: theta * Math.abs(I.moment), area: theta * I.lateral + (deg < 360 ? 2 * Math.abs(I.area) : 0) };
  }
  const integrals = feature.loops.map(loopIntegrals);
  const [outer, ...holes] = integrals;
  const section = Math.abs(outer.area) - holes.reduce((s, h) => s + Math.abs(h.area), 0);
  const perimeter = integrals.reduce((s, i) => s + i.perimeter, 0);
  const L = feature.extrude.distance;
  let volume = section * L, area = 2 * section + perimeter * L;
  for (const c of feature.chamfers ?? []) {
    const cut = chamferIntegrals(feature.loops[c.loop], c.distance, c.loop > 0);
    if (!cut) throw new Error(`ループ ${c.loop} の面取り ${c.distance} mm の輪郭を作れません`);
    volume -= cut.volume;
    area += (Math.SQRT2 - 1) * cut.face - integrals[c.loop].perimeter * c.distance;
  }
  return { volume, area };
}

/**
 * 押し出し（面取りを含む）の表面までの距離。側面は高さ z での断面の輪郭（面取りの範囲では縁を材料側へずらした線）までの
 * 水平距離、端面は断面の内側にあるときの高さの差。面取り面（45°）では水平距離は実際の距離の √2 倍以下なので、上限を与える。
 */
function extrudeDistance([x, y, z], feature, outlines) {
  const half = feature.extrude.distance / 2;
  const outlineAt = (h) => {
    const key = h.toFixed(6);
    if (!outlines.has(key)) {
      outlines.set(key, feature.loops.map((loop, k) => {
        const depth = Math.max(0, ...(feature.chamfers ?? []).filter((c) => c.loop === k)
          .map((c) => c.distance - (half - (c.side === "+Z" ? h : -h))));
        return depth > 0 ? offsetIntoMaterial(loop, depth, k > 0).loop : loop;
      }));
    }
    return outlines.get(key);
  };
  const clamped = Math.max(-half, Math.min(half, z));
  const side = Math.hypot(Math.min(...outlineAt(clamped).map((l) => distanceToLoop([x, y], l))), Math.abs(z) - Math.abs(clamped));
  const cap = insideSection([x, y], outlineAt(Math.sign(z) * half || half)) ? Math.abs(Math.abs(z) - half) : Infinity;
  return Math.min(side, cap);
}

/** 元のメッシュの全頂点が、形状定義から再構成した面にどれだけ近いか（最大距離 mm）。変換の正しさの検証に使う。 */
export function maxDeviation(part, feature, vertices = new Set(part.tris)) {
  const f = feature.frame;
  const outlines = new Map();
  let worst = 0;
  for (const i of vertices) {
    const d = sub(pointAt(part.points, i), f.origin);
    const [lx, ly, lz] = [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
    let dist;
    if (feature.kind === "revolve") {
      const r = Math.hypot(lx, lz);
      dist = distanceToLoop([r, ly], feature.loops[0]);
      const half = (feature.revolve.angle_deg * Math.PI) / 360;
      if (feature.revolve.angle_deg < 360 && r > 1e-6) dist = Math.max(dist, r * Math.max(0, Math.abs(Math.atan2(lz, lx)) - half));
    } else dist = extrudeDistance([lx, ly, lz], feature, outlines);
    worst = Math.max(worst, dist);
  }
  return worst;
}

/** 三角形メッシュの体積と表面積（検証用）。 */
export function meshProperties(part) {
  let volume = 0, area = 0;
  for (let k = 0; k < part.tris.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => pointAt(part.points, part.tris[k + j]));
    volume += dot(a, cross(b, c)) / 6;
    area += length(cross(sub(b, a), sub(c, a))) / 2;
  }
  return { volume: Math.abs(volume), area };
}

const short = (v) => String(snapValue(v));
const safe = (name) => name.replace(/[\\/:*?"<>|\s]+/g, "_");

function labelOf(part, feature) {
  if (feature.kind === "revolve") {
    const base = `φ${short(part.outerDiameter)}x${short(part.length)}`;
    return part.sweepDeg < 360 ? `部分回転_${base}_${short(part.sweepDeg)}deg` : `回転体_${base}`;
  }
  const chamfer = [...new Set((feature.chamfers ?? []).map((c) => `_C${short(c.distance)}`))].join("");
  return `押し出し_${part.shape.replace(/\s+/g, "")}_${short(part.width)}x${short(part.height)}x${short(part.length)}${chamfer}`;
}

/**
 * 認識結果から変換データを作る。
 * @param {{ file: string, revision: string|null, capturedAt: string }} source
 */
export function buildInventorSpec(source, recognition) {
  const shapes = new Map();
  const skipped = new Map();
  for (const part of recognition.parts) {
    if (part.kind === "open") continue;
    const feature = featureOf(part);
    if (!feature) {
      const key = part.reason;
      if (!skipped.has(key)) skipped.set(key, { reason: part.reason, count: 0 });
      skipped.get(key).count += 1;
      continue;
    }
    const { frame, ...shape } = feature;
    const key = JSON.stringify(shape);
    if (!shapes.has(key)) shapes.set(key, { shape, label: labelOf(part, feature), instances: [] });
    shapes.get(key).instances.push({ origin: snapPoint(frame.origin), x: snapUnit(frame.x), y: snapUnit(frame.y), z: snapUnit(frame.z) });
  }
  const stem = safe(source.file.replace(/\.[^.]+$/, ""));
  const pad = (i) => String(i + 1).padStart(2, "0");
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    format: FORMAT,
    version: VERSION,
    units: "mm",
    source: { file: source.file, three: source.revision, captured_at: source.capturedAt, unit_mm: recognition.unit ?? 1 },
    parts: [...shapes.values()].map(({ shape, label, instances }, i) => {
      const expect = expectedProperties(shape);
      return {
        key: `p${pad(i)}`,
        name: safe(`${stem}_${pad(i)}_${label}`),
        kind: shape.kind,
        sketch: { plane: "XY", loops: shape.loops },
        ...(shape.revolve ? { revolve: { axis: "Y", ...shape.revolve } } : { extrude: { direction: "Z", ...shape.extrude } }),
        ...(shape.chamfers && { chamfers: shape.chamfers }),
        expect: { volume: round(expect.volume), area: round(expect.area) },
        instances,
      };
    }),
    skipped: [...skipped.values()],
  };
}

/**
 * 変換データ（.inventor.json の文字列）を読み、形式・版・単位を確かめる。作れるかの細かい確かめはビルダー（Python）が行う。
 * @throws {Error} 変換データではない・読めない版のとき（利用者に見せる理由）
 */
export function readSpec(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めません");
  }
  if (spec?.format !== FORMAT) throw new Error("変換データ（format: inventor-builder）ではありません");
  if (!(spec.version >= 1 && spec.version <= VERSION)) throw new Error(`この版（version ${spec.version}）には対応していません。アプリを新しくしてください`);
  if (spec.units !== "mm") throw new Error("単位は mm のみ対応しています");
  if (!Array.isArray(spec.parts)) throw new Error("部品（parts）がありません");
  return { ...spec, source: spec.source ?? {}, skipped: spec.skipped ?? [] };
}

/** 変換データを読みやすい JSON 文字列にする（数値の配列は 1 行にまとめる）。 */
export function formatSpec(spec) {
  return JSON.stringify(spec, null, 1).replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, inner) => `[${inner.replace(/\s+/g, " ")}]`) + "\n";
}
