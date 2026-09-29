// three.js による 3D 表示。シーン JSON を受け取って描き、視点・稜線・強調表示を受け持つ。
// 色は CSS のテーマトークンから読み、ライト／ダークの切り替えに追従する。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AXES } from "./describe.js";
import { edgeSegments, faceGeometry } from "./tessellate.js";

export const VIEWS = { iso: [1, 1, 1], top: [0, 1, 1e-4], front: [0, 0, 1], right: [1, 0, 0] };
const TRANSITION_MS = 380;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewer {
  /**
   * @param {{ stage: HTMLElement, canvas: HTMLCanvasElement, gizmo: HTMLCanvasElement }} elements
   * @param {{ onHover?: (faceId: number | null) => void }} [callbacks]
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
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100000);
    this.scene.add(this.camera, new THREE.HemisphereLight(0xffffff, 0x8a939e, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(1.5, 2.5, 3);
    this.camera.add(key); // 光源をカメラに固定し、どの向きから見ても陰影が読めるようにする

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener("change", () => this.requestRender());
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.faceMeshes = [];
    this.edgeMaterial = new THREE.LineBasicMaterial();
    this.highlighted = new Set();
    this.bounds = new THREE.Box3();
    this.fitted = false;
    this.tween = 0;

    this.#watchSize();
    this.#watchTheme();
    this.#watchPointer();
  }

  /** シーン JSON を表示する（前の形状は破棄する）。 */
  show(sceneData) {
    this.clear();
    for (const body of sceneData.bodies) {
      for (const face of body.faces) {
        const geometry = faceGeometry(face);
        if (!geometry) continue;
        const material = new THREE.MeshStandardMaterial({
          metalness: 0.25, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.faceId = face.id;
        this.model.add(mesh);
        this.faceMeshes.push(mesh);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(edgeSegments(body.edges), 3));
      this.model.add(new THREE.LineSegments(geometry, this.edgeMaterial));
    }
    this.bounds.setFromObject(this.model);
    this.applyColors();
    if (this.fitted) this.setView(VIEWS.iso, false);
  }

  clear() {
    for (const child of [...this.model.children]) {
      child.geometry.dispose();
      if (child.material !== this.edgeMaterial) child.material.dispose();
      this.model.remove(child);
    }
    this.faceMeshes = [];
    this.highlighted.clear();
    this.requestRender();
  }

  highlight(faceIds) {
    this.highlighted = new Set(faceIds);
    this.applyColors();
  }

  setEdgesVisible(visible) {
    for (const child of this.model.children) if (child.isLineSegments) child.visible = visible;
    this.requestRender();
  }

  /** 視点を変える。direction はカメラを置く向き（注視点から見た方向）。 */
  setView(direction, animate = !reduceMotion()) {
    const { camera, controls } = this;
    const center = this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
    const to = new THREE.Vector3(...direction).normalize();
    const from = camera.position.clone().sub(controls.target).normalize();
    const fromTarget = controls.target.clone();
    const fromDistance = camera.position.distanceTo(controls.target);
    const toDistance = this.#fitDistance();
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
    const steel = new THREE.Color(token("--steel"));
    const accent = new THREE.Color(token("--accent"));
    for (const mesh of this.faceMeshes) {
      mesh.material.color.copy(this.highlighted.has(mesh.userData.faceId) ? steel.clone().lerp(accent, 0.65) : steel);
    }
    this.edgeMaterial.color.set(token("--edge"));
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

  #fitDistance() {
    const radius = Math.max(this.bounds.isEmpty() ? 1 : this.bounds.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const { fov, aspect } = this.camera;
    return (radius / Math.sin(THREE.MathUtils.degToRad(fov / 2))) * (aspect < 1 ? 1.35 / aspect : 1.15);
  }

  #drawGizmo() {
    const g = this.gizmo;
    const size = g.canvas.width, c = size / 2, len = size * 0.3;
    g.clearRect(0, 0, size, size);
    const inverse = this.camera.quaternion.clone().invert();
    const axes = AXES.map(([name, dir]) => ({
      name, color: token(`--axis-${name.toLowerCase()}`), v: new THREE.Vector3(...dir).applyQuaternion(inverse),
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

  #watchSize() {
    new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = this.stage;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (!this.fitted) {
        this.fitted = true; // 画面の縦横比が決まってから初回の全体表示を行う
        this.setView(VIEWS.iso, false);
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
        const hit = raycaster.intersectObjects(this.faceMeshes, false)[0];
        this.onHover(hit ? hit.object.userData.faceId : null);
      });
    });
    this.canvas.addEventListener("pointerleave", () => this.onHover(null));
  }
}
