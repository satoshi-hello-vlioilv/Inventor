// 2026-11（作る流れの右の欄）: 変換データ・HTML から CAD を作る間と作った後に、右の欄をどう組むと、結果を読み、問題の部品を直し、
// 次にすること（保存先を開く・直して作り直す）に迷わず進めるか。状態は spec（作る前）・building（作っている途中）・done（全て一致）・
// mixed（不一致と失敗が混じる）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-11-buildpanel.mjs --states spec,building,done,mixed
// 今の画面（2.10.0）を撮って見えたこと:
// ① 照合の升目（01〜25）と、下の「作る部品」の行がつながらない。行に番号が無く、名前も違う（升目の 04 ＝ 行の「回転体 φ160 × 1710」）。
//    寸法を直すのは行を押してなので、04 が不一致と分かっても、どの行を押せばよいかを探す
// ② 作り終えると、結果の欄が上に入り、部品の一覧が下へ押し出される。フル HD では一覧が 2 行しか見えず、欄の先に 20 以上の操作が隠れる
// ③ 結果の例外の行（不一致・失敗）は読むだけで、押しても何も起きない（3D で見る・寸法を直すへ進めない）
// ④ 作る間の進み具合が 3 か所に出る（段階の帯の 6 / 25・結果の帯と升目・ドックの文と棒）。凡例も 2 か所（結果の欄と 3D の右下）
// 案の共通: 中身（部品・結果・数）は同じ。並べ方と見せ方を変える。番号は変換データの部品の順（升目と同じ）。
// 案は今の画面に CSS と、描き直しのたびに当て直す script（LIVE）で再現する（build.js が 0.8 秒ごとに結果の欄を描き直すため）。

// 頁の中で使う道具（升目・行・結果を読む）
const PRE = `
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const no = (i) => String(i + 1).padStart(2, "0");
  const cells = () => $$("#build-summary .verdict-grid li");
  const rows = () => $$("#parts > li").filter((li) => li.querySelector(".feature"));
  const toneOf = (i) => cells()[i]?.dataset.tone ?? null; // ok・warn・bad・run・wait（作る前は null）
  const shown = () => !$("#result-card").hidden && cells().length > 0;
  const LABEL = { ok: "一致", warn: "不一致", bad: "失敗", run: "作成中", wait: "待ち" };
  const detail = (i) => {
    const lines = (cells()[i]?.title ?? "").split("\\n"); // 結果の名前・部品の名前・差か理由・…（build.js の升目の title）
    const diff = lines.find((l) => l.startsWith("体積の差"))?.replace(/ · 表面積.*/, "").replace("体積の差 ", "体積 ") ?? "";
    return { diff, error: toneOf(i) === "bad" ? lines[2] ?? "" : "" };
  };
  const indexOf = (li) => { if (li.dataset.pv === undefined) li.dataset.pv = rows().indexOf(li); return Number(li.dataset.pv); };
  const partNo = (li) => Number(li.querySelector(".name")?.textContent.match(/^(\\d+)_/)?.[1] ?? 0) - 1; // 結果の行 → 部品の番号（無ければ -1）
  const ensure = (parent, cls, tag = "span", where = "append") => {
    let el = parent.querySelector(":scope > ." + cls);
    if (!el) { el = document.createElement(tag); el.className = cls; parent[where](el); }
    return el;
  };
  const badge = (b, i) => { const n = ensure(b, "pv-no", "span", "prepend"); n.textContent = no(i); const t = toneOf(i); if (t) n.dataset.tone = t; else delete n.dataset.tone; };`;

// 描き直しのたびに当て直す（自分の書き換えでは呼ばれないよう、当てる間は見張りを外す）
const LIVE = (body) => `${PRE}
  const watch = new MutationObserver(() => run());
  const observe = () => ["build-summary", "build-results", "parts", "result-card", "spec-tally", "dock"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "data-tone", "title"] });
  });
  function run() { watch.disconnect(); try { ${body} } catch (e) { console.warn(e); } finally { observe(); } }
  run();`;

