// U3D（ECMA-363。3D の PDF の中身の形式の 1 つ）を読み、表示できる三角形メッシュにする。
//   readU3d(bytes) → { meshes: [{ name, instance, positions: Float32Array, normals: Float32Array | null, index: Uint32Array, groups, matrix,
//                                 faces, vertices }], nodes, views: [{ name, matrix }], units, warnings }
// ブロック: 種類（U32）・データの大きさ・メタデータの大きさ・データ・メタデータ（それぞれ 4 バイトに揃える）。
// 修飾の鎖（0xFFFFFF14）の中に、ノード（群・モデル・光・視点）・資源（CLOD メッシュ・陰影・材質）の宣言が入れ子に並び、
// メッシュの中身（基本 0xFFFFFF3B・段階的 0xFFFFFF3C）は後のブロックで、宣言の名前を指して届く。

import { BitStream } from "./bitstream.js";
import { readBase, readDeclaration, readProgressive } from "./clod.js";

export class U3dError extends Error {}

const T = {
  header: 0x00443355, chain: 0xffffff14, group: 0xffffff21, model: 0xffffff22, light: 0xffffff23, view: 0xffffff24,
  clodDecl: 0xffffff31, clodBase: 0xffffff3b, clodProgressive: 0xffffff3c, pointDecl: 0xffffff36, lineDecl: 0xffffff37,
  shading: 0xffffff45, litShader: 0xffffff53, material: 0xffffff54,
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** ブロックの並び（入れ子の修飾の鎖は、その中のブロックも並べる） */
function* blocks(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  while (at + 12 <= end) {
    const type = view.getUint32(at, true), size = view.getUint32(at + 4, true), meta = view.getUint32(at + 8, true);
    const dataStart = at + 12;
    if (dataStart + size > end) return;
    yield { type, data: bytes.subarray(dataStart, dataStart + size) };
    at = dataStart + Math.ceil(size / 4) * 4 + Math.ceil(meta / 4) * 4;
  }
}

export function readU3d(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== T.header) throw new U3dError("U3D の見出しがありません。");
  const state = { nodes: new Map(), meshes: new Map(), shadings: new Map(), shaders: new Map(), materials: new Map(), warnings: new Set(), units: 1 };
  const header = new BitStream([...blocks(bytes)][0].data);
  header.readU32(); // 版
  const profile = header.readU32();
  header.readU32();
  header.readU32();
  header.readU32();
  header.readU32(); // 文字の符号化（106 = UTF-8）
  if (profile & 8) state.units = header.readF64(); // 1 単位の長さ（m）
  for (const block of blocks(bytes)) readBlock(block, state);
  return assemble(state);
}

function readBlock(block, state) {
  try {
    switch (block.type) {
      case T.chain: return readChain(block.data, state);
      case T.group: case T.model: case T.light: case T.view: return readNode(block, state);
      case T.clodDecl: {
        const mesh = readDeclaration(new BitStream(block.data));
        state.meshes.set(mesh.name, mesh);
        return;
      }
      case T.clodBase: case T.clodProgressive: {
        const bs = new BitStream(block.data);
        const name = new BitStream(block.data).readString();
        const mesh = state.meshes.get(name);
        if (!mesh) return state.warnings.add(`宣言の無いメッシュ ${name}`);
        (block.type === T.clodBase ? readBase : readProgressive)(bs, mesh);
        return;
      }
      case T.shading: {
        const bs = new BitStream(block.data);
        const name = bs.readString();
        bs.readU32(); // 鎖の番号
        bs.readU32(); // 属性
        const lists = [];
        for (let i = 0, n = bs.readU32(); i < n; i++) {
          const list = [];
          for (let j = 0, m = bs.readU32(); j < m; j++) list.push(bs.readString());
          lists.push(list);
        }
        state.shadings.set(name, lists);
        return;
      }
      case T.litShader: {
        const bs = new BitStream(block.data);
        const name = bs.readString();
        bs.readU32();
        bs.readF32();
        bs.readU32();
        bs.readU32();
        bs.readU32();
        const channels = bs.readU32();
        bs.readU32();
        state.shaders.set(name, { material: bs.readString(), textured: channels !== 0 });
        return;
      }
      case T.material: {
        const bs = new BitStream(block.data);
        const name = bs.readString();
        bs.readU32();
        const rgb = () => [bs.readF32(), bs.readF32(), bs.readF32()];
        const ambient = rgb(), diffuse = rgb(), specular = rgb(), emissive = rgb();
        bs.readF32();
        state.materials.set(name, { ambient, diffuse, specular, emissive, opacity: bs.readF32() });
        return;
      }
      case T.pointDecl: case T.lineDecl:
        state.warnings.add(block.type === T.lineDecl ? "線の集まり（まだ表示しません）" : "点の集まり（まだ表示しません）");
    }
  } catch (error) {
    state.warnings.add(`読めないブロック 0x${block.type.toString(16)}（${error.message}）`);
  }
}

