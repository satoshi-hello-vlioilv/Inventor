// 図面の説明（DOM に依存しない）: 指した図形の一行（種類・寸法・画層）と、右の欄の要約（図形の内訳・画層・まだ描かない図形）。

import { mtextLines, singleLine } from "./text.js";

// 図形の種類の名前（AutoCAD の日本語版の呼び方に合わせる）
export const TYPE_LABEL = {
  LINE: "線分", CIRCLE: "円", ARC: "円弧", ELLIPSE: "楕円", LWPOLYLINE: "ポリライン", POLYLINE: "ポリライン", SPLINE: "スプライン",
  TEXT: "文字", MTEXT: "マルチテキスト", ATTDEF: "属性定義", ATTRIB: "属性", INSERT: "ブロック参照", DIMENSION: "寸法",
  HATCH: "ハッチング", SOLID: "塗り潰し", "3DFACE": "3D 面", LEADER: "引出線", POINT: "点", RAY: "放射線", XLINE: "構築線",
  VIEWPORT: "ビューポート",
};
// まだ描かない図形の名前（DWG の種類・DXF の名前）
const UNSUPPORTED_LABEL = {
  MULTILEADER: "マルチ引出線", ACAD_TABLE: "表", MLINE: "マルチライン", WIPEOUT: "ワイプアウト", REGION: "リージョン", "3DSOLID": "3D ソリッド",
  BODY: "ボディ", TOLERANCE: "幾何公差", ARC_DIMENSION: "弧長寸法", LARGE_RADIAL_DIMENSION: "折り曲げ半径寸法", IMAGE: "ラスター イメージ",
  LIGHT: "ライト", HELIX: "らせん", OLE2FRAME: "OLE オブジェクト", OLEFRAME: "OLE オブジェクト", SHAPE: "シェイプ", MESH: "メッシュ",
  SURFACE: "サーフェス", PLANESURFACE: "サーフェス", EXTRUDEDSURFACE: "サーフェス", REVOLVEDSURFACE: "サーフェス", LOFTEDSURFACE: "サーフェス",
  SWEPTSURFACE: "サーフェス", NURBSURFACE: "サーフェス", UNDERLAY: "アンダーレイ", PDFUNDERLAY: "PDF アンダーレイ", DWFUNDERLAY: "DWF アンダーレイ",
  DGNUNDERLAY: "DGN アンダーレイ", SECTIONOBJECT: "断面オブジェクト", ACAD_PROXY_ENTITY: "プロキシ図形", POINTCLOUD: "点群",
};
const DIMENSION_LABEL = { linear: "長さ寸法", aligned: "平行寸法", angular: "角度寸法", angular3: "角度寸法", diameter: "直径寸法", radius: "半径寸法", ordinate: "座標寸法" };

export const typeLabel = (type) => TYPE_LABEL[type] ?? UNSUPPORTED_LABEL[type] ?? type;

/** 長さの表記（小数 3 桁まで、末尾の 0 を省く）。単位があれば付ける */
export const length = (v, units = "") => `${String(Number(v.toFixed(3)))}${units ? ` ${units}` : ""}`;
const angle = (rad) => `${String(Number(((rad * 180) / Math.PI).toFixed(2)))}°`;
const quote = (s, max = 24) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `「${t.length > max ? `${t.slice(0, max)}…` : t}」`;
};

/** 膨らみのある頂点の並びの長さ */
function bulgedLength(points, bulges, closed) {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i], b = points[(i + 1) % n];
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const theta = 4 * Math.atan(bulges?.[i] ?? 0);
    sum += theta ? (chord * Math.abs(theta)) / (2 * Math.sin(Math.abs(theta) / 2)) : chord;
  }
  return sum;
}

