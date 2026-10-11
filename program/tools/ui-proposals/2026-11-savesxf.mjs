// 2026-11（SXF で保存）: 図面を DXF だけでなく SXF（SFC。電子納品・Jw_cad など日本の CAD）でも保存できるようにする入口をどこに・どう置くか。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-savesxf.mjs --states drawing,edit-done
// 今の画面（DXF で保存だけ）の画像で見えたこと:
// ① 見出しの右に「DXF で保存｜R2013 ▾」があるだけで、SXF で保存できることが見えない
// ② 版の欄の「R2013」「R2000」は、どの CAD・どの相手に向くかが書いていない（覚えていないと選べない）
// ③ 右の欄の「図面」のカードに形式（DXF R2018 など）が出ているが、別の形式で保存する手がかりは無い
// 直した後（保存していない）は保存のボタンを主の色にし点を付ける（案 F。docs/ui.md §22）。どの案もこれを保つ。点数は 2026-11-savesxf.json

// 直した後（edit-done）だけ、開いた様子を撮る（メニュー・小窓の案）
const WHEN_DIRTY = (selector) => `
  const run = () => { const el = document.querySelector("${selector}"); if (el) el.hidden = !document.getElementById("save-dxf-group").classList.contains("is-dirty"); };
  new MutationObserver(run).observe(document.getElementById("save-dxf-group"), { attributes: true });
  run();`;
// 見出しの保存の群を隠して、案の部品を同じ場所に置く
const HIDE_CURRENT = `#save-dxf, #dxf-version { display: none !important; }`;
// 主の色（直した後）
const DIRTY = (sel) => `
  .save-dxf.is-dirty ${sel} { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
  .save-dxf.is-dirty ${sel}::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-inline-end: 6px; border-radius: 50%; background: var(--warn); vertical-align: 1px; }`;
const MENU_CSS = `
  .pv-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 360px; padding: 6px; background: var(--surface, #fff);
    border: 1px solid var(--rule); border-radius: 10px; box-shadow: 0 10px 28px rgba(15, 30, 50, .18); display: grid; gap: 2px; }
  .pv-menu[hidden] { display: none; }
  .pv-item { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 8px 10px; border-radius: 8px; text-align: left; }
  .pv-item:hover, .pv-item.is-current { background: var(--accent-soft, #e8f0fb); }
  .pv-item b { font-size: var(--fs-m, 14px); }
  .pv-item small { grid-column: 1 / -1; color: var(--ink-2, #5b6672); font-size: var(--fs-s, 12px); }
  .pv-item kbd { font: 600 11px var(--font-num, monospace); color: var(--ink-2); align-self: center; }
  .pv-sep { height: 1px; margin: 4px 6px; background: var(--rule); }`;
const ITEMS = `
  <div class="pv-item is-current"><b>DXF（R2013）</b><kbd>.dxf</kbd><small>AutoCAD・Inventor など。日本語はそのまま</small></div>
  <div class="pv-item"><b>DXF（R2000）</b><kbd>.dxf</kbd><small>古い CAD・Jw_cad 向け。日本語は Shift_JIS</small></div>
  <div class="pv-sep"></div>
  <div class="pv-item"><b>SXF（SFC）</b><kbd>.sfc</kbd><small>電子納品（国交省）・Jw_cad など日本の CAD。いま見ているレイアウトを 1 枚の用紙に</small></div>`;

