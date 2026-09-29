// 三角形分割の検査（評価で共用）: 面ごとの分割をつないだ形が閉じているか、表裏がそろっているか、曲面の上にあるか、体積。
import * as THREE from "three";
import { faceGeometry, STEPS } from "../../app/static/js/viewer/tessellate.js";

const WELD = 1e4; // 頂点の同一視（0.1 µm 単位に丸める）
// 1 面の三角形の数の上限。サンプルで最も多い面（ボルトの首下のトーラス）は約 2,000。
// 細分が自然に終わらず安全弁（REFINE_BUDGET）で止まると数十万になるので、その検出に使う
export const FACE_TRIANGLE_LIMIT = 10_000;

/** 面ごとの三角形分割を 1 つの三角形の集合にまとめる（matrix があれば組立の座標にする）。largest … 1 面の三角形の数の最大 */
export function bodyMesh(bodies, matrix = null) {
  const ids = new Map();
  const key = (v) => `${Math.round(v.x * WELD)},${Math.round(v.y * WELD)},${Math.round(v.z * WELD)}`;
  const vertexId = (v) => {
    const k = key(v);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const m = matrix ? new THREE.Matrix4().set(...matrix) : null;
  const triangles = [], missing = [];
  let largest = 0;
  for (const body of bodies) {
    for (const face of body.faces) {
      const geometry = faceGeometry(face);
      if (!geometry) {
        missing.push(`${face.id}:${face.type}`);
        continue;
      }
      const pos = geometry.getAttribute("position"), idx = geometry.index.array;
      largest = Math.max(largest, idx.length / 3);
      const corner = (k) => {
        const v = new THREE.Vector3().fromBufferAttribute(pos, idx[k]);
        return m ? v.applyMatrix4(m) : v;
      };
      for (let k = 0; k < idx.length; k += 3) {
        const p = [corner(k), corner(k + 1), corner(k + 2)];
        triangles.push({ face, p, v: p.map(vertexId) });
      }
    }
  }
  return { triangles, missing, largest };
}

/** 辺の使われ方。閉じた向き付け可能な曲面なら、全ての辺が逆向きの 2 枚の三角形に 1 回ずつ使われる。 */
export function edgeDefects(triangles) {
  const directed = new Map();
  for (const { v } of triangles) {
    if (new Set(v).size < 3) continue; // 退化した三角形（円錐の頂点など）は辺を持たない
    for (let i = 0; i < 3; i++) {
      const k = `${v[i]}>${v[(i + 1) % 3]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let open = 0, duplicated = 0;
  for (const [k, n] of directed) {
    const [a, b] = k.split(">");
    if (n > 1) duplicated += 1;
    if (!directed.has(`${b}>${a}`)) open += 1;
  }
  return { open, duplicated };
}

export const signedVolume = (triangles) => triangles.reduce((s, { p: [a, b, c] }) => s + a.dot(new THREE.Vector3().crossVectors(b, c)) / 6, 0);
export const triangleArea = ([a, b, c]) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;

/** 刻み step の弦の垂れ（半径 1 あたり） */
const sag = (step) => 1 - Math.cos(step / 2);
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
/** 設計上の弦の誤差に対する許容の倍率（三角形の重心は弦の中点より曲面から離れうる） */
export const DEVIATION_LIMIT = 2.5;

/**
 * 面の境界の折れ線（隣の面と共有する稜線の点列）の 1 区間が、軸のまわり（θ）と、トーラスは管のまわり（φ）に
 * どれだけの角度を占めるか（最大値）。分割は境界の点を変えないので、境界の弦が刻みより粗い面は、その弦の垂れまでは曲面から離れる。
 */
function boundarySpans(face) {
  const origin = new THREE.Vector3(...face.origin), axis = new THREE.Vector3(...face.axis).normalize();
  const ref = new THREE.Vector3(...face.ref).normalize(), side = new THREE.Vector3().crossVectors(axis, ref);
  const polar = (q) => {
    const d = new THREE.Vector3(...q).sub(origin);
    const x = d.dot(ref), y = d.dot(side), rho = Math.hypot(x, y);
    return { t: Math.atan2(y, x), rho, phi: Math.atan2(d.dot(axis), rho - face.radius) };
  };
  let theta = 0, phi = 0;
  for (const loop of face.loops) {
    const pts = loop.map(polar);
    pts.slice(1).forEach((b, i) => {
      const a = pts[i];
      if (Math.min(a.rho, b.rho) > 1e-6) theta = Math.max(theta, Math.abs(wrap(b.t - a.t))); // 円錐の先端を通る区間は母線（直線）
      phi = Math.max(phi, Math.abs(wrap(b.phi - a.phi)));
    });
  }
  return { theta, phi };
}

/**
 * 回転面（円筒・円錐・トーラス）の三角形の重心が曲面からどれだけ離れているかを、設計上の弦の誤差との比で返す（最大値）。
 * 設計上の弦の誤差 … 軸のまわりを STEPS.arc 刻み、トーラスは管のまわりも STEPS.tube 刻みの弦で近似したときの垂れ
 * （境界の折れ線がそれより粗い面は、その粗さ（boundarySpans）の弦の垂れ）。
 * 組立の座標にしていない三角形に使う。円筒・円錐で境界が細かければ、比 2.5 が半径の 0.3% に当たる
 */
export function surfaceDeviation(triangles) {
  const spans = new Map();
  let worst = 0;
  for (const { face, p } of triangles) {
    if (!["cylinder", "cone", "torus"].includes(face.type)) continue;
    if (!spans.has(face)) spans.set(face, boundarySpans(face));
    const span = spans.get(face);
    const [theta, phi] = [sag(Math.max(STEPS.arc, span.theta)), sag(Math.max(STEPS.tube, span.phi))];
    const c = p[0].clone().add(p[1]).add(p[2]).divideScalar(3).sub(new THREE.Vector3(...face.origin));
    const axis = new THREE.Vector3(...face.axis).normalize();
    const h = c.dot(axis);
    const rho = c.clone().addScaledVector(axis, -h).length();
    let off, allowed;
    if (face.type === "torus") {
      off = Math.abs(Math.hypot(rho - face.radius, h) - face.minor);
      allowed = (face.radius + face.minor) * theta + face.minor * phi;
    } else {
      const expected = face.radius + (face.slope ?? 0) * h;
      off = Math.abs(rho - expected);
      allowed = Math.max(expected, face.radius, 1e-9) * theta;
    }
    worst = Math.max(worst, off / allowed);
  }
  return worst;
}
