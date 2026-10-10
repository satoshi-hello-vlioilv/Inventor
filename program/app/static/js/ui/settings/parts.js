// 設定のページの部品（区分のどれもが使う DOM の小さな道具と、表示の決まり）。区分の作りは ./panes.js の冒頭の説明

export const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

/** ボタン（kind: primary・secondary・quiet・danger・st-link） */
export function button(label, kind, onClick, title) {
  const b = el("button", `${kind} st-btn`, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** 状態の点（ok・warn・bad・idle） */
export const dot = (tone) => el("i", `dot ${tone}`);

/** 状態の 1 行（点と文） */
export function status(tone, text) {
  const s = el("span", "st-status");
  s.append(dot(tone), text);
  return s;
}

/** 区分の中のまとまり（見出し・説明・中身） */
export function block(title, note, ...children) {
  const s = el("section", "st-block");
  if (title) {
    const h = el("h3", "", title);
    if (note) h.append(el("small", "", note));
    s.append(h);
  }
  s.append(...children.filter(Boolean));
  return s;
}

/** 名前と値と操作の 1 行 */
export function row(name, value, ...actions) {
  const r = el("div", "st-row");
  const v = el("span", "st-val");
  v.append(...(Array.isArray(value) ? value : [value]).filter((x) => x !== null && x !== undefined));
  r.append(el("span", "st-name", name), v);
  if (actions.length) {
    const a = el("span", "st-acts");
    a.append(...actions);
    r.append(a);
  }
  return r;
}

/** 道（等幅。折り返すなら区切りで） */
export const pathText = (text) => el("span", "mono st-path", text ?? "");

export const ROLE_LABEL = { developer: "開発者", maintainer: "メンテナンス者", user: "一般の利用者", unset: "役割が未設定", unknown: "役割が不明（置き場に届かない）" };
export const ROLE_NOTE = {
  developer: "版の管理と、役割の変更ができます",
  maintainer: "版を置く・配る・消すことができます",
  user: "版の一覧を見られます（置く・配るのは開発者とメンテナンス者）",
  unset: "最初の 1 人として、自分を開発者にできます",
  unknown: "置き場に届くと分かります",
};
export const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
export const who = (by) => String(by ?? "").split("@")[0];

/** 変わったことの文（1 行に 1 つ。頭の「・」「-」は外す） */
export const noteLines = (text) => String(text ?? "").split("\n").map((l) => l.replace(/^\s*[・\-*]\s*/, "").trim()).filter(Boolean);
export function noteList(text, list = el("ul", "st-notes-list")) {
  list.replaceChildren(...noteLines(text).map((l) => el("li", "", l)));
  return list;
}
