// 2D の図面の表示（Canvas 2D）。scene.js が作った描くものを、拡大・移動して描き、指した図形を知らせて強調する。
// 線は「色・太さ・破線」ごとに 1 つの Path2D にまとめ、拡大・移動では変換だけを変えて描き直す（図形が多くても速い）。
// 座標は外形の中心を原点にずらして持つ（大きな座標でも、Canvas の単精度で崩れない）。色は CSS のトークンを Canvas の位置で読む
// （図面のときだけの上書き・テーマの切り替えに追従する）:
//   --sheet          … 図面の地の色
//   --sheet-ink      … 色番号 7（前景色）。地が暗ければ白、明るければ黒
//   --sheet-contrast … 地に対するコントラスト比の下限（例 3）。届かない図面の色を前景の側へ寄せる（0 か無しなら図面の色のまま）
//   --accent         … 指した図形・選んだ図形の強調、測った線と札（--accent-ink は札の文字）
//   --caution-ink    … 吸い付く点の印
// 図の上の印（setOverlay）: 測った線・点・吸い付く点の印・札を、図面の座標で渡し、画面の大きさ（px）で描く（拡大しても太さが変わらない）。

import { readable } from "./colors.js";
import { HitIndex, textOutline } from "./hit.js";
import { SnapIndex } from "./snap.js";

const ZOOM_STEP = 1.0015; // ホイール 1 単位あたりの拡大率
const MIN_DASH_PX = 3; // 破線の 1 周期が画面でこれより短ければ、実線で描く
const MIN_TEXT_PX = 1.5; // 文字の高さが画面でこれより小さければ描かない
const HIT_PX = 6; // 指した点からこの距離（画面の px）までの図形を拾う
const SNAP_PX = 12; // 吸い付く点を探す距離（画面の px）
const CLICK_PX = 4; // 押してから離すまでにこれ以上動いたら、押したのではなくドラッグ（移動）
const FIT_MARGIN = 0.06;
const CAP_HEIGHT = 0.72; // フォントの大きさ（em）に対する大文字の高さ（図面の文字の高さ = 大文字の高さ）
const DESCENT = 0.25; // TEXT の「下」揃え: 基線から下の部分（大文字の高さに対する比）
const PAPER = "#ffffff"; // PDF の紙（テーマに依らず白。PDF の色は白い紙の上の色）
const PAPER_EDGE = "#b8bec6";
const BOX_EDGE = "#9aa3ad"; // 解けない画像の枠
const CAPS = ["butt", "round", "square"]; // PDF の線端
// 書体の手がかり（PDF の文字）→ 画面の書体。ゴシック体は図面の書体（--font-drawing）を使う
const SERIF = '"Yu Mincho", "YuMincho", "MS Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif';
const MONO = '"MS Gothic", "Osaka-Mono", "Noto Sans Mono CJK JP", monospace';
const PREPARED = new WeakMap(); // 画像 → 描ける形（Canvas・ImageBitmap）