/** 修飾の鎖: 名前・種類・属性（外接球・外接箱）・4 バイトに揃える詰め物・修飾の数・入れ子のブロック */
function readChain(data, state) {
  const bs = new BitStream(data);
  const name = bs.readString();
  bs.readU32(); // 種類（0 ノード・1 資源・2 模様）
  const attributes = bs.readU32();
  let at = 2 + new TextEncoder().encode(name).length + 8;
  if (attributes & 1) {
    for (let i = 0; i < 4; i++) bs.readF32();
    at += 16;
  }
  if (attributes & 2) {
    for (let i = 0; i < 6; i++) bs.readF32();
    at += 24;
  }
  at = Math.ceil(at / 4) * 4;
  at += 4; // 修飾の数
  for (const block of blocks(data, at)) readBlock(block, state);
}

/** ノード: 名前・親の数・親ごとに（親の名前・配置の 4×4 行列）。モデルは資源の名前と見え方も持つ */
function readNode(block, state) {
  const bs = new BitStream(block.data);
  const name = bs.readString();
  const parents = [];
  for (let i = 0, n = bs.readU32(); i < n; i++) {
    const parent = bs.readString();
    const matrix = Array.from({ length: 16 }, () => bs.readF32());
    parents.push({ name: parent, matrix });
  }
  const kind = { [T.group]: "group", [T.model]: "model", [T.light]: "light", [T.view]: "view" }[block.type];
  const node = { name, kind, parents };
  if (kind === "model") {
    node.resource = bs.readString();
    node.visibility = bs.readU32();
  }
  state.nodes.set(name, node);
}

/** 4×4 行列（列優先: 平行移動は 12〜14）の積 a × b */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** ノードの全ての置き方（親をたどった世界の行列。親が複数なら置き方も複数） */
function worldMatrices(state, name, depth = 0) {
  const node = state.nodes.get(name);
  if (!node || depth > 64) return [IDENTITY];
  if (!node.parents.length) return [IDENTITY];
  return node.parents.flatMap((p) => (p.name && state.nodes.has(p.name) ? worldMatrices(state, p.name, depth + 1) : [IDENTITY]).map((m) => multiply(m, p.matrix)));
}

const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");

/** 読んだ場面 → 表示のメッシュ（モデルのノードの置き方ごとに 1 つ。陰影ごとに群に分け、色は材質の拡散色） */
function assemble(state) {
  const out = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "model" || node.visibility === 0) continue;
    const mesh = state.meshes.get(node.resource);
    if (!mesh?.faces.length) continue;
    const lists = state.shadings.get(node.name) ?? [];
    const colorOf = (shading) => {
      const shader = state.shaders.get(lists[shading]?.[0] ?? lists[0]?.[0]);
      const material = state.materials.get(shader?.material);
      return material ? hex(material.diffuse) : null;
    };
    // 角ごとに（位置・法線）の組を頂点にする。陰影ごとに三角形を並べる
    const positions = [], normals = [], index = [], groups = [];
    const vertex = new Map();
    const byShading = new Map();
    mesh.faces.forEach((face) => {
      if (!byShading.has(face.shading)) byShading.set(face.shading, []);
      byShading.get(face.shading).push(face);
    });
    const hasNormals = !mesh.excludeNormals && mesh.normals.length > 0;
    for (const [shading, faces] of byShading) {
      const start = index.length;
      for (const face of faces) {
        if (new Set(face.p).size < 3) continue; // 縮退した面
        for (let k = 0; k < 3; k++) {
          const p = face.p[k], n = hasNormals ? face.n[k] : -1;
          const key = `${p}/${n}`;
          let v = vertex.get(key);
          if (v === undefined) {
            v = positions.length / 3;
            vertex.set(key, v);
            positions.push(...(mesh.positions[p] ?? [0, 0, 0]));
            if (hasNormals) normals.push(...(mesh.normals[n] ?? [0, 0, 1]));
          }
          index.push(v);
        }
      }
      groups.push({ start, count: index.length - start, shading, color: colorOf(shading) });
    }
    for (const [i, matrix] of worldMatrices(state, node.name).entries()) {
      out.push({
        name: node.name, instance: i, positions: Float32Array.from(positions), normals: hasNormals ? Float32Array.from(normals) : null,
        index: Uint32Array.from(index), groups, matrix, faces: mesh.faces.length, vertices: mesh.positions.length,
      });
    }
  }
  // 視点（カメラのノード）: 世界の行列（列優先。カメラは自分の −Z の向きを見て、+Y が上。OpenGL と同じ）
  const views = [...state.nodes.values()].filter((n) => n.kind === "view").map((n) => ({ name: n.name, matrix: worldMatrices(state, n.name)[0] }));
  return { meshes: out, nodes: state.nodes, views, units: state.units, warnings: [...state.warnings] };
}

/** 確かめ用: 読んだメッシュの宣言と組み立てたもの（名前 → { positions, faces }） */
export function readU3dMeshes(bytes) {
  const state = { nodes: new Map(), meshes: new Map(), shadings: new Map(), shaders: new Map(), materials: new Map(), warnings: new Set(), units: 1 };
  for (const block of blocks(bytes)) readBlock(block, state);
  return { meshes: state.meshes, nodes: state.nodes, warnings: [...state.warnings] };
}

