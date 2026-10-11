// 裏で計算する仕組み（work/）の評価: Worker で動かした結果が、画面の流れでそのまま計算した結果と同じか。
// Node には画面の Worker が無いので、worker_threads で同じ形（postMessage・onmessage・onerror）の Worker を作り、
// 本物の work/worker.js を動かす（写せる物・渡す ArrayBuffer・引数の関数を画面に頼む・取りやめ・落ちたら画面の流れでやり直す）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { recognizeSnapshot } from "../../app/static/js/convert/recognize/index.js";
import { buildDisplayMeshes } from "../../app/static/js/html/describe.js";
import { readModel } from "../../app/static/js/formats/open.js";
import { attachWires } from "../../app/static/js/formats/acis/index.js";
import { read3d } from "../../app/static/js/formats/model3d.js";
import { faceArrays, faceGeometry, prepareMeshes } from "../../app/static/js/viewer/tessellate.js";
import { CALL, TaskError, encodeCalls, transferables } from "../../app/static/js/work/protocol.js";
import { ROOT, readHtmlFixture, readSampleFile } from "./helpers.mjs";

/** 画面の Worker と同じ形の Worker（worker_threads の上に、self.postMessage・self.onmessage を用意してから読む） */
class WebWorker {
  static created = 0;
  static all = [];
  constructor(url) {
    WebWorker.created += 1;
    WebWorker.all.push(this);
    const boot = `
      const { parentPort, workerData } = require("node:worker_threads");
      globalThis.self = globalThis;
      self.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
      // 画面の Worker と同じく、読み終えるまでに届いた知らせは貯めておき、読み終えてから渡す
      let waiting = [];
      parentPort.on("message", (data) => (waiting ? waiting.push(data) : self.onmessage?.({ data })));
      import(workerData.url).then(() => {
        const queued = waiting;
        waiting = null;
        queued.forEach((data) => self.onmessage?.({ data }));
      }, (error) => { throw error; });`;
    this.inner = new NodeWorker(boot, { eval: true, workerData: { url: String(url) } });
    this.inner.on("message", (data) => this.onmessage?.({ data }));
    this.inner.on("error", (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message) {
    this.inner.postMessage(message);
  }
  terminate() {
    this.inner.terminate();
  }
}

after(() => WebWorker.all.forEach((w) => w.terminate())); // 使い回す Worker を止める（残ると試験が終わらない）

const POOL = "../../app/static/js/work/pool.js";
/** 新しい pool.js（Worker の有る・無しを、読むときに決めるため。? を変えると別のモジュールになる） */
async function freshPool(WorkerClass, tag) {
  const saved = globalThis.Worker;
  globalThis.Worker = WorkerClass;
  try {
    return await import(`${POOL}?${tag}`);
  } finally {
    globalThis.Worker = saved;
  }
}

const DWG = () => new Uint8Array(fs.readFileSync(path.join(ROOT, "samples/dwg/ACadSharp_sample_R2004.dwg")));
const plain = (v) => JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? [x.constructor.name, ...x] : x instanceof Map ? [...x] : x instanceof Set ? [...x] : x));

test("引数の関数は印に置き換え、結果の ArrayBuffer は 1 回ずつ集める", () => {
  const fns = [];
  const fn = () => 1;
  const encoded = encodeCalls([new Uint8Array(2), "名前", { findPart: fn, deep: [fn] }], fns);
  assert.equal(fns.length, 2);
  assert.deepEqual(encoded[2], { findPart: { [CALL]: 0 }, deep: [{ [CALL]: 1 }] });
  assert.ok(ArrayBuffer.isView(encoded[0]), "型付き配列はたどらない");
  const shared = new Float32Array(4);
  const list = transferables({ a: shared, b: [shared.subarray(1)], c: new Map([["k", new Uint32Array(1)]]) });
  assert.equal(list.length, 2, "同じ ArrayBuffer は 1 回（2 回並べると渡せない）");
  const error = new TaskError({ kind: "DwgError", message: "壊れています", explained: "DWG として読めませんでした。壊れています" });
  assert.equal(error.kind, "DwgError");
  assert.equal(error.explained, "DWG として読めませんでした。壊れています");
});

