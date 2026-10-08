// U3D の CLOD メッシュ（ECMA-363 の 9.6.1）: 宣言（大きさ・陰影の種類・量子化の係数）・基本のメッシュ・段階的なメッシュ（頂点の分割）。
// 段階的なメッシュは「頂点を 1 つずつ分割して面を足していく」形で符号化されていて、読む側も同じ手順で形を組み立て直す。
// 手順（集合の並び = 降順・予測の作り方・読む順序）は、公式の実装（Intel の U3D ライブラリ。Apache License 2.0。
// CIFXAuthorCLODDecoder・CIFXSetAdjacencyX・CIFXSetX）に従う。読む順序は浮動小数の計算に依らない（予測は値だけに効く）。

import { STATIC_FULL } from "./bitstream.js";

// 文脈の番号（IFXACContext.h）
const C = {
  shadingID: 65, orientation: 2, thirdIndexType: 3, local3rd: 4, stayMove: 15, numNewFaces: 1,
  posSigns: 20, posX: 21, posY: 22, posZ: 23,
  newDiffuse: 99, diffuseSign: 100, newSpecular: 101, specularSign: 102, texSign: 103, newTex: 123,
  colorMag: [60, 61, 62, 63], texMag: [33, 34, 35, 36],
  diffuseKeep: 104, diffuseType: 105, diffuseNew: 106, diffuseLocal: 107, diffuseGlobal: 108,
  specularKeep: 109, specularType: 110, specularNew: 111, specularLocal: 112, specularGlobal: 113,
  texKeep: 114, texType: 115, texNew: 116, texLocal: 117, texGlobal: 118,
  colorDup: 56, colorSplitType: 55, colorLocal: 119, colorGlobal: 120,
  texDup: 39, texSplitType: 29, texLocalIdx: 121, texGlobalIdx: 122,
  numLocalNormals: 40, normalSigns: 41, normalX: 42, normalY: 43, normalZ: 44, normalLocal: 45,
  baseShading: 1,
};

/** 降順に並べた整数の集合（公式の実装の IFXSetX と同じ並び。番号で取り出す値がこの並びに依る） */
class SortedSet {
  constructor() {
    this.items = [];
  }
  #find(v) {
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid] > v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  has(v) {
    const i = this.#find(v);
    return this.items[i] === v;
  }
  add(v) {
    const i = this.#find(v);
    if (this.items[i] !== v) this.items.splice(i, 0, v);
  }
  remove(v) {
    const i = this.#find(v);
    if (this.items[i] === v) this.items.splice(i, 1);
  }
  member(i) {
    return this.items[i] ?? 0;
  }
  get size() {
    return this.items.length;
  }
}

/** CLOD メッシュの宣言（0xFFFFFF31）→ 組み立てる前のメッシュ */
export function readDeclaration(bs) {
  const name = bs.readString();
  bs.readU32(); // 修飾の鎖の番号
  const excludeNormals = Boolean(bs.readU32() & 1);
  const max = { faces: bs.readU32(), positions: bs.readU32(), normals: bs.readU32(), diffuse: bs.readU32(), specular: bs.readU32(),
    tex: bs.readU32(), shadings: bs.readU32() };
  const shadings = [];
  for (let i = 0; i < max.shadings; i++) {
    const attr = bs.readU32();
    const layers = bs.readU32();
    for (let j = 0; j < layers; j++) bs.readU32(); // 文字の座標の次元
    bs.readU32(); // 元の陰影の番号
    shadings.push({ diffuse: Boolean(attr & 1), specular: Boolean(attr & 2), layers });
  }
  const minResolution = bs.readU32(), finalResolution = bs.readU32();
  for (let i = 0; i < 3; i++) bs.readU32(); // 品質の係数
  const q = { position: bs.readF32(), normal: bs.readF32(), tex: bs.readF32(), diffuse: bs.readF32(), specular: bs.readF32() };
  return {
    name, excludeNormals, max, shadings, minResolution, finalResolution, q,
    positions: [], normals: [], diffuse: [], specular: [], tex: [],
    faces: [], // [{ p: [a, b, c], n, d, s, t: [[…] 層ごと], shading }]
    adjacency: new Map(), // 位置 → その位置を使う面の集合
    prev: { d: [0, 0, 0], s: [0, 0, 0], t: [0, 0, 0] },
  };
}

