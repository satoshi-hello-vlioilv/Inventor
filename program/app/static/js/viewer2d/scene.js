// 図面のモデル（formats/cad2d/model.js）の 1 つのレイアウトを、描くもの（線・塗り・文字）の並びにする（DOM に依存しない）。
//   buildScene(drawing, layout, { hidden, shown }) → {（hidden・shown: 利用者が隠した・表示にした画層。shown はファイルの off・凍結より強い）
//     strokes: [{ color, lineweight, dashes, lines: [{ item, points: Float64Array(x, y, …), width?, weight?, cap?, alpha? }] }]（線の種類ごとにまとめる。
//              weight: PDF の線の太さ = 幅は太さの表示を切ると細線、cap: 線端 0 平ら・1 丸・2 四角）
//     fills:   [{ item, color, rings: [Float64Array], rule?, alpha? }]（rule が無ければ偶奇の規則。SOLID・ハッチング・PDF の塗り）
//     texts:   [{ item, color, x, y, rotation, height, widthFactor, oblique, mirror, lines, align, valign, width, lineSpacing, font? }]
//     points:  [{ item, color, x, y }]
//     images:  [{ item, matrix: [a, b, c, d, e, f]（画像の単位の正方形 → 表示の座標）, image }]（PDF の画像）
//     regions: [{ item, rings }]（模様のハッチング・画像の外形。描かないが、内側を指せるように索引に入れる）
//     items:   [{ handle, type, layer, entity }]（指せる図形。レイアウトに直に置かれた図形の単位。ブロック参照は中身ごと 1 つ）
//     extents: { min: [x, y], max: [x, y] } | null（放射線・構築線を除く）
//     layers:  Map<画層, 図形の数>（このレイアウトに出る画層。ブロックの中の図形も、画層 0 以外はその画層に数える）
//     broken:  値が壊れていて描けなかった図形の数（飛ばして、残りを描く）
//     unsupported: まだ描かない図形の種類 → 数（PDF はページごと。ほかは図面全体）
//     ordered: 描く順序に意味がある（PDF。描く側は z の順に描く）・exact: 色を地に合わせて補正しない（PDF）・paper: 紙の外形（PDF のページ）
//   }
//   線・塗り・文字・点・画像は、足した順の番号 z と、切り取りの枠 clip（{ min, max }。ビューポート・PDF の切り取り）を持てる。
// 色は "#rrggbb"、null は「前景色」（色番号 7: 背景が暗ければ白、明るければ黒。描く側が決める）。
// 線の太さは 1/100 mm（既定 25）、破線は図面の長さの単位の並び（正 = 線・負 = すき間・0 = 点）。

import { IDENTITY, apply, multiply, rotationZ, scaling, translation } from "../core/matrix.js";
import { bulgePoints, flattenSubpath, interpolateFit, neutralSpline, ocsAxes, toOcs, toWcs } from "../formats/cad2d/curves.js";
import { sampleCurve } from "../model/curves.js";
import { ACI, rgbHex } from "./colors.js";
import { mtextLines, singleLine } from "./text.js";

const DEFAULT_LINEWEIGHT = 25; // LWDEFAULT（0.25 mm）
const MAX_DEPTH = 24; // ブロックの入れ子の上限（自分を含むブロックの無限の入れ子を止める）
const MAX_PATTERN_LINES = 4000; // ハッチングの模様の線の本数の上限（越えたら薄い塗りにする）
const INFINITE = 1e7; // 放射線・構築線を描く長さ
const TAU = 2 * Math.PI;

const nameKey = (name) => String(name ?? "").toLowerCase();