// 行の番号の札（升目と同じ色）。A と組合せで使う
const BADGE_CSS = `
  #parts .feature { grid-template-columns: 2.5em minmax(2.8em, max-content) 1fr auto; }
  #parts .feature .sub, #parts .feature .note, #parts .feature .pv-line { grid-column: 3 / 5; }
  .pv-no { grid-row: span 2; align-self: start; margin-top: 1px; height: 24px; display: grid; place-items: center; border: 1.5px solid var(--rule);
    border-radius: 6px; font: 600 var(--fs-xs) var(--font-num); font-variant-numeric: tabular-nums; color: var(--muted); }
  .pv-no[data-tone]:not([data-tone="wait"]) { border-color: var(--tone); background: color-mix(in srgb, var(--tone) 16%, var(--surface)); color: color-mix(in srgb, var(--tone) 80%, var(--ink)); }
  .pv-no[data-tone="warn"] { color: var(--caution-ink); }`;
const BADGE = `rows().forEach((li) => badge(li.querySelector(".feature"), indexOf(li)));`;


// 結果を部品の行に溶かす（D と組合せ）。fix … 問題の行に「寸法を直す」、compact … 一致の行を 1 行に、group … 一致の行を 1 行にまとめて畳む
const MERGED_CSS = `${BADGE_CSS}
  .pv-line { font-size: var(--fs-xs); font-weight: 600; color: var(--tone-ink); display: flex; gap: 6px; align-items: baseline; }
  .pv-line::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); transform: translateY(-1px); }
  .pv-line b { white-space: nowrap; }
  .pv-line span { font-weight: 400; font-family: var(--font-num); }
  .pv-line[data-tone="bad"] span { font-family: var(--font-ui); }
  .pv-fix { grid-column: 3 / 5; justify-self: start; margin-top: 4px; padding: 3px 12px; border: 1px solid var(--accent); border-radius: 6px;
    color: var(--accent); font-size: var(--fs-xs); font-weight: 600; background: var(--surface); }
  #parts .feature.pv-ok { padding-block: 6px; } #parts .feature.pv-ok .sub { display: none; } #parts .feature.pv-ok .dim { font-size: var(--fs-m); }
  .pv-group { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 9px 10px; margin-top: 6px; border: 1px solid var(--rule); border-radius: 8px;
    background: var(--surface-2); font-size: var(--fs-s); }
  .pv-group b { color: var(--ok); } .pv-group span:last-child { color: var(--accent); font-weight: 600; white-space: nowrap; }`;
const MERGED = ({ fix = false, compact = false, group = false } = {}) => `
  const on = shown();
  $("#build-summary .verdict-grid")?.toggleAttribute("hidden", on);
  $$("#build-results li").forEach((li) => { li.hidden = on && partNo(li) >= 0; });
  const ORDER = { bad: 0, warn: 1, run: 2, ok: 3, wait: 4 };
  const items = rows();
  items.forEach((li) => {
    const i = indexOf(li), b = li.querySelector(".feature"), t = toneOf(i);
    badge(b, i);
    const show = on && t && t !== "ok" && t !== "wait";
    const line = ensure(b, "pv-line");
    line.hidden = !show;
    if (show) { const d = detail(i); line.dataset.tone = t; line.innerHTML = '<b>' + LABEL[t] + '</b><span>' + (t === "bad" ? d.error : d.diff) + '</span>'; }
    const fixer = ensure(b, "pv-fix");
    fixer.textContent = "寸法を直す";
    fixer.hidden = !(${fix} && on && (t === "warn" || t === "bad"));
    b.classList.toggle("pv-ok", ${compact} && on && (t === "ok" || t === "wait"));
    li.hidden = ${group} && on && (t === "ok" || t === "wait");
  });
  const key = (li) => (on ? (ORDER[toneOf(indexOf(li))] ?? 5) * 1000 : 0) + indexOf(li);
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  if (sorted.some((li, k) => li !== items[k])) $("#parts").append(...sorted);
  if (${group}) {
    const t = cells().map((c) => c.dataset.tone);
    const groups = [["ok", "一致した"], ["wait", "待ちの"]].map(([tone, label]) => [label, t.map((x, i) => [x, i]).filter(([x]) => x === tone).map(([, i]) => no(i))]).filter(([, list]) => list.length);
    $$("#parts > .pv-group-li").forEach((x) => x.remove());
    if (on) for (const [label, list] of groups) {
      const li = document.createElement("li");
      li.className = "pv-group-li";
      li.innerHTML = '<button type="button" class="pv-group"><span><b>' + label + ' ' + list.length + ' 部品</b>（' + list[0] + '〜' + list[list.length - 1] + '）</span><span>開く ▾</span></button>';
      $("#parts").append(li);
    }
  }`;

