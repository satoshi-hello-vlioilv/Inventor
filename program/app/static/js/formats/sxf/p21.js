// SXF の P21（ISO 10303-21 の AP202 ASSOCIATIVE_DRAUGHTING）→ SFC と同じフィーチャの並び（意味づけは cad2d/from-sxf.js が共通に受け持つ）。
//   並べる順: 表（画層・色・線種・線幅・文字の書体）→ ハッチングの境界の複合曲線 → 複合図形（その中身 → sfig_org）→ 用紙（中身 → drawing_sheet）
//   P21 にだけあるもの（SFC のフィーチャに無いもの）は、名前の違う内部のフィーチャにする:
//     terminator … 矢印 1 つ: [画層, 色, 番号, x, y, 向き x, 向き y, 尺度]（P21 の矢印は位置と向きを持つ）
//     nurbs      … B スプライン: [画層, 色, 線種, 線幅, JSON { degree, knots, controls, weights, closed }]
//     callout    … 寸法 1 つ: kind（"linear" など）と children（寸法線・補助線・文字・矢印のフィーチャ）
//   画層: PRESENTATION_LAYER_ASSIGNMENT の順（$$SXF_dummy… は複合図形を置くための仮の画層なので除く）。INVISIBILITY が指す画層は隠す
//   文字の基準点: 名前の $$SXF_topline centre など（SFC の基準点 1〜9）。無ければ配置の揃え（'baseline centre' など）。
//     配置点は SFC の基準点から段ごとに決まった量ずれている（下の text_string のところ）
//   寸法: DIMENSION_CALLOUT_RELATIONSHIP の related の側（同じ文字をもう一度持つ構造の呼び出し）は描かない

import { argsOf, isType } from "../step/p21.js";
import { ARROWS, COLOURS, LINETYPES, SxfError, WIDTHS, codeOf } from "./tables.js";

const DEG = 180 / Math.PI;
const f6 = (v) => (Number.isFinite(v) ? Number(v.toFixed(9)) : 0).toString();
const listOf = (vs) => `(${vs.map(f6).join(",")})`;

