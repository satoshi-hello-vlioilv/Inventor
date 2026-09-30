// 他の HTML を隔離した iframe で動かし、フック経由で three.js の形状を受け取る。
//
// sandbox="allow-scripts" のみを許可するため、元のページは別オリジン扱いになり、
// このアプリの DOM・保存領域・Cookie には触れられない。やり取りは postMessage だけで行い、
// 受け取ったデータは送り主（その iframe）と形（型付き配列・数値）を確かめてから使う。

import { threeHook } from "./hook.js";

const HOOK_TAG = `<script>(${threeHook.toString()})();</script>`;
const TIMEOUT_MS = 15000;
let sequence = 0;

/** 元の HTML の <head> 直後（無ければ先頭）にフックを差し込む。元のスクリプトより先に実行される。 */
export function injectHook(html) {
  const at = /<head[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + HOOK_TAG + html.slice(at.index + at[0].length) : HOOK_TAG + html;
}

const isNumberArray = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

/** 受け取ったシーンのうち、形の正しいメッシュだけを残す。 */
export function sanitizeSnapshot(data) {
  const meshes = (Array.isArray(data.meshes) ? data.meshes : []).filter((m) =>
    m && m.positions instanceof Float32Array && m.positions.length % 3 === 0 &&
    (m.index === null || m.index instanceof Uint32Array) &&
    (m.normals === null || (m.normals instanceof Float32Array && m.normals.length === m.positions.length)) &&
    isNumberArray(m.matrix, 16) &&
    (m.instances == null || (Array.isArray(m.instances) && m.instances.every((x) => isNumberArray(x, 16)))));
  const excluded = {};
  for (const [key, value] of Object.entries(data.excluded ?? {})) if (Number.isInteger(value)) excluded[String(key)] = value;
  return {
    revision: typeof data.revision === "string" ? data.revision : null,
    excluded,
    meshes: meshes.map((m) => ({
      name: String(m.name ?? ""),
      path: Array.isArray(m.path) ? m.path.map(String) : [],
      geometryType: String(m.geometryType ?? ""),
      matrix: m.matrix,
      instances: m.instances ?? null,
      positions: m.positions,
      normals: m.normals,
      index: m.index,
      color: Number.isInteger(m.color) ? m.color : null,
    })),
  };
}

export class SourceFrame {
  /**
   * @param {HTMLElement} container  iframe を置く場所
   * @param {string} html            元の HTML
   * @param {{ onReady?: (revision: string|null) => void }} [callbacks]  最初の描画が行われたとき
   */
  constructor(container, html, { onReady } = {}) {
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.title = "元のページ";
    this.frame.srcdoc = injectHook(html);
    this.pending = new Map();
    this.listener = (event) => {
      if (event.source !== this.frame.contentWindow || !event.data || typeof event.data !== "object") return;
      const { type, id } = event.data;
      if (type === "ipt:ready") onReady?.(typeof event.data.revision === "string" ? event.data.revision : null);
      if (type === "ipt:scene" && this.pending.has(id)) {
        const { resolve, reject, timer } = this.pending.get(id);
        clearTimeout(timer);
        this.pending.delete(id);
        if (event.data.error) reject(new Error(String(event.data.error)));
        else resolve(sanitizeSnapshot(event.data));
      }
    };
    addEventListener("message", this.listener);
    container.replaceChildren(this.frame);
  }

  /** 元のページで今表示されている形状を取り出す。 */
  extract() {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("元のページから応答がありません"));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.frame.contentWindow?.postMessage({ type: "ipt:extract", id }, "*");
    });
  }

  dispose() {
    removeEventListener("message", this.listener);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("閉じられました"));
    }
    this.pending.clear();
    this.frame.remove();
  }
}