/** 指した図形の一行（種類 · 寸法 · 画層）。units は長さの単位（"mm" など。無ければ付けない） */
export function describeItem(item, units = "") {
  const e = item.entity;
  const L = (v) => length(v, units);
  const parts = [e.type === "DIMENSION" ? DIMENSION_LABEL[e.kind] ?? "寸法" : typeLabel(e.type)];
  switch (e.type) {
    case "LINE": {
      const d = [e.b[0] - e.a[0], e.b[1] - e.a[1], (e.b[2] ?? 0) - (e.a[2] ?? 0)];
      parts.push(`長さ ${L(Math.hypot(...d))}`, `角度 ${angle(Math.atan2(d[1], d[0]))}`);
      break;
    }
    case "CIRCLE": parts.push(`Φ${L(e.radius * 2)}`, `半径 ${L(e.radius)}`); break;
    case "ARC": {
      let sweep = e.end - e.start;
      while (sweep <= 0) sweep += 2 * Math.PI;
      parts.push(`半径 ${L(e.radius)}`, `中心角 ${angle(sweep)}`, `弧長 ${L(e.radius * sweep)}`);
      break;
    }
    case "ELLIPSE": {
      const a = Math.hypot(...e.major);
      parts.push(`長径 ${L(a * 2)}`, `短径 ${L(a * 2 * e.ratio)}`);
      break;
    }
    case "LWPOLYLINE":
      parts.push(`頂点 ${e.points.length}`, `長さ ${L(bulgedLength(e.points, e.bulges, e.closed))}`, ...(e.closed ? ["閉じた形"] : []));
      break;
    case "POLYLINE":
      if (e.kind === "2d" || e.kind === "3d") {
        const pts = e.vertices.map((v) => v.p);
        parts.push(`頂点 ${pts.length}`, `長さ ${L(bulgedLength(pts, e.vertices.map((v) => v.bulge), e.closed))}`, ...(e.closed ? ["閉じた形"] : []));
      } else parts.push(e.kind === "mesh" ? "ポリゴン メッシュ" : "ポリフェース メッシュ", `頂点 ${e.vertices.length}`);
      break;
    case "SPLINE": parts.push(`${e.degree} 次`, e.fit?.length ? `通過点 ${e.fit.length}` : `制御点 ${e.controls?.length ?? 0}`); break;
    case "TEXT": case "ATTDEF": case "ATTRIB": parts.push(quote(singleLine(e.text) || e.tag || ""), `高さ ${L(e.height)}`); break;
    case "MTEXT": parts.push(quote(mtextLines(e.text).join(" ")), `高さ ${L(e.height)}`); break;
    case "INSERT": {
      const [sx, sy] = e.scale ?? [1, 1];
      parts.push(`「${e.block}」`);
      if (sx !== 1 || sy !== 1) parts.push(`尺度 ${Number(sx.toFixed(4))}${sy !== sx ? ` × ${Number(sy.toFixed(4))}` : ""}`);
      if (e.rotation) parts.push(`回転 ${angle(e.rotation)}`);
      if (e.attribs?.length) parts.push(`属性 ${e.attribs.map((a) => singleLine(a.text)).filter(Boolean).slice(0, 2).join("・")}`);
      break;
    }
    case "DIMENSION": {
      const isAngle = e.kind === "angular" || e.kind === "angular3";
      if (typeof e.measurement === "number") parts.push(isAngle ? angle(e.measurement) : L(e.measurement));
      const override = e.text && e.text !== "<>" ? mtextLines(e.text).join(" ").replace("<>", "").trim() : "";
      if (override) parts.push(`文字 ${quote(override, 16)}`);
      break;
    }
    case "HATCH": parts.push(e.solid ? "塗り潰し" : `模様 ${e.pattern || "ユーザー定義"}`, `境界 ${e.loops?.length ?? 0}`); break;
    case "LEADER": parts.push(`点 ${e.points?.length ?? 0}`); break;
    case "VIEWPORT": if (e.viewHeight > 0 && e.height > 0) parts.push(`尺度 ${scaleText(e.height / e.viewHeight)}`); break;
    default: break;
  }
  parts.push(`画層 ${item.layer}`);
  return parts.join(" · ");
}

/** 線種の見た目の種類: solid 実線・dash 破線（線とすき間だけ）・chain 鎖線（長い線と点・短い線の組み合わせ） */
export function dashKind(dashes) {
  if (!dashes?.length || dashes.every((d) => d >= 0)) return "solid";
  const lines = dashes.filter((d) => d >= 0);
  return lines.length >= 2 && Math.min(...lines) < Math.max(...lines) * 0.5 ? "chain" : "dash";
}

/** 尺度の表記（1:2・2:1 など。きれいな比でなければ小数） */
export function scaleText(k) {
  if (!(k > 0)) return "—";
  const near = (v) => Math.abs(v - Math.round(v)) < 1e-6 * Math.max(1, v);
  if (k >= 1 && near(k)) return `${Math.round(k)}:1`;
  if (k < 1 && near(1 / k)) return `1:${Math.round(1 / k)}`;
  return String(Number(k.toFixed(4)));
}

/**
 * 右の欄の要約。scene はいま表示しているレイアウトのもの。
 * @returns {{ types: [{ type, label, count }], layers: [{ name, color, count, off, frozen }], unsupported: [{ type, label, count }], broken, extents }}
 *   broken … 値が壊れていて描けなかった図形の数
 */
export function describeDrawing(drawing, scene) {
  const types = new Map();
  for (const item of scene.items) if (item.viewport === undefined) types.set(item.type, (types.get(item.type) ?? 0) + 1);
  const linetypes = new Map([...drawing.linetypes.values()].map((t) => [t.name.toLowerCase(), t]));
  const layers = [...drawing.layers.values()].map((l) => ({
    name: l.name, color: l.color, count: scene.layers.get(l.name) ?? 0, off: Boolean(l.off), frozen: Boolean(l.frozen),
    dash: dashKind(linetypes.get(String(l.linetype ?? "").toLowerCase())?.dashes),
  }));
  return {
    types: [...types].map(([type, count]) => ({ type, label: typeLabel(type), count })).sort((a, b) => b.count - a.count),
    layers,
    unsupported: [...(scene.unsupported ?? drawing.unsupported)].map(([type, count]) => ({ type, label: typeLabel(type), count })).sort((a, b) => b.count - a.count),
    broken: scene.broken ?? 0,
    extents: scene.extents && [scene.extents.max[0] - scene.extents.min[0], scene.extents.max[1] - scene.extents.min[1]],
  };
}
