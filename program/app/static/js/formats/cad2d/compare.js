// 図面の旧版と新版を比べる（2D の図面のモデル model.js。表示は viewer2d/、画面は ui/）。
//   compareDrawings(older, newer, { olderLayout, newerLayout }) → { items, counts, byHandle, tolerance }
//     items … [{ status, older, newer, changes }]（図形ごとに 1 つ。older・newer は図形か null）
//       status: same（同じ）・changed（同じ図形が変わった）・removed（旧版だけ）・added（新版だけ）
//       changes（changed のとき）: ["shape"（形・位置）, "props"（画層・色・線種・線の太さ）, "text"（文字）] のうち当てはまるもの
//     counts … { same, changed, removed, added }
//     byHandle … 残りの組をハンドルで決めたか（下の 3。DWG・DXF だけ）
//
// 突き合わせ方（上から順に。組にした図形は次へ回さない）:
//   1. 中身がそっくり同じ図形（ハンドルを除いた全ての値）: same。同じ中身の図形が何個もあれば、同じハンドルどうしを先に組にする
//   2. 中身が近い図形（数の差が図面の広がり × NEAR の中。書き出しの丸めの差）: same
//   3. 同じハンドル・同じ種類の図形（DWG・DXF の背番号。AutoCAD は直しても変えない）: changed。1・2 の残りだけで組にするので、
//      ハンドルを振り直した図面（別のソフトで書き出した）でも、変わっていない図形を「変わった」とはしない
//      （PDF・Jw_cad・SXF のハンドルは読み取りが順に振った番号なので使わない）
//   4. 形が同じで、画層・色などだけが違う図形: changed（props）
//   5. 同じ種類・同じ場所（基準の点が近い）の図形: changed（文字を直した・半径を変えたなど）
//   残りは removed（旧版）と added（新版）。ハンドルの無い図面で動かした図形は、removed と added の組になる（どちらにも印が付く）
//
// 中身の比べ方: 図形の値を、ハンドルなどの背番号と、表示のために読み取りが足した値（SKIP）を除いて文字列にする。数は許し幅で丸める
// （許し幅 = 図面の広がり × 1e-9。書き出しの桁の差を吸う）。ブロック参照・表はブロックの中身も比べる（ブロックの定義を直すと、
// その参照は全て changed）。寸法の見た目のブロック（*D…）は寸法の定義点から作られるので比べない（定義点と寸法の値を比べる）。

const STATUS = ["same", "changed", "removed", "added"];
const NEAR = 1e-6; // 2・5 の「近い」: 図面の広がりに対する数の差
const PERSISTENT = new Set(["dwg", "dxf"]); // ハンドルが図形の背番号として続く形式
const PROPS = ["layer", "color", "linetype", "lineweight", "ltscale", "invisible"];
const TEXTS = new Set(["TEXT", "MTEXT", "ATTDEF", "ATTRIB"]);
// 比べない値: 背番号・紙の空間の印・表示のために足した値（2D の稜線 wire・3D の形 acis はバイト列の要約で比べる）
const SKIP = new Set(["handle", "paper", "wire"]);
// 種類ごとの、ブロックの名前を持つ値（名前でなく中身で比べる）と、読み取りが振った名前で比べない値（寸法の見た目のブロック *D…）
const BLOCK_REF = { INSERT: "block", ACAD_TABLE: "block" };
const DERIVED = { DIMENSION: "block" };
// 既定の値（無い・0・false・空）は同じとみなす（読み取りや書き手によって、既定の値を書く・書かないが違う。例: 厚み 0 と厚み無し）
// 0 でない既定の値は表で（押し出しの向き +Z・尺度 1・文字の幅 1）
const DEFAULTS = { extrusion: "[0,0,1]", scale: "[1,1,1]", widthFactor: "1", lineSpacing: "1" };
const unset = (k, v) => v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) ||
  (k in DEFAULTS && JSON.stringify(v) === DEFAULTS[k]);
const compared = (v, k) => !SKIP.has(k) && DERIVED[v.type] !== k && !unset(k, v[k]);

/** レイアウトに直に置かれた図形 */
function entitiesOf(drawing, layout = drawing.layouts[0]) {
  return drawing.blocks.get(layout?.block)?.entities ?? [];
}

/** バイト列の要約（FNV-1a） */
function digest(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return `${bytes.length}:${h.toString(16)}`;
}

