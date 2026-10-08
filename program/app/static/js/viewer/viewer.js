// three.js による 3D 表示。ipt の面、または HTML から取り出した部品を描き、視点・稜線・強調表示を受け持つ。
// 色は CSS のテーマトークンから読み、ライト／ダークの切り替えに追従する。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AXES } from "./describe.js";
import { edgeSegments, faceGeometry, meshVolume, partGeometry } from "./tessellate.js";

export const VIEWS = { iso: [1, 1, 1], top: [0, 1, 1e-4], front: [0, 0, 1], right: [1, 0, 0] };
const TRANSITION_MS = 380;
const FIT_FILL = 0.85; // 全体表示で、形が画面（縦・横）に占める割合の上限（上のツールバー・下の案内に掛からない余白）
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const EDGE_ANGLE_DEG = 25; // 取り込んだメッシュで稜線として描く折れ角
const FOCUS_TONES = new Set(["warn", "bad", "run"]); // 目を向ける印（不一致・失敗・作成中）。あれば、ほかの部品を透かす
const GHOST_OPACITY = 0.12;
// 面・部品の色の種類 → 色の名前（CSS の変数）。ok〜run は作った結果の印（mark）
const TONE_TOKEN = { exact: "--steel", approx: "--approx", ok: "--mark-ok", warn: "--warn", bad: "--critical", run: "--accent" }; // --mark-ok は 3D の形の一致の色（画面の文字の --ok と分ける）