const facesAt = (mesh, p) => {
  let set = mesh.adjacency.get(p);
  if (!set) mesh.adjacency.set(p, (set = new SortedSet()));
  return set;
};
const cornerOf = (face, p) => face.p.indexOf(p);

/** 位置 p で使う、属性（d 拡散色・s 鏡面色・t 文字の座標）の番号の集合（その属性を持つ陰影の面だけ） */
function attributeSet(mesh, p, key, layer = 0) {
  const out = new SortedSet();
  for (const f of facesAt(mesh, p).items) {
    const face = mesh.faces[f];
    const shading = mesh.shadings[face.shading] ?? {};
    const has = key === "d" ? shading.diffuse : key === "s" ? shading.specular : shading.layers > layer;
    if (!has) continue;
    const corner = cornerOf(face, p);
    const values = key === "t" ? face.t[layer] : face[key];
    if (corner >= 0 && values) out.add(values[corner]);
  }
  return out;
}

/** 基本のメッシュ（0xFFFFFF3B）: 値をそのまま持つ */
export function readBase(bs, mesh) {
  bs.readString();
  bs.readU32();
  const n = { faces: bs.readU32(), positions: bs.readU32(), normals: bs.readU32(), diffuse: bs.readU32(), specular: bs.readU32(), tex: bs.readU32() };
  const v3 = () => [bs.readF32(), bs.readF32(), bs.readF32()];
  const v4 = () => [bs.readF32(), bs.readF32(), bs.readF32(), bs.readF32()];
  for (let i = 0; i < n.positions; i++) mesh.positions.push(v3());
  for (let i = 0; i < n.normals; i++) mesh.normals.push(v3());
  for (let i = 0; i < n.diffuse; i++) mesh.diffuse.push(v4());
  for (let i = 0; i < n.specular; i++) mesh.specular.push(v4());
  for (let i = 0; i < n.tex; i++) mesh.tex.push(v4());
  const index = (count) => bs.readCompressedU32(STATIC_FULL + count);
  for (let i = 0; i < n.faces; i++) {
    const shading = bs.readCompressedU32(C.baseShading);
    const sh = mesh.shadings[shading] ?? { layers: 0 };
    const face = { p: [], n: [], d: sh.diffuse ? [] : null, s: sh.specular ? [] : null, t: Array.from({ length: sh.layers }, () => []), shading };
    for (let k = 0; k < 3; k++) {
      face.p.push(index(n.positions));
      if (!mesh.excludeNormals) face.n.push(index(n.normals));
      if (face.d) face.d.push(index(n.diffuse));
      if (face.s) face.s.push(index(n.specular));
      for (const t of face.t) t.push(index(n.tex));
    }
    mesh.faces.push(face);
  }
  mesh.faces.forEach((face, i) => face.p.forEach((p) => facesAt(mesh, p).add(i)));
}

/** 段階的なメッシュ（0xFFFFFF3C）: 解像度 start から end まで、頂点を 1 つずつ分割する */
export function readProgressive(bs, mesh) {
  bs.readString();
  bs.readU32();
  const start = bs.readU32(), end = bs.readU32();
  mesh.prev = { d: [0, 0, 0], s: [0, 0, 0], t: [0, 0, 0] };
  for (let i = start; i < end; i++) splitVertex(bs, mesh);
}

/** 新しい色・文字の座標（予測 = 分割する位置の値の平均 ＋ 量子化した差） */
function readNewValues(bs, mesh, count, list, key, signContext, magContexts, quant, split) {
  if (!count) return;
  const used = attributeSet(mesh, split, key);
  const prediction = [0, 0, 0, 0];
  for (const i of used.items) for (let k = 0; k < 4; k++) prediction[k] += (list[i]?.[k] ?? 0) / used.size;
  for (let j = 0; j < count; j++) {
    const signs = bs.readCompressedU8(signContext);
    const v = magContexts.map((c, k) => (signs & (1 << k) ? -1 : 1) * quant * bs.readCompressedU32(c) + prediction[k]);
    list.push(v);
  }
}

