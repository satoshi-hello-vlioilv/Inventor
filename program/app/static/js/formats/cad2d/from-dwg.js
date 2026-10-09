// DWG のオブジェクト（../dwg/）を、図面のモデル（model.js。DXF と共通）に組み立てる。
// ハンドルの参照を名前にし（画層・線種・文字スタイル・ブロック）、子の図形（ポリラインの頂点・ブロック参照の属性）を親に付け、
// ブロックごとの図形の並びとレイアウトを作る。

import { readDwgObjects, VERSION_NAME } from "../dwg/index.js";
import { completeSpline } from "./curves.js";
import { cadText, createDrawing, normalizeLayouts, unitsOf } from "./model.js";

const VERTEX = /^VERTEX_/;
// 図面のモデルに入れる図形の種類（DWG の種類 → モデルの種類）。ここに無い図形は「読まない図形」として数える
const ENTITY = {
  LINE: "LINE", POINT: "POINT", CIRCLE: "CIRCLE", ARC: "ARC", ELLIPSE: "ELLIPSE", LWPOLYLINE: "LWPOLYLINE",
  POLYLINE_2D: "POLYLINE", POLYLINE_3D: "POLYLINE", POLYLINE_MESH: "POLYLINE", POLYLINE_PFACE: "POLYLINE",
  SPLINE: "SPLINE", TEXT: "TEXT", ATTDEF: "ATTDEF", MTEXT: "MTEXT", INSERT: "INSERT", MINSERT: "INSERT",
  DIMENSION_ORDINATE: "DIMENSION", DIMENSION_LINEAR: "DIMENSION", DIMENSION_ALIGNED: "DIMENSION", DIMENSION_ANG3PT: "DIMENSION",
  DIMENSION_ANG2LN: "DIMENSION", DIMENSION_RADIUS: "DIMENSION", DIMENSION_DIAMETER: "DIMENSION",
  HATCH: "HATCH", SOLID: "SOLID", TRACE: "SOLID", "3DFACE": "3DFACE", LEADER: "LEADER", RAY: "RAY", XLINE: "XLINE", VIEWPORT: "VIEWPORT",
};
// 図形ではあるが、表示しないもの（ブロックの区切り・子の図形）
const STRUCTURE = new Set(["BLOCK", "ENDBLK", "SEQEND", "ATTRIB", "VERTEX_2D", "VERTEX_3D", "VERTEX_MESH", "VERTEX_PFACE", "VERTEX_PFACE_FACE"]);
const DIMENSION_KIND = { DIMENSION_ORDINATE: "ordinate", DIMENSION_LINEAR: "linear", DIMENSION_ALIGNED: "aligned", DIMENSION_ANG3PT: "angular3",
  DIMENSION_ANG2LN: "angular", DIMENSION_RADIUS: "radius", DIMENSION_DIAMETER: "diameter" };