export class Viewer {
  /**
   * @param {{ stage: HTMLElement, canvas: HTMLCanvasElement, gizmo: HTMLCanvasElement }} elements
   * @param {{ onHover?: (id: number | null) => void }} [callbacks]  id は ipt の面番号、または HTML の部品番号
   */
  constructor({ stage, canvas, gizmo }, { onHover } = {}) {
    this.stage = stage;
    this.canvas = canvas;
    this.gizmo = gizmo.getContext("2d");
    this.onHover = onHover ?? (() => {});
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); // 失敗時は呼び出し側で扱う
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 1e6);
    // 光: 空と地の光（全体）・主の光（右上の前）・補いの光（左の前。面の向きの差を出す）。強さは CSS のトークン（--light-*）
    this.ambient = new THREE.HemisphereLight(0xffffff, 0x8a939e, 1.6);
    this.scene.add(this.camera, this.ambient);
    this.key = new THREE.DirectionalLight(0xffffff, 1.8);
    this.key.position.set(1.5, 2.5, 3);
    this.fill = new THREE.DirectionalLight(0xffffff, 0);
    this.fill.position.set(-2.5, 0.5, 1.5);
    this.camera.add(this.key, this.fill); // 光源をカメラに固定し、どの向きから見ても陰影が読めるようにする

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener("change", () => this.requestRender());
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.surfaces = []; // 当たり判定の対象
    this.materials = new Map(); // 面・部品の id → { material, tone }
    this.edgeMaterial = new THREE.LineBasicMaterial();
    this.highlighted = new Set();
    this.marks = new Map(); // 面・部品の id → 印の色の種類（作った結果。元の色の代わりに塗る）
    this.focus = false; // 目を向ける印があるか（あれば、それだけを不透明にし、ほかの部品を薄く透かす）
    this.edgesVisible = true;
    this.bounds = new THREE.Box3();
    this.home = VIEWS.iso; // 最初の視点（注視点から見たカメラの向き）
    this.fitted = false;
    this.tween = 0;

    this.#watchSize();
    this.#watchTheme();
    this.#watchPointer();
  }

  /**
   * 形状を表示する（前の形状は破棄する）。
   * scene.bodies    … 部品（ipt・STEP の部品）の面（平面・円筒など）と稜線。面ごとに当たり判定する
   * scene.instances … 組立（iam・STEP）と変換データ。部品ごとに作った形状を、配置の数だけ置く。配置ごとに当たり判定する
   *                    （部品は面 bodies を持つか、作った形 geometry を持つ。変換データは convert/preview.js が作る）
   * scene.meshes    … 三角形メッシュ（部品ごとの groups 付き。HTML から取り出したもの・3D の PDF。groups の color はファイルの色）
   * scene.view      … 最初の視点 { direction（注視点 → カメラ）, up（画面の上）}（3D の PDF の既定の視点）。up に最も近い軸が
   *                    表示の上（+Y）になるようにモデルを回し、その軸の周りに回転させる。無ければ等角
   * @returns {{ volume?: number, volumes?: number[] }}  体積（mm³）。組立は部品ごと
   */
  show(sceneData) {
    this.clear();
    let stats = {};
    if (sceneData.meshes) this.#showMeshes(sceneData.meshes);
    else if (sceneData.instances) stats = this.#showAssembly(sceneData);
    else stats = this.#showBodies(sceneData.bodies);
    if (sceneData.view) this.#orient(sceneData.view);
    this.model.updateMatrixWorld(true);
    this.bounds.setFromObject(this.model);
    this.applyColors();
    // 表示の切り替え（HTML ⇄ ほか）で 3D の場所の大きさが変わった直後でも、新しい大きさで全体を収める
    if (this.fitted) {
      this.#syncSize();
      this.setView(this.home, false);
    }
    return stats;
  }

  /** ファイルの視点に合わせる: up に最も近い軸を表示の上（+Y）に回し、最初の視点（home）を direction にする */
  #orient({ direction, up }) {
    const k = [0, 1, 2].reduce((best, i) => (Math.abs(up[i]) > Math.abs(up[best]) ? i : best), 0);
    const axis = new THREE.Vector3().setComponent(k, Math.sign(up[k]) || 1);
    this.model.quaternion.setFromUnitVectors(axis, new THREE.Vector3(0, 1, 0));
    this.home = new THREE.Vector3(...direction).applyQuaternion(this.model.quaternion).toArray();
  }

  /** 面の材質。color（"#rrggbb"）はファイルが持つ色（3D の PDF の材質など）。無ければ tone の色（CSS のトークン） */
  #material(id, tone, color = null) {
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.25, roughness: 0.55, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.materials.set(id, { material, tone, color: color ? new THREE.Color(color) : null });
    return material;
  }

  #addEdges(geometry) {
    this.model.add(new THREE.LineSegments(geometry, this.edgeMaterial));
  }

  #showBodies(bodies) {
    let volume = 0;
    for (const body of bodies) {
      for (const face of body.faces) {
        const geometry = faceGeometry(face);
        if (!geometry) continue;
        volume += meshVolume(geometry);
        const mesh = new THREE.Mesh(geometry, this.#material(face.id, "exact"));
        mesh.userData.ids = [face.id];
        this.model.add(mesh);
        this.surfaces.push(mesh);
      }
      this.#addEdges(this.#edgeGeometry(body.edges));
    }
    return { volume };
  }

  #edgeGeometry(edges) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(edgeSegments(edges), 3));
    return geometry;
  }

  /** 組立: 部品ごとの形状（面をまとめたもの・稜線）を 1 回だけ作り、配置（4×4 行優先、mm）ごとに置く */
  #showAssembly({ parts, instances }) {
    const shapes = parts.map((part) => {
      if (part.geometry) return { geometry: part.geometry, volume: meshVolume(part.geometry), edges: new THREE.EdgesGeometry(part.geometry, EDGE_ANGLE_DEG) };
      if (!part.bodies?.length) return null;
      const { geometry, volume } = partGeometry(part.bodies);
      return { geometry, volume, edges: this.#edgeGeometry(part.bodies.flatMap((b) => b.edges)) };
    });
    for (const inst of instances) {
      const shape = shapes[inst.part];
      if (!shape) continue;
      const matrix = new THREE.Matrix4().set(...inst.matrix);
      const mesh = new THREE.Mesh(shape.geometry, this.#material(inst.id, "exact"));
      const lines = new THREE.LineSegments(shape.edges, this.edgeMaterial);
      lines.userData.id = inst.id; // 透かす部品の稜線を隠すため
      for (const obj of [mesh, lines]) {
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(matrix);
        this.model.add(obj);
      }
      mesh.userData.ids = [inst.id];
      this.surfaces.push(mesh);
    }
    return { volumes: shapes.map((s) => s?.volume ?? null) };
  }

  #showMeshes(meshes) {
    const matrix = new THREE.Matrix4();
    for (const m of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3)); // 複製される（元データは変えない）
      if (m.normals) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
      m.groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
      geometry.applyMatrix4(matrix.fromArray(m.matrix));
      if (!m.normals) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, m.groups.map((g) => this.#material(g.id, g.tone, g.color)));
      mesh.userData.ids = m.groups.map((g) => g.id);
      this.model.add(mesh);
      this.surfaces.push(mesh);
      this.#addEdges(new THREE.EdgesGeometry(geometry, EDGE_ANGLE_DEG));
    }
  }

  clear() {
    for (const child of [...this.model.children]) {
      child.geometry.dispose();
      this.model.remove(child);
    }
    for (const { material } of this.materials.values()) material.dispose();
    this.materials.clear();
    this.surfaces = [];
    this.highlighted.clear();
    this.marks.clear();
    this.focus = false;
    this.model.quaternion.identity();
    this.home = VIEWS.iso;
    this.requestRender();
  }

  highlight(ids) {
    this.highlighted = new Set(ids);
    this.applyColors();
  }

  /**
   * 部品に作った結果の印の色を塗る（[[id, 色の種類]]。空なら元の色に戻す）。
   * 目を向ける印（不一致 warn・失敗 bad・作成中 run）があれば、それだけを不透明にし、ほかの部品を透かす（内側の部品も外から見える）
   */
  mark(entries) {
    const marks = new Map(entries);
    if (marks.size === this.marks.size && [...marks].every(([id, tone]) => this.marks.get(id) === tone)) return; // 変わらなければ描き直さない
    this.marks = marks;
    this.focus = [...marks.values()].some((tone) => FOCUS_TONES.has(tone));
    this.applyColors();
  }

  /** 透かす部品か（目を向ける印があるとき、その印の無い部品。強調している部品は透かさない） */
  #ghosted(id) {
    return this.focus && !FOCUS_TONES.has(this.marks.get(id)) && !this.highlighted.has(id);
  }

  setEdgesVisible(visible) {
    this.edgesVisible = visible;
    this.applyColors(); // 稜線の見え方は、透かしている部品も合わせて決める
  }

  /** 視点を変える。direction はカメラを置く向き（注視点から見た方向）。 */
  setView(direction, animate = !reduceMotion()) {
    const { camera, controls } = this;
    const center = this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
    const to = new THREE.Vector3(...direction).normalize();
    const from = camera.position.clone().sub(controls.target).normalize();
    const fromTarget = controls.target.clone();
    const fromDistance = camera.position.distanceTo(controls.target);
    const toDistance = this.#fitDistance(to);
    const started = performance.now();
    const id = ++this.tween;
    const step = (now) => {
      if (id !== this.tween) return;
      const k = animate ? Math.min(1, (now - started) / TRANSITION_MS) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const dir = from.clone().lerp(to, e).normalize();
      controls.target.lerpVectors(fromTarget, center, e);
      camera.position.copy(controls.target).addScaledVector(dir, fromDistance + (toDistance - fromDistance) * e);
      camera.lookAt(controls.target);
      controls.update();
      this.requestRender();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** 現在の向きのまま、モデル全体が収まる距離に合わせる。 */
  fit() {
    this.setView(this.camera.position.clone().sub(this.controls.target).toArray());
  }

  applyColors() {
    const accent = new THREE.Color(token("--accent"));
    const tones = Object.fromEntries(Object.entries(TONE_TOKEN).map(([tone, name]) => [tone, new THREE.Color(token(name))]));
    for (const [id, { material, tone, color }] of this.materials) {
      const mark = this.marks.get(id);
      const base = mark ? tones[mark] ?? tones.exact : color ?? tones[tone] ?? tones.exact;
      material.color.copy(this.highlighted.has(id) ? base.clone().lerp(accent, 0.65) : base);
      const ghost = this.#ghosted(id);
      if (material.transparent !== ghost) {
        Object.assign(material, { transparent: ghost, opacity: ghost ? GHOST_OPACITY : 1, depthWrite: !ghost, needsUpdate: true });
      }
    }
    for (const child of this.model.children) {
      if (!child.isLineSegments) continue;
      const id = child.userData.id; // 配置ごとの稜線だけが id を持つ（部品の面の稜線は透かさない）
      child.visible = this.edgesVisible && !(id !== undefined && this.#ghosted(id));
    }
    this.edgeMaterial.color.set(token("--edge"));
    const light = (name, fallback) => Number.parseFloat(token(name)) || fallback;
    this.ambient.intensity = light("--light-ambient", 1.6);
    this.key.intensity = light("--light-key", 1.8);
    this.fill.intensity = Number.parseFloat(token("--light-fill")) || 0;
    this.requestRender();
  }

  requestRender() {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.renderer.render(this.scene, this.camera);
      this.#drawGizmo();
    });
  }

  /**
   * 向き direction（注視点 → カメラ）から見て、外形の箱の 8 つの角が画面の FIT_FILL の内に収まる距離。
   * 外接球で測ると、細長い形（組立の軸など）が画面の半分ほどにしか広がらないので、画面に写る大きさで測る。
   */
  #fitDistance(direction) {
    if (this.bounds.isEmpty()) return 10;
    const back = direction.clone().normalize();
    let right = this.camera.up.clone().cross(back);
    if (right.lengthSq() < 1e-8) right = new THREE.Vector3(0, 0, -1).cross(back); // 真上・真下から見るとき
    right.normalize();
    const up = back.clone().cross(right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * FIT_FILL;
    const tanH = tanV * this.camera.aspect;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const { min, max } = this.bounds;
    let distance = 1e-3;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const p = new THREE.Vector3(x, y, z).sub(center);
      const depth = p.dot(back); // カメラに近い側が正
      distance = Math.max(distance, depth + Math.abs(p.dot(right)) / tanH, depth + Math.abs(p.dot(up)) / tanV);
    }
    return distance;
  }

  #drawGizmo() {
    const g = this.gizmo;
    const size = g.canvas.width, c = size / 2, len = size * 0.3;
    g.clearRect(0, 0, size, size);
    const inverse = this.camera.quaternion.clone().invert();
    const axes = AXES.map(([name, dir]) => ({ // ファイルの軸（モデルを回して表示しているときは、回した後の向き）
      name, color: token(`--axis-${name.toLowerCase()}`), v: new THREE.Vector3(...dir).applyQuaternion(this.model.quaternion).applyQuaternion(inverse),
    })).sort((a, b) => a.v.z - b.v.z);
    g.lineWidth = 4;
    g.lineCap = "round";
    g.font = `600 ${size * 0.15}px ${token("--font-num")}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const { name, color, v } of axes) {
      g.strokeStyle = g.fillStyle = color;
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(c + v.x * len, c - v.y * len);
      g.stroke();
      g.fillText(name, c + v.x * len * 1.42, c - v.y * len * 1.42);
    }
  }

  /** 描く大きさとカメラの縦横比を、3D の場所のいまの大きさに合わせる（→ 大きさがあるか） */
  #syncSize() {
    const { clientWidth: w, clientHeight: h } = this.stage;
    if (!w || !h) return false;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return true;
  }

  #watchSize() {
    new ResizeObserver(() => {
      if (!this.#syncSize()) return;
      if (!this.fitted) {
        this.fitted = true; // 画面の縦横比が決まってから初回の全体表示を行う
        this.setView(this.home, false);
      }
      this.requestRender();
    }).observe(this.stage);
  }

  #watchTheme() {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyColors());
    new MutationObserver(() => this.applyColors()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  #watchPointer() {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pending = false;
    this.canvas.addEventListener("pointermove", (event) => {
      if (event.buttons) return; // 回転・移動中は判定しない
      const rect = this.canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        raycaster.setFromCamera(pointer, this.camera);
        const hit = raycaster.intersectObjects(this.surfaces, false)[0];
        this.onHover(hit ? hit.object.userData.ids[hit.face.materialIndex ?? 0] ?? null : null);
      });
    });
    this.canvas.addEventListener("pointerleave", () => this.onHover(null));
  }
}
