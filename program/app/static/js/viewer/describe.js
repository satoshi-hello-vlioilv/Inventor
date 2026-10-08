// シーンの要約から、画面に出す説明（面ごとの説明文・形状要素のグループ）を作る。DOM に依存しない。

import { isRenderable } from "./tessellate.js";

export const fmt = (v) => v.toFixed(3);
/** 角度は小数第 1 位まで（269.889083 → 269.9、90 → 90） */
export const fmtAngle = (deg) => `${Number(deg.toFixed(1))}°`;
/** 寸法の短い表記（末尾の 0 を省く: 12 → 12、6.25 → 6.25） */
const fmtShort = (v) => String(Number(v.toFixed(3)));
export const AXES = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]];
// パネルに並べる順: 設計者が最初に確かめたいもの（ねじ・穴の径）から
const KIND_ORDER = ["thread", "hole", "boss", "round", "inner_round", "cone"];
const INTERNAL = new Set(["hole", "inner_round"]); // 凹の円筒（めねじになる側）

/** 座標軸に平行なら "+Y" のように、そうでなければ成分で表す。 */
export function axisName(v) {
  for (const [name, axis] of AXES) {
    const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    if (Math.abs(Math.abs(d) - 1) < 1e-6) return (d > 0 ? "+" : "−") + name;
  }
  return `(${v.map(fmt).join(", ")})`;
}

const unique = (values) => [...new Set(values)].join(" / ");

/**
 * 形状要素（円筒・円錐）をグループの定義に変換する。同じ key の要素は 1 行にまとめる。
 * @returns {{ key, kind, size, name, dim, hover, detail: (items) => string }}  size … 同じ種類の中で並べる順（寸法）
 */
function cylinderEntry(c, labels) {
  const label = labels.cylinders[c.kind];
  const size = `${label.symbol}${fmt(c[label.field])}`;
  if (c.thread) {
    const t = c.thread;
    const name = labels.threads[INTERNAL.has(c.kind) ? "internal" : "external"];
    const dim = t.designation.replace(/x/g, "×");
    const threadLength = (item) => item.thread.lengths.map(fmtShort).join(" + ");
    return {
      key: `thread:${name}:${t.designation}:${t.class}`, kind: "thread", size: c.diameter, name, dim,
      hover: `${name} ${dim} ${t.class} · ねじ長さ ${threadLength(c)} · 下穴 ${size}`,
      detail: (items) => `${t.class} · ねじ長さ ${unique(items.map(threadLength))} · 下穴 ${unique(items.map((i) => `${label.symbol}${fmt(i[label.field])}`))}`,
    };
  }
  return {
    key: `${c.kind}:${size}`, kind: c.kind, size: c[label.field], name: label.name, dim: size,
    hover: `${label.name} ${size}${c.sweep_deg < 360 ? ` · ${fmtAngle(c.sweep_deg)}` : ""}`,
    detail: (items) => `長さ ${unique(items.map((i) => fmt(i.length)))} · ${unique(items.map((i) => fmtAngle(i.sweep_deg)))}`,
  };
}

function coneEntry(c, labels) {
  const dim = fmtAngle(c.angle_deg);
  const range = (i) => `Φ${fmt(i.diameters[0])} 〜 Φ${fmt(i.diameters[1])}`;
  return {
    key: `cone:${dim}:${range(c)}`, kind: "cone", size: c.angle_deg, name: labels.cone.name, dim,
    hover: `${labels.cone.name} 頂角 ${dim} · ${range(c)}`,
    detail: (items) => `${unique(items.map(range))} · 長さ ${unique(items.map((i) => fmt(i.length)))}`,
  };
}

/**
 * @returns {{ faceInfo: Map<number, {group: string|null, text: string}>, groups: object[], unsupported: number }}
 */
export function describeBody(body, labels) {
  const surfaceName = (type) => labels.surfaces[type] ?? type;
  const faceInfo = new Map();
  const groups = new Map();
  const entries = [
    ...body.summary.cylinders.map((c) => [c, cylinderEntry(c, labels)]),
    ...(body.summary.cones ?? []).map((c) => [c, coneEntry(c, labels)]),
  ];
  for (const [item, entry] of entries) {
    if (!groups.has(entry.key)) groups.set(entry.key, { ...entry, items: [] });
    groups.get(entry.key).items.push(item);
    for (const id of item.face_ids) {
      faceInfo.set(id, { group: entry.key, text: `${entry.hover} · 中心 (${item.center.map(fmt).join(", ")})` });
    }
  }
  let unsupported = 0;
  for (const f of body.faces) {
    if (!isRenderable(f)) unsupported += 1;
    if (faceInfo.has(f.id)) continue;
    const text = f.type === "plane" ? `${surfaceName("plane")} · 法線 ${axisName(f.normal)}`
      : isRenderable(f) ? surfaceName(f.type) : `${surfaceName(f.type)} · 表示未対応（稜線のみ）`;
    faceInfo.set(f.id, { group: null, text });
  }
  const ordered = [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.size - b.size);
  for (const g of ordered) {
    g.faceIds = g.items.flatMap((c) => c.face_ids);
    g.text = `${g.name} ${g.dim} × ${g.items.length}`;
    g.detail = g.detail(g.items);
  }
  return { faceInfo, groups: ordered, unsupported };
}