export const PROPOSALS = [
  {
    key: "A",
    name: "版の欄を形式の欄に（DXF R2013・DXF R2000・SXF）。ボタンの名前が選んだ形式に変わる",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-a-save")}
      #pv-a { display: flex; } #pv-a button { border-start-end-radius: 0; border-end-end-radius: 0; }
      #pv-a select { padding: 0 6px; border: 1px solid var(--rule); border-inline-start: 0; border-start-end-radius: 8px; border-end-end-radius: 8px; background: var(--surface); }`,
    ops: [["insert", `<div id="pv-a"><button type="button" class="secondary" id="pv-a-save">DXF で保存</button>
      <select aria-label="保存の形式"><option>DXF R2013</option><option>DXF R2000</option><option>SXF（SFC）</option></select></div>`, "beforeend", "#save-dxf-group"]],
  },
  {
    key: "B",
    name: "形式ごとのボタンを並べる（DXF で保存｜R2013 ▾ と SXF で保存）",
    css: `${DIRTY("#pv-b-dxf")}
      #pv-b-sxf { margin-inline-start: 8px; }`,
    ops: [["insert", `<button type="button" class="secondary" id="pv-b-sxf" title="電子納品・Jw_cad など日本の CAD 向け">SXF で保存</button>`, "beforeend", "#save-dxf-group"],
      ["attr", "#save-dxf", "id", "pv-b-dxf"]],
  },
  {
    key: "C",
    name: "「保存 ▾」の 1 つにまとめ、押すと形式のメニュー（向く相手の説明つき）",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-c-save")} ${MENU_CSS}
      #pv-c { position: relative; }`,
    ops: [["insert", `<div id="pv-c"><button type="button" class="secondary" id="pv-c-save">保存 ▾</button><div class="pv-menu" id="pv-c-menu">${ITEMS}</div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-c-menu")]],
  },
  {
    key: "D",
    name: "分割ボタン: 左は前に使った形式ですぐ保存（DXF R2013 で保存）、右の ▾ で形式のメニュー",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-d-save")} ${MENU_CSS}
      #pv-d { position: relative; display: flex; }
      #pv-d-save { border-start-end-radius: 0; border-end-end-radius: 0; }
      #pv-d-more { padding: 0 10px; border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start: 0; }`,
    ops: [["insert", `<div id="pv-d"><button type="button" class="secondary" id="pv-d-save">DXF R2013 で保存</button><button type="button" class="secondary" id="pv-d-more" aria-label="形式を選ぶ">▾</button>
      <div class="pv-menu" id="pv-d-menu">${ITEMS}</div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-d-menu")]],
  },
  {
    key: "E",
    name: "「保存…」で小窓: 形式を 3 つのカード（説明つき）から選び、保存を押す",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-e-save")}
      #pv-e { position: relative; }
      #pv-e-pop { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 420px; padding: 14px; background: var(--surface, #fff);
        border: 1px solid var(--rule); border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 30, 50, .2); display: grid; gap: 8px; }
      #pv-e-pop[hidden] { display: none; }
      #pv-e-pop h3 { margin: 0 0 2px; font-size: var(--fs-m, 14px); }
      .pv-card { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 10px; }
      .pv-card.is-current { border-color: var(--accent); background: var(--accent-soft, #e8f0fb); }
      .pv-card i { grid-row: span 2; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%; border: 2px solid var(--rule); }
      .pv-card.is-current i { border: 4px solid var(--accent); }
      .pv-card small { color: var(--ink-2); font-size: var(--fs-s, 12px); }
      #pv-e-pop footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }`,
    ops: [["insert", `<div id="pv-e"><button type="button" class="secondary" id="pv-e-save">保存…</button>
      <div id="pv-e-pop"><h3>形式を選んで保存</h3>
        <div class="pv-card is-current"><i></i><b>DXF（R2013）</b><small>AutoCAD・Inventor など。日本語はそのまま</small></div>
        <div class="pv-card"><i></i><b>DXF（R2000）</b><small>古い CAD・Jw_cad 向け。日本語は Shift_JIS</small></div>
        <div class="pv-card"><i></i><b>SXF（SFC）</b><small>電子納品（国交省）・Jw_cad など日本の CAD。いま見ているレイアウトを 1 枚の用紙に</small></div>
        <footer><button type="button" class="quiet">やめる</button><button type="button" class="primary">保存</button></footer></div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-e-pop")]],
  },
  {
    key: "F",
    name: "見出しは「DXF で保存」のまま、右の欄の図面のカードに「別の形式で保存」の行（DXF R2000・SXF）",
    css: `
      #pv-f { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--rule); align-items: center; }
      #pv-f span { color: var(--ink-2); font-size: var(--fs-s, 12px); }
      #pv-f div { display: flex; gap: 6px; flex-wrap: wrap; }
      #pv-f button { padding: 4px 10px; font-size: var(--fs-s, 12px); }
      #dxf-version { display: none !important; } #save-dxf { border-radius: 8px !important; }`,
    ops: [["insert", `<div id="pv-f"><span>別の形式で</span><div><button type="button" class="secondary">DXF R2000 で保存</button><button type="button" class="secondary">SXF で保存</button></div></div>`, "beforeend", ".key-card"]],
  },
  // ---- 2 回目（1 回目は D と B が僅差。複合案 3 つ＋上位 2 案）----
  {
    key: "G",
    name: "D の分割ボタンの隣に「SXF で保存」（B×D。▾ は DXF の版と説明）",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-g-save")} ${MENU_CSS}
      #pv-g { position: relative; display: flex; gap: 8px; } #pv-g .split { display: flex; }
      #pv-g-save { border-start-end-radius: 0; border-end-end-radius: 0; }
      #pv-g-more { padding: 0 10px; border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start: 0; }`,
    ops: [["insert", `<div id="pv-g"><div class="split"><button type="button" class="secondary" id="pv-g-save">DXF R2013 で保存</button><button type="button" class="secondary" id="pv-g-more" aria-label="DXF の版">▾</button></div>
      <button type="button" class="secondary">SXF で保存</button><div class="pv-menu" id="pv-g-menu">${ITEMS.split('<div class="pv-sep">')[0]}</div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-g-menu")]],
  },
  {
    key: "H",
    name: "D の右半分を「形式 ▾」と文字で（ほかの形式があると見て分かる）",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-h-save")} ${MENU_CSS}
      #pv-h { position: relative; display: flex; }
      #pv-h-save { border-start-end-radius: 0; border-end-end-radius: 0; }
      #pv-h-more { padding: 0 10px; border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start: 0; font-weight: 500; color: var(--ink-2); }`,
    ops: [["insert", `<div id="pv-h"><button type="button" class="secondary" id="pv-h-save">DXF R2013 で保存</button><button type="button" class="secondary" id="pv-h-more">形式 ▾</button>
      <div class="pv-menu" id="pv-h-menu">${ITEMS}</div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-h-menu")]],
  },
  {
    key: "I",
    name: "「保存」と今の形式の札（DXF R2013 ▾）。札を押すと説明つきのメニュー（A×D）",
    css: `${HIDE_CURRENT} ${DIRTY("#pv-i-save")} ${MENU_CSS}
      #pv-i { position: relative; display: flex; }
      #pv-i-save { border-start-end-radius: 0; border-end-end-radius: 0; }
      #pv-i-fmt { padding: 0 10px; border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start: 0; font: 600 12px var(--font-num, monospace); }`,
    ops: [["insert", `<div id="pv-i"><button type="button" class="secondary" id="pv-i-save">保存</button><button type="button" class="secondary" id="pv-i-fmt">DXF R2013 ▾</button>
      <div class="pv-menu" id="pv-i-menu">${ITEMS}</div></div>`, "beforeend", "#save-dxf-group"],
      ["script", WHEN_DIRTY("#pv-i-menu")]],
  },
];
