// 認識結果を画面の言葉にする: 部品ごとの説明文と、同じ形状の部品をまとめたグループ。DOM に依存しない。

const fmt = (v) => v.toFixed(3);

export const TONE = { revolve: "exact", prism: "exact", mesh: "approx" };
export const KIND_LABEL = { revolve: "回転体", sector: "部分回転", prism: "押し出し", mesh: "近似" };
const KIND_ORDER = ["revolve", "sector", "prism", "mesh"];
export const EXCLUDED_LABEL = {
  open: "厚みのない面（床・目印など）",
  line: "線（寸法線・補助線など）",
  sprite: "文字・画像の板",
  points: "点群",
  instanced: "インスタンス描画（未対応）",
  empty: "頂点のない物体",
};

const CORNER_NOTE_MIN = 1e-3; // mm。これを超える差があれば、角付近の差として書き添える

/** 面取りの説明: 「面取り C1（穴の縁・両面）」。 */
function describeChamfers(chamfers) {
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

/** 1 部品の説明（見出しの寸法・補足・注意・種類）。 */
export function describePart(p) {
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
  for (const p of recognition.parts) {
    if (p.kind === "open") {
      counts.excluded += 1;
      continue;
    }
    const d = describePart(p);
    const key = `${d.kind}|${d.main}|${d.sub}|${d.note ?? ""}`;
    if (!groups.has(key)) groups.set(key, { key, ...d, label: KIND_LABEL[d.kind], tone: TONE[p.kind], ids: [] });
    groups.get(key).ids.push(p.id);
    partInfo.set(p.id, { group: key, text: `${KIND_LABEL[d.kind]} ${d.main} · ${d.sub}` });
    counts[TONE[p.kind]] += 1;
  }
  const excluded = Object.entries({ open: counts.excluded, ...recognition.excluded })
    .filter(([, n]) => n > 0)
    .map(([k, n]) => [EXCLUDED_LABEL[k] ?? k, n]);
  counts.excluded = excluded.reduce((s, [, n]) => s + n, 0);
  const ordered = [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.ids.length - a.ids.length);
  return { groups: ordered, partInfo, counts, excluded };
}

/**
 * 3D 表示用のデータ: 元のメッシュごとに、三角形を部品順に並べ替えて部品ごとのグループ（色分けの単位）を作る。
 * 厚みのない面（除外）は表示しない。
 */
export function buildDisplayMeshes(snapshot, recognition) {
  const byMesh = new Map();
  for (const p of recognition.parts) {
    if (p.kind === "open") continue;
    if (!byMesh.has(p.meshIndex)) byMesh.set(p.meshIndex, []);
    byMesh.get(p.meshIndex).push(p);
  }
  return [...byMesh].map(([meshIndex, parts]) => {
    const m = snapshot.meshes[meshIndex];
    const corner = (t, k) => (m.index ? m.index[3 * t + k] : 3 * t + k);
    const index = [];
    const groups = parts.map((p) => {
      const start = index.length;
      for (const t of p.sourceTriangles) index.push(corner(t, 0), corner(t, 1), corner(t, 2));
      return { start, count: index.length - start, id: p.id, tone: TONE[p.kind] };
    });
    return { positions: m.positions, normals: m.normals, index: Uint32Array.from(index), matrix: m.matrix, groups };
  });
}