/** DWG のバイト列 → 図面のモデル */
export function drawingFromDwg(bytes) {
  const { version, codepage, header, headerError, objects, failures } = readDwgObjects(bytes);
  const drawing = createDrawing({ format: "dwg", version: VERSION_NAME[version] ?? String(version), codepage });
  // 見出しの変数（DXF の $LTSCALE・$INSUNITS と同じ）。読めなければ既定（尺度 1・単位なし）のまま、見出しバーで知らせる
  drawing.headerError = headerError;
  if (header) {
    drawing.units = unitsOf(header.insunits ?? 0);
    drawing.ltscale = header.ltscale > 0 ? header.ltscale : 1;
  }
  // ブロックの名前: DWG の無名のブロック（*D・*T・*Paper_Space など）は番号の無い同じ名前で入っているので、番号を付けて分ける
  // （DXF に書き出すと AutoCAD が付けるのと同じ考え方。参照はハンドルなので、番号の付け方は表示のためだけ）
  const headers = [...objects.values()].filter((o) => o.kind === "BLOCK_HEADER").sort((a, b) => a.handle - b.handle);
  const blockNames = new Map();
  const used = new Map();
  for (const h of headers) {
    const base = h.name || "*U";
    const n = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), n + 1);
    const anonymousSeries = base.startsWith("*") && !/^\*model_space$/i.test(base);
    blockNames.set(h.handle, n === 0 && (!anonymousSeries || /^\*paper_space$/i.test(base)) ? base : `${base}${/^\*paper_space$/i.test(base) ? n - 1 : n}`);
  }
  const name = (handle) => cadText(blockNames.get(handle) ?? objects.get(handle)?.name);

  // 表: 画層・線種・文字スタイル
  for (const o of objects.values()) {
    if (o.kind === "LAYER") {
      const color = { ...o.color };
      const off = o.off || color.index < 0;
      if (color.index < 0) color.index = -color.index;
      const layer = cadText(o.name);
      drawing.layers.set(layer, { name: layer, color, off, frozen: o.frozen, locked: o.locked, plot: o.plot,
        linetype: name(o.ltype) ?? "Continuous", lineweight: o.lineweight });
    } else if (o.kind === "LTYPE") {
      drawing.linetypes.set(cadText(o.name), { name: cadText(o.name), description: cadText(o.description), dashes: o.dashes });
    } else if (o.kind === "STYLE" && !o.shape) {
      drawing.styles.set(cadText(o.name), { name: cadText(o.name), font: o.font, bigFont: o.bigFont, height: o.height, widthFactor: o.widthFactor, oblique: o.oblique });
    }
  }

  // 子の図形（持ち主のハンドル → 子）。R2004+ は持ち主が並びを持つ。それより前は持ち主の印とハンドルの順
  const children = new Map();
  for (const o of objects.values()) {
    if (o.owner === undefined) continue;
    if (!children.has(o.owner)) children.set(o.owner, []);
    children.get(o.owner).push(o);
  }
  for (const list of children.values()) list.sort((a, b) => a.handle - b.handle);
  // 子の図形: R2004+ は持ち主が並び（owned）を持つ。R2000 までは最初と最後のハンドル（その間の子）。どちらも無ければ持ち主の印
  const sorted = [...objects.keys()].sort((a, b) => a - b);
  const between = (first, last) => {
    if (!first || !last || last < first) return null;
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < first) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < sorted.length && sorted[i] <= last; i++) out.push(objects.get(sorted[i]));
    return out;
  };
  const childrenOf = (o, ownedList, first, last) =>
    ownedList?.length ? ownedList.map((h) => objects.get(h)).filter(Boolean) : between(first, last) ?? children.get(o.handle) ?? [];

  // 色見本帳の色: RGB は DBCOLOR から（色番号は図形が持つ近い色の番号のまま）
  const bookColor = (o) => {
    const rgb = o.colorBook && objects.get(o.colorBook)?.color?.rgb;
    return rgb === undefined ? o.color : { ...o.color, rgb };
  };
  const common = (o) => ({
    handle: o.handle.toString(16).toUpperCase(),
    layer: name(o.layer) ?? "0",
    color: bookColor(o),
    linetype: ["BYLAYER", "BYBLOCK", "CONTINUOUS"][o.ltypeFlags] ?? name(o.ltype) ?? "BYLAYER",
    lineweight: o.lineweight,
    ltscale: o.ltscale,
    invisible: o.invisible,
  });

  const unsupported = drawing.unsupported;
  /** DWG の図形 → モデルの図形（表示しないものは null） */
  const entity = (o) => {
    const type = ENTITY[o.kind];
    if (!type) {
      if (!STRUCTURE.has(o.kind) && o.color) unsupported.set(o.kind, (unsupported.get(o.kind) ?? 0) + 1);
      return null;
    }
    const e = { type, ...common(o) };
    switch (o.kind) {
      case "LINE": return Object.assign(e, { a: o.a, b: o.b, extrusion: o.extrusion, thickness: o.thickness });
      case "POINT": return Object.assign(e, { p: o.p });
      case "CIRCLE": return Object.assign(e, { center: o.center, radius: o.radius, extrusion: o.extrusion });
      case "ARC": return Object.assign(e, { center: o.center, radius: o.radius, start: o.start, end: o.end, extrusion: o.extrusion });
      case "ELLIPSE": return Object.assign(e, { center: o.center, major: o.major, ratio: o.ratio, start: o.start, end: o.end, extrusion: o.extrusion });
      case "LWPOLYLINE":
        // 膨らみ・幅は、無ければ頂点の数の 0 にそろえる（DWG は持たないとき省く）
        return Object.assign(e, { points: o.points, bulges: o.points.map((_, i) => o.bulges?.[i] ?? 0),
          widths: o.points.map((_, i) => o.widths?.[i] ?? [0, 0]), constWidth: o.constWidth, closed: o.closed,
          elevation: o.elevation, extrusion: o.extrusion });
      case "POLYLINE_2D": case "POLYLINE_3D": case "POLYLINE_MESH": case "POLYLINE_PFACE": {
        let list = childrenOf(o, o.vertices, o.firstVertex, o.lastVertex).filter((v) => VERTEX.test(v.kind));
        const kind = { POLYLINE_2D: "2d", POLYLINE_3D: "3d", POLYLINE_MESH: "mesh", POLYLINE_PFACE: "pface" }[o.kind];
        // 2D: 曲線にした頂点（フラグ 16）があればそれを、無ければ元の頂点を使う（スプラインの制御点は 16 = 0x10 の頂点）
        if (kind === "2d" || kind === "3d") {
          const fitted = list.filter((v) => v.flags & 8);
          if (fitted.length) list = fitted;
          else list = list.filter((v) => !(v.flags & 16));
        }
        const elevation = o.elevation ?? 0;
        return Object.assign(e, { kind, closed: Boolean(o.flags & 1), extrusion: o.extrusion ?? [0, 0, 1], elevation,
          m: o.m, n: o.n,
          vertices: list.filter((v) => v.kind !== "VERTEX_PFACE_FACE").map((v) => ({ p: kind === "2d" ? [v.p[0], v.p[1], elevation] : v.p,
            bulge: v.bulge ?? 0, widths: v.widths })),
          faces: kind === "pface" ? list.filter((v) => v.kind === "VERTEX_PFACE_FACE").map((v) => v.indices) : undefined });
      }
      case "SPLINE":
        return completeSpline(Object.assign(e, { degree: o.degree, knots: o.knots, controls: o.controls, weights: o.weights, fit: o.fit,
          closed: Boolean(o.closed), periodic: Boolean(o.periodic), startTangent: o.startTangent, endTangent: o.endTangent,
          knotParam: o.knotParam ?? 0, fitTolerance: o.fitTolerance }));
      case "TEXT": case "ATTDEF":
        return Object.assign(e, textFields(o, name), o.kind === "ATTDEF" ? { tag: cadText(o.tag), prompt: cadText(o.prompt), flags: o.flags } : {});
      case "MTEXT":
        return Object.assign(e, { p: o.p, direction: o.direction, extrusion: o.extrusion, height: o.height, width: o.width, attach: o.attach,
          drawing: o.drawing, text: cadText(o.text), style: name(o.style) ?? "Standard", lineSpacing: o.lineSpacing ?? 1 });
      case "INSERT": case "MINSERT": {
        const attribs = childrenOf(o, o.attribs, o.firstAttrib, o.lastAttrib)
          .filter((a) => a?.kind === "ATTRIB")
          .map((a) => Object.assign({ type: "ATTRIB", ...common(a) }, textFields(a, name), { tag: cadText(a.tag), flags: a.flags, mtext: a.mtext }));
        return Object.assign(e, { block: name(o.block), p: o.p, scale: o.scale, rotation: o.rotation, extrusion: o.extrusion,
          columns: o.columns ?? 1, rows: o.rows ?? 1, columnSpacing: o.columnSpacing ?? 0, rowSpacing: o.rowSpacing ?? 0, attribs });
      }
      case "HATCH":
        return Object.assign(e, { loops: o.loops, solid: o.solid, pattern: o.pattern, angle: o.angle ?? 0, scale: o.scale ?? 1, lines: o.lines,
          elevation: o.elevation, extrusion: o.extrusion, style: o.style, gradient: o.gradient });
      case "SOLID": case "TRACE": return Object.assign(e, { points: o.points, extrusion: o.extrusion });
      case "3DFACE": return Object.assign(e, { points: o.points, invisibleEdges: o.invisibleEdges });
      case "LEADER": return Object.assign(e, { points: o.points, arrow: o.arrow, pathType: o.pathType, extrusion: o.extrusion });
      case "RAY": case "XLINE": return Object.assign(e, { p: o.p, direction: o.direction });
      case "VIEWPORT":
        return Object.assign(e, { center: o.center, width: o.width, height: o.height, viewCenter: o.viewCenter, viewHeight: o.viewHeight,
          twist: o.twist ?? 0, viewTarget: o.viewTarget, viewDirection: o.viewDirection });
      default:
        if (o.kind.startsWith("DIMENSION_")) {
          // p16（2 本の線の角度の寸法の円弧の位置）は DWG では 2D。z は寸法の高さ（p10 の z）
          return Object.assign(e, { kind: DIMENSION_KIND[o.kind], block: name(o.block), text: cadText(o.text), measurement: o.measurement,
            textMid: o.textMid, extrusion: o.extrusion, p10: o.p10, p13: o.p13, p14: o.p14, p15: o.p15,
            p16: o.p16 && [o.p16[0], o.p16[1], o.p16[2] ?? o.p10?.[2] ?? 0],
            dimstyle: name(o.dimstyle) });
        }
        return e;
    }
  };

  // ブロック: 名前・基点・図形の並び
  const modelName = name(headers.find((h) => /^\*model_space$/i.test(h.name))?.handle) ?? "*Model_Space";
  const paperName = name(headers.find((h) => /^\*paper_space$/i.test(h.name))?.handle) ?? "*Paper_Space";
  const bySpace = { model: [], paper: [] };
  for (const o of objects.values()) if (o.space) bySpace[o.space].push(o);
  for (const list of Object.values(bySpace)) list.sort((a, b) => a.handle - b.handle);
  for (const header of headers) {
    let list = childrenOf(header, header.entities);
    const blockName = name(header.handle);
    // R2000 まで: モデル・紙の図形は、空間の印（entmode）で入るものと、持ち主を明示するものがある。両方を合わせ、ハンドルの順に
    if (!header.entities?.length && (blockName === modelName || blockName === paperName)) {
      const all = new Map([...list, ...bySpace[blockName === modelName ? "model" : "paper"]].map((o) => [o.handle, o]));
      list = [...all.values()].sort((a, b) => a.handle - b.handle);
    }
    drawing.blocks.set(blockName, {
      name: blockName, handle: header.handle.toString(16).toUpperCase(), base: header.base ?? [0, 0, 0], anonymous: header.anonymous, xref: header.xref || header.overlay,
      entities: list.map(entity).filter(Boolean),
    });
  }

  // レイアウト
  const layouts = [...objects.values()].filter((o) => o.kind === "LAYOUT").map((l) => ({
    name: l.name, block: name(l.block), tabOrder: l.tabOrder, limits: l.limits, extents: l.extents,
  }));
  drawing.layouts = normalizeLayouts(layouts, drawing.blocks, modelName);
  drawing.failures = failures;
  return drawing;
}

// 文字の値。生成の印は 2（左右の反転）・4（上下の反転）だけが意味を持つので、ほかのビットは捨てる
function textFields(o, name) {
  return { p: o.p, align: o.align, height: o.height, rotation: o.rotation, widthFactor: o.widthFactor, oblique: o.oblique,
    halign: o.halign, valign: o.valign, generation: (o.generation ?? 0) & 6, text: cadText(o.text), style: name(o.style) ?? "Standard",
    extrusion: o.extrusion };
}
