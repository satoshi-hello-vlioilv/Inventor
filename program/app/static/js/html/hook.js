// 他の HTML に差し込み、three.js のシーンを取り出すフック。隔離した iframe の中で、元のスクリプトより先に実行される。
// 関数の文字列をそのまま埋め込むため、この関数の外側の識別子を参照しないこと（自己完結で書く）。
//
// 仕組み: three.js は Scene / WebGLRenderer を生成すると window.__THREE_DEVTOOLS__ に "observe" を通知する
// （r160・r170・r180 で確認）。これを受けてレンダラーの render を包み、画面に描かれた最後のシーンを覚えておく。
// 親から { type: "ipt:extract", id } が届いたら、そのシーンの見えているメッシュを送り返す。

export function threeHook() {
  const state = { scene: null, announced: false };
  const devtools = new EventTarget();

  devtools.addEventListener("observe", (event) => {
    const renderer = event.detail;
    if (!renderer || !renderer.isWebGLRenderer || renderer.__iptHooked) return;
    renderer.__iptHooked = true;
    const render = renderer.render;
    renderer.render = function (scene, camera) {
      // 画面への描画だけを記録する（環境マップ作成などのオフスクリーン描画は除く）
      const onScreen = !this.getRenderTarget || this.getRenderTarget() === null;
      if (onScreen && scene && scene.isScene) {
        state.scene = scene;
        if (!state.announced) {
          state.announced = true;
          parent.postMessage({ type: "ipt:ready", revision: window.__THREE__ || null }, "*");
        }
      }
      return render.apply(this, arguments);
    };
  });
  window.__THREE_DEVTOOLS__ = devtools;

  const plain = (object) => {
    const out = {};
    for (const [key, value] of Object.entries(object || {})) {
      if (["number", "boolean", "string"].includes(typeof value)) out[key] = value;
    }
    return out;
  };
  const copy = (attribute, Type, itemSize) => {
    const out = new Type(attribute.count * itemSize);
    for (let i = 0; i < attribute.count; i++) {
      out[i * itemSize] = attribute.getX(i);
      if (itemSize > 1) out[i * itemSize + 1] = attribute.getY(i);
      if (itemSize > 2) out[i * itemSize + 2] = attribute.getZ(i);
    }
    return out;
  };

  const extract = () => {
    const scene = state.scene;
    if (!scene) return { payload: { error: "three.js の描画がまだ行われていません" }, transfer: [] };
    scene.updateMatrixWorld(true);
    const meshes = [], transfer = [], excluded = {};
    const skip = (reason) => (excluded[reason] = (excluded[reason] || 0) + 1);
    scene.traverseVisible((object) => {
      if (object.isInstancedMesh) return skip("instanced");
      if (object.isLine || object.isLineSegments) return skip("line");
      if (object.isSprite) return skip("sprite");
      if (object.isPoints) return skip("points");
      if (!object.isMesh) return;
      const geometry = object.geometry;
      const position = geometry && geometry.attributes && geometry.attributes.position;
      if (!position) return skip("empty");
      const positions = copy(position, Float32Array, 3);
      const normals = geometry.attributes.normal ? copy(geometry.attributes.normal, Float32Array, 3) : null;
      const index = geometry.index ? copy(geometry.index, Uint32Array, 1) : null;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      const path = [];
      for (let o = object; o && !o.isScene; o = o.parent) path.unshift(o.name || o.type);
      meshes.push({
        name: object.name || "",
        path,
        geometryType: geometry.type,
        parameters: plain(geometry.parameters),
        matrix: object.matrixWorld.elements.slice(),
        positions,
        normals,
        index,
        color: material && material.color ? material.color.getHex() : null,
        transparent: Boolean(material && material.transparent && material.opacity < 1),
      });
      transfer.push(positions.buffer);
      if (normals) transfer.push(normals.buffer);
      if (index) transfer.push(index.buffer);
    });
    return { payload: { revision: window.__THREE__ || null, meshes, excluded }, transfer };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.type !== "ipt:extract") return;
    const { payload, transfer } = extract();
    parent.postMessage({ type: "ipt:scene", id: event.data.id, ...payload }, "*", transfer);
  });
}
