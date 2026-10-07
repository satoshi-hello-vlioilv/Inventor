// 2D の図面の表示（Canvas 2D）。scene.js が作った描くものを、拡大・移動して描き、指した図形を知らせて強調する。
// 線は「色・太さ・破線」ごとに 1 つの Path2D にまとめ、拡大・移動では変換だけを変えて描き直す（図形が多くても速い）。
// 座標は外形の中心を原点にずらして持つ（大きな座標でも、Canvas の単精度で崩れない）。色は CSS のトークンを Canvas の位置で読む
// （図面のときだけの上書き・テーマの切り替えに追従する）:
//   --sheet          … 図面の地の色
//   --sheet-ink      … 色番号 7（前景色）。地が暗ければ白、明るければ黒
//   --sheet-contrast … 地に対するコントラスト比の下限（例 3）。届かない図面の色を前景の側へ寄せる（0 か無しなら図面の色のまま）
//   --accent         … 指した図形の強調

import { readable } from "./colors.js";
import { HitIndex, textOutline } from "./hit.js";

const ZOOM_STEP = 1.0015; // ホイール 1 単位あたりの拡大率
const MIN_DASH_PX = 3; // 破線の 1 周期が画面でこれより短ければ、実線で描く
const MIN_TEXT_PX = 1.5; // 文字の高さが画面でこれより小さければ描かない
const HIT_PX = 6; // 指した点からこの距離（画面の px）までの図形を拾う
const FIT_MARGIN = 0.06;
const CAP_HEIGHT = 0.72; // フォントの大きさ（em）に対する大文字の高さ（図面の文字の高さ = 大文字の高さ）
const DESCENT = 0.25; // TEXT の「下」揃え: 基線から下の部分（大文字の高さに対する比）