/** 図面の広がり（許し幅の物差し）: 座標（数の並び）と長さの最も大きな絶対値。色（rgb は大きな数）・番号などの数は数えない */
const NOT_GEOMETRY = /colou?r|fill|alpha|rgb|weight|index|flags?$/i;
const LENGTHS = new Set(["radius", "height", "width"]);
const PARAMETERS = new Set(["knots", "weights", "dashes", "widths", "bulges"]); // 座標でない数の並び（基準の点に使わない）
function spanOf(entities) {
  let span = 0;
  const visit = (v, inArray, depth) => {
    if (typeof v === "number") { if (inArray && Number.isFinite(v)) span = Math.max(span, Math.abs(v)); }
    else if (Array.isArray(v)) { if (depth < 8) for (const x of v) visit(x, true, depth + 1); }
    else if (v && typeof v === "object" && !ArrayBuffer.isView(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (SKIP.has(k) || PROPS.includes(k) || NOT_GEOMETRY.test(k)) continue;
        if (LENGTHS.has(k) && typeof x === "number" && Number.isFinite(x)) span = Math.max(span, Math.abs(x));
        else visit(x, false, depth + 1);
      }
    }
  };
  for (const e of entities) visit(e, false, 0);
  return span || 1;
}

/** 図形の値を比べられる文字列にする（数は tol で丸める）。block(名前) はブロックの中身の文字列 */
function canonical(value, tol, block, skip = SKIP) {
  const walk = (v, key) => {
    if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v / tol)) : String(v);
    if (v === null || v === undefined) return "null";
    if (typeof v !== "object") return JSON.stringify(v);
    if (ArrayBuffer.isView(v)) return `#${digest(bytesOf(v))}`;
    if (Array.isArray(v)) return `[${v.map((x) => walk(x)).join(",")}]`;
    if (v instanceof Map) return `{${[...v.keys()].sort().map((k) => `${k}:${walk(v.get(k))}`).join(",")}}`;
    const keys = Object.keys(v).filter((k) => compared(v, k) && !skip.has(k)).sort();
    return `{${keys.map((k) => `${k}:${BLOCK_REF[v.type] === k ? `<${block(v[k])}>` : walk(v[k], k)}`).join(",")}}`;
  };
  return walk(value);
}

const bytesOf = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** 2 つの値が近いか（同じ形で、数の差が tol 以内）。ブロックの名前を持つ値は、両方の版のブロックの中身（blockA・blockB）で比べる */
function near(a, b, tol, blockA, blockB) {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= tol;
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && digest(bytesOf(a)) === digest(bytesOf(b));
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a).filter((k) => compared(a, k)), ...Object.keys(b).filter((k) => compared(b, k))]);
  for (const k of keys) {
    const same = BLOCK_REF[a.type] === k && a.type === b.type ? blockA(a[k]) === blockB(b[k]) : near(a[k], b[k], tol, blockA, blockB);
    if (!same) return false;
  }
  return true;
}

/** 基準の点（種類ごとの代表の点。無い種類は、値の中の最初の座標: PDF の線の道筋・ハッチングの境界など） */
export function anchor(e) {
  const p = e.p ?? e.center ?? e.a ?? e.points?.[0] ?? e.vertices?.[0]?.p ?? e.controls?.[0] ?? e.fit?.[0] ?? e.p10 ?? e.base ?? null;
  if (Array.isArray(p)) return p;
  let found = null;
  const visit = (v, depth) => {
    if (found || depth > 6) return;
    if (Array.isArray(v)) {
      if (typeof v[0] === "number" && typeof v[1] === "number") found = [v[0], v[1]];
      else for (const x of v) visit(x, depth + 1);
    } else if (v && typeof v === "object" && !ArrayBuffer.isView(v)) {
      for (const [k, x] of Object.entries(v)) if (!SKIP.has(k) && !PROPS.includes(k) && !NOT_GEOMETRY.test(k) && !PARAMETERS.has(k)) visit(x, depth + 1);
    }
  };
  visit(e, 0);
  return found;
}

/** 図面ごとの、図形とブロックの比べる文字列（ブロックは中身を 1 度だけ計算する） */
function keyer(drawing, tol) {
  const blocks = new Map();
  const block = (name, depth = 0) => {
    if (blocks.has(name)) return blocks.get(name);
    blocks.set(name, "…"); // 自分を含むブロック（壊れた図面）で止める
    const b = drawing.blocks.get(name);
    const text = b ? `${canonical(b.base, tol, block)}|${b.entities.map((e) => canonical(e, tol, block)).join(";")}` : "missing";
    blocks.set(name, digest(new TextEncoder().encode(text)));
    return blocks.get(name);
  };
  const shapeSkip = new Set([...SKIP, ...PROPS]);
  return {
    block,
    full: (e) => canonical(e, tol, block),
    shape: (e) => canonical(e, tol, block, shapeSkip),
  };
}

