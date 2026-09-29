// Inventor 用の変換データ（JSON）を作る。ビルダー（builder/ の Python スクリプト）がこれを読み、Inventor API で .ipt を作る。
//
// 部品ごとのローカル座標系（mm）:
//   回転体   … 断面を XY 平面に「x = 半径、y = 軸方向」で描き、Y 軸まわりに回す。部分回転は XY 平面に対して対称
//   押し出し … 断面を XY 平面に描き、Z 方向に押し出す。XY 平面に対して対称
// 対称にするのは、Inventor の回転・押し出しの「正方向」の解釈に左右されない形にするため。
// 同じ形の部品は 1 つにまとめ、取り込んだシーン内の配置（instances）を並べる。

import { add, cross, dot, length, mul, sub } from "../ipt/vec.js";
import { pointAt } from "../recognize/mesh.js";
import { distanceToLoop, loopIntegrals } from "./geometry2d.js";

export const FORMAT = "inventor-builder";
export const VERSION = 1;

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
  return {
    kind: "extrude",
    loops,
    extrude: { distance: snapValue(h1 - h0) },
    frame: { origin: add(axis.origin, mul(z, (h0 + h1) / 2)), x, y: cross(z, x), z },
  };
}

/** 認識結果から、ローカル座標系での形状定義を作る（近似・除外の部品は null）。 */
export function featureOf(part) {
  if (part.kind === "revolve") return revolveFeature(part);
  if (part.kind === "prism") return extrudeFeature(part);
  return null;
}

/** 形状定義から体積（mm³）と表面積（mm²）を厳密に計算する。Inventor が作った部品の検証に使う。 */
export function expectedProperties(feature) {
  if (feature.kind === "revolve") {
    const deg = feature.revolve.angle_deg;
    const theta = (deg * Math.PI) / 180;
    const I = loopIntegrals(feature.loops[0]);
    return { volume: theta * Math.abs(I.moment), area: theta * I.lateral + (deg < 360 ? 2 * Math.abs(I.area) : 0) };
  }
  const [outer, ...holes] = feature.loops.map(loopIntegrals);
  const section = Math.abs(outer.area) - holes.reduce((s, h) => s + Math.abs(h.area), 0);
  const perimeter = outer.perimeter + holes.reduce((s, h) => s + h.perimeter, 0);
  const L = feature.extrude.distance;
  return { volume: section * L, area: 2 * section + perimeter * L };
}

/** 元のメッシュの全頂点が、形状定義から再構成した面にどれだけ近いか（最大距離 mm）。変換の正しさの検証に使う。 */
export function maxDeviation(part, feature) {
  const f = feature.frame;
  let worst = 0;
  for (const i of new Set(part.tris)) {
    const d = sub(pointAt(part.points, i), f.origin);
    const [lx, ly, lz] = [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
    let dist;
    if (feature.kind === "revolve") {
      const r = Math.hypot(lx, lz);
      dist = distanceToLoop([r, ly], feature.loops[0]);
      const half = (feature.revolve.angle_deg * Math.PI) / 360;
      if (feature.revolve.angle_deg < 360 && r > 1e-6) dist = Math.max(dist, r * Math.max(0, Math.abs(Math.atan2(lz, lx)) - half));
    } else {
      const half = feature.extrude.distance / 2;
      dist = Math.min(Math.abs(Math.abs(lz) - half), ...feature.loops.map((l) => distanceToLoop([lx, ly], l)));
    }
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
  return `押し出し_${part.shape.replace(/\s+/g, "")}_${short(part.width)}x${short(part.height)}x${short(part.length)}`;
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
    source: { file: source.file, three: source.revision, captured_at: source.capturedAt },
    parts: [...shapes.values()].map(({ shape, label, instances }, i) => {
      const expect = expectedProperties(shape);
      return {
        key: `p${pad(i)}`,
        name: safe(`${stem}_${pad(i)}_${label}`),
        kind: shape.kind,
        sketch: { plane: "XY", loops: shape.loops },
        ...(shape.revolve ? { revolve: { axis: "Y", ...shape.revolve } } : { extrude: { direction: "Z", ...shape.extrude } }),
        expect: { volume: round(expect.volume), area: round(expect.area) },
        instances,
      };
    }),
    skipped: [...skipped.values()],
  };
}

/** 変換データを読みやすい JSON 文字列にする（数値の配列は 1 行にまとめる）。 */
export function formatSpec(spec) {
  return JSON.stringify(spec, null, 1).replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, inner) => `[${inner.replace(/\s+/g, " ")}]`) + "\n";
}
