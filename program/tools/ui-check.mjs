// 画面の撮影と測定（開発用。画面を直す前と後で同じ物差しで比べる）。
//
//   node program/tools/ui-check.mjs 出力フォルダ [light|dark|both] [1536x864]
//
// 利用者の画面と同じ大きさで、状態ごと（起動・何も開いていない・サンプルの一覧・部品・組立・HTML・変換データ・ライブラリを尋ねる・
// 作っている途中・作り終えた・不一致と失敗が混じった結果）に撮り（状態名-テーマ.png）、迷いやすさに関わる量を測る（metrics.json。測る量は ui-harness.mjs の measure）。
// 改良案どうしを画像で比べるときは ui-variants.mjs。

import fs from "node:fs";
import path from "node:path";
import { launch, measure, parseView, walk } from "./ui-harness.mjs";

const OUT = path.resolve(process.argv[2] ?? "ui-check");
const THEMES = { light: ["light"], dark: ["dark"], both: ["light", "dark"] }[process.argv[3] ?? "both"];
const VIEW = parseView(process.argv[4]); // 省くと利用者の PC の大きさ（1728×1152）

const app = await launch();
const report = {};
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const theme of THEMES) {
    const page = await app.newPage(theme, VIEW);
    await walk(page, app.dev, async (name, next) => {
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      report[`${name}-${theme}`] = await page.evaluate(measure, next);
      console.log(`${name}-${theme}`, JSON.stringify(report[`${name}-${theme}`]));
    });
    await page.context().close();
  }
} finally {
  await app.close();
}
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(report, null, 1));