export class DrawingViewer {
  /**
   * @param {{ stage: HTMLElement, canvas: HTMLCanvasElement }} elements
   * @param {{ onHover?: (item: number | null, at?: { px, py, x, y }) => void, onClick?: (hit: { px, py, x, y, item }) => void,
   *   insets?: () => { top, right, bottom, left } }} [callbacks]
   *   onHover … 指した図形と、指した所（画面の px・図面の座標）。onClick … ドラッグせずに押して離した所と、そこの図形
   *   insets … 図面の上に重ねた帯（ツールバー・読み出し）が覆う幅（px）。全体表示はその内側に収める
   */
  constructor({ stage, canvas }, { onHover, onClick, insets } = {}) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHover = onHover ?? (() => {});
    this.onClick = onClick ?? (() => {});
    this.selected = null; // 選んだ図形（強調が残る）
    this.overlay = null; // 図の上の印（setOverlay）
    this.insets = insets ?? (() => ({ top: 0, right: 0, bottom: 0, left: 0 }));
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
    this.snapper = new SnapIndex(scene, this.index);
    this.highlighted = null;
    this.selected = null;
    this.overlay = null;
    this.highlightKey = "";
    if (fit) this.fit();
    else this.requestRender();
  }

  clear() {
    this.scene = null;
    this.ops = [];
    this.requestRender();
  }

  /** 全体が収まるように */
  fit() {
    const ext = this.scene?.extents;
    const { width, height } = this.#size();
    if (!ext || !width || !height) return this.requestRender();
    const w = Math.max(ext.max[0] - ext.min[0], 1e-9), h = Math.max(ext.max[1] - ext.min[1], 1e-9);
    // 重ねた帯の内側（帯が場所の半分を越えるなら、場所の半分は使う）
    const { top = 0, right = 0, bottom = 0, left = 0 } = this.insets();
    const aw = Math.max(width - left - right, width / 2), ah = Math.max(height - top - bottom, height / 2);
    const x0 = Math.min(left, width - aw), y0 = Math.min(top, height - ah);
    const scale = Math.min(aw / w, ah / h) * (1 - 2 * FIT_MARGIN);
    this.view = { scale, x: x0 + aw / 2, y: y0 + ah / 2 };
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

  /** 選んだ図形（items の番号の並び。null か空で外す）。カーソルの強調と別に残る */
  select(items) {
    this.selected = items?.length ? items : null;
    this.requestRender();
  }

  /**
   * 図の上の印（null で消す）。座標は図面の座標
   * @param {{ lines?: { a, b, dashed? }[], points?: [x, y][], snap?: { x, y, kind, label }, tags?: { x, y, text }[] } | null} overlay
   */
  setOverlay(overlay) {
    this.overlay = overlay;
    this.requestRender();
  }

  /** 画面の点の近くの吸い付く点（viewer2d/snap.js）。無ければ null */
  snapAt(px, py) {
    if (!this.snapper) return null;
    return this.snapper.find(...this.toWorld(px, py), SNAP_PX / this.view.scale);
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
  // 描く並び（this.ops）を作る。順序に意味が無い図面（DWG・DXF）は「画像 → 塗り → 幅のある線 → 線 → 文字 → 点」の種類の順にし、
  // 同じ線（色・太さ・破線・線端・切り取り）を 1 つの Path2D にまとめる。順序に意味がある図面（PDF）は足した順（z）にし、
  // 続く同じ線だけをまとめる（後の図形が前の図形を隠す順を守る）。
  #build() {
    const [ox, oy] = this.origin;
    const clipKey = (c) => (c ? `${c.min.join(",")},${c.max.join(",")}` : "");
    const pathOf = (points) => {
      const p = new Path2D();
      p.moveTo(points[0] - ox, points[1] - oy);
      for (let i = 2; i < points.length; i += 2) p.lineTo(points[i] - ox, points[i + 1] - oy);
      return p;
    };
    this.byItem = new Map(); // 図形の番号 → その線・塗り（強調に使う）
    const remember = (item, entry) => {
      if (!this.byItem.has(item)) this.byItem.set(item, []);
      this.byItem.get(item).push(entry);
    };
    const ops = [];
    for (const s of this.scene.strokes) {
      for (const line of s.lines) {
        const path = pathOf(line.points);
        remember(line.item, { kind: "stroke", path, clip: line.clip, width: line.width });
        const wide = line.width > 0;
        const key = wide
          ? `w|${s.color}|${line.width}|${line.weight ? 1 : 0}|${line.cap ?? 1}|${line.alpha ?? 1}|${s.dashes?.join(",") ?? ""}|${clipKey(line.clip)}`
          : `s|${s.color}|${s.lineweight}|${s.dashes?.join(",") ?? ""}|${clipKey(line.clip)}`;
        ops.push({ z: line.z ?? 0, kind: wide ? "wide" : "stroke", key, color: s.color, lineweight: s.lineweight, dashes: s.dashes, clip: line.clip,
          path, width: line.width, weight: Boolean(line.weight), cap: line.cap ?? 1, alpha: line.alpha ?? 1 });
      }
    }
    for (const f of this.scene.fills) {
      const path = new Path2D();
      for (const r of f.rings) path.addPath(pathOf(r)), path.closePath?.();
      remember(f.item, { kind: "fill", path, clip: f.clip });
      ops.push({ z: f.z ?? 0, kind: "fill", color: f.color, alpha: f.alpha ?? 1, rule: f.rule ?? "evenodd", path, clip: f.clip });
    }
    for (const im of this.scene.images ?? []) {
      const [a, b, c, d, e, f] = im.matrix;
      const quad = new Path2D();
      quad.moveTo(e - ox, f - oy);
      quad.lineTo(a + e - ox, b + f - oy);
      quad.lineTo(a + c + e - ox, b + d + f - oy);
      quad.lineTo(c + e - ox, d + f - oy);
      quad.closePath();
      remember(im.item, { kind: "fill", path: quad, clip: im.clip });
      ops.push({ z: im.z ?? 0, kind: "image", image: im, quad, clip: im.clip });
      this.#prepareImage(im.image);
    }
    for (const t of this.scene.texts) {
      remember(t.item, { kind: "text", text: t });
      ops.push({ z: t.z ?? 0, kind: "text", text: t, clip: t.clip });
    }
    for (const p of this.scene.points) {
      remember(p.item, { kind: "point", point: p });
      ops.push({ z: p.z ?? 0, kind: "point", point: p, clip: p.clip });
    }
    const RANK = { image: 0, fill: 1, wide: 2, stroke: 3, text: 4, point: 5 };
    ops.sort(this.scene.ordered ? (a, b) => a.z - b.z : (a, b) => RANK[a.kind] - RANK[b.kind] || a.z - b.z);
    // 線をまとめる: 順序に意味があれば続くものだけ、無ければ同じ鍵のもの全て
    const out = [], byKey = new Map();
    for (const op of ops) {
      if (op.key) {
        const last = out.at(-1);
        const into = this.scene.ordered ? (last?.key === op.key ? last : null) : byKey.get(op.key);
        if (into) {
          into.path.addPath(op.path);
          continue;
        }
        const batch = { ...op, path: new Path2D() };
        batch.path.addPath(op.path);
        byKey.set(op.key, batch);
        out.push(batch);
      } else out.push(op);
    }
    this.ops = out;
  }

  /** 画像を描ける形に（標本は Canvas に、JPEG は画像として解く。解けたら描き直す） */
  #prepareImage(image) {
    if (PREPARED.has(image) || image.kind === "box") return;
    PREPARED.set(image, null);
    const canvas = document.createElement("canvas");
    if (image.kind === "rgba") {
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
      PREPARED.set(image, canvas);
      return;
    }
    if (image.kind !== "jpeg" || typeof createImageBitmap !== "function") return;
    createImageBitmap(new Blob([image.bytes], { type: "image/jpeg" })).then((bitmap) => {
      if (!image.alpha) {
        PREPARED.set(image, bitmap);
        return this.requestRender();
      }
      // 透明（/SMask）: 濃さの画像を不透明度にして重ねる
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const c = canvas.getContext("2d");
      c.drawImage(bitmap, 0, 0);
      const pixels = c.getImageData(0, 0, bitmap.width, bitmap.height);
      const { width: aw, height: ah, data: alpha } = image.alpha;
      for (let y = 0; y < bitmap.height; y++) {
        const ay = Math.min(ah - 1, Math.floor((y * ah) / bitmap.height));
        for (let x = 0; x < bitmap.width; x++) pixels.data[(y * bitmap.width + x) * 4 + 3] = alpha[ay * aw + Math.min(aw - 1, Math.floor((x * aw) / bitmap.width))];
      }
      c.putImageData(pixels, 0, 0);
      PREPARED.set(image, canvas);
      this.requestRender();
    }).catch(() => {});
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
    const exact = this.scene.exact; // PDF: 色はそのまま（紙は白）
    const colorOf = (c) => {
      if (exact) return c ?? "#000000";
      if (!c) return ink;
      if (!this.palette.has(c)) this.palette.set(c, readable(c, sheet, ink, minimum));
      return this.palette.get(c);
    };
    const { scale, x, y } = this.view;
    const [ox, oy] = this.origin;
    const world = () => ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * x, dpr * y);
    const px = 1 / scale; // 図面の単位での 1 px
    const withClip = (clip, draw) => {
      if (!clip) return draw();
      ctx.save();
      world(); // 枠は図面の座標で作る（文字を描いた後は、文字の座標系になっているため）
      ctx.beginPath();
      ctx.rect(clip.min[0] - ox, clip.min[1] - oy, clip.max[0] - clip.min[0], clip.max[1] - clip.min[1]);
      ctx.clip();
      draw();
      ctx.restore();
    };
    world();
    // 紙（PDF のページ）: 白い紙と細い縁
    const paper = this.scene.paper;
    if (paper) {
      ctx.fillStyle = PAPER;
      ctx.fillRect(paper.min[0] - ox, paper.min[1] - oy, paper.max[0] - paper.min[0], paper.max[1] - paper.min[1]);
      ctx.strokeStyle = PAPER_EDGE;
      ctx.lineWidth = px;
      ctx.strokeRect(paper.min[0] - ox, paper.min[1] - oy, paper.max[0] - paper.min[0], paper.max[1] - paper.min[1]);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const op of this.ops) {
      withClip(op.clip, () => {
        switch (op.kind) {
          case "fill":
            ctx.globalAlpha = op.alpha;
            ctx.fillStyle = colorOf(op.color);
            ctx.fill(op.path, op.rule);
            ctx.globalAlpha = 1;
            return;
          case "wide":
            ctx.globalAlpha = op.alpha;
            ctx.strokeStyle = colorOf(op.color);
            // PDF の線（weight）は太さの表示を切ると細線。ポリラインの幅（DWG）は形の一部なので、いつも幅で描く
            ctx.lineWidth = op.weight && !this.lineweights ? px : Math.max(op.width, px);
            ctx.setLineDash(op.dashes ? this.#dash(op.dashes, scale) : []);
            if (op.weight) ctx.lineCap = CAPS[op.cap] ?? "butt";
            ctx.stroke(op.path);
            ctx.lineCap = "round";
            ctx.globalAlpha = 1;
            return;
          case "stroke":
            ctx.strokeStyle = colorOf(op.color);
            ctx.lineWidth = this.#lineWidthPx(op.lineweight) * px;
            ctx.setLineDash(this.#dash(op.dashes, scale));
            ctx.stroke(op.path);
            return;
          case "image": return this.#image(op, px);
          case "text":
            ctx.setLineDash([]);
            this.#text(op.text, colorOf(op.text.color), dpr);
            world();
            return;
          case "point":
            // 点: AutoCAD の既定（PDMODE 0）と同じく、1 px 四方の点
            ctx.fillStyle = colorOf(op.point.color);
            ctx.fillRect(op.point.x - ox - 0.75 * px, op.point.y - oy - 0.75 * px, 1.5 * px, 1.5 * px);
            return;
        }
      });
    }
    ctx.setLineDash([]);
    if (this.selected) this.#drawHighlight(dpr, px, this.selected);
    if (this.highlighted !== null) this.#drawHighlight(dpr, px, this.highlighted);
    if (this.overlay) this.#drawOverlay(dpr);
  }

  /** 画像: 単位の正方形 → 図面 の行列で、画素の行 0（上）が正方形の上辺に来るように描く */
  #image(op, px) {
    const { ctx } = this;
    const prepared = PREPARED.get(op.image.image);
    if (!prepared) {
      // まだ解けていない・解けない画像は、枠と対角線
      ctx.strokeStyle = BOX_EDGE;
      ctx.lineWidth = px;
      ctx.setLineDash([]);
      ctx.stroke(op.quad);
      return;
    }
    const [a, b, c, d, e, f] = op.image.matrix;
    const w = prepared.width, h = prepared.height;
    ctx.save();
    ctx.transform(a / w, b / w, -c / h, -d / h, c + e - this.origin[0], d + f - this.origin[1]);
    // 引き伸ばすときは、補間の指定（/Interpolate）が無ければ画素のまま（PDF の読み手と同じ）。縮めるときはぼかして荒れを防ぐ
    const magnified = Math.hypot(a, b) * this.view.scale > w;
    ctx.imageSmoothingEnabled = !magnified || Boolean(op.image.image.interpolate);
    ctx.drawImage(prepared, 0, 0);
    ctx.restore();
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
    const f = t.font;
    const family = f?.family === "serif" ? SERIF : f?.family === "monospace" ? MONO : this.font;
    ctx.font = `${f?.italic ? "italic " : ""}${f?.weight === 700 ? "bold " : ""}${h / CAP_HEIGHT}px ${family}`;
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

  #drawHighlight(dpr, px, items) {
    const { ctx } = this;
    const accent = this.#token("--accent") || "#1a62c4";
    const entries = items.flatMap((item) => this.byItem.get(item) ?? []);
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

  /** 図面の座標 → 画面の px */
  toScreen(x, y) {
    const v = this.view;
    return [(x - this.origin[0]) * v.scale + v.x, -(y - this.origin[1]) * v.scale + v.y];
  }

  /** 図の上の印（画面の px で描く） */
  #drawOverlay(dpr) {
    const { ctx, overlay: o } = this;
    const accent = this.#token("--accent") || "#1a62c4";
    const ink = this.#token("--accent-ink") || "#fff";
    const surface = this.#token("--surface") || "#fff";
    const caution = this.#token("--caution-ink") || "#8a5a12";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = ctx.lineCap = "round";
    for (const { a, b, dashed } of o.lines ?? []) {
      const [x0, y0] = this.toScreen(...a), [x1, y1] = this.toScreen(...b);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const p of o.points ?? []) {
      const [x, y] = this.toScreen(...p);
      ctx.fillStyle = surface;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    if (o.snap) {
      const [x, y] = this.toScreen(o.snap.x, o.snap.y);
      ctx.strokeStyle = ctx.fillStyle = caution;
      ctx.lineWidth = 2;
      snapMark(ctx, o.snap.kind, x, y, 7);
      if (o.snap.label) {
        ctx.font = `600 12px ${this.#token("--font-ui") || "sans-serif"}`;
        ctx.textBaseline = "bottom";
        ctx.textAlign = "left";
        ctx.fillText(o.snap.label, x + 10, y - 8);
      }
    }
    ctx.font = `600 13px ${this.#token("--font-num") || "monospace"}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const t of o.tags ?? []) {
      const [x, y] = this.toScreen(t.x, t.y);
      const w = ctx.measureText(t.text).width + 16;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x + 10, y - 11, w, 22, 6);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText(t.text, x + 18, y);
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
      drag = { at: local(event), view: { ...this.view }, button: event.button, moved: false };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-panning");
    });
    canvas.addEventListener("pointerup", (event) => {
      // ドラッグせずに押して離したら「押した」（左ボタンだけ）
      if (drag && !drag.moved && drag.button === 0 && this.index) {
        const [px, py] = local(event), [x, y] = this.toWorld(px, py);
        this.onClick({ px, py, x, y, item: this.index.find(x, y, HIT_PX / this.view.scale) });
      }
      drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.classList.remove("is-panning");
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("dblclick", () => this.fit());
    canvas.addEventListener("pointermove", (event) => {
      const p = local(event);
      if (drag) {
        if (!drag.moved && Math.hypot(p[0] - drag.at[0], p[1] - drag.at[1]) < CLICK_PX) return;
        drag.moved = true;
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
        this.onHover(this.index.find(wx, wy, HIT_PX / this.view.scale), { px: last[0], py: last[1], x: wx, y: wy });
      });
    });
    canvas.addEventListener("pointerleave", () => {
      last = null;
      this.onHover(null);
    });
  }
}

/** 吸い付く点の印（端点 □・中点 △・中心 ○・四分点 ◇・交点 ×・点 ◎・線上 ⧖） */
function snapMark(ctx, kind, x, y, r) {
  ctx.beginPath();
  if (kind === "end") ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (kind === "mid") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.8);
    ctx.lineTo(x - r, y + r * 0.8);
    ctx.closePath();
  } else if (kind === "quad") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else if (kind === "int") {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
  } else if (kind === "near") {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.lineTo(x + r, y + r);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (kind === "node") {
      ctx.moveTo(x + r / 2, y);
      ctx.arc(x, y, r / 2, 0, 2 * Math.PI);
    }
  }
  ctx.stroke();
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
