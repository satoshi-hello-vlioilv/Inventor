// 単位の欄（右の欄の「単位」。段階の帯の「単位を確かめる」から移れる）: シーンの 1 単位が何 mm かを選ぶ。形の大きさを実寸で並べ、選んだ単位が正しいかを確かめられるようにする。
// 選んだ単位は HTML のファイル名ごとに覚える（このブラウザーだけ。次に同じ HTML を開いたとき選び直さなくてよい）。

import { UNIT_PRESETS, formatSize, guessUnit, sceneExtent } from "../convert/units.js";
import { updateFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
const KEY = (name) => `inventor3d.unit:${name}`;
const ORIGIN_NOTE = {
  guess: "大きさから推定した単位です。実物の大きさと違えば選び直してください",
  remembered: "前回この HTML で選んだ単位です",
  chosen: "",
};

let state = { name: "", extent: null, mm: 1, origin: "guess", onChange: () => {} };

function recall(name) {
  try {
    const mm = Number(localStorage.getItem(KEY(name)));
    return mm > 0 && Number.isFinite(mm) ? mm : null;
  } catch {
    return null;
  }
}

function keep(name, mm) {
  try {
    localStorage.setItem(KEY(name), String(mm));
  } catch {
    // 保存できないブラウザーでは覚えない（毎回推定する）
  }
}

const presetOf = (mm) => UNIT_PRESETS.find((u) => Math.abs(u.mm - mm) <= 1e-12 * u.mm);

function render() {
  const preset = presetOf(state.mm);
  $("unit-select").value = preset ? preset.key : "custom";
  $("unit-custom").hidden = Boolean(preset);
  if (!preset && document.activeElement !== $("unit-mm")) $("unit-mm").value = String(state.mm);
  const size = state.extent ? `全体 ${formatSize(state.extent.map((v) => v * state.mm))}` : "";
  $("unit-note").textContent = [size, ORIGIN_NOTE[state.origin]].filter(Boolean).join("。");
  $("unit-note").dataset.origin = state.origin;
  updateFlow({ unit: { origin: state.origin, label: preset ? `1 ${preset.label}` : `${state.mm} mm` } }); // 段階の帯「単位を確かめる」
}

function apply(mm) {
  if (!(mm > 0 && Number.isFinite(mm)) || mm === state.mm) return render();
  state.mm = mm;
  state.origin = "chosen";
  keep(state.name, mm);
  render();
  state.onChange(mm);
}

/**
 * 取り込んだシーンの単位を決めて欄に出す（前回選んだ単位 → 大きさからの推定の順）。
 * @param {(mm: number) => void} onChange  利用者が単位を変えたとき
 * @returns {number} 1 単位の長さ（mm）
 */
export function setupUnit(name, snapshot, onChange) {
  const extent = sceneExtent(snapshot);
  const saved = recall(name);
  state = { name, extent, mm: saved ?? guessUnit(extent).mm, origin: saved ? "remembered" : "guess", onChange };
  render();
  return state.mm;
}

$("unit-select").replaceChildren(
  ...UNIT_PRESETS.map((u) => new Option(`1 ${u.label}`, u.key)),
  new Option("任意の長さ…", "custom"),
);
$("unit-select").addEventListener("change", (event) => {
  const preset = UNIT_PRESETS.find((u) => u.key === event.currentTarget.value);
  if (preset) return apply(preset.mm);
  $("unit-custom").hidden = false;
  $("unit-mm").value = String(state.mm);
  $("unit-mm").focus();
  $("unit-mm").select();
});
$("unit-mm").addEventListener("change", (event) => apply(Number(event.currentTarget.value)));