function splitVertex(bs, mesh) {
  const r = mesh.positions.length; // いまの解像度 = 位置の数（新しい位置の番号）
  const counts = { d: mesh.diffuse.length, s: mesh.specular.length, t: mesh.tex.length, faces: mesh.faces.length };
  const split = bs.readCompressedU32(STATIC_FULL + r);
  const splitFaces = [...facesAt(mesh, split).items];
  const positionSet = new SortedSet();
  for (const f of splitFaces) for (const p of mesh.faces[f].p) positionSet.add(p);
  positionSet.remove(split);

  readNewValues(bs, mesh, bs.readCompressedU16(C.newDiffuse), mesh.diffuse, "d", C.diffuseSign, C.colorMag, mesh.q.diffuse, split);
  readNewValues(bs, mesh, bs.readCompressedU16(C.newSpecular), mesh.specular, "s", C.specularSign, C.colorMag, mesh.q.specular, split);
  readNewValues(bs, mesh, bs.readCompressedU16(C.newTex), mesh.tex, "t", C.texSign, C.texMag, mesh.q.tex, split);

  // 新しい面: 陰影・向き（左 = 分割する位置・新しい位置・3 番目、右 = 新しい位置・分割する位置・3 番目）・3 番目の位置
  const newFaces = bs.readCompressedU32(C.numNewFaces);
  const left = new SortedSet(), right = new SortedSet();
  for (let j = 0; j < newFaces; j++) {
    const shading = bs.readCompressedU32(C.shadingID);
    const orientation = bs.readCompressedU8(C.orientation);
    const thirdType = bs.readCompressedU8(C.thirdIndexType);
    let third;
    if (thirdType === 1) third = positionSet.member(bs.readCompressedU32(C.local3rd));
    else {
      third = bs.readCompressedU32(STATIC_FULL + r);
      positionSet.add(third);
    }
    (orientation === 1 ? left : right).add(third);
    const sh = mesh.shadings[shading] ?? { layers: 0 };
    mesh.faces.push({ p: orientation === 1 ? [split, r, third] : [r, split, third], n: [0, 0, 0], d: sh.diffuse ? [0, 0, 0] : null,
      s: sh.specular ? [0, 0, 0] : null, t: Array.from({ length: sh.layers }, () => [0, 0, 0]), shading });
  }

  // 分割する位置を使う面: 残るか、新しい位置へ移るか（周りの面から予測した文脈で読む）
  const moveFaces = new SortedSet(), movePositions = new SortedSet(), stayPositions = new SortedSet();
  for (const f of splitFaces) {
    const face = mesh.faces[f];
    const c = cornerOf(face, split);
    const next = face.p[(c + 1) % 3], prev = face.p[(c + 2) % 3];
    let prediction = right.has(next) ? 1 : right.has(prev) ? 2 : left.has(next) ? 2 : left.has(prev) ? 1 : 0;
    if (!prediction && face.p.some((p) => movePositions.has(p))) prediction = 3;
    if (!prediction && face.p.some((p) => stayPositions.has(p))) prediction = 4;
    const move = bs.readCompressedU8(C.stayMove + prediction) === 1;
    const target = move ? movePositions : stayPositions;
    if (move) moveFaces.add(f);
    for (const p of face.p) target.add(p);
    target.remove(split);
  }

  // 移る面の更新: 位置の角を新しい位置へ。色・文字の座標の角は、変えるなら新しい番号へ
  const updates = [];
  const attributeUpdate = (key, layer, face, f, corner, ctx, base) => {
    if (bs.readCompressedU8(ctx.keep) !== 1) return;
    const type = bs.readCompressedU8(ctx.type);
    const index = bs.readCompressedU32(type === 1 ? ctx.newIdx : type === 2 ? ctx.local : ctx.global);
    const value = type === 1 ? index + base : type === 2 ? attributeSet(mesh, split, key, layer).member(index) : index;
    updates.push(() => ((key === "t" ? mesh.faces[f].t[layer] : mesh.faces[f][key])[corner] = value));
  };
  for (const f of moveFaces.items) {
    const face = mesh.faces[f];
    const corner = cornerOf(face, split);
    updates.push(() => (mesh.faces[f].p[corner] = r));
    const sh = mesh.shadings[face.shading] ?? { layers: 0 };
    if (sh.diffuse) attributeUpdate("d", 0, face, f, corner, { keep: C.diffuseKeep, type: C.diffuseType, newIdx: C.diffuseNew, local: C.diffuseLocal, global: C.diffuseGlobal }, counts.d);
    if (sh.specular) attributeUpdate("s", 0, face, f, corner, { keep: C.specularKeep, type: C.specularType, newIdx: C.specularNew, local: C.specularLocal, global: C.specularGlobal }, counts.s);
    for (let layer = 0; layer < sh.layers; layer++) {
      attributeUpdate("t", layer, face, f, corner, { keep: C.texKeep, type: C.texType, newIdx: C.texNew, local: C.texLocal, global: C.texGlobal }, counts.t);
    }
  }

  // 新しい面の色・文字の座標（直前の面と同じなら印だけ）
  for (let j = 0; j < newFaces; j++) {
    const f = counts.faces + j, face = mesh.faces[f];
    const third = face.p[2];
    const corners = { split: cornerOf(face, split), add: cornerOf(face, r), third: 2 };
    const sh = mesh.shadings[face.shading] ?? { layers: 0 };
    const attribute = (key, layer, dupContext, typeContext, localContext, globalContext) => {
      const dup = bs.readCompressedU8(dupContext);
      const splitSet = attributeSet(mesh, split, key, layer);
      const pick = (flag, set, prev) => {
        if (dup & flag) return prev;
        const type = bs.readCompressedU8(typeContext);
        return type === 2 ? set.member(bs.readCompressedU32(localContext)) : bs.readCompressedU32(globalContext);
      };
      const prev = mesh.prev[key];
      const a = pick(1, splitSet, prev[0]);
      const b = pick(2, splitSet, prev[1]);
      const c = pick(4, attributeSet(mesh, third, key, layer), prev[2]);
      const values = key === "t" ? face.t[layer] : face[key];
      values[corners.split] = a;
      values[corners.add] = b;
      values[corners.third] = c;
      mesh.prev[key] = [a, b, c];
    };
    if (sh.diffuse) attribute("d", 0, C.colorDup, C.colorSplitType, C.colorLocal, C.colorGlobal);
    if (sh.specular) attribute("s", 0, C.colorDup, C.colorSplitType, C.colorLocal, C.colorGlobal);
    for (let layer = 0; layer < sh.layers; layer++) attribute("t", layer, C.texDup, C.texSplitType, C.texLocalIdx, C.texGlobalIdx);
  }

  // 隣接の更新: 移る面は新しい位置へ、新しい面は 3 つの位置へ
  for (const f of moveFaces.items) {
    facesAt(mesh, split).remove(f);
    facesAt(mesh, r).add(f);
  }
  for (let j = 0; j < newFaces; j++) for (const p of mesh.faces[counts.faces + j].p) facesAt(mesh, p).add(counts.faces + j);

  // 法線を読み直す位置: 新しい位置を使う面の位置（位置の角の更新の前の値で集める）
  const normalPositions = new SortedSet();
  for (const f of facesAt(mesh, r).items) for (const p of mesh.faces[f].p) normalPositions.add(p);

  // 新しい位置 = 分割する位置 ＋ 量子化した差
  const signs = bs.readCompressedU8(C.posSigns);
  const d = [C.posX, C.posY, C.posZ].map((c, k) => (signs & (1 << k) ? -1 : 1) * mesh.q.position * bs.readCompressedU32(c));
  const base = r > 0 ? mesh.positions[split] : [0, 0, 0];
  mesh.positions.push([base[0] + d[0], base[1] + d[1], base[2] + d[2]]);
  for (const apply of updates) apply();

  if (!mesh.excludeNormals) readNormals(bs, mesh, normalPositions, counts.faces);
}

