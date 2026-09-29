// シーン JSON の面を three.js の BufferGeometry に三角形分割する。
// 面の種類ごとに mesher を用意し、未対応の種類は null を返す（ビューアは稜線だけを描く）。

import * as THREE from "three";

const ARC_STEP = Math.PI / 48;
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);

/** 末尾が先頭と同じ点なら取り除き、開いた点列にする。 */
function openLoop(loop) {
  const points = loop.map(v3);
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < 1e-9) points.pop();
  return points;
}

function plane(face) {
  const n = v3(face.normal).normalize();
  const helper = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const loops = face.loops.map(openLoop).filter((l) => l.length >= 3);
  if (!loops.length) return null;
  const flat = loops.map((l) => l.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
  // 面積が最大のループを外周、それ以外を穴として扱う
  const area = (l) => Math.abs(THREE.ShapeUtils.area(l));
  const outer = flat.reduce((best, l, i) => (area(l) > area(flat[best]) ? i : best), 0);
  const order = [outer, ...flat.keys()].filter((i, k) => k === 0 || i !== outer);
  const triangles = THREE.ShapeUtils.triangulateShape(flat[outer], order.slice(1).map((i) => flat[i]));
  const points = order.flatMap((i) => loops[i]);
  return { points, normals: points.map(() => n), index: triangles.flat() };
}

function cylinder(face) {
  const [t0, t1] = face.theta;
  const [h0, h1] = face.height;
  const origin = v3(face.origin), axis = v3(face.axis), ref = v3(face.ref);
  const side = new THREE.Vector3().crossVectors(axis, ref);
  const sign = face.outward ? 1 : -1;
  const steps = Math.max(2, Math.ceil((t1 - t0) / ARC_STEP));
  const points = [], normals = [], index = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const dir = ref.clone().multiplyScalar(Math.cos(t)).addScaledVector(side, Math.sin(t));
    for (const h of [h0, h1]) {
      points.push(origin.clone().addScaledVector(axis, h).addScaledVector(dir, face.radius));
      normals.push(dir.clone().multiplyScalar(sign));
    }
    if (i < steps) index.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  return { points, normals, index };
}

export const MESHERS = { plane, cylinder };
export const isRenderable = (face) => face.type in MESHERS;

/** 三角形の向きを頂点法線に揃えてから BufferGeometry にする（表裏の判定と陰影を正しくするため）。 */
function toGeometry({ points, normals, index }) {
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [index[k], index[k + 1], index[k + 2]];
    e1.subVectors(points[b], points[a]);
    e2.subVectors(points[c], points[a]);
    if (e1.cross(e2).dot(normals[a]) < 0) [index[k + 1], index[k + 2]] = [c, b];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals.flatMap((p) => p.toArray()), 3));
  geometry.setIndex(index);
  return geometry;
}

/** @returns {THREE.BufferGeometry | null} */
export function faceGeometry(face) {
  const raw = MESHERS[face.type]?.(face);
  return raw && raw.index.length ? toGeometry(raw) : null;
}

/** 稜線の折れ線群を LineSegments 用の座標列にする。 */
export function edgeSegments(edges) {
  return edges.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
}