export const PROPOSALS = [
  {
    key: "A", name: "番号でつなぐ: 部品の行に升目と同じ番号の札（色も結果と同じ）。升目を押すとその行へ移り、寸法を直せる",
    css: BADGE_CSS,
    ops: [["script", LIVE(BADGE)]],
  },
  {
    key: "B", name: "作り終えたら一覧を畳む: 結果が出たら部品の一覧を 1 行に畳み（開ける）、例外の行に部品の種類と寸法・「寸法を直す」",
    css: `
      .pv-collapsed { display: flex; justify-content: space-between; gap: 8px; align-items: center; width: 100%; padding: 9px 12px; border: 1px solid var(--rule);
        border-radius: 8px; background: var(--surface-2); font: inherit; font-size: var(--fs-s); color: var(--ink); text-align: start; }
      .pv-collapsed .pv-open { color: var(--accent); font-weight: 600; white-space: nowrap; }
      #build-results li { row-gap: 4px; }
      .pv-dim { grid-column: 2 / 4; display: flex; align-items: center; justify-content: space-between; gap: 8px; font: var(--fs-s) var(--font-num); }
      .pv-dim b { font: 600 var(--fs-xs) var(--font-ui); color: var(--muted); margin-right: 6px; }
      .pv-fix { padding: 2px 10px; font-size: var(--fs-xs); white-space: nowrap; }`,
    ops: [["script", LIVE(`
      const card = $("#parts").closest("section");
      const on = shown();
      $("#parts").hidden = on;
      $("#spec-tally").hidden = on;
      const c = ensure(card, "pv-collapsed", "button");
      card.querySelector("h2").after(c);
      c.type = "button";
      c.hidden = !on;
      const tally = $$("#spec-tally .tally-chip").map((x) => x.textContent.replace(/\\s+/g, " ").trim()).join("・");
      c.innerHTML = '<span>' + tally + '</span><span class="pv-open">一覧を開く ▾</span>';
      $$("#build-results li").forEach((li) => {
        const i = partNo(li), row = rows()[i]?.querySelector(".feature");
        if (i < 0 || !row) return;
        const d = ensure(li, "pv-dim");
        d.innerHTML = '<span><b>' + row.querySelector(".kind").textContent + '</b>' + row.querySelector(".dim").textContent + '</span>' +
          (li.querySelector(".verdict").dataset.tone === "run" ? "" : '<button type="button" class="secondary pv-fix">寸法を直す</button>');
      });`)]],
  },
  {
    key: "C", name: "タブで切り替える: 結果が出たら欄の上に「照合の結果｜作る部品」のタブ。結果を選んでいる間は一覧を出さない",
    css: `
      .pv-tabs { order: -9; position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 0 -16px; padding: 10px 16px 0;
        background: var(--surface); border-bottom: 1px solid var(--rule); }
      .pv-tabs button { display: flex; justify-content: center; gap: 8px; align-items: baseline; padding: 8px 6px 9px; border: 0; border-bottom: 3px solid transparent;
        border-radius: 0; background: none; font: inherit; font-size: var(--fs-m); color: var(--muted); }
      .pv-tabs button[aria-selected="true"] { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
      .pv-tabs b { font: 600 var(--fs-xs) var(--font-num); padding: 1px 7px; border-radius: 999px; background: var(--surface-2); }
      .pv-tabs b[data-tone] { background: var(--tone-soft); color: var(--tone-ink); }
      #result-card h2 { display: none; }`,
    ops: [["script", LIVE(`
      const card = $("#parts").closest("section");
      const tabs = ensure($("#side-scroll"), "pv-tabs", "div", "prepend");
      tabs.setAttribute("role", "tablist");
      const on = shown();
      tabs.hidden = !on;
      card.hidden = on;
      const t = cells().map((c) => c.dataset.tone);
      const problems = t.filter((x) => x === "warn" || x === "bad").length;
      const busy = t.some((x) => x === "run" || x === "wait");
      const label = busy ? (t.filter((x) => x !== "wait" && x !== "run").length + " / " + t.length) : problems ? "要確認 " + problems : "全て一致";
      const tone = busy ? "run" : problems ? "warn" : "ok";
      tabs.innerHTML = '<button type="button" role="tab" aria-selected="true">照合の結果<b data-tone="' + tone + '">' + label + '</b></button>' +
        '<button type="button" role="tab" aria-selected="false">作る部品<b>' + rows().length + '</b></button>';`)]],
  },
  {
    key: "D", name: "結果を行に溶かす: 升目と例外の行をやめ、部品の行に番号と結果（差・理由）を出し、問題の行を先に並べる。帯と数は残す",
    css: MERGED_CSS,
    ops: [["script", LIVE(MERGED())]],
  },
  {
    key: "E", name: "文で要約し、問題の部品を札で: 升目をやめ、「25 部品のうち 3 部品を確かめてください」と問題の部品の札（番号・結果）を並べる",
    css: `
      .pv-say { margin: 0; font-size: var(--fs-m); font-weight: 600; }
      .pv-say small { display: block; font-size: var(--fs-xs); font-weight: 400; color: var(--muted); }
      .pv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .pv-chips button { display: inline-flex; gap: 6px; align-items: baseline; padding: 4px 10px; border: 1px solid var(--tone); border-radius: 999px;
        background: var(--tone-soft); color: var(--tone-ink); font: 600 var(--fs-s) var(--font-num); }
      .pv-chips button span { font: 600 var(--fs-xs) var(--font-ui); }
      #build-summary .verdict-legend, #build-summary .verdict-grid { display: none; }
      #build-summary .verdict-bar { height: 8px; }`,
    ops: [["script", LIVE(`
      const box = $("#build-summary");
      if (!shown()) return;
      const t = cells().map((c) => c.dataset.tone);
      const made = t.filter((x) => x !== "wait" && x !== "run").length;
      const bad = t.map((x, i) => [x, i]).filter(([x]) => x === "warn" || x === "bad" || x === "run");
      const busy = t.some((x) => x === "run" || x === "wait");
      const say = ensure(box, "pv-say", "p", "prepend");
      say.innerHTML = busy ? t.length + " 部品のうち " + made + " 部品を作りました<small>作り終えた部品から 3D を緑（一致）・琥珀（不一致）・赤（失敗）に塗ります</small>"
        : bad.length ? t.length + " 部品のうち " + bad.length + " 部品を確かめてください<small>ほかの " + (t.length - bad.length) + " 部品は期待値と一致しました。札を押すと、その部品を 3D で示し、寸法を直せます</small>"
        : "全ての部品（" + t.length + "）が期待値と一致しました";
      const chips = ensure(box, "pv-chips", "div");
      chips.innerHTML = bad.map(([x, i]) => '<button type="button" data-tone="' + x + '">' + no(i) + '<span>' + LABEL[x] + '</span></button>').join("");
      chips.hidden = !bad.length;`)]],
  },
  {
    key: "F", name: "【方向の違う案】結果を 3D の上に: 帯・数・升目を 3D の左上に重ね（色を塗った形のすぐそば）、右の欄は例外の行と部品の一覧だけ",
    css: `
      #build-summary { position: absolute; left: 16px; top: 64px; z-index: 3; width: 340px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 10px;
        background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: var(--shadow-1); }
      #build-summary::before { content: "照合の結果"; font-size: var(--fs-s); font-weight: 600; }
      #stage-legend { display: none !important; }
      #result-card h2 { font-size: var(--fs-s); }`,
    ops: [["move", "#build-summary", "append", "#stage"]],
  },
  {
    key: "G", name: "【方向の違う案】1 つの表にする: 部品を 1 行ずつの表（番号・種類・寸法・数・結果）にし、升目と例外の行をやめる。25 部品が欄に収まる",
    css: `
      #parts .feature { grid-template-columns: 2.2em 3.6em minmax(0, 1fr) 2.6em 6.6em; padding: 5px 4px; column-gap: 8px; align-items: center; border-inline-start: 0 !important; }
      #parts .feature .sub, #parts .feature .note { display: none; }
      #parts .feature .dim { font-size: var(--fs-s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #parts .feature .count { text-align: end; font-size: var(--fs-xs); }
      .pv-no { font: 600 var(--fs-xs) var(--font-num); color: var(--muted); }
      .pv-v { justify-self: end; font: 600 var(--fs-xs) var(--font-num); color: var(--tone-ink); white-space: nowrap; }
      .pv-v[data-tone="ok"]::before, .pv-v[data-tone="warn"]::before, .pv-v[data-tone="bad"]::before, .pv-v[data-tone="run"]::before {
        content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--tone); margin-right: 5px; }
      .pv-err { grid-column: 3 / 6; font-size: var(--fs-xs); color: var(--critical); }
      .pv-head { display: grid; grid-template-columns: 2.2em 3.6em minmax(0, 1fr) 2.6em 6.6em; column-gap: 8px; padding: 0 4px 4px; font-size: var(--fs-xs); color: var(--muted);
        border-bottom: 1px solid var(--rule); }
      .pv-head span:nth-child(4), .pv-head span:nth-child(5) { text-align: end; }
      #build-summary .verdict-grid { display: none; }`,
    ops: [["script", LIVE(`
      const on = shown();
      $$("#build-results li").forEach((li) => { li.hidden = on && partNo(li) >= 0; });
      const head = ensure($("#parts").parentElement, "pv-head", "div");
      $("#parts").before(head);
      head.innerHTML = "<span>No</span><span>種類</span><span>寸法</span><span>数</span><span>結果</span>";
      rows().forEach((li) => {
        const i = indexOf(li), b = li.querySelector(".feature"), t = toneOf(i);
        const n = ensure(b, "pv-no", "span", "prepend"); n.textContent = no(i);
        const v = ensure(b, "pv-v");
        const d = detail(i);
        v.dataset.tone = t ?? "wait";
        v.textContent = !t ? "—" : t === "warn" ? d.diff.replace("体積 ", "") : LABEL[t];
        const e = ensure(b, "pv-err");
        e.hidden = t !== "bad";
        e.textContent = t === "bad" ? d.error : "";
      });`)]],
  },
  // ---- 2 回目: 1 回目の案のエッセンスを組み合わせた 4 案（1 回目の上位 3 案 D・B・C と比べる） ----
  {
    key: "H", name: "【組合せ】D × A × B × G: 1 つの番号つき一覧に結果を溶かし、問題の行を先頭に、その行に理由と「寸法を直す」。一致の行は 1 行に詰める",
    css: MERGED_CSS,
    ops: [["script", LIVE(MERGED({ fix: true, compact: true }))]],
  },
  {
    key: "I", name: "【組合せ】B × A: 結果が出たら一覧を畳み、例外の行に番号の札・部品の寸法・「寸法を直す」。升目は残す",
    css: `${BADGE_CSS}
      .pv-collapsed { display: flex; justify-content: space-between; gap: 8px; align-items: center; width: 100%; padding: 9px 12px; border: 1px solid var(--rule);
        border-radius: 8px; background: var(--surface-2); font: inherit; font-size: var(--fs-s); color: var(--ink); text-align: start; }
      .pv-collapsed .pv-open { color: var(--accent); font-weight: 600; white-space: nowrap; }
      #build-results li { grid-template-columns: 2.4em 4.4em minmax(0, 1fr) auto; row-gap: 4px; }
      #build-results li > .pv-no { grid-row: auto; height: 22px; }
      #build-results li:not(:has(.pv-no)) > .verdict { grid-column: 2; }
      #build-results .error, .pv-dim { grid-column: 3 / 5; }
      .pv-dim { display: flex; align-items: center; justify-content: space-between; gap: 8px; font: var(--fs-s) var(--font-num); }
      .pv-dim b { font: 600 var(--fs-xs) var(--font-ui); color: var(--muted); margin-right: 6px; }
      .pv-fix { padding: 2px 10px; font-size: var(--fs-xs); white-space: nowrap; }`,
    ops: [["script", LIVE(`
      const card = $("#parts").closest("section");
      const on = shown();
      $("#parts").hidden = on;
      $("#spec-tally").hidden = on;
      const c = ensure(card, "pv-collapsed", "button");
      card.querySelector("h2").after(c);
      c.type = "button";
      c.hidden = !on;
      const tally = $$("#spec-tally .tally-chip").map((x) => x.textContent.replace(/\\s+/g, " ").trim()).join("・");
      c.innerHTML = '<span>' + tally + '</span><span class="pv-open">一覧を開く ▾</span>';
      $$("#build-results li").forEach((li) => {
        const i = partNo(li), row = rows()[i]?.querySelector(".feature");
        if (i < 0 || !row) return;
        badge(li, i);
        const d = ensure(li, "pv-dim");
        d.innerHTML = '<span><b>' + row.querySelector(".kind").textContent + '</b>' + row.querySelector(".dim").textContent + '</span>' +
          (li.querySelector(".verdict").dataset.tone === "run" ? "" : '<button type="button" class="secondary pv-fix">寸法を直す</button>');
      });`)]],
  },
  {
    key: "J", name: "【組合せ】E × D: 一文の要約（何部品を確かめるか）と、問題の行を先頭にした番号つきの 1 つの一覧。升目・例外の行・凡例をやめる",
    css: `${MERGED_CSS}
      .pv-say { margin: 0; font-size: var(--fs-m); font-weight: 600; }
      .pv-say small { display: block; font-size: var(--fs-xs); font-weight: 400; color: var(--muted); }
      #build-summary .verdict-legend { display: none; }
      #build-summary .verdict-bar { height: 8px; }`,
    ops: [["script", LIVE(`${MERGED()}
      if (on) {
        const t = cells().map((c) => c.dataset.tone);
        const made = t.filter((x) => x !== "wait" && x !== "run").length;
        const bad = t.filter((x) => x === "warn" || x === "bad").length;
        const busy = t.some((x) => x === "run" || x === "wait");
        const say = ensure($("#build-summary"), "pv-say", "p", "prepend");
        say.innerHTML = busy ? t.length + " 部品のうち " + made + " 部品を作りました<small>作り終えた部品から、下の一覧と 3D に結果を出します</small>"
          : bad ? t.length + " 部品のうち " + bad + " 部品を確かめてください<small>ほかの " + (t.length - bad) + " 部品は期待値と一致しました。行を押すと寸法を直せます</small>"
          : "全ての部品（" + t.length + "）が期待値と一致しました";
      }`)]],
  },
  {
    key: "K", name: "【組合せ】D × B × C: 問題の行（理由と「寸法を直す」）だけを開いて並べ、一致・待ちの部品は 1 行にまとめて畳む。帯と数は残す",
    css: MERGED_CSS,
    ops: [["script", LIVE(MERGED({ fix: true, group: true }))]],
  },
];
