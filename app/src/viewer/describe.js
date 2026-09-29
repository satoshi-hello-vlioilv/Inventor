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