/** 変わったところ（changed の中身） */
function changesOf(older, newer, ko, kn) {
  const out = [];
  if (ko.shape(older) !== kn.shape(newer)) {
    const textOnly = TEXTS.has(older.type) && older.type === newer.type && older.text !== newer.text && ko.shape({ ...older, text: "" }) === kn.shape({ ...newer, text: "" });
    out.push(textOnly ? "text" : "shape");
  }
  if (PROPS.some((k) => JSON.stringify(older[k]) !== JSON.stringify(newer[k]))) out.push("props");
  return out;
}

/** 旧版と新版を比べる */
export function compareDrawings(older, newer, { olderLayout = older.layouts[0], newerLayout = newer.layouts[0] } = {}) {
  const A = entitiesOf(older, olderLayout), B = entitiesOf(newer, newerLayout);
  const span = Math.max(spanOf(A), spanOf(B));
  const tol = Math.max(span * 1e-9, 1e-12);
  const ko = keyer(older, tol), kn = keyer(newer, tol);
  const close = (a, b) => near(a, b, span * NEAR, ko.block, kn.block);
  const fullA = A.map(ko.full), fullB = B.map(kn.full);
  const usedA = new Array(A.length).fill(false), usedB = new Array(B.length).fill(false);
  const items = [];
  const pair = (i, j, status, changes) => {
    usedA[i] = usedB[j] = true;
    items.push({ status, older: A[i], newer: B[j], ...(changes && { changes }) });
  };
  const rest = (used) => used.map((u, k) => (u ? -1 : k)).filter((k) => k >= 0);
  /** 残りの旧版の図形ごとに、候補（candidates）の中から match する新版の図形を探して組にする（同じハンドルを先に） */
  const pass = (candidates, match, status, changes) => {
    for (const i of rest(usedA)) {
      const list = candidates(i).filter((j) => !usedB[j] && match(i, j));
      const j = list.find((k) => A[i].handle && B[k].handle === A[i].handle) ?? list[0];
      if (j !== undefined) pair(i, j, status, changes?.(A[i], B[j]));
    }
  };
  // 索引（総当たりにしない）: 種類と基準の点の升目（升目の幅は「近い」の許し幅より広い。隣の升目まで見る）・ハンドル・形
  const gap = span * NEAR, size = gap * 4;
  const cellOf = (e, dx = 0, dy = 0) => {
    const p = anchor(e);
    return p ? `${e.type}|${Math.floor(p[0] / size) + dx}|${Math.floor(p[1] / size) + dy}` : `${e.type}|-`;
  };
  const grid = new Map(), handles = new Map();
  B.forEach((e, j) => {
    grid.set(cellOf(e), [...(grid.get(cellOf(e)) ?? []), j]);
    if (e.handle) handles.set(e.handle, [...(handles.get(e.handle) ?? []), j]);
  });
  const around = (i) => (anchor(A[i]) ? [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => grid.get(cellOf(A[i], dx, dy)) ?? [])) : grid.get(cellOf(A[i])) ?? []);
  const sameType = (i) => (j) => B[j].type === A[i].type;

  // 2. 中身が近い（近ければ基準の点も近いので、隣の升目までを見る）
  pass(around, (i, j) => close(A[i], B[j]), "same");
  // 3. 同じハンドル（DWG・DXF）
  const byHandle = PERSISTENT.has(older.format) && PERSISTENT.has(newer.format);
  if (byHandle) pass((i) => (handles.get(A[i].handle) ?? []).filter(sameType(i)), () => true, "changed", (a, b) => changesOf(a, b, ko, kn));
  // 4. 形が同じで、画層・色などだけが違う（残りの図形だけ、形の文字列を 1 度ずつ作る）
  const shapes = new Map();
  for (const j of rest(usedB)) shapes.set(kn.shape(B[j]), [...(shapes.get(kn.shape(B[j])) ?? []), j]);
  pass((i) => shapes.get(ko.shape(A[i])) ?? [], () => true, "changed", () => ["props"]);
  // 5. 同じ場所
  pass(around, (i, j) => {
    const [p, q] = [anchor(A[i]), anchor(B[j])];
    return Boolean(p && q) && Math.hypot(p[0] - q[0], p[1] - q[1]) <= gap;
  }, "changed", (a, b) => changesOf(a, b, ko, kn));

  for (const i of rest(usedA)) items.push({ status: "removed", older: A[i], newer: null });
  for (const j of rest(usedB)) items.push({ status: "added", older: null, newer: B[j] });
  const counts = Object.fromEntries(STATUS.map((k) => [k, items.filter((x) => x.status === k).length]));
  return { items, counts, byHandle, tolerance: tol };
}