export class DrawingViewer {
  /**
   * @param {{ stage: HTMLElement, canvas: HTMLCanvasElement }} elements
   * @param {{ onHover?: (item: number | null) => void }} [callbacks]
   */
  constructor({ stage, canvas }, { onHover } = {}) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHover = onHover ?? (() => {});
    this.scene = null;
    this.view = { scale: 1, x: 0, y: 0 }; // 画面の px = (world - origin) × scale + (x, y)。y は上向き
    this.origin = [0, 0];
    this.highlighted = null;
    this.lineweights = true;
    this.palette = new Map(); // 図面の色 → 地に合わせた色（描くたびに作り直す）
    this.#watchSize();
    this.#watchPointer();
    this.#watchTheme();
  }

  /** 描くものを表示する（前のものは捨てる）。fit = 全体が収まるように */
  show(scene, { fit = true } = {}) {
    this.scene = scene;
    const ext = scene.extents;
    this.origin = ext ? [(ext.min[0] + ext.max[0]) / 2, (ext.min[1] + ext.max[1]) / 2] : [0, 0];
    this.#build();
    this.index = new HitIndex(scene);
    this.highlighted = null;
    this.highlightKey = "";
    if (fit) this.fit();
    else this.requestRender();
  }

  clear() {
    this.scene = null;
    this.batches = [];
    this.requestRender();
  }

  /** 全体が収まるように */
  fit() {
    const ext = this.scene?.extents;
    const { width, height } = this.#size();
    if (!ext || !width || !height) return this.requestRender();
    const w = Math.max(ext.max[0] - ext.min[0], 1e-9), h = Math.max(ext.max[1] - ext.min[1], 1e-9);
    const scale = Math.min(width / w, height / h) * (1 - 2 * FIT_MARGIN);
    this.view = { scale, x: width / 2, y: height / 2 };
    this.requestRender();
  }

  /** 画面の中心を基準に拡大・縮小（factor > 1 で拡大） */
  zoom(factor, at = null) {
    const { width, height } = this.#size();
    const [px, py] = at ?? [width / 2, height / 2];
    const v = this.view;
    v.x = px - (px - v.x) * factor;
    v.y = py - (py - v.y) * factor;
    v.scale *= factor;
    this.requestRender();
  }

  /** 図形の強調（items の番号・その並び。null か空で消す） */
  highlight(items) {
    const list = items === null || items === undefined ? [] : Array.isArray(items) ? items : [items];
    const key = list.join(",");
    if (key === this.highlightKey) return;
    this.highlightKey = key;
    this.highlighted = list.length ? list : null;
    this.requestRender();
  }

  /** 図面の色 → 地に合わせて描く色（画層の欄の見本を、図面と同じ色にするため） */
  displayColor(color) {
    const ink = this.#token("--sheet-ink") || "#000";
    if (!color) return ink;
    return readable(color, this.#token("--sheet") || "#fff", ink, Number(this.#token("--sheet-contrast")) || 0);
  }

  setLineweights(on) {
    this.lineweights = on;
    this.requestRender();
  }

  /** 画面の点 → 図面の座標 */
  toWorld(px, py) {
    const v = this.view;
    return [(px - v.x) / v.scale + this.origin[0], -(py - v.y) / v.scale + this.origin[1]];
  }

  requestRender() {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.#render();
    });
  }

  // ---- 組み立て（表示するものが変わったときだけ） -------------------------------------------------------------------
  #build() {
    const [ox, oy] = this.origin;
    const clipKey = (c) => (c ? `${c.min.join(",")},${c.max.join(",")}` : "");
    const pathOf = (points) => {
      const p = new Path2D();
      p.moveTo(points[0] - ox, points[1] - oy);
      for (let i = 2; i < points.length; i += 2) p.lineTo(points[i] - ox, points[i + 1] - oy);
      return p;
    };
    // 線: 色・太さ・破線・切り取りの枠ごとに 1 つの Path2D。幅のあるポリラインは 1 本ずつ
    const batches = new Map();
    this.wide = [];
    this.byItem = new Map(); // 図形の番号 → その線・塗り（強調に使う）
    const remember = (item, entry) => {
      if (!this.byItem.has(item)) this.byItem.set(item, []);
      this.byItem.get(item).push(entry);
    };
    for (const s of this.scene.strokes) {
      for (const line of s.lines) {
        const path = pathOf(line.points);
        remember(line.item, { kind: "stroke", path, clip: line.clip, width: line.width });
        if (line.width > 0) {
          this.wide.push({ color: s.color, width: line.width, path, clip: line.clip });
          continue;
        }
        const key = `${s.color}|${s.lineweight}|${s.dashes?.join(",") ?? ""}|${clipKey(line.clip)}`;
        if (!batches.has(key)) batches.set(key, { color: s.color, lineweight: s.lineweight, dashes: s.dashes, clip: line.clip, path: new Path2D() });
        batches.get(key).path.addPath(path);
      }
    }
    this.batches = [...batches.values()];
    this.fills = this.scene.fills.map((f) => {
      const path = new Path2D();
      for (const r of f.rings) path.addPath(pathOf(r)), path.closePath?.();
      remember(f.item, { kind: "fill", path, clip: f.clip });
      return { color: f.color, alpha: f.alpha ?? 1, path, clip: f.clip };
    });
    for (const t of this.scene.texts) remember(t.item, { kind: "text", text: t });
    for (const p of this.scene.points) remember(p.item, { kind: "point", point: p });
  }

  // ---- 描く -------------------------------------------------------------------------------------------------------
  /** CSS のトークン（Canvas の位置で読む） */
  #token(name) {
    return getComputedStyle(this.canvas).getPropertyValue(name).trim();
  }

  #size() {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }

  #render() {
    const { ctx, canvas } = this;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const { width, height } = this.#size();
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.scene) return;
    const ink = this.#token("--sheet-ink") || "#000";
    const sheet = this.#token("--sheet") || "#fff";
    const minimum = Number(this.#token("--sheet-contrast")) || 0;
    this.font = this.#token("--font-drawing") || "sans-serif"; // 文字ごとに読み直さない
    this.palette.clear();
    const colorOf = (c) => {
      if (!c) return ink;
      if (!this.palette.has(c)) this.palette.set(c, readable(c, sheet, ink, minimum));
      return this.palette.get(c);
    };
    const { scale, x, y } = this.view;
    const world = () => ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * x, dpr * y);
    const px = 1 / scale; // 図面の単位での 1 px
    const withClip = (clip, draw) => {
      if (!clip) return draw();
      ctx.save();
      world(); // 枠は図面の座標で作る（文字を描いた後は、文字の座標系になっているため）
      ctx.beginPath();
      ctx.rect(clip.min[0] - this.origin[0], clip.min[1] - this.origin[1], clip.max[0] - clip.min[0], clip.max[1] - clip.min[1]);
      ctx.clip();
      draw();
      ctx.restore();
    };
    world();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // 塗り（下）→ 線 → 文字・点（上）
    for (const f of this.fills) {
      withClip(f.clip, () => {
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = colorOf(f.color);
        ctx.fill(f.path, "evenodd");
        ctx.globalAlpha = 1;
      });
    }
    for (const w of this.wide) {
      withClip(w.clip, () => {
        ctx.strokeStyle = colorOf(w.color);
        ctx.lineWidth = Math.max(w.width, px);
        ctx.setLineDash([]);
        ctx.stroke(w.path);
      });
    }
    for (const b of this.batches) {
      withClip(b.clip, () => {
        ctx.strokeStyle = colorOf(b.color);
        ctx.lineWidth = this.#lineWidthPx(b.lineweight) * px;
        ctx.setLineDash(this.#dash(b.dashes, scale));
        ctx.stroke(b.path);
      });
    }
    ctx.setLineDash([]);
    for (const t of this.scene.texts) withClip(t.clip, () => this.#text(t, colorOf(t.color), dpr));
    world();
    // 点: AutoCAD の既定（PDMODE 0）と同じく、1 px 四方の点
    for (const p of this.scene.points) {
      withClip(p.clip, () => {
        ctx.fillStyle = colorOf(p.color);
        ctx.fillRect(p.x - this.origin[0] - 0.75 * px, p.y - this.origin[1] - 0.75 * px, 1.5 * px, 1.5 * px);
      });
    }
    if (this.highlighted !== null) this.#drawHighlight(dpr, px);
  }

  #lineWidthPx(lineweight) {
    if (!this.lineweights) return 1;
    return Math.max(1, Math.round((lineweight ?? 25) / 25)); // 0.25 mm 以下 = 1 px、0.50 mm = 2 px …
  }

  /** 破線（図面の単位。正 = 線・負 = すき間・0 = 点）→ Canvas の破線 [線, すき間, …]。画面で細かすぎれば実線 */
  #dash(dashes, scale) {
    if (!dashes?.length) return [];
    const period = dashes.reduce((s, v) => s + Math.abs(v), 0);
    if (period * scale < MIN_DASH_PX) return [];
    // 同じ種類（線・すき間）が続けば足し、すき間で始まるなら先頭のすき間を末尾へ回す（位相が少しずれるだけ）
    const runs = [];
    for (const d of dashes) {
      const on = d >= 0, len = d === 0 ? 0 : Math.abs(d);
      if (runs.length && runs.at(-1).on === on) runs.at(-1).len += len;
      else runs.push({ on, len });
    }
    if (!runs[0].on) runs.push(runs.shift());
    if (runs.length > 1 && runs.at(-1).on === runs[0].on) runs[0].len += runs.pop().len;
    const out = runs.map((r) => r.len);
    if (out.length % 2 === 1) out.push(0);
    return out; // 長さ 0 の線は、丸い線端で点として描かれる
  }

  /** 文字（画面の px で描く。図面の単位のままの小さなフォントの大きさは、ブラウザによって崩れるため） */
  #text(t, color, dpr) {
    const { ctx } = this;
    const { scale, x, y } = this.view;
    const h = t.height * scale; // 大文字の高さ（px）
    if (h < MIN_TEXT_PX || !t.lines.length) return;
    const sx = (t.x - this.origin[0]) * scale + x, sy = -(t.y - this.origin[1]) * scale + y;
    ctx.setTransform(dpr, 0, 0, dpr, dpr * sx, dpr * sy);
    ctx.rotate(-t.rotation);
    if (t.mirror) ctx.scale(-1, 1);
    if (t.flip) ctx.scale(1, -1);
    if (t.oblique) ctx.transform(1, 0, -Math.tan(t.oblique), 1, 0, 0);
    ctx.font = `${h / CAP_HEIGHT}px ${this.font}`;
    ctx.fillStyle = color;
    ctx.textAlign = t.align === "center" ? "center" : t.align === "right" ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    let factor = t.widthFactor || 1, lines = t.lines;
    if (t.fit && lines[0]) {
      // 2 点の間に収める: 測った幅を長さに合わせる（aligned は高さも同じ比で）
      const measured = ctx.measureText(lines[0]).width;
      if (measured > 0) factor = (t.fit.length * scale) / measured;
      if (t.fit.mode === "aligned") {
        ctx.scale(factor, factor);
        factor = 1;
      }
    }
    if (t.mtext && t.width > 0) lines = wrap(ctx, lines, (t.width * scale) / factor);
    ctx.scale(factor, 1);
    // 行の基線（上向きが正）。1 行目の基線 first から、行の間隔ずつ下へ
    const n = lines.length;
    const lineHeight = h * (t.mtext ? (5 / 3) * (t.lineSpacing || 1) : 1.6);
    const block = h + lineHeight * (n - 1);
    const first = t.valign === "top" ? -h : t.valign === "middle" ? block / 2 - h : t.valign === "bottom" ? lineHeight * (n - 1) + (t.mtext ? 0 : DESCENT * h) : 0;
    lines.forEach((line, i) => ctx.fillText(line, 0, -(first - lineHeight * i)));
  }

  #drawHighlight(dpr, px) {
    const { ctx } = this;
    const accent = this.#token("--accent") || "#1a62c4";
    const entries = this.highlighted.flatMap((item) => this.byItem.get(item) ?? []);
    ctx.strokeStyle = ctx.fillStyle = accent;
    for (const e of entries) {
      const { scale, x, y } = this.view;
      ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * x, dpr * y);
      if (e.kind === "stroke") {
        ctx.lineWidth = Math.max(e.width ?? 0, 3 * px);
        ctx.stroke(e.path);
      } else if (e.kind === "fill") {
        ctx.globalAlpha = 0.45;
        ctx.fill(e.path, "evenodd");
        ctx.globalAlpha = 1;
      } else if (e.kind === "text") {
        const r = textOutline(e.text);
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        for (let i = 0; i < r.length; i += 2) ctx.lineTo(r[i] - this.origin[0], r[i + 1] - this.origin[1]);
        ctx.closePath();
        ctx.stroke();
        this.#text(e.text, accent, dpr);
      } else if (e.kind === "point") {
        ctx.fillRect(e.point.x - this.origin[0] - 3 * px, e.point.y - this.origin[1] - 3 * px, 6 * px, 6 * px);
      }
    }
  }

  // ---- 操作 -------------------------------------------------------------------------------------------------------
  #watchSize() {
    let first = true;
    new ResizeObserver(() => {
      const { width, height } = this.#size();
      if (!width || !height) return;
      if (first && this.scene) this.fit();
      first = false;
      this.requestRender();
    }).observe(this.stage);
  }

  #watchTheme() {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.requestRender());
    new MutationObserver(() => this.requestRender()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  #watchPointer() {
    const canvas = this.canvas;
    let drag = null, pending = false, last = null;
    const local = (event) => {
      const r = canvas.getBoundingClientRect();
      return [event.clientX - r.left, event.clientY - r.top];
    };
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      this.zoom(ZOOM_STEP ** -delta, local(event));
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      drag = { at: local(event), view: { ...this.view } };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-panning");
    });
    canvas.addEventListener("pointerup", (event) => {
      drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.classList.remove("is-panning");
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("dblclick", () => this.fit());
    canvas.addEventListener("pointermove", (event) => {
      const p = local(event);
      if (drag) {
        this.view.x = drag.view.x + p[0] - drag.at[0];
        this.view.y = drag.view.y + p[1] - drag.at[1];
        this.requestRender();
        return;
      }
      last = p;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!this.index || !last) return;
        const [wx, wy] = this.toWorld(...last);
        this.onHover(this.index.find(wx, wy, HIT_PX / this.view.scale));
      });
    });
    canvas.addEventListener("pointerleave", () => {
      last = null;
      this.onHover(null);
    });
  }
}

/** MTEXT の折り返し（幅 width を越える行を、語か文字の切れ目で折る） */
function wrap(ctx, lines, width) {
  const out = [];
  for (const line of lines) {
    if (ctx.measureText(line).width <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const token of line.match(/[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+|\s+/g) ?? []) {
      const next = current + token;
      if (current && ctx.measureText(next).width > width) {
        out.push(current.trimEnd());
        current = token.trimStart();
      } else current = next;
    }
    out.push(current);
  }
  return out;
}