// ---- 法線 -----------------------------------------------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function faceNormal(mesh, face) {
  const [a, b, c] = face.p.map((p) => mesh.positions[p]);
  if (!a || !b || !c) return null;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  if (lu < 1e-6 || lv < 1e-6) return null;
  const n = [(u[1] * v[2] - u[2] * v[1]) / (lu * lv), (u[2] * v[0] - u[0] * v[2]) / (lu * lv), (u[0] * v[1] - u[1] * v[0]) / (lu * lv)];
  const ln = Math.hypot(...n);
  return ln < 1e-6 ? null : n.map((x) => x / ln);
}

/** 単位の四元数（ベクトル部だけの）の球面補間（公式の実装の IFXQuaternion::Interpolate） */
function slerp(t, from, to) {
  let cos = dot(from, to);
  let target = to;
  if (cos < 0) {
    cos = -cos;
    target = to.map((x) => -x);
  }
  let s0 = 1 - t, s1 = t;
  if (1 - cos > 1e-6) {
    const omega = Math.acos(Math.min(1, cos)), sin = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / sin;
    s1 = Math.sin(t * omega) / sin;
  }
  return [s0 * from[0] + s1 * target[0], s0 * from[1] + s1 * target[1], s0 * from[2] + s1 * target[2]];
}

