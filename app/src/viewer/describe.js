// シーンの要約から、画面に出す説明（面ごとの説明文・形状要素のグループ）を作る。DOM に依存しない。

import { isRenderable } from "./tessellate.js";

export const fmt = (v) => v.toFixed(3);
export const AXES = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]];
const KIND_ORDER = ["hole", "boss", "round", "inner_round"];

/** 座標軸に平行なら "+Y" のように、そうでなければ成分で表す。 */
export function axisName(v) {
  for (const [name, axis] of AXES) {
    const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    if (Math.abs(Math.abs(d) - 1) < 1e-6) return (d > 0 ? "+" : "−") + name;
  }
  return `(${v.map(fmt).join(", ")})`;
}

/**
 * @returns {{ faceInfo: Map<number, {group: string|null, text: string}>, groups: object[], unsupported: number }}
 */
export function describeBody(body, labels) {
  const surfaceName = (type) => labels.surfaces[type] ?? type;
  const faceInfo = new Map();
  const groups = new Map();
  for (const c of body.summary.cylinders) {
    const label = labels.cylinders[c.kind];
    const dim = `${label.symbol}${fmt(c[label.field])}`;
    const key = `${c.kind}:${dim}`;
    if (!groups.has(key)) groups.set(key, { key, kind: c.kind, name: label.name, dim, items: [] });
    groups.get(key).items.push(c);
    for (const id of c.face_ids) {
      faceInfo.set(id, { group: key, text: `${label.name} ${dim} · 中心 (${c.center.map(fmt).join(", ")})` });
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
  const ordered = [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const g of ordered) {
    g.faceIds = g.items.flatMap((c) => c.face_ids);
    g.text = `${g.name} ${g.dim} × ${g.items.length}`;
    g.detail = `長さ ${[...new Set(g.items.map((c) => fmt(c.length)))].join(" / ")} · ${[...new Set(g.items.map((c) => `${c.sweep_deg}°`))].join(" / ")}`;
  }
  return { faceInfo, groups: ordered, unsupported };
}
