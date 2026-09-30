// 認識結果を画面の言葉にする: 部品ごとの説明文と、同じ形状の部品をまとめたグループ。DOM に依存しない。

import { selfIntersectionNote } from "../convert/recognize/intersect.js";

const fmt = (v) => v.toFixed(3);

export const TONE = { revolve: "exact", prism: "exact", mesh: "approx" };
export const KIND_LABEL = { revolve: "回転体", sector: "部分回転", prism: "押し出し", mesh: "近似" };
const KIND_ORDER = ["revolve", "sector", "prism", "mesh"];
export const EXCLUDED_LABEL = {
  line: "線（寸法線・補助線など）",
  sprite: "文字・画像の板",
  points: "点群",
  empty: "頂点のない物体",
};

const CORNER_NOTE_MIN = 1e-3; // mm。これを超える差があれば、角付近の差として書き添える

/** 面取りの説明: 「面取り C1（穴の縁・両面）」。side は ±1（認識結果）か "+Z"・"-Z"（変換データ）。 */
export function describeChamfers(chamfers) {
  const groups = new Map();
  for (const c of chamfers) {
    const key = `${c.loop === 0 ? "外周" : "穴"}の縁|${+c.distance.toFixed(3)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const text = [...groups].map(([key, list]) => {
    const [edge, distance] = key.split("|");
    return `面取り C${distance}（${edge}・${new Set(list.map((c) => c.side)).size > 1 ? "両面" : "片面"}）`;
  });
  return text;
}

/** 変換後の形が元と違う箇所の注意（無ければ null）。 */
function chamferNote(chamfers) {
  const corner = Math.max(0, ...chamfers.map((c) => c.cornerDeviation));
  return corner > CORNER_NOTE_MIN ? `角付近は元の形と最大 ${corner.toFixed(3)} mm 差（CAD 標準の面取りで作るため）` : null;
}

/** 開いた面から作った部品の注意（元の形との違い）。 */
const REPAIR_NOTE = {
  stitched: "元は開いた面の組み合わせ（縫い合わせて立体にした）",
  capped: "元は開いた面（平らな縁を塞いで立体にした）",
};

/** 1 部品の説明（見出しの寸法・補足・注意・種類）。 */
export function describePart(p) {
  const d = describeShape(p);
  const untangled = p.untangled && `断面の小さな重なり ${p.untangled.count} か所（元のメッシュの折れ。最大 ${p.untangled.deviation.toFixed(3)} mm）を取り除いた`;
  const note = [d.note, REPAIR_NOTE[p.repair], untangled, p.intersections && selfIntersectionNote(p.intersections)].filter(Boolean).join("。");
  return { ...d, note: note || null };
}

function describeShape(p) {
  if (p.kind === "revolve") {
    const sector = p.sweepDeg < 360 - 1e-6;
    const inner = p.innerDiameter > 0 ? `内径 φ${fmt(p.innerDiameter)}` : "中実";
    return {
      kind: sector ? "sector" : "revolve",
      main: `φ${fmt(p.outerDiameter)} × ${fmt(p.length)}`,
      sub: [inner, sector ? `${p.sweepDeg.toFixed(2)}°` : null, `断面 ${p.profileText}`].filter(Boolean).join(" · "),
    };
  }
  if (p.kind === "prism") {
    return {
      kind: "prism",
      main: `${fmt(p.width)} × ${fmt(p.height)} × ${fmt(p.length)}`,
      sub: [`断面 ${p.shape}${p.holes ? `（穴 ${p.holes}）` : ""}`, `長さ ${fmt(p.length)}`, ...describeChamfers(p.chamfers ?? [])].join(" · "),
      note: chamferNote(p.chamfers ?? []),
    };
  }
  return { kind: "mesh", main: p.bbox.size.map(fmt).join(" × "), sub: p.reason };
}

/**
 * @returns {{ groups: object[], partInfo: Map<number, {group: string, text: string}>, counts: object, excluded: [string, number][] }}
 */
export function describeRecognition(recognition) {
  const groups = new Map();
  const partInfo = new Map();
  const counts = { exact: 0, approx: 0, excluded: 0 };
  const dropped = new Map(); // 除外した部品の理由 → 数
  for (const p of recognition.parts) {
    if (p.kind === "open") {
      dropped.set(p.reason, (dropped.get(p.reason) ?? 0) + 1);
      continue;
    }
    const d = describePart(p);
    const key = `${d.kind}|${d.main}|${d.sub}|${d.note ?? ""}`;
    if (!groups.has(key)) groups.set(key, { key, ...d, label: KIND_LABEL[d.kind], tone: TONE[p.kind], ids: [] });
    groups.get(key).ids.push(p.id);
    partInfo.set(p.id, { group: key, text: `${KIND_LABEL[d.kind]} ${d.main} · ${d.sub}` });
    counts[TONE[p.kind]] += 1;
  }
  const excluded = [...dropped, ...Object.entries(recognition.excluded).map(([k, n]) => [EXCLUDED_LABEL[k] ?? k, n])].filter(([, n]) => n > 0);
  counts.excluded = excluded.reduce((s, [, n]) => s + n, 0);
  const ordered = [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.ids.length - a.ids.length);
  return { groups: ordered, partInfo, counts, excluded };
}

/**
 * 3D 表示用のデータ（mm）: 元のメッシュ（インスタンスごと）ごとに、三角形を部品順に並べ替えて部品ごとのグループ（色分けの単位）を作る。
 * 塞いだ三角形（元のメッシュに無い）は、まとめて 1 つのメッシュにする。除外した部品は表示しない。
 */
export function buildDisplayMeshes(snapshot, recognition) {
  const unit = recognition.unit ?? 1;
  const pieces = new Map(); // "メッシュ:インスタンス" → 部品ごとの三角形
  const caps = { positions: [], groups: [] };
  for (const p of recognition.parts) {
    if (p.kind === "open") continue;
    for (const src of p.sources) {
      const key = `${src.mesh}:${src.instance}`;
      if (!pieces.has(key)) pieces.set(key, { src, list: [] });
      pieces.get(key).list.push({ part: p, triangles: src.triangles });
    }
    if (p.caps) {
      const start = caps.positions.length / 3;
      for (let k = p.tris.length - 3 * p.caps; k < p.tris.length; k++) caps.positions.push(p.points[3 * p.tris[k]], p.points[3 * p.tris[k] + 1], p.points[3 * p.tris[k] + 2]);
      caps.groups.push({ start, count: caps.positions.length / 3 - start, id: p.id, tone: TONE[p.kind] });
    }
  }
  const meshes = [...pieces.values()].map(({ src, list }) => {
    const m = snapshot.meshes[src.mesh];
    const matrix = (m.instances?.[src.instance] ?? m.matrix).map((v, i) => (i % 4 === 3 ? v : v * unit)); // シーンの単位 → mm（行列の 4 行目はそのまま）
    const corner = (t, k) => (m.index ? m.index[3 * t + k] : 3 * t + k);
    const index = [];
    const groups = list.map(({ part, triangles }) => {
      const start = index.length;
      for (const t of triangles) index.push(corner(t, 0), corner(t, 1), corner(t, 2));
      return { start, count: index.length - start, id: part.id, tone: TONE[part.kind] };
    });
    return { positions: m.positions, normals: m.normals, index: Uint32Array.from(index), matrix, groups };
  });
  if (caps.groups.length) {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    meshes.push({ positions: Float32Array.from(caps.positions), normals: null, index: Uint32Array.from({ length: caps.positions.length / 3 }, (_, i) => i), matrix: identity, groups: caps.groups });
  }
  return meshes;
}