function readNormals(bs, mesh, positions, oldFaceCount) {
  const added = [];
  const oldCount = mesh.normals.length;
  void oldFaceCount;
  for (const p of positions.items) {
    const faces = [...facesAt(mesh, p).items];
    const count = bs.readCompressedU32(C.numLocalNormals);
    // 予測: 面の法線から、互いに最も離れたものを count 個選び、各面の法線を近い予測へ混ぜる
    const normals = faces.map((f) => faceNormal(mesh, mesh.faces[f])).filter(Boolean);
    const predicted = [];
    if (normals.length) predicted.push(normals[0]);
    while (predicted.length < count) {
      let farthest = 1, index = 0;
      normals.forEach((n, k) => {
        const nearest = Math.max(-2, ...predicted.map((q) => dot(n, q)));
        if (nearest < farthest) {
          farthest = nearest;
          index = k;
        }
      });
      predicted.push(normals[index] ?? [0, 0, 0]);
    }
    const weights = predicted.map(() => 0);
    for (const n of normals) {
      let best = 0, closest = -2;
      predicted.forEach((q, l) => {
        const d = dot(n, q);
        if (d > closest) {
          closest = d;
          best = l;
        }
      });
      if (!predicted.length) continue;
      predicted[best] = slerp(1 / (weights[best] + 1), predicted[best], n);
      weights[best]++;
    }
    // 予測 × 量子化した差の四元数（w は単位の長さから）
    const local = [];
    for (let k = 0; k < count; k++) {
      const signs = bs.readCompressedU8(C.normalSigns);
      const [dx, dy, dz] = [C.normalX, C.normalY, C.normalZ].map((c, i) => (signs & (2 << i) ? -1 : 1) * mesh.q.normal * bs.readCompressedU32(c));
      const dw = (signs & 1 ? -1 : 1) * Math.sqrt(Math.max(0, 1 - Math.min(1, dx * dx + dy * dy + dz * dz)));
      const [a1, a2, a3] = predicted[k] ?? [0, 0, 0]; // 予測の四元数は (0, a1, a2, a3)
      local.push([a1 * dw + a2 * dz - a3 * dy, a2 * dw + a3 * dx - a1 * dz, a3 * dw + a1 * dy - a2 * dx]);
    }
    for (const f of faces) {
      const index = bs.readCompressedU32(C.normalLocal);
      const face = mesh.faces[f];
      const corner = cornerOf(face, p);
      if (corner >= 0) face.n[corner] = oldCount + added.length + index;
    }
    added.push(...local);
  }
  mesh.normals.push(...added);
}