export function buildScene(drawing, layout, { hidden = new Set(), shown = new Set() } = {}) {
  const layers = new Map([...drawing.layers.values()].map((l) => [nameKey(l.name), l]));
  const linetypes = new Map([...drawing.linetypes.values()].map((l) => [nameKey(l.name), l]));
  const blocks = new Map([...drawing.blocks.values()].map((b) => [nameKey(b.name), b]));
  const hiddenKeys = new Set([...hidden].map(nameKey));
  const shownKeys = new Set([...shown].map(nameKey));

  const strokes = new Map(), fills = [], texts = [], points = [], regions = [], images = [], items = [];
  let seq = 0; // 描く順序（PDF のように順序に意味がある図面では、描く側がこの順に描く）
  const usedLayers = new Map();
  const box = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  let measuring = true; // 外形に入れるか（紙のレイアウトのビューポートの中身は、枠の外へはみ出しても入れない）
  // 描くものの点は全てここを通る。数でない座標（壊れた値の図形）は、その図形を飛ばす印に例外を投げる（draw が数える）
  const grow = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("座標が数ではありません");
    if (!measuring) return;
    if (x < box.min[0]) box.min[0] = x;
    if (y < box.min[1]) box.min[1] = y;
    if (x > box.max[0]) box.max[0] = x;
    if (y > box.max[1]) box.max[1] = y;
  };

  // ---- 属性（画層・色・線種・線の太さ）を、画層ごと・ブロックごとから解く --------------------------------------------
  const effectiveLayer = (e, ctx) => (e.layer === "0" && ctx.layer ? ctx.layer : e.layer ?? "0");
  const layerOf = (name) => layers.get(nameKey(name));
  const isShown = (name) => {
    const key = nameKey(name), l = layerOf(name);
    return shownKeys.has(key) || (!hiddenKeys.has(key) && !(l && (l.off || l.frozen)));
  };
  const isFrozen = (name) => !shownKeys.has(nameKey(name)) && (hiddenKeys.has(nameKey(name)) || Boolean(layerOf(name)?.frozen));

  /** 色 { index, rgb? } → "#rrggbb" か null（前景色） */
  function color(c, layer, ctx) {
    const index = c?.index ?? 256;
    if (index === 256) {
      const l = layerOf(layer);
      return l ? colorValue(l.color) : null;
    }
    if (index === 0) return ctx.color === undefined ? null : ctx.color;
    return colorValue(c);
  }
  const colorValue = (c) => (c?.rgb !== undefined && c.index !== 256 && c.index !== 0 ? rgbHex(c.rgb) : ACI[Math.abs(c?.index ?? 7)] ?? null);

  function lineweight(e, layer, ctx) {
    let lw = e.lineweight ?? -1;
    if (lw === -1) lw = layerOf(layer)?.lineweight ?? -3;
    if (lw === -2) lw = ctx.lineweight ?? -3;
    return lw < 0 ? DEFAULT_LINEWEIGHT : lw;
  }

  function linetypeName(e, layer, ctx) {
    let name = e.linetype ?? "BYLAYER";
    if (/^bylayer$/i.test(name)) name = layerOf(layer)?.linetype ?? "Continuous";
    if (/^byblock$/i.test(name)) name = ctx.linetype ?? "Continuous";
    return name;
  }

  function dashes(e, layer, ctx) {
    const lt = linetypes.get(nameKey(linetypeName(e, layer, ctx)));
    if (!lt?.dashes?.length || lt.dashes.every((d) => d >= 0)) return null; // 実線（すき間の無い線種）
    const scale = (e.ltscale ?? 1) * (drawing.ltscale ?? 1) * ctx.scale;
    return lt.dashes.map((d) => d * scale);
  }

  // ---- 描くもの -----------------------------------------------------------------------------------------------------
  const style = (e, layer, ctx) => ({ color: color(e.color, layer, ctx), lineweight: lineweight(e, layer, ctx), dashes: dashes(e, layer, ctx) });

  /** 線を足す。width > 0 は幅のある線（図面の単位）。extra: { weight（PDF の線の太さ: 太さの表示を切ると細線）, cap（線端） } */
  function stroke(st, item, pts, width = 0, extra = null) {
    if (pts.length < 2) return;
    const key = `${st.color}|${st.lineweight}|${st.dashes?.map((d) => d.toPrecision(6)).join(",") ?? ""}`;
    if (!strokes.has(key)) strokes.set(key, { color: st.color, lineweight: st.lineweight, dashes: st.dashes, lines: [] });
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => {
      flat[i * 2] = p[0];
      flat[i * 2 + 1] = p[1];
      if (item.extents !== false) grow(p[0], p[1]);
      else if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new RangeError("座標が数ではありません");
    });
    const line = width > 0 ? { z: seq++, item: item.index, points: flat, width } : { z: seq++, item: item.index, points: flat };
    strokes.get(key).lines.push(extra ? Object.assign(line, extra) : line);
  }

  const ring = (pts) => {
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => {
      flat[i * 2] = p[0];
      flat[i * 2 + 1] = p[1];
      grow(p[0], p[1]);
    });
    return flat;
  };

  /** OCS（押し出しの向き）の点の並び → 表示の座標（ctx の変換を掛け、XY に落とす） */
  const place = (ctx, axes) => (p) => apply(ctx.m, toWcs(axes, p));

  /** 変換の向きだけ（移動を除く）。文字の向き・大きさを変換に通すのに使う */
  const linear = (m) => [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1];

  /** 変換の拡大の大きさ（線の幅・破線・文字の高さに掛ける） */
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[5] - m[1] * m[4])) || 1;

  // ---- 図形ごと -----------------------------------------------------------------------------------------------------
  function arcPoints(center, radius, start, end) {
    let sweep = end - start;
    while (sweep <= 0) sweep += TAU;
    if (sweep > TAU) sweep -= TAU;
    return sampleCurve({ kind: "ellipse", origin: [center[0], center[1], center[2] ?? 0], direction: [0, 0, 1], major: [radius, 0, 0], ratio: 1 },
      start, start + sweep);
  }

  /** 膨らみのある頂点の並び → 点の並び（OCS のまま） */
  function bulged(vertices, bulges, closed, z = 0) {
    const out = [[vertices[0][0], vertices[0][1], vertices[0][2] ?? z]];
    const n = vertices.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = vertices[i], b = vertices[(i + 1) % n];
      out.push(...bulgePoints([a[0], a[1], a[2] ?? z], [b[0], b[1], b[2] ?? z], bulges[i] ?? 0));
    }
    return out;
  }

  /** パス（PDF）: 線分と 3 次ベジェの区間を点の並びにして、塗るか線を引く */
  function path(e, layer, ctx, item) {
    const at = place(ctx, null);
    const runs = e.subpaths.map((sp) => flattenSubpath(sp).map((p) => at([p[0], p[1], 0])));
    const c = color(e.color, layer, ctx);
    if (e.fill) {
      const rings = runs.filter((r) => r.length >= 3);
      if (rings.length) fills.push({ z: seq++, item: item.index, color: c, rings: rings.map(ring), rule: e.fill, ...(e.alpha < 1 && { alpha: e.alpha }) });
      return;
    }
    const k = ctx.scale;
    const st = { color: c, lineweight: 0, dashes: e.dashes?.length ? e.dashes.map((d) => d * k) : null };
    for (const r of runs) stroke(st, item, r, Math.max(e.width * k, 1e-9), { weight: true, cap: e.cap ?? 0, ...(e.alpha < 1 && { alpha: e.alpha }) });
  }

  /** 画像（PDF）: 単位の正方形 → 図面 の行列に、表示の変換を掛ける */
  function image(e, ctx, item) {
    const m = e.matrix;
    const corner = (u, v) => apply(ctx.m, [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5], 0]);
    const [o, ux, uy] = [corner(0, 0), corner(1, 0), corner(0, 1)];
    const quad = [o, ux, corner(1, 1), uy];
    for (const p of quad) grow(p[0], p[1]);
    images.push({ z: seq++, item: item.index, matrix: [ux[0] - o[0], ux[1] - o[1], uy[0] - o[0], uy[1] - o[1], o[0], o[1]], image: e.image });
    regions.push({ item: item.index, rings: [ring(quad)] }); // 内側を指せるように
  }

  function textItem(e, layer, ctx, item, lines, extra) {
    const m = ctx.m;
    const axes = extra.ocs ? ocsAxes(e.extrusion) : null;
    const at = place(ctx, axes)(extra.anchor);
    // 文字の向き: OCS の回転を変換に通す（ブロック参照の回転・鏡映も入る）
    const turn = place({ m: linear(m) }, axes);
    const dir = turn([Math.cos(extra.rotation), Math.sin(extra.rotation), 0]);
    const up = turn([-Math.sin(extra.rotation), Math.cos(extra.rotation), 0]);
    const sx = Math.hypot(dir[0], dir[1]) || 1, sy = Math.hypot(up[0], up[1]) || 1;
    const mirror = dir[0] * up[1] - dir[1] * up[0] < 0;
    texts.push({
      z: seq++,
      item: item.index, color: color(e.color, layer, ctx), x: at[0], y: at[1], rotation: Math.atan2(dir[1], dir[0]),
      height: (e.height || 0) * sy, widthFactor: (e.widthFactor || 1) * (sx / sy), oblique: e.oblique ?? 0,
      mirror: mirror !== Boolean(extra.mirrorX), flip: Boolean(extra.mirrorY), lines, align: extra.align, valign: extra.valign,
      width: (extra.width ?? 0) * sx, lineSpacing: extra.lineSpacing ?? 1, mtext: Boolean(extra.mtext),
      ...(extra.fit && { fit: { mode: extra.fit.mode, length: extra.fit.length * sx } }),
      ...(e.font && { font: e.font }),
    });
    // 外形の見積もり（文字の高さ × 行数・幅は高さ × 文字数 × 0.8）
    const h = (e.height || 0) * sy, w = Math.max(...lines.map((l) => l.length), 1) * h * 0.8 * (e.widthFactor || 1);
    grow(at[0] - w, at[1] - h * lines.length * 1.7);
    grow(at[0] + w, at[1] + h * 1.2);
  }

  // TEXT の水平・垂直の揃え（72・73）→ 表示の揃え
  const HALIGN = ["left", "center", "right", "left", "center", "left"];
  const VALIGN = ["baseline", "bottom", "middle", "top"];

  function text(e, layer, ctx, item) {
    const h = e.halign ?? 0, v = e.valign ?? 0;
    const aligned = h === 3 || h === 5; // 2 点の間に収める
    const useAlign = (h !== 0 || v !== 0) && e.align;
    let rotation = e.rotation ?? 0, anchor = useAlign ? e.align : e.p, fit = null;
    if (aligned && e.align) {
      // 2 点の間に収める（3 = 高さも変える・5 = 幅だけ変える）。正確な幅は描く側が文字を測って合わせる
      const dx = e.align[0] - e.p[0], dy = e.align[1] - e.p[1];
      rotation = Math.atan2(dy, dx);
      anchor = e.p;
      fit = { mode: h === 3 ? "aligned" : "fit", length: Math.hypot(dx, dy) };
    }
    textItem(e, layer, ctx, item, [singleLine(e.text)], {
      ocs: true, anchor, rotation, align: aligned ? "left" : HALIGN[h] ?? "left", valign: h === 4 ? "middle" : VALIGN[v] ?? "baseline",
      mirrorX: (e.generation ?? 0) & 2, mirrorY: (e.generation ?? 0) & 4, fit,
    });
  }

  // MTEXT の付ける点（71: 1 左上 … 9 右下）
  const ATTACH_H = ["left", "center", "right"];
  const ATTACH_V = ["top", "middle", "bottom"];

  function mtext(e, layer, ctx, item) {
    const attach = Math.min(Math.max((e.attach ?? 1) - 1, 0), 8);
    // MTEXT の点・向きは WCS。向きを押し出しの OCS の角度にして渡す
    const axes = ocsAxes(e.extrusion);
    const local = toOcs(axes, e.direction ?? [1, 0, 0]);
    const anchor = toOcs(axes, e.p ?? [0, 0, 0]);
    textItem(e, layer, ctx, item, mtextLines(e.text), {
      ocs: true, anchor, rotation: Math.atan2(local[1], local[0]), align: ATTACH_H[attach % 3], valign: ATTACH_V[Math.floor(attach / 3)],
      width: e.width ?? 0, lineSpacing: e.lineSpacing ?? 1, mtext: true,
    });
  }

  /** ハッチングの境界 → 輪の並び（OCS の 2D の点） */
  function hatchRings(e) {
    const rings = [];
    for (const loop of e.loops ?? []) {
      if (loop.points?.length) {
        rings.push(bulged(loop.points.map((p) => [p[0], p[1], 0]), loop.bulges ?? [], loop.closed !== false).map((p) => [p[0], p[1]]));
        continue;
      }
      const pts = [];
      for (const edge of loop.edges ?? []) {
        let seg = [];
        if (edge.kind === "line") seg = [edge.a, edge.b];
        else if (edge.kind === "arc") {
          // 時計回りの円弧は、角度を補角（−角度）で持つ（DXF の約束。DWG も同じ値）
          const [s, t] = edge.ccw === false ? [-edge.start, -edge.end] : [edge.start, edge.end];
          seg = edge.ccw === false ? arcPoints(edge.center, edge.radius, t, s).reverse() : arcPoints(edge.center, edge.radius, s, t);
        } else if (edge.kind === "ellipse") {
          const [s, t] = edge.ccw === false ? [-edge.start, -edge.end] : [edge.start, edge.end];
          let sweep = edge.ccw === false ? s - t : t - s;
          while (sweep <= 0) sweep += TAU;
          const c = { kind: "ellipse", origin: [edge.center[0], edge.center[1], 0], direction: [0, 0, 1], major: [edge.major[0], edge.major[1], 0], ratio: edge.ratio };
          seg = edge.ccw === false ? sampleCurve(c, s - sweep, s).reverse() : sampleCurve(c, s, s + sweep);
        } else if (edge.kind === "spline") {
          const sp = edge.controls?.length
            ? { degree: edge.degree, knots: edge.knots, controls: edge.controls.map((p) => [p[0], p[1], 0]), weights: edge.weights }
            : interpolateFit({ fit: edge.fit.map((p) => [p[0], p[1], 0]) });
          if (sp) seg = sampleCurve(neutralSpline(sp), sp.knots[sp.degree], sp.knots[sp.controls.length]);
        }
        for (const p of seg) {
          const last = pts.at(-1);
          if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) pts.push([p[0], p[1]]);
        }
      }
      if (pts.length > 2) rings.push(pts);
    }
    return rings;
  }

  /** 模様の線を境界で切る（偶奇の規則）。lines: [{ angle, base, offset, dashes }]（図面の単位。角度・尺度は掛け済み） */
  function patternSegments(rings, lines) {
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
    const min = [Math.min(...xs), Math.min(...ys)], max = [Math.max(...xs), Math.max(...ys)];
    const out = [];
    let total = 0;
    for (const line of lines) {
      const d = [Math.cos(line.angle), Math.sin(line.angle)], n = [-d[1], d[0]];
      const step = line.offset[0] * n[0] + line.offset[1] * n[1]; // 隣の線までの距離（法線の向き）
      if (Math.abs(step) < 1e-12) continue;
      const shift = line.offset[0] * d[0] + line.offset[1] * d[1]; // 隣の線で破線がずれる量
      const corners = [[min[0], min[1]], [max[0], min[1]], [min[0], max[1]], [max[0], max[1]]];
      const along = corners.map((c) => (c[0] - line.base[0]) * n[0] + (c[1] - line.base[1]) * n[1]);
      const k0 = Math.ceil(Math.min(...along) / step), k1 = Math.floor(Math.max(...along) / step);
      const [lo, hi] = k0 <= k1 ? [k0, k1] : [k1, k0];
      total += hi - lo + 1;
      if (total > MAX_PATTERN_LINES) return null;
      const period = line.dashes.reduce((s, v) => s + Math.abs(v), 0);
      for (let k = lo; k <= hi; k++) {
        const o = [line.base[0] + n[0] * step * k + d[0] * shift * k, line.base[1] + n[1] * step * k + d[1] * shift * k];
        // 線 o + t d と輪の辺の交点
        const ts = [];
        for (const r of rings) {
          for (let i = 0; i < r.length; i++) {
            const a = r[i], b = r[(i + 1) % r.length];
            const ea = (a[0] - o[0]) * n[0] + (a[1] - o[1]) * n[1], eb = (b[0] - o[0]) * n[0] + (b[1] - o[1]) * n[1];
            if ((ea > 0) === (eb > 0) || ea === eb) continue;
            const f = ea / (ea - eb);
            ts.push((a[0] + (b[0] - a[0]) * f - o[0]) * d[0] + (a[1] + (b[1] - a[1]) * f - o[1]) * d[1]);
          }
        }
        ts.sort((x, y) => x - y);
        for (let i = 0; i + 1 < ts.length; i += 2) {
          if (!line.dashes.length || !(period > 0)) out.push([[o[0] + d[0] * ts[i], o[1] + d[1] * ts[i]], [o[0] + d[0] * ts[i + 1], o[1] + d[1] * ts[i + 1]]]);
          else out.push(...dashed(o, d, ts[i], ts[i + 1], line.dashes, period));
        }
      }
    }
    return out;
  }

  /** o + t d の t0〜t1 を、破線（正 = 線・負 = すき間・0 = 点）で区切った線分の並び */
  function dashed(o, d, t0, t1, pattern, period) {
    const out = [];
    let t = Math.floor(t0 / period) * period;
    while (t < t1) {
      for (const len of pattern) {
        const a = t, b = t + Math.abs(len);
        if (len >= 0 && b >= t0 && a <= t1) {
          const s = Math.max(a, t0), e = Math.max(Math.min(b, t1), s + (len === 0 ? period * 1e-3 : 0));
          out.push([[o[0] + d[0] * s, o[1] + d[1] * s], [o[0] + d[0] * e, o[1] + d[1] * e]]);
        }
        t = b;
        if (t >= t1) break;
      }
    }
    return out;
  }

  function hatch(e, layer, ctx, item) {
    const axes = ocsAxes(e.extrusion);
    const toWorld = place(ctx, axes);
    const z = e.elevation ?? 0;
    const rings = hatchRings(e);
    if (!rings.length) return;
    const worldRings = rings.map((r) => r.map((p) => toWorld([p[0], p[1], z])));
    const c = color(e.color, layer, ctx);
    if (e.solid || e.gradient || !e.lines?.length) {
      fills.push({ z: seq++, item: item.index, color: c, rings: worldRings.map(ring) });
      return;
    }
    regions.push({ item: item.index, rings: worldRings.map(ring) });
    const segments = patternSegments(rings, e.lines);
    if (!segments) {
      fills.push({ z: seq++, item: item.index, color: c, rings: worldRings.map(ring), alpha: 0.25 }); // 模様が細かすぎる: 薄く塗る
      return;
    }
    const st = { color: c, lineweight: lineweight(e, layer, ctx), dashes: null };
    for (const s of segments) stroke(st, item, s.map((p) => toWorld([p[0], p[1], z])));
  }

  function insert(e, layer, ctx, item, depth) {
    const block = blocks.get(nameKey(e.block));
    if (!block || depth > MAX_DEPTH) return;
    const axes = ocsAxes(e.extrusion);
    const ocs = axes
      ? [axes[0][0], axes[1][0], axes[2][0], 0, axes[0][1], axes[1][1], axes[2][1], 0, axes[0][2], axes[1][2], axes[2][2], 0, 0, 0, 0, 1]
      : IDENTITY;
    const base = block.base ?? [0, 0, 0];
    const [sx, sy, sz] = e.scale ?? [1, 1, 1];
    const inner = {
      layer: layer, color: color(e.color, layer, ctx), linetype: linetypeName(e, layer, ctx), lineweight: lineweight(e, layer, ctx),
    };
    for (let r = 0; r < Math.max(1, e.rows ?? 1); r++) {
      for (let c = 0; c < Math.max(1, e.columns ?? 1); c++) {
        const cell = [(e.columnSpacing ?? 0) * c, (e.rowSpacing ?? 0) * r, 0];
        const local = multiply(multiply(multiply(multiply(translation(e.p ?? [0, 0, 0]), rotationZ(e.rotation ?? 0)), translation(cell)),
          scaling([sx || 1, sy || 1, sz || 1])), translation(base.map((v) => -v)));
        const m = multiply(ctx.m, multiply(ocs, local));
        const sub = { ...inner, m, scale: scaleOf(m), item: ctx.item };
        for (const child of block.entities) draw(child, sub, item, depth + 1, true);
      }
    }
    for (const a of e.attribs ?? []) {
      if ((a.flags ?? 0) & 1) continue; // 見えない属性
      const al = effectiveLayer(a, ctx);
      if (isShown(al)) text(a, al, ctx, item);
    }
  }

  // 寸法: 見た目のブロックがあればそれを描く（ブロックの座標は WCS）。無ければ（DWG で寸法のブロックが無いもの）定義点から簡単に描く
  function dimension(e, layer, ctx, item, depth) {
    const block = blocks.get(nameKey(e.block));
    if (block?.entities.length) {
      const sub = { layer, color: color(e.color, layer, ctx), linetype: linetypeName(e, layer, ctx), lineweight: lineweight(e, layer, ctx),
        m: ctx.m, scale: ctx.scale };
      for (const child of block.entities) draw(child, sub, item, depth + 1, true);
      return;
    }
    const st = style(e, layer, ctx);
    const toWorld = place(ctx, null);
    const p10 = e.p10 ?? [0, 0, 0];
    if ((e.kind === "linear" || e.kind === "aligned") && e.p13 && e.p14) {
      // 寸法線は p10 を通り、p13 → p14 に平行（回転寸法は回転の向き。ここでは平行で近似）
      const d = [e.p14[0] - e.p13[0], e.p14[1] - e.p13[1]];
      const len = Math.hypot(d[0], d[1]) || 1, u = [d[0] / len, d[1] / len];
      const proj = (p) => {
        const t = (p[0] - p10[0]) * u[0] + (p[1] - p10[1]) * u[1];
        return [p10[0] + u[0] * t, p10[1] + u[1] * t, 0];
      };
      const a = proj(e.p13), b = proj(e.p14);
      stroke(st, item, [e.p13, a].map(toWorld));
      stroke(st, item, [e.p14, b].map(toWorld));
      stroke(st, item, [a, b].map(toWorld));
    } else if ((e.kind === "radius" || e.kind === "diameter") && e.p15) {
      stroke(st, item, [p10, e.p15].map(toWorld));
    }
    const value = e.text && e.text !== "<>" && e.text.trim() ? e.text.replace("<>", formatNumber(e.measurement)) : formatNumber(e.measurement);
    if (value && e.textMid && e.text !== " ") {
      // 寸法スタイルは読まないので、文字の高さは AutoCAD の既定（インチ 0.18・それ以外 2.5）
      const h = (drawing.units?.code === 1 ? 0.18 : 2.5) * ctx.scale;
      textItem({ color: e.color, height: h, widthFactor: 1 }, layer, ctx, item, mtextLines(value), {
        ocs: false, anchor: e.textMid, rotation: 0, align: "center", valign: "middle",
      });
    }
  }

  function leader(e, layer, ctx, item) {
    const st = style(e, layer, ctx);
    const toWorld = place(ctx, null);
    let pts = e.points ?? [];
    if (pts.length < 2) return;
    if (e.pathType === 1 && pts.length > 2) {
      const sp = interpolateFit({ fit: pts });
      if (sp) pts = sampleCurve(neutralSpline(sp), sp.knots[sp.degree], sp.knots[sp.controls.length]);
    }
    stroke(st, item, pts.map(toWorld));
    if (e.arrow) {
      // 矢印: 寸法スタイルの大きさは読まないので、最初の線分の長さの 1/4（上限 = 全長の 1/10）で描く
      const [a, b] = [e.points[0], e.points[1]];
      const total = e.points.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - e.points[i][0], p[1] - e.points[i][1]), 0);
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const size = Math.min(seg / 4, total / 10), u = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
      const tip = [a[0], a[1], a[2] ?? 0], back = [a[0] + u[0] * size, a[1] + u[1] * size];
      const w = size / 3;
      fills.push({ z: seq++, item: item.index, color: st.color, rings: [ring([tip, [back[0] - u[1] * w, back[1] + u[0] * w, 0], [back[0] + u[1] * w, back[1] - u[0] * w, 0]].map(toWorld))] });
    }
  }

  /** 図形 1 つを描く。値が壊れていて描けない図形（大きさが数でない円など）は飛ばして数え、図面の残りは描く */
  function draw(e, ctx, item, depth = 0, inBlock = false) {
    const mark = e.clip ? marks() : null;
    // ブロック（SXF の部分図・寸法の中身など）の中の図形も、その画層に数える（画層の一覧で表示・非表示を切り替えられるように）。
    // 画層 0 の図形は置く側の画層を引き継ぐので数えない
    if (inBlock && e.layer && e.layer !== "0" && e.type !== "INSERT") usedLayers.set(e.layer, (usedLayers.get(e.layer) ?? 0) + 1);
    try {
      drawEntity(e, ctx, item, depth, inBlock);
    } catch {
      broken++;
    }
    if (mark) clipSince(mark, clipBox(e.clip, ctx));
  }

  // ---- 切り取り（ビューポートの枠・PDF の切り取りの外形）: 印を付けた後に足したものに、枠を付ける -------------------------
  const marks = () => ({ strokes: new Map([...strokes].map(([key, s]) => [key, s.lines.length])), fills: fills.length, texts: texts.length,
    points: points.length, regions: regions.length, images: images.length });
  const meet = (a, b) => (a ? { min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1])], max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1])] } : b);
  function clipSince(mark, clip) {
    const set = (list, from) => {
      for (let i = from; i < list.length; i++) list[i].clip = meet(list[i].clip, clip);
    };
    for (const [key, s] of strokes) set(s.lines, mark.strokes.get(key) ?? 0);
    set(fills, mark.fills);
    set(texts, mark.texts);
    set(points, mark.points);
    set(regions, mark.regions);
    set(images, mark.images);
  }
  /** 図形の切り取りの外形（図形の座標）→ 表示の座標の外形 */
  function clipBox(c, ctx) {
    const pts = [[c.min[0], c.min[1]], [c.max[0], c.min[1]], [c.max[0], c.max[1]], [c.min[0], c.max[1]]].map((p) => apply(ctx.m, [p[0], p[1], 0]));
    return { min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] };
  }

  /** 図形 1 つを描く。inBlock: ブロックの中（ATTDEF は描かない） */
  function drawEntity(e, ctx, item, depth, inBlock) {
    const layer = effectiveLayer(e, ctx);
    if (e.invisible) return;
    // ブロック参照は、画層が凍結（または利用者が隠した）なら中身ごと消す。画層が off なら、中身のうち画層 0 の図形だけ消える（AutoCAD と同じ）
    if (e.type === "INSERT" ? isFrozen(layer) : !isShown(layer)) return;
    const st = () => style(e, layer, ctx);
    const axes = () => ocsAxes(e.extrusion);
    switch (e.type) {
      case "PATH": return path(e, layer, ctx, item);
      case "IMAGE": return image(e, ctx, item);
      case "LINE": return stroke(st(), item, [e.a, e.b].map(place(ctx, null)));
      case "POINT": {
        const p = place(ctx, null)(e.p);
        grow(p[0], p[1]);
        return points.push({ z: seq++, item: item.index, color: color(e.color, layer, ctx), x: p[0], y: p[1] });
      }
      case "CIRCLE": return stroke(st(), item, arcPoints(e.center, e.radius, 0, TAU).map(place(ctx, axes())));
      case "ARC": return stroke(st(), item, arcPoints(e.center, e.radius, e.start, e.end).map(place(ctx, axes())));
      case "ELLIPSE": {
        let end = e.end;
        while (end <= e.start) end += TAU;
        const c = { kind: "ellipse", origin: e.center, direction: e.extrusion ?? [0, 0, 1], major: e.major, ratio: e.ratio };
        return stroke(st(), item, sampleCurve(c, e.start, end).map(place(ctx, null)));
      }
      case "LWPOLYLINE": {
        if (!e.points?.length) return;
        const pts = bulged(e.points.map((p) => [p[0], p[1], e.elevation ?? 0]), e.bulges ?? [], e.closed, e.elevation ?? 0);
        const width = (e.constWidth || Math.max(0, ...(e.widths ?? []).flat())) * ctx.scale;
        return stroke(st(), item, pts.map(place(ctx, axes())), width);
      }
      case "POLYLINE": return polyline(e, st(), ctx, item);
      case "SPLINE": {
        if (e.controls?.length && e.knots?.length === e.controls.length + e.degree + 1) {
          const pts = sampleCurve(neutralSpline(e), e.knots[e.degree], e.knots[e.controls.length]);
          return stroke(st(), item, pts.map(place(ctx, null)));
        }
        return stroke(st(), item, (e.fit ?? []).map(place(ctx, null)));
      }
      case "TEXT": case "ATTRIB": return text(e, layer, ctx, item);
      case "ATTDEF": return inBlock ? undefined : text(e, layer, ctx, item);
      case "MTEXT": return mtext(e, layer, ctx, item);
      case "INSERT": return insert(e, layer, ctx, item, depth);
      case "DIMENSION": return dimension(e, layer, ctx, item, depth);
      case "HATCH": return hatch(e, layer, ctx, item);
      case "SOLID": {
        const [a, b, c, d] = e.points.map(place(ctx, axes()));
        return fills.push({ z: seq++, item: item.index, color: color(e.color, layer, ctx), rings: [ring([a, b, d ?? c, c])] });
      }
      case "3DFACE": {
        const p = e.points.map(place(ctx, null));
        const hiddenEdges = e.invisibleEdges ?? 0;
        for (let i = 0; i < 4; i++) if (!(hiddenEdges & (1 << i))) stroke(st(), item, [p[i], p[(i + 1) % 4]]);
        return;
      }
      case "LEADER": return leader(e, layer, ctx, item);
      case "RAY": case "XLINE": {
        const d = e.direction ?? [1, 0, 0], p = e.p ?? [0, 0, 0];
        const from = e.type === "XLINE" ? p.map((v, k) => v - d[k] * INFINITE) : p;
        return stroke(st(), { ...item, extents: false }, [from, p.map((v, k) => v + d[k] * INFINITE)].map(place(ctx, null)));
      }
      case "VIEWPORT": return undefined; // レイアウトで扱う（viewport()）
      default: return undefined;
    }
  }

  function polyline(e, st, ctx, item) {
    const v = e.vertices ?? [];
    if (!v.length) return;
    if (e.kind === "2d") return stroke(st, item, bulged(v.map((x) => x.p), v.map((x) => x.bulge), e.closed, e.elevation).map(place(ctx, ocsAxes(e.extrusion))));
    if (e.kind === "3d") return stroke(st, item, [...v, ...(e.closed ? [v[0]] : [])].map((x) => x.p).map(place(ctx, null)));
    const toWorld = place(ctx, null);
    if (e.kind === "mesh" && e.m > 0 && e.n > 0) {
      const at = (i, j) => v[i * e.n + j]?.p;
      for (let i = 0; i < e.m; i++) stroke(st, item, Array.from({ length: e.n }, (_, j) => at(i, j)).filter(Boolean).map(toWorld));
      for (let j = 0; j < e.n; j++) stroke(st, item, Array.from({ length: e.m }, (_, i) => at(i, j)).filter(Boolean).map(toWorld));
      return;
    }
    if (e.kind === "pface") {
      for (const face of e.faces ?? []) {
        const idx = face.filter((i) => i !== 0);
        for (let k = 0; k < idx.length; k++) {
          const a = idx[k], b = idx[(k + 1) % idx.length];
          if (a < 0) continue; // 負の番号 = 見えない辺
          const pa = v[Math.abs(a) - 1]?.p, pb = v[Math.abs(b) - 1]?.p;
          if (pa && pb) stroke(st, item, [pa, pb].map(toWorld));
        }
      }
    }
  }

  // ---- レイアウト -------------------------------------------------------------------------------------------------
  const top = blocks.get(nameKey(layout?.block));
  const root = { m: IDENTITY, scale: 1 };
  const newItem = (e, extra = {}) => {
    const index = items.length;
    items.push({ handle: e.handle, type: e.type, layer: e.layer ?? "0", entity: e, ...extra });
    usedLayers.set(e.layer ?? "0", (usedLayers.get(e.layer ?? "0") ?? 0) + 1);
    return { index };
  };
  const viewports = [];
  let broken = 0;
  // 紙（PDF のページ）: 白い紙として描き、外形に入れる
  const paper = layout?.paper ?? null;
  if (paper) {
    grow(paper.min[0], paper.min[1]);
    grow(paper.max[0], paper.max[1]);
  }
  for (const e of top?.entities ?? []) {
    if (e.type === "VIEWPORT") viewports.push(e);
    else draw(e, root, newItem(e));
  }
  // 紙のレイアウト: ビューポートの中にモデルを描く（最初のビューポートは紙そのもの。枠も中身も描かない）
  if (!layout?.model && viewports.length > 1) {
    const model = [...blocks.values()].find((b) => /^\*model_space$/i.test(b.name));
    for (const vp of viewports.slice(1)) viewport(vp, model);
  }

  function viewport(vp, model) {
    if (!model || !(vp.viewHeight > 0) || !(vp.height > 0)) return;
    const item = newItem(vp);
    const st = style(vp, vp.layer, root);
    const [cx, cy] = vp.center, hw = vp.width / 2, hh = vp.height / 2;
    if (isShown(vp.layer)) stroke(st, item, [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh], [cx - hw, cy - hh]]);
    // モデル → 紙: ビューの中心を枠の中心へ、高さを合わせ、ねじれ（twist）だけ回す。枠の外は描く側が切る（clip）
    const k = vp.height / vp.viewHeight;
    const m = multiply(multiply(multiply(translation([cx, cy, 0]), scaling([k, k, k])), rotationZ(vp.twist ?? 0)),
      translation([-(vp.viewCenter?.[0] ?? 0), -(vp.viewCenter?.[1] ?? 0), 0]));
    const ctx = { m, scale: k };
    const clip = { min: [cx - hw, cy - hh], max: [cx + hw, cy + hh] };
    const start = marks();
    measuring = false;
    for (const e of model.entities) draw(e, ctx, newItem(e, { viewport: item.index }));
    measuring = true;
    clipSince(start, clip); // この枠の中に描いたものに、切り取りの枠を付ける
  }

  const extents = box.min[0] <= box.max[0] ? box : null;
  return { strokes: [...strokes.values()], fills, texts, points, regions, images, items, extents, layers: usedLayers, broken,
    unsupported: top?.unsupported ?? drawing.unsupported, ordered: Boolean(drawing.ordered), exact: Boolean(drawing.exactColors), paper };
}

/** 寸法の値の表示（小数 4 桁まで、末尾の 0 を省く） */
export function formatNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  return String(Number(v.toFixed(4)));
}
