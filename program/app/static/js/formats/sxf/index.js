// SXF（国土交通省の電子納品の図面。建設情報標準化委員会の SXF Ver.3.x）を読む。2 つの書き方がある:
//   SFC（.sfc）… ISO 10303-21 の外枠の DATA 部に、注記（/*SXF … SXF*/）として「#番号 = 名前_feature('引数', …)」を並べた簡易形式
//   P21（.p21）… ISO 10303-21 の AP202（ASSOCIATIVE_DRAUGHTING）の実体（p21.js が SFC と同じフィーチャの並びに直す）
// どちらも見出しの FILE_DESCRIPTION が 'SCADEC level2 feature_mode'（SFC）・'SCADEC level2 AP202_mode'（P21）。
//
// readSxf(bytes) → { kind: "sfc"|"p21", header, features: [{ id, name（"line" など。_feature を外す）, params }], warnings }
//   params … 引数の文字列の並び（数は文字列のまま。'(1,2)' のような並びも文字列）。意味づけは cad2d/from-sxf.js
// 文字の符号: UTF-8 として読めなければ Shift_JIS（日本の CAD の多くは Shift_JIS で書く）

import { StepError, parseStep } from "../step/p21.js";
import { featuresFromP21 } from "./p21.js";
import { SxfError } from "./tables.js";

export { SxfError };

const head = (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 2048));

/** SXF か（ISO 10303-21 の見出しに SCADEC か ASSOCIATIVE_DRAUGHTING がある。3D の STEP と見分ける） */
export function isSxf(bytes) {
  const h = head(bytes);
  return /^\s*ISO-10303-21\s*;/.test(h) && /SCADEC|ASSOCIATIVE_DRAUGHTING/i.test(h);
}

export function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export function readSxf(bytes) {
  const text = decodeText(bytes);
  let step;
  try {
    step = parseStep(text);
  } catch (error) {
    if (error instanceof StepError) throw new SxfError(`ISO 10303-21 の外枠として読めません（${error.message}）`);
    throw error;
  }
  const sfc = /feature_mode/i.test(step.header.description ?? "") || (step.records.size === 0 && text.includes("/*SXF"));
  if (sfc) return { kind: "sfc", header: step.header, ...featuresFromSfc(text) };
  return { kind: "p21", header: step.header, ...featuresFromP21(step) };
}

/** SFC: 注記 /*SXF … SXF*\/ の中のフィーチャを順に読む */
export function featuresFromSfc(text) {
  const features = [];
  const warnings = [];
  const block = /\/\*SXF([\d.]*)\s*([\s\S]*?)\s*SXF\1\*\//g; // /*SXF … SXF*/（Ver.3 で増えたものは /*SXF3 … SXF3*/・/*SXF3.1 … SXF3.1*/）
  for (let m = block.exec(text); m; m = block.exec(text)) {
    const call = /#(\d+)\s*=\s*([A-Za-z_]\w*)\s*\(/y;
    const body = m[2];
    for (let pos = 0; pos < body.length;) {
      while (/\s/.test(body[pos] ?? "")) pos++;
      if (pos >= body.length) break;
      call.lastIndex = pos;
      const head = call.exec(body);
      if (!head) {
        warnings.push(`読めないフィーチャ: ${body.slice(pos, pos + 60)}`);
        break;
      }
      const { params, end } = readParams(body, call.lastIndex);
      features.push({ id: Number(head[1]), name: head[2].toLowerCase().replace(/_feature$/, ""), params });
      pos = end;
    }
  }
  if (!features.length) throw new SxfError("SFC のフィーチャ（/*SXF … SXF*/）が見つかりません");
  return { features, warnings };
}

/**
 * 引数の並び（開きの括弧の次から）。文字の引数は \'…\'（CAD の多く）か '…'（どちらも）。数・並びも '…' で囲む。
 * 囲みの無い値（数など）も受ける。答えは引数の文字列の並びと、閉じの括弧の次の位置
 */
function readParams(s, pos) {
  const params = [];
  for (;;) {
    while (/[\s,]/.test(s[pos] ?? "")) pos++;
    const c = s[pos];
    if (c === undefined) return { params, end: pos };
    if (c === ")") return { params, end: pos + 1 };
    if (c === "\\" && s[pos + 1] === "'") {
      const end = s.indexOf("\\'", pos + 2);
      params.push(s.slice(pos + 2, end < 0 ? s.length : end));
      pos = end < 0 ? s.length : end + 2;
    } else if (c === "'") {
      const end = s.indexOf("'", pos + 1);
      params.push(s.slice(pos + 1, end < 0 ? s.length : end));
      pos = end < 0 ? s.length : end + 1;
    } else {
      const end = s.slice(pos).search(/[,)]/);
      params.push(s.slice(pos, end < 0 ? s.length : pos + end).trim());
      pos = end < 0 ? s.length : pos + end;
    }
  }
}
