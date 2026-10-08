// 試験・画面の撮影に使う小さな PDF を作る（アプリでは使わない）。
//   pdfFile(objects) … オブジェクト（1 から番号。文字列か { dict, data }（ストリーム））を並べ、相互参照表と trailer を付ける（1 番が /Catalog）
//   drawingSet(count) … 図枠・表題欄・図形の入った count ページの図面（ページの多い PDF の見え方と、ページを表示するときに読む動きを確かめる）

const encoder = new TextEncoder();

/** @param {(string | { dict: string, data: Uint8Array })[]} objects */
export function pdfFile(objects) {
  const parts = [Uint8Array.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", (c) => c.charCodeAt(0))]; // 2 行目: 中身が文字でない印（4 バイト）
  const offsets = [];
  let length = parts[0].length;
  const push = (bytes) => {
    parts.push(bytes);
    length += bytes.length;
  };
  objects.forEach((object, i) => {
    offsets.push(length);
    if (typeof object === "string") push(encoder.encode(`${i + 1} 0 obj\n${object}\nendobj\n`));
    else {
      push(encoder.encode(`${i + 1} 0 obj\n<< ${object.dict} /Length ${object.data.length} >>\nstream\n`));
      push(object.data);
      push(encoder.encode("\nendstream\nendobj\n"));
    }
  });
  const xref = length;
  const rows = offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const stream = (text) => ({ dict: "", data: encoder.encode(text) });

/** A3 横（420 × 297 mm）の図面を count ページ。ページごとに図番が変わる */
export function drawingSet(count) {
  const [w, h] = [1190.55, 841.89];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (let i = 0; i < count; i++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const r = 60 + (i % 5) * 20; // ページごとに少し違う形
    objects.push(stream([
      "0.8 w 0 0 0 RG 28 28 1134.55 785.89 re S", // 図枠
      "0.4 w 794 28 m 794 128 l 1162.55 128 l S 794 78 m 1162.55 78 l S", // 表題欄
      `BT /F1 18 Tf 806 96 Td (Sheet ${i + 1} / ${count}) Tj ET`,
      `BT /F1 12 Tf 806 46 Td (DWG-${String(i + 1).padStart(3, "0")}) Tj ET`,
      `0.6 w 300 420 m ${300 + r} 420 ${380 + r} ${500 - r} ${380 + r} 500 c ${380 + r} ${500 + r} ${300 + r} 580 300 580 c S`, // 曲線
      `200 300 ${400 + r * 2} 240 re S 200 300 m ${600 + r * 2} 540 l S`,
    ].join("\n")));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  return pdfFile(objects);
}