export function featuresFromP21(step) {
  const { records, get } = step;
  const features = [];
  const warnings = [];
  const out = (name, params, extra = {}) => features.push({ id: features.length + 1, name, params: params.map(String), ...extra });
  const all = [...records.values()];
  const ofType = (type) => all.filter((e) => isType(e, type));

  // ---- 表 ----
  const invisible = new Set(ofType("INVISIBILITY").flatMap((e) => (argsOf(e, "INVISIBILITY")[0] ?? []).map((r) => r.ref)));
  const layerOfItem = new Map();
  let layerCode = 0;
  for (const e of ofType("PRESENTATION_LAYER_ASSIGNMENT")) {
    const [name, , items] = argsOf(e, "PRESENTATION_LAYER_ASSIGNMENT");
    if (/^\$\$SXF_dummy/i.test(name ?? "")) continue;
    out("layer", [name || `画層 ${layerCode + 1}`, invisible.has(e.id) ? "0" : "1"]);
    layerCode++;
    for (const r of items ?? []) layerOfItem.set(r.ref, layerCode);
  }
  const colourCodes = new Map();
  let userColour = 17;
  const colourOf = (ref) => {
    const e = get(ref);
    if (!e) return 1;
    if (colourCodes.has(e.id)) return colourCodes.get(e.id);
    let code = 1;
    const pre = argsOf(e, "DRAUGHTING_PRE_DEFINED_COLOUR") ?? argsOf(e, "PRE_DEFINED_COLOUR");
    const rgb = argsOf(e, "COLOUR_RGB");
    if (pre) code = codeOf(COLOURS, pre[0]) || 1;
    else if (rgb) {
      out("user_defined_colour", rgb.slice(1, 4).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
      code = userColour++;
    }
    colourCodes.set(e.id, code);
    return code;
  };
  const fontCodes = new Map();
  let userType = 17;
  const typeOf = (ref) => {
    const e = get(ref);
    if (!e) return 1;
    if (fontCodes.has(e.id)) return fontCodes.get(e.id);
    let code = 1;
    const pre = argsOf(e, "DRAUGHTING_PRE_DEFINED_CURVE_FONT") ?? argsOf(e, "PRE_DEFINED_CURVE_FONT");
    const user = argsOf(e, "CURVE_STYLE_FONT");
    if (pre) code = codeOf(LINETYPES, pre[0]) || 1;
    else if (user) {
      const pitch = (user[1] ?? []).flatMap((r) => argsOf(get(r), "CURVE_STYLE_FONT_PATTERN") ?? []).map(Number);
      out("user_defined_font", [user[0] || `線種 ${userType}`, pitch.length, listOf(pitch)]);
      code = userType++;
    }
    fontCodes.set(e.id, code);
    return code;
  };
  const widthCodes = new Map();
  let userWidth = 11;
  const widthOf = (v) => {
    const w = measure(v, get);
    const i = WIDTHS.findIndex((x) => Math.abs(x - w) < 1e-6);
    if (i >= 0) return i + 1;
    const key = f6(w);
    if (!widthCodes.has(key)) {
      out("width", [key]);
      widthCodes.set(key, userWidth++);
    }
    return widthCodes.get(key);
  };
  const textFonts = new Map();
  const textFontOf = (ref) => {
    const e = get(ref);
    if (!e) return 1;
    if (!textFonts.has(e.id)) {
      const name = argsOf(e, "EXTERNALLY_DEFINED_TEXT_FONT")?.[0] ?? argsOf(e, "PRE_DEFINED_TEXT_FONT")?.[0];
      out("text_font", [identifier(name) || "SXF"]);
      textFonts.set(e.id, textFonts.size + 1);
    }
    return textFonts.get(e.id);
  };

  /** 図形の見た目（STYLED_ITEM の styles）→ { color, type, width }（番号） */
  const styleOf = (occurrence) => {
    const styled = argsOf(occurrence, "STYLED_ITEM");
    for (const psa of styled?.[0] ?? []) {
      for (const s of argsOf(get(psa), "PRESENTATION_STYLE_ASSIGNMENT")?.[0] ?? []) {
        const cs = argsOf(get(s), "CURVE_STYLE");
        if (cs) return { color: colourOf(cs[3]), type: typeOf(cs[1]), width: widthOf(cs[2]) };
        const ss = argsOf(get(s), "SYMBOL_STYLE");
        if (ss) return { color: colourOf(argsOf(get(ss[1]), "SYMBOL_COLOUR")?.[0]), type: 1, width: 1 };
        const ts = argsOf(get(s), "TEXT_STYLE");
        if (ts) return { color: colourOf(argsOf(get(ts[1]), "TEXT_STYLE_FOR_DEFINED_FONT")?.[0]), type: 1, width: 1, text: get(s) };
      }
    }
    return { color: 1, type: 1, width: 1 };
  };
  const layerOf = (id, fallback = 0) => layerOfItem.get(id) ?? fallback;

  // ---- 曲線 ----
  const point = (ref) => (argsOf(get(ref), "CARTESIAN_POINT")?.[1] ?? [0, 0]).map(Number);
  const placement = (ref) => {
    const a = argsOf(get(ref), "AXIS2_PLACEMENT_2D");
    const dir = a?.[2] ? argsOf(get(a[2]), "DIRECTION")?.[1] ?? [1, 0] : [1, 0];
    return { at: point(a?.[1]), angle: Math.atan2(dir[1], dir[0]) };
  };
  /** 幾何の曲線 → [フィーチャの名前, 形の引数]（線種などの前の 4 つは呼ぶ側が付ける）。描けなければ null */
  const curveOf = (ref) => {
    const e = get(ref);
    if (!e) return null;
    const poly = argsOf(e, "POLYLINE");
    if (poly) {
      const pts = poly[1].map(point);
      return [["polyline", [pts.length, listOf(pts.map((q) => q[0])), listOf(pts.map((q) => q[1]))]]];
    }
    const circle = argsOf(e, "CIRCLE");
    if (circle) {
      const p = placement(circle[1]);
      return [["circle", [f6(p.at[0]), f6(p.at[1]), f6(circle[2])]]];
    }
    const ellipse = argsOf(e, "ELLIPSE");
    if (ellipse) {
      const p = placement(ellipse[1]);
      return [["ellipse", [f6(p.at[0]), f6(p.at[1]), f6(ellipse[2]), f6(ellipse[3]), f6(p.angle * DEG)]]];
    }
    const bezier = argsOf(e, "BEZIER_CURVE");
    if (bezier) return [["nurbs", [JSON.stringify(bezierOf(bezier, point))]]];
    const spline = argsOf(e, "B_SPLINE_CURVE_WITH_KNOTS") ?? argsOf(e, "B_SPLINE_CURVE");
    if (spline) return [["nurbs", [JSON.stringify(nurbsOf(e, get, point))]]];
    const trimmed = argsOf(e, "TRIMMED_CURVE");
    if (trimmed) return trimmedOf(trimmed);
    const composite = argsOf(e, "COMPOSITE_CURVE");
    if (composite) return composite[1].flatMap((seg) => curveOf(argsOf(get(seg), "COMPOSITE_CURVE_SEGMENT")?.[2]) ?? []);
    return null;
  };
  const trimmedOf = ([, basisRef, trim1, trim2, sense]) => {
    const basis = get(basisRef);
    const forward = sense?.enum !== "F";
    const line = argsOf(basis, "LINE");
    if (line) {
      const origin = point(line[1]);
      const vec = argsOf(get(line[2]), "VECTOR");
      const dir = argsOf(get(vec?.[1]), "DIRECTION")?.[1] ?? [1, 0];
      const len = Math.hypot(dir[0], dir[1]) || 1, mag = Number(vec?.[2] ?? 1);
      const at = (trim) => {
        const p = cartesian(trim);
        if (p) return p;
        const t = parameter(trim) ?? 0;
        return [origin[0] + (dir[0] / len) * mag * t, origin[1] + (dir[1] / len) * mag * t];
      };
      const [a, b] = [at(trim1), at(trim2)];
      return [["line", [a[0], a[1], b[0], b[1]].map(f6)]];
    }
    const circle = argsOf(basis, "CIRCLE"), ellipse = argsOf(basis, "ELLIPSE");
    if (circle || ellipse) {
      const p = placement((circle ?? ellipse)[1]);
      const [ra, rb] = circle ? [Number(circle[2]), Number(circle[2])] : [Number(ellipse[2]), Number(ellipse[3])];
      // 端の角（基準の向きからの媒介変数。度）: 点で切るなら点の角、媒介変数ならそのまま（角の単位はラジアン）
      const angle = (trim) => {
        const q = cartesian(trim);
        if (!q) return (parameter(trim) ?? 0) * DEG;
        const dx = q[0] - p.at[0], dy = q[1] - p.at[1], c = Math.cos(p.angle), s = Math.sin(p.angle);
        return Math.atan2((-dx * s + dy * c) / rb, (dx * c + dy * s) / ra) * DEG;
      };
      let [s, t] = [angle(trim1), angle(trim2)];
      if (!forward) [s, t] = [t, s];
      if (circle) return [["arc", [f6(p.at[0]), f6(p.at[1]), f6(ra), "0", f6(s + p.angle * DEG), f6(t + p.angle * DEG)]]];
      return [["ellipse_arc", [f6(p.at[0]), f6(p.at[1]), f6(ra), f6(rb), "0", f6(p.angle * DEG), f6(s), f6(t)]]];
    }
    return curveOf(basisRef);
  };
  const cartesian = (trim) => {
    const ref = (trim ?? []).find((v) => v?.ref !== undefined);
    return ref ? point(ref) : null;
  };
  const parameter = (trim) => {
    const v = (trim ?? []).find((x) => typeof x === "number" || x?.type === "PARAMETER_VALUE");
    return typeof v === "number" ? v : v ? Number(v.args[0]) : null;
  };

  // ---- 複合曲線（ハッチングの境界）: 先に全てを出して番号を決める ----
  const compositeCodes = new Map();
  const styledComposite = new Map(); // 複合曲線 → それを描く STYLED_ITEM
  for (const e of all) {
    const s = argsOf(e, "STYLED_ITEM");
    if (s && isType(get(s[1]), "COMPOSITE_CURVE") && isType(e, "ANNOTATION_CURVE_OCCURRENCE")) styledComposite.set(s[1].ref, e);
  }
  for (const area of ofType("ANNOTATION_FILL_AREA")) {
    for (const ref of argsOf(area, "ANNOTATION_FILL_AREA")[1] ?? []) {
      if (compositeCodes.has(ref.ref)) continue;
      const occ = styledComposite.get(ref.ref);
      const st = occ ? styleOf(occ) : { color: 1, type: 1, width: 1 };
      for (const [name, params] of curveOf(ref) ?? []) out(name, [0, st.color, st.type, st.width, ...params]);
      out("composite_curve", [st.color, st.type, st.width, occ && !invisible.has(occ.id) ? "1" : "0"]);
      compositeCodes.set(ref.ref, compositeCodes.size + 1);
    }
  }

  // ---- 図形 ----
  const done = new Set();
  const related = new Set(ofType("DIMENSION_CALLOUT_RELATIONSHIP").map((e) => argsOf(e, "DIMENSION_CALLOUT_RELATIONSHIP")[3]?.ref));
  /** 表す物 1 つ → フィーチャ（emit に渡す）。layer は画層の番号（呼び出しの中身は呼び出しの画層を引き継ぐ） */
  const itemOf = (ref, emit, inherited = 0) => {
    const e = get(ref);
    if (!e || done.has(e.id)) return;
    done.add(e.id);
    const layer = layerOf(e.id, inherited);
    if (isType(e, "DRAUGHTING_CALLOUT")) {
      if (related.has(e.id)) return;
      const contents = argsOf(e, "DRAUGHTING_CALLOUT")[0] ?? [];
      const kind = ["LINEAR", "CURVE", "ANGULAR", "RADIUS", "DIAMETER"].find((k) => isType(e, `${k}_DIMENSION`));
      if (!kind) {
        for (const r of contents) itemOf(r, emit, layer);
        return;
      }
      const children = [];
      for (const r of contents) itemOf(r, (name, params, extra) => children.push({ name, params: params.map(String), ...extra }), layer);
      emit("callout", [layer], { kind: { CURVE: "arc" }[kind] ?? kind.toLowerCase(), children });
      return;
    }
    const styled = argsOf(e, "STYLED_ITEM");
    if (!styled) return;
    const target = get(styled[1]);
    const st = styleOf(e);
    if (isType(e, "ANNOTATION_SUBFIGURE_OCCURRENCE") || isType(target, "MAPPED_ITEM")) {
      const [mapRef, targetRef] = argsOf(target, "MAPPED_ITEM") ?? [];
      const rep = argsOf(get(argsOf(get(mapRef), "SYMBOL_REPRESENTATION_MAP")?.[1]), "DRAUGHTING_SUBFIGURE_REPRESENTATION") ??
        argsOf(get(argsOf(get(mapRef), "REPRESENTATION_MAP")?.[1]), "DRAUGHTING_SUBFIGURE_REPRESENTATION");
      const t = argsOf(get(targetRef), "SYMBOL_TARGET");
      const p = placement(t?.[1]);
      emit("sfig_locate", [layer, figureName(rep?.[0]), f6(p.at[0]), f6(p.at[1]), f6(p.angle * DEG), f6(Number(t?.[2] ?? 1)), f6(Number(t?.[3] ?? 1))]);
      return;
    }
    if (isType(e, "ANNOTATION_TEXT_OCCURRENCE")) {
      const t = argsOf(target, "TEXT_LITERAL_WITH_EXTENT") ?? argsOf(target, "TEXT_LITERAL");
      if (!t) return;
      const [name, literal, placeRef, alignment, path, fontRef, extentRef] = t;
      const p = placement(placeRef);
      const extent = argsOf(get(extentRef), "PLANAR_EXTENT") ?? [null, 0, 0];
      const box = textBox(st.text);
      const base = basePoint(name, alignment);
      // P21 の配置点は、SFC の基準点から文字の上向きに 高さ × (下の段 +1/2・中の段 −1/2・上の段 −1) ずれている
      // （SXF の変換部品 SCADEC API が同じ図面を書いた SFC と P21 の組で、全ての文字（460）で同じずれ）。戻して SFC の基準点にする
      const height = box.height ?? Number(extent[2]);
      const shift = [0.5, -0.5, -1][Math.floor((base - 1) / 3)] * height;
      const at = [p.at[0] + Math.sin(p.angle) * shift, p.at[1] - Math.cos(p.angle) * shift];
      emit("text_string", [layer, st.color, textFontOf(fontRef), literal ?? "", f6(at[0]), f6(at[1]), f6(height),
        f6(Number(extent[1])), f6(box.spacing), f6(p.angle * DEG), f6(box.slant * DEG), base, path?.enum === "DOWN" ? 2 : 1]);
      return;
    }
    if (isType(e, "ANNOTATION_SYMBOL_OCCURRENCE")) {
      const sym = argsOf(target, "DEFINED_SYMBOL");
      const definition = get(sym?.[1]);
      const t = argsOf(get(sym?.[2]), "SYMBOL_TARGET");
      const p = placement(t?.[1]);
      const marker = argsOf(definition, "PRE_DEFINED_POINT_MARKER_SYMBOL");
      if (marker) {
        emit("point_marker", [layer, st.color, f6(p.at[0]), f6(p.at[1]), 0, f6(p.angle * DEG), f6(Number(t?.[2] ?? 1))]);
        return;
      }
      const external = argsOf(definition, "EXTERNALLY_DEFINED_SYMBOL");
      if (external) {
        emit("symbol_externally_defined", [layer, 1, st.color, identifier(external[0]), f6(p.at[0]), f6(p.at[1]), f6(p.angle * DEG), f6(Number(t?.[2] ?? 1))]);
        return;
      }
      const name = argsOf(definition, "PRE_DEFINED_TERMINATOR_SYMBOL")?.[0] ?? argsOf(definition, "PRE_DEFINED_SYMBOL")?.[0];
      const code = codeOf(ARROWS, name);
      // 引出線の矢印の向きは、書いたソフトで逆になる（SXF の変換部品は線の中へ・ezsxf は線の外へ）。引出線の形から決める:
      // 矢の先に近い端の点へ、隣の点から向かう向き（矢の先が指す物へ向く慣例。SFC の読みと同じ）
      const u = (isType(e, "LEADER_TERMINATOR") && leaderDirection(argsOf(e, "TERMINATOR_SYMBOL")?.[0], p.at)) || [Math.cos(p.angle), Math.sin(p.angle)];
      if (code) emit("terminator", [layer, st.color, code, f6(p.at[0]), f6(p.at[1]), f6(u[0]), f6(u[1]), f6(Number(t?.[2] ?? 1))]);
      else warnings.push(`描かない記号: ${name ?? sym?.[1]?.ref}`);
      return;
    }
    if (isType(e, "ANNOTATION_FILL_AREA_OCCURRENCE")) {
      emit(...hatchOf(e, target, layer, st));
      return;
    }
    if (isType(e, "ANNOTATION_CURVE_OCCURRENCE")) {
      if (isType(target, "COMPOSITE_CURVE") && compositeCodes.has(target.id)) return; // 境界は複合曲線（見えるものはハッチングが描く）
      if (invisible.has(e.id)) return;
      const curves = curveOf(styled[1]);
      if (!curves) {
        warnings.push(`描かない曲線: ${target?.type || target?.parts?.map((x) => x.type).join("+")}`);
        return;
      }
      for (const [name, params] of curves) emit(name, [layer, st.color, st.type, st.width, ...params]);
    }
  };
  /** 引出線（曲線の注記）の、点 tip に近い端での向き（隣の点 → 端）。折れ線・線分でなければ null */
  const leaderDirection = (curveRef, tip) => {
    const target = get(argsOf(get(curveRef), "STYLED_ITEM")?.[1]);
    const poly = argsOf(target, "POLYLINE")?.[1]?.map(point);
    const trimmed = argsOf(target, "TRIMMED_CURVE");
    const pts = poly ?? (trimmed ? [cartesian(trimmed[2]), cartesian(trimmed[3])].filter(Boolean) : []);
    if (pts.length < 2) return null;
    const d = (q) => Math.hypot(q[0] - tip[0], q[1] - tip[1]);
    const [end, next] = d(pts[0]) <= d(pts.at(-1)) ? [pts[0], pts[1]] : [pts.at(-1), pts.at(-2)];
    const len = Math.hypot(end[0] - next[0], end[1] - next[1]);
    return len > 0 ? [(end[0] - next[0]) / len, (end[1] - next[1]) / len] : null;
  };
  const hatchOf = (e, target, layer, st) => {
    const bounds = (argsOf(target, "ANNOTATION_FILL_AREA")?.[1] ?? []).map((r) => compositeCodes.get(r.ref) ?? 0);
    const [outer, ...inner] = bounds;
    const tail = [outer ?? 0, inner.length, `(${inner.join(",")})`];
    const fill = (argsOf(e, "STYLED_ITEM")[0] ?? []).flatMap((psa) => argsOf(get(psa), "PRESENTATION_STYLE_ASSIGNMENT")?.[0] ?? [])
      .map(get).find((s) => isType(s, "FILL_AREA_STYLE"));
    const styles = (argsOf(fill, "FILL_AREA_STYLE")?.[1] ?? []).map(get);
    const hatching = styles.filter((s) => isType(s, "FILL_AREA_STYLE_HATCHING"));
    if (hatching.length) {
      const patterns = hatching.map((s) => {
        const [, csRef, repeatRef, , refPoint, angle] = argsOf(s, "FILL_AREA_STYLE_HATCHING");
        const cs = argsOf(get(csRef), "CURVE_STYLE");
        const vec = argsOf(get(argsOf(get(repeatRef), "ONE_DIRECTION_REPEAT_FACTOR")?.[1]), "VECTOR");
        const dir = argsOf(get(vec?.[1]), "DIRECTION")?.[1] ?? [0, 1];
        const spacing = Math.hypot(dir[0], dir[1]) * Number(vec?.[2] ?? 1) / (Math.hypot(dir[0], dir[1]) || 1);
        const q = point(refPoint);
        return `(${[cs ? colourOf(cs[3]) : st.color, cs ? typeOf(cs[1]) : 1, cs ? widthOf(cs[2]) : 1, f6(q[0]), f6(q[1]), f6(spacing), f6(Number(angle) * DEG)].join(",")})`;
      });
      return ["fill_area_style_hatching", [layer, patterns.length, ...patterns, ...tail]];
    }
    if (styles.some((s) => isType(s, "FILL_AREA_STYLE_TILES"))) return ["fill_area_style_tiles_hatching", [layer, "", ...Array(10).fill(0), ...tail]];
    const colour = styles.find((s) => isType(s, "FILL_AREA_STYLE_COLOUR"));
    if (colour) return ["fill_area_style_colour", [layer, colourOf(argsOf(colour, "FILL_AREA_STYLE_COLOUR")[1]), ...tail]];
    const external = styles.find((s) => isType(s, "EXTERNALLY_DEFINED_HATCH_STYLE"));
    return ["externally_defined_hatch", [layer, identifier(argsOf(external, "EXTERNALLY_DEFINED_HATCH_STYLE")?.[0]) || "", ...tail]];
  };

  // 複合図形（置く側が名前で指す）。入れ子でも、名前で引くので順は問わない
  for (const e of ofType("DRAUGHTING_SUBFIGURE_REPRESENTATION")) {
    const [name, items] = argsOf(e, "DRAUGHTING_SUBFIGURE_REPRESENTATION");
    for (const r of items ?? []) itemOf(r, out);
    out("sfig_org", [figureName(name), figureKind(name)]);
  }
  const sheet = ofType("DRAWING_SHEET_REVISION")[0];
  if (!sheet) throw new SxfError("用紙（DRAWING_SHEET_REVISION）がありません");
  const [sheetName, items] = argsOf(sheet, "DRAWING_SHEET_REVISION");
  for (const r of items ?? []) itemOf(r, out);
  const size = ofType("PRESENTATION_SIZE").map((e) => argsOf(e, "PRESENTATION_SIZE")).find((a) => a[0]?.ref === sheet.id);
  const boxArgs = argsOf(get(size?.[1]), "PLANAR_BOX");
  const [w, h] = boxArgs ? [Number(boxArgs[1]), Number(boxArgs[2])] : [841, 594];
  const m = /^A(\d)/i.exec(sheetName ?? "");
  const type = m && Number(m[1]) <= 4 ? Number(m[1]) : 9;
  out("drawing_sheet", [sheetName || "図面", type, w >= h ? 1 : 0, f6(w), f6(h)]);
  return { features, warnings };
}

/** IDENTIFIER('…') のような型付きの値 → 文字列 */
const identifier = (v) => (typeof v === "string" ? v : typeof v?.args?.[0] === "string" ? v.args[0] : "");
/** LENGTH_MEASURE_WITH_UNIT(POSITIVE_LENGTH_MEASURE(0.13), #10) か数 → mm */
function measure(v, get) {
  if (typeof v === "number") return v;
  if (v?.args) return Number(v.args[0]);
  const m = argsOf(get(v), "LENGTH_MEASURE_WITH_UNIT")?.[0];
  return m === undefined ? 0.25 : measure(m, get);
}
/** 複合図形の名前: $$SXF_FM_部分図-1 → 部分図-1（種類の印を外す。$$SXF_G_$$ATR… → $$ATR…） */
const figureName = (name) => String(name ?? "").replace(/^\$\$SXF_[A-Z]+_/, "");
/** 種類の印 → sfig_org の種類（1 部分図・2 部分図以外の図・3 作図グループ・4 部品）。FM = 部分図、G = 作図グループ、P = 部品（推定） */
const figureKind = (name) => ({ FM: 1, F: 2, G: 3, P: 4 })[/^\$\$SXF_([A-Z]+)_/.exec(String(name ?? ""))?.[1]] ?? 3;

/** 文字の基準点（1 左下 … 9 右上）: 名前の $$SXF_topline centre など、無ければ揃え（'baseline centre' など）。縦は先の語・横は後の語 */
function basePoint(name, alignment) {
  const words = (/^\$\$SXF_/.test(name ?? "") ? name.slice(6) : alignment ?? "").toLowerCase().trim().split(/\s+/);
  const row = /^top/.test(words[0]) ? 2 : /^(centre|center|middle)/.test(words[0]) ? 1 : 0;
  const last = words.at(-1);
  const col = last === "right" ? 2 : /^(centre|center|middle)$/.test(last) && words.length > 1 ? 1 : 0;
  return row * 3 + col + 1;
}

/** 文字の様式の高さ・字間・傾き（TEXT_STYLE_WITH_BOX_CHARACTERISTICS・TEXT_STYLE_WITH_SPACING） */
function textBox(style) {
  const out = { height: null, spacing: 0, slant: 0 };
  const box = argsOf(style, "TEXT_STYLE_WITH_BOX_CHARACTERISTICS")?.[0] ?? [];
  for (const c of box) {
    if (c?.type === "BOX_HEIGHT") out.height = Number(c.args[0]);
    if (c?.type === "BOX_SLANT_ANGLE") out.slant = Number(c.args[0]);
  }
  const sp = argsOf(style, "TEXT_STYLE_WITH_SPACING")?.[0];
  if (sp !== undefined) out.spacing = Number(sp?.args?.[0] ?? sp) || 0;
  return out;
}

/** ベジェ曲線（区間ごとに degree 次。つなぎ目のノットを degree 重に）→ B スプラインの形 */
function bezierOf(b, point) {
  const degree = Number(b[1]);
  const controls = (b[2] ?? []).map((r) => [...point(r), 0]);
  const n = Math.max(1, Math.round((controls.length - 1) / degree));
  const knots = [...Array(degree + 1).fill(0)];
  for (let i = 1; i < n; i++) knots.push(...Array(degree).fill(i));
  knots.push(...Array(degree + 1).fill(n));
  return { degree, knots, controls, weights: [], closed: b[4]?.enum === "T" };
}

/** B スプライン → { degree, knots, controls, weights, closed } */
function nurbsOf(e, get, point) {
  const b = argsOf(e, "B_SPLINE_CURVE_WITH_KNOTS") ?? [];
  const base = argsOf(e, "B_SPLINE_CURVE") ?? b.slice(0, 6);
  const degree = Number(base[1]);
  const controls = (base[2] ?? []).map((r) => [...point(r), 0]);
  const withKnots = argsOf(e, "B_SPLINE_CURVE_WITH_KNOTS");
  const [mults, values] = withKnots ? (e.parts ? [withKnots[0], withKnots[1]] : [withKnots[6], withKnots[7]]) : [[], []];
  const knots = (values ?? []).flatMap((v, i) => Array(Number(mults[i] ?? 1)).fill(Number(v)));
  const weights = (argsOf(e, "RATIONAL_B_SPLINE_CURVE")?.[0] ?? []).map(Number);
  return { degree, knots, controls, weights, closed: base[4]?.enum === "T" };
}
