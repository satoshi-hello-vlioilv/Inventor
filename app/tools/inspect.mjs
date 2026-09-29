// 開発用: Inventor のファイル（.ipt・.iam）の中身を調べる（形式の調査の再現に使う。docs/ipt-format.md・iam-format.md）。
//   node app/tools/inspect.mjs FILE              … 解析結果（ファイル構造・セグメント・形状の要約）を JSON で出す
//   node app/tools/inspect.mjs FILE --dump DIR   … 展開したセグメント・SAB ブロック・ストリーム・サムネイルと解析結果を DIR に書き出す
import fs from "node:fs";
import path from "node:path";
import { openIpt } from "../src/formats/ipt/container.js";
import { parseIpt, shapes } from "../src/formats/ipt/index.js";
import { parseIam } from "../src/formats/iam/index.js";

const [file, flag, dir] = process.argv.slice(2);
if (!file || (flag && (flag !== "--dump" || !dir))) {
  console.error("使い方: node app/tools/inspect.mjs FILE [--dump DIR]");
  process.exit(2);
}
const bytes = new Uint8Array(fs.readFileSync(file));
const name = path.basename(file);
const report = /\.iam$/i.test(name) ? parseIam(bytes, name).report : parseIpt(bytes, name).report;
if (!flag) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const doc = openIpt(bytes);
  const safe = (s) => s.replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_");
  fs.mkdirSync(path.join(dir, "segments"), { recursive: true });
  fs.mkdirSync(path.join(dir, "streams"), { recursive: true });
  for (const s of doc.segments) {
    fs.writeFileSync(path.join(dir, "segments", `${s.name}.bin`), s.data);
    fs.writeFileSync(path.join(dir, "segments", `${s.name}.meta.bin`), s.meta);
  }
  for (const { segment, doc: sab } of shapes(doc)) fs.writeFileSync(path.join(dir, `${segment.name}@${sab.offset}.sab`), segment.data.subarray(sab.offset, sab.end));
  for (const [p, content] of doc.streamData) fs.writeFileSync(path.join(dir, "streams", safe(p)), content);
  if (doc.thumbnail) fs.writeFileSync(path.join(dir, "thumbnail.png"), doc.thumbnail);
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${dir} に書き出しました（セグメント ${doc.segments.length}・ストリーム ${doc.streamData.size}）`);
}
