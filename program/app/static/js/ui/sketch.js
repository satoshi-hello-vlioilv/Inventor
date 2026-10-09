// 変換データの断面（sketch.loops: 直線・円弧・円）を SVG の文字列にする（DOM に依存しない。寸法を直す欄の小さな断面図）。
//   sketchMarkup(loops, { width, height, focus, label }) → SVG の文字列
//     focus … 光らせる所 { loop, seg? }（seg を省けばループ全体）。label … 光らせた所に添える札の文字（「直径 250」）
//   図の座標は断面の座標（x 右・y 上）。外形を枠の内に収め、札は枠からはみ出さない所に置く。

const PAD = 14; // 枠と形の間（px）
const LABEL_H = 22, LABEL_PAD = 8; // 札の高さ・左右の余白（px）
/** 札の文字の幅の目安（12px の字: 全角 12・半角 7.2） */
const textWidth = (text) => [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 12 : 7.2), 0);

/** 区間の外形の箱に入れる点（端点と、円弧が通る軸の向きの点） */
function bounds(s) {
  if (s.type === "circle") return [[s.center[0] - s.radius, s.center[1] - s.radius], [s.center[0] + s.radius, s.center[1] + s.radius]];
  if (s.type === "line") return [s.a, s.b];
  // 円弧: 端点と、円弧が通る軸の向き（0°・90°・180°・270°）の点
  const r = Math.hypot(s.a[0] - s.center[0], s.a[1] - s.center[1]);
  const pts = [s.a, s.b];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    if (onArc(s, t)) pts.push([s.center[0] + r * Math.cos(t), s.center[1] + r * Math.sin(t)]);
  }
  return pts;
}

const angle = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
/** 円弧の開き（a から b へ、ccw の向きに測る） */
const sweepOf = (s) => {
  const d = norm(angle(s.center, s.b) - angle(s.center, s.a));
  return s.ccw ? d || 2 * Math.PI : (2 * Math.PI - d) % (2 * Math.PI) || 2 * Math.PI;
};
/** 角 t が円弧の上か */
function onArc(s, t) {
  const from = angle(s.center, s.a);
  const d = s.ccw ? norm(t - from) : norm(from - t);
  return d <= sweepOf(s);
}

/** 区間の中ほどの点（札を置く所） */
function middle(s) {
  if (s.type === "line") return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  if (s.type === "circle") return [s.center[0] + s.radius * Math.SQRT1_2, s.center[1] + s.radius * Math.SQRT1_2]; // 右上 45°
  const r = Math.hypot(s.a[0] - s.center[0], s.a[1] - s.center[1]);
  const t = angle(s.center, s.a) + ((s.ccw ? 1 : -1) * sweepOf(s)) / 2;
  return [s.center[0] + r * Math.cos(t), s.center[1] + r * Math.sin(t)];
}

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (v) => Math.round(v * 100) / 100;

export function sketchMarkup(loops, { width = 400, height = 200, focus = null, label = "" } = {}) {
  const pts = loops.flat().flatMap(bounds);
  if (!pts.length) return "";
  const lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
  const hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const k = Math.min((width - 2 * PAD) / Math.max(hi[0] - lo[0], 1e-9), (height - 2 * PAD) / Math.max(hi[1] - lo[1], 1e-9));
  const ox = (width - (hi[0] - lo[0]) * k) / 2, oy = (height - (hi[1] - lo[1]) * k) / 2;
  const X = (x) => num(ox + (x - lo[0]) * k), Y = (y) => num(height - (oy + (y - lo[1]) * k));
  const path = (s) => {
    if (s.type === "line") return `M${X(s.a[0])} ${Y(s.a[1])}L${X(s.b[0])} ${Y(s.b[1])}`;
    if (s.type === "circle") {
      const r = num(s.radius * k), cx = X(s.center[0]), cy = Y(s.center[1]);
      return `M${num(cx - r)} ${cy}a${r} ${r} 0 1 0 ${num(2 * r)} 0a${r} ${r} 0 1 0 ${num(-2 * r)} 0`;
    }
    const r = num(Math.hypot(s.a[0] - s.center[0], s.a[1] - s.center[1]) * k);
    // 図は y が下向き。断面の反時計回りは、図でも見た目は反時計回り（SVG の sweep-flag 0）
    return `M${X(s.a[0])} ${Y(s.a[1])}A${r} ${r} 0 ${sweepOf(s) > Math.PI ? 1 : 0} ${s.ccw ? 0 : 1} ${X(s.b[0])} ${Y(s.b[1])}`;
  };
  const lit = (li, si) => focus && focus.loop === li && (focus.seg === undefined || focus.seg === si);
  const lines = loops.map((loop, li) => loop.map((s, si) => `<path class="sk-line${lit(li, si) ? " is-focus" : ""}" d="${path(s)}"/>`).join("")).join("");
  let tag = "";
  const target = focus && loops[focus.loop]?.[focus.seg ?? 0];
  if (target && label) {
    const [px, py] = middle(target);
    const w = Math.round(textWidth(label) + 2 * LABEL_PAD);
    const x = num(Math.min(Math.max(X(px) + 6, 2), width - w - 2)), y = num(Math.min(Math.max(Y(py) - LABEL_H - 4, 2), height - LABEL_H - 2));
    tag = `<g class="sk-tag"><rect x="${x}" y="${y}" width="${w}" height="${LABEL_H}" rx="6"/><text x="${num(x + LABEL_PAD)}" y="${num(y + LABEL_H / 2 + 4)}">${esc(label)}</text></g>`;
  }
  return `<svg class="sketch" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="断面図${label ? `（${esc(label)}）` : ""}">${lines}${tag}</svg>`;
}