// ---- 組立 ---------------------------------------------------------------------
const multiplyPoint = (m, p) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
/** 質量の表記（g、1 kg 以上は kg） */
export const fmtMass = (g) => (g >= 1000 ? `${(g / 1000).toFixed(3)} kg` : `${g.toFixed(1)} g`);
/** 外形の表記（54.5 × 54.5 × 77） */
export const fmtSize = (size) => size.map((v) => String(Number(v.toFixed(3)))).join(" × ");

/**
 * 組立（iam・STEP）の説明: 部品表（部品ごとの行）、配置ごとの説明文、外形寸法、質量の合計。
 * @param {object} scene   組立のシーン（parts・instances）
 * @param {Array<number|null>} volumes  部品ごとの体積（mm³、表示用の三角形から求めたもの）
 */
export function describeAssembly(scene, volumes = []) {
  const byPart = new Map();
  for (const inst of scene.instances) {
    if (!byPart.has(inst.part)) byPart.set(inst.part, []);
    byPart.get(inst.part).push(inst);
  }
  // 部品表は、組立の中で最初に現れた順（組立のブラウザーの並び）
  const order = [...new Set([...scene.instances.map((i) => i.part), ...scene.parts.keys()])];
  const info = new Map();
  const groups = order.map((index, n) => {
    const part = scene.parts[index];
    const instances = byPart.get(index) ?? [];
    const size = part.bodies?.[0]?.summary.size ?? null;
    const volume = volumes[index] ?? null;
    const mass = volume !== null && part.density_g_per_mm3 ? volume * part.density_g_per_mm3 : null;
    const key = `part:${index}`;
    for (const inst of instances) {
      info.set(inst.id, { group: key, text: `${inst.name}${size ? ` · ${fmtSize(size)}` : ""}${part.missing ? " · 部品ファイルなし" : ""}` });
    }
    return {
      key, index, number: n + 1, name: part.name, ids: instances.map((i) => i.id), count: instances.length,
      size, material: part.material, volume, mass, missing: Boolean(part.missing), file: part.file ?? null, path: part.path ?? null,
      standard: Boolean(part.display), // Content Center の標準部品（.iam の参照に表示名がある）
      text: `${part.name} × ${instances.length}`,
    };
  });
  // 外形寸法: 全ての配置の稜線の点を組立の座標にして囲む
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const inst of scene.instances) {
    for (const body of scene.parts[inst.part].bodies ?? []) {
      for (const line of body.edges) {
        for (const p of line) {
          const q = multiplyPoint(inst.matrix, p);
          for (let k = 0; k < 3; k++) {
            if (q[k] < lo[k]) lo[k] = q[k];
            if (q[k] > hi[k]) hi[k] = q[k];
          }
        }
      }
    }
  }
  const size = lo[0] <= hi[0] ? hi.map((v, k) => v - lo[k]) : null;
  const massKnown = groups.filter((g) => g.count && g.mass === null).length === 0;
  const totalMass = groups.reduce((s, g) => s + (g.mass ?? 0) * g.count, 0);
  return {
    info, groups, size,
    missing: groups.filter((g) => g.missing),
    totals: { parts: groups.length, instances: scene.instances.length, mass: totalMass, massComplete: massKnown },
  };
}

// ---- 三角形メッシュの場面（3D の PDF の 3D）-----------------------------------------
/**
 * 部品の行（一覧の順）・強調の対応（群の id → 行と説明文）・外形寸法（全ての部品の置いた後の位置を囲む）。
 * @param {{ meshes: { positions, matrix }[], parts: { name, faces, ids }[] }} scene  formats/model3d.js の read3d の結果
 */
export function describeMeshes({ meshes, parts }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { positions: p, matrix: m } of meshes) {
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m[k] * p[i] + m[4 + k] * p[i + 1] + m[8 + k] * p[i + 2] + m[12 + k]; // 列優先
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
  }
  const info = new Map();
  const groups = parts.map((part, i) => {
    const key = `mesh:${i}`;
    const text = `${part.name} · 面 ${part.faces}`;
    for (const id of part.ids) info.set(id, { group: key, text });
    return { key, number: i + 1, name: part.name, ids: part.ids, faces: part.faces, text };
  });
  const size = lo.every(Number.isFinite) ? hi.map((v, k) => v - lo[k]) : null;
  return { groups, info, size, faces: parts.reduce((sum, p) => sum + p.faces, 0) };
}