test("Worker で動かした結果は、そのまま計算した結果と同じ（図面・3D ソリッド・HTML の認識）", async () => {
  const pool = await freshPool(WebWorker, "same");
  const bytes = DWG();
  const direct = await readModel(bytes, "a.dwg");
  attachWires(direct.drawing);
  const viaWorker = await pool.runTask("readModel", [bytes, "a.dwg"]);
  assert.equal(plain(viaWorker), plain(direct), "図面の読み取り（3D の立体の 2D の稜線を先に作ってある）");
  assert.ok([...viaWorker.drawing.blocks.values()].some((b) => b.entities.some((e) => e.type === "ACIS" && Array.isArray(e.wire))));
  assert.ok(bytes.length > 0, "渡したバイト列は写すだけ（画面の側で使い続けられる）");

  const entry = direct.drawing.models3d[0];
  const stages = [];
  const solids = await pool.runTask("read3d", [entry], { onProgress: (p) => stages.push(p) });
  assert.equal(plain(solids), plain(read3d(entry)), "3D ソリッドのメッシュ");
  assert.ok(stages.some((p) => p.total > 0 && p.done === p.total), "進み具合が最後（done = total）まで届く");

  const snapshot = readHtmlFixture("spool_reel_assembly_v2.rubber");
  const { recognition, display } = await pool.runTask("recognize", [snapshot, { unit: 1 }]);
  const direct2 = recognizeSnapshot(snapshot, { unit: 1 });
  assert.equal(plain(recognition), plain(direct2), "HTML の認識");
  const shown = buildDisplayMeshes(snapshot, direct2);
  assert.equal(plain(display.map(({ edges, ...d }) => d)), plain(shown), "表示の形");
  assert.ok(display.every((d) => d.edges instanceof Float32Array && d.edges.length % 6 === 0), "稜線（線分の両端）も裏で作る");
});

test("組立の部品は、画面の側の findPart に頼んで探す（引数の関数）", async () => {
  const pool = await freshPool(WebWorker, "calls");
  const asked = [];
  const findPart = async (ref) => {
    asked.push(ref.file);
    const file = fs.readdirSync(path.join(ROOT, "samples/ipt")).find((n) => n.toLowerCase() === ref.file.toLowerCase());
    return file ? { name: file, bytes: readSampleFile("ipt", file) } : null;
  };
  const bytes = readSampleFile("iam", "Assembly_全体_Φ54.5.iam");
  const model = await pool.runTask("readModel", [bytes, "Assembly_全体_Φ54.5.iam", { findPart }]);
  const direct = prepareMeshes(await readModel(bytes, "Assembly_全体_Φ54.5.iam", { findPart }));
  assert.ok(asked.length > 0, "Worker が画面の側の関数を呼んだ");
  assert.equal(plain(model), plain(direct));
});

test("部品の面の三角形は裏で先に作り、画面で作るのと同じ形になる", async () => {
  const pool = await freshPool(WebWorker, "meshes");
  const file = "探索Part1.stp";
  const bytes = readSampleFile("stp", file);
  const model = await pool.runTask("readModel", [bytes, file]);
  const faces = (model.scene.bodies ?? model.scene.parts.flatMap((p) => p.bodies ?? [])).flatMap((b) => b.faces);
  const direct = await readModel(bytes, file);
  const fresh = (direct.scene.bodies ?? direct.scene.parts.flatMap((p) => p.bodies ?? [])).flatMap((b) => b.faces);
  assert.ok(faces.length > 0 && faces.every((f) => "mesh" in f), "全ての面に三角形（描けない面は null）");
  faces.forEach((face, i) => {
    const expect = faceArrays(fresh[i]);
    assert.equal(plain(face.mesh), plain(expect), `面 ${i}`);
    if (face.mesh) assert.equal(faceGeometry(face).index.count, expect.index.length, "画面は先に作った三角形をそのまま使う");
  });
});

test("読めないファイルは、仕事が付けた説明つきの誤りで返る", async () => {
  const pool = await freshPool(WebWorker, "error");
  await assert.rejects(pool.runTask("readModel", [new TextEncoder().encode("AC1018 壊れた図面"), "broken.dwg"]), (error) => {
    assert.ok(error instanceof TaskError);
    assert.match(error.explained, /DWG として読めませんでした/);
    return true;
  });
});

test("取りやめると、動いている Worker を止めて誤り（AbortError）で返り、次の仕事は新しい Worker で動く", async () => {
  const pool = await freshPool(WebWorker, "abort");
  const controller = new AbortController();
  const before = WebWorker.created;
  const running = pool.runTask("recognize", [readHtmlFixture("C_tong_3D.body"), {}], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error) => pool.isAbort(error));
  const again = await pool.runTask("readModel", [DWG(), "a.dwg"]);
  assert.equal(again.kind, "drawing");
  assert.ok(WebWorker.created > before + 1, "止めた Worker の代わりを作った");
});

test("Worker が無い・動かない環境では、画面の流れで同じ結果を返す", async () => {
  const none = await freshPool(undefined, "none");
  const bytes = DWG();
  const direct = await readModel(bytes, "a.dwg");
  attachWires(direct.drawing);
  assert.equal(plain(await none.runTask("readModel", [bytes, "a.dwg"])), plain(direct), "同じ仕事の表で動く（稜線も先に作る）");

  class BrokenWorker extends WebWorker {
    constructor() {
      super(new URL("data:text/javascript,throw new Error('読めません')"));
    }
  }
  const broken = await freshPool(BrokenWorker, "broken");
  const model = await broken.runTask("readModel", [bytes, "a.dwg"]);
  assert.equal(model.kind, "drawing", "読み込めない Worker に気づいて、画面の流れでやり直した");
});
