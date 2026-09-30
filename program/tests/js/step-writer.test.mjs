// 書き出した STEP（Python の ipt_build/step.py）を、アプリの STEP の読み取り（formats/step。Inventor が書いた STEP で確かめてある）で
// 読み戻す評価。書き手と読み手は別々の実装なので、両方が同じ形を表していれば、書き方の誤り（向き・単位・配置）が見つかる。
//   部品の数・出現の数と置いた位置、全ての面を表示できること、体積（三角形に分けた面から）が変換データの期待値と一致すること
// Python が無い環境では飛ばす。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { readModel } from "../../app/static/js/formats/open.js";
import { partGeometry } from "../../app/static/js/viewer/tessellate.js";
import { ROOT } from "./helpers.mjs";

const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const FIXTURES = path.join(ROOT, "tests/fixtures/builder");
let python = true;
try {
  execFileSync(PYTHON, ["--version"], { stdio: "ignore" });
} catch {
  python = false;
}

/** 変換データから STEP を書く（Python）→ 読み戻す（JS） */
async function roundTrip(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-writer-"));
  const out = path.join(dir, `${name}.stp`);
  execFileSync(PYTHON, ["-c", `from ipt_build.spec import load_spec; from ipt_build.step import write_step; write_step(load_spec(r"${path.join(FIXTURES, `${name}.inventor.json`)}"), r"${out}")`], { cwd: ROOT });
  const spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.inventor.json`), "utf8"));
  const model = await readModel(new Uint8Array(fs.readFileSync(out)), `${name}.stp`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { spec, model };
}

// 体積の許容: 曲面を三角形に分けるときの弦の誤差（表示用の分割。円を π/32 刻み → 面積で約 0.16%）
const CHORD = 0.005;

describe("書き出した STEP をアプリで読み戻す", { skip: !python && "Python が無い" }, () => {
  for (const name of ["finger", "plate-holes", "spacer-t50", "reel", "wire"]) {
    test(`${name}: 部品・出現・面・体積が変換データと一致`, async () => {
      const { spec, model } = await roundTrip(name);
      const placed = spec.parts.reduce((n, p) => n + p.instances.length, 0);
      const parts = model.kind === "assembly" ? model.scene.parts : [{ bodies: model.scene.bodies, name: spec.parts[0].name }];
      assert.equal(parts.length, spec.parts.length, "部品の数");
      if (placed > 1) {
        assert.equal(model.kind, "assembly");
        assert.equal(model.scene.instances.length, placed, "出現の数");
        // 置いた位置（行列の移動の成分）が変換データの原点と一致する
        const origins = (list) => list.map((o) => o.map((v) => +v.toFixed(4)).join(",")).sort();
        const read = model.scene.instances.map((i) => [i.matrix[3], i.matrix[7], i.matrix[11]]);
        assert.deepEqual(origins(read), origins(spec.parts.flatMap((p) => p.instances.map((f) => f.origin))));
      }
      for (const [i, part] of parts.entries()) {
        const expected = spec.parts.find((p) => p.name === part.name) ?? spec.parts[i];
        const { volume, unsupported } = partGeometry(part.bodies);
        // 表示（三角形分割）は球面に未対応（極の扱いが要る）。STEP の球面そのものは OpenCascade で確かめている（test_step.py）
        const spheres = part.bodies.flatMap((b) => b.faces).filter((f) => f.type === "sphere").length;
        assert.equal(unsupported, spheres, `${expected.name}: 球面のほかに表示できない面がある`);
        if (spheres) continue;
        assert.ok(Math.abs(volume - expected.expect.volume) / expected.expect.volume <= CHORD, `${expected.name}: 体積 ${volume} / 期待値 ${expected.expect.volume}`);
      }
    });
  }
});
