/* 自己診断（環境変数 INVENTOR_TOOL_SELFTEST=結果のファイル で起動したときだけ、窓が画面に流し込む）。
   本物の WebView（Windows では WebView2）の中から、利用者と同じ道を通して確かめ、/__desktop/selftest/result へ送る。窓は結果を書いて終わる。
   CI（.github/workflows/desktop.yml）は exe をサンプルの組立（.iam）を渡して起こし、合図（stage=second）を見たら、
   2 つめの exe に変換データ（.inventor.json）を渡して起こす（1 つめの窓が受け取って開く）。
   調べること: 合言葉・画面の部品の種類・起動で受け取ったファイルが開く（組立と同じフォルダの部品も届く）・サンプル・合言葉の無い依頼を断る・
   2 つめの起動のファイルが届く・「STEP を作る」ボタンから STEP ができる・作成中（409）と作れない変換データ（400）の理由・
   2D の図面（DXF）を開くと Canvas に描かれ、レイアウトを切り替えられる・
   HTML のモデル（隔離した iframe の three.js）を取り込める・設定の引き出し・同時の問い合わせ・速さ。 */
(async () => {
  const res = [];
  const ok = (name, cond, info = "") => res.push({ name, ok: !!cond, info: String(info).slice(0, 400) });
  const t0 = performance.now();
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const until = async (cond, ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      try { if (await cond()) return true; } catch { /* まだ */ }
      await sleep(200);
    }
    return false;
  };
  const token = document.querySelector('meta[name="app-token"]')?.content ?? "";
  const api = async (path, opt = {}) => {
    const r = await fetch(path, { cache: "no-store", ...opt, headers: { "X-App-Token": token, ...(opt.body ? { "Content-Type": "application/json" } : {}), ...opt.headers } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* JSON でない */ }
    return { r, text, json };
  };
  const post = (path, body) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const extra = {};
  try {
    const info = (await api("/__desktop/info")).json ?? {};
    extra.info = info;
    ok("窓の情報（版・作ったコミット・program の場所・Python）", info.version && info.program, JSON.stringify(info));

    // 1) 画面
    ok("合言葉が埋め込まれている（起動ごとの 48 桁）", /^[0-9a-f]{48}$/.test(token), token.length);
    const js = await fetch("/static/js/main.js");
    ok("画面の部品はモジュールとして読める種類", js.ok && /^text\/javascript/.test(js.headers.get("Content-Type") || ""), js.headers.get("Content-Type"));
    ok("画面の題", document.title === "Inventor 3Dツール", document.title);

    // 2) 起動で受け取ったファイル（1 つめの起動の引数）が開く
    const first = (info.launched || [])[0];
    const opened = await until(() => $("file-name").textContent === first, 90000);
    ok("起動で受け取った組立が開く", first && opened, `${first} → ${$("file-name").textContent} · ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
    // サンプルの組立のボルトは Content Center の部品で .ipt が無い（samples/iam/README.md）。それ以外は全て見つかること
    const bom = $("bom")?.children.length ?? 0;
    const missing = [...($("missing")?.querySelectorAll(".feature") ?? [])].map((row) => row.title); // 行の題は参照先のパス
    ok("組立の部品表が組み上がり、見つからないのは Content Center の部品だけ", bom > 0 && missing.every((t) => /Content Center/.test(t)),
       `部品表 ${bom} 行 · 見つからない ${missing.length} 種類`);
    const webgl = !document.querySelector("#stage .message") && !!document.createElement("canvas").getContext("webgl2");
    ok("3D 表示（WebGL）が使える", webgl, navigator.userAgent);

    // 3) サンプル
    const samples = (await api("/api/samples")).json?.samples ?? [];
    const kinds = [...new Set(samples.map((s) => s.kind))];
    ok("サンプルの一覧（ipt・iam・stp・dwg・html の順）", kinds.join() === "ipt,iam,stp,dwg,html", `${kinds.join()} · ${samples.length} 件`);
    const sizes = await Promise.all(kinds.map(async (k) => {
      const s = samples.find((x) => x.kind === k);
      const b = await (await fetch(s.url)).arrayBuffer();
      return b.byteLength === s.size;
    }));
    ok("サンプルの中身（日本語の名前も）が欠けずに届く", sizes.every(Boolean), sizes.join());

    // 4) 合言葉の無い依頼は断る（開いた HTML のモデルは合言葉を持たない）
    const bare = await fetch("/api/build");
    const wrong = await fetch("/api/launch", { method: "POST", headers: { "X-App-Token": "x".repeat(48) } });
    ok("合言葉の無い・違う依頼は断る（403）", bare.status === 403 && wrong.status === 403, `${bare.status} ${wrong.status}`);

    // 5) 2 つめの起動（CI が合図を見て、変換データを渡して起こす）
    await post("/__desktop/selftest/stage", { stage: "second" });
    const second = await until(() => /\.inventor\.json$/.test($("file-name").textContent), 120000);
    ok("2 つめの起動に渡したファイルが、1 つめの窓で開く", second, $("file-name").textContent);

    // 6) 「STEP を作る」ボタン（利用者と同じ道）
    const before = (await api("/api/build")).json ?? {};
    extra.build_before = { ready: before.ready, inventor_installed: before.inventor_installed, root: before.root, python_missing: before.python_missing };
    ok("作る仕事の状態（保存先・Python が見つかる）", before.root && !before.python_missing, JSON.stringify(extra.build_before));
    const button = $("build-step");
    await until(() => !button.disabled, 10000);
    // 作っている間は次を受け付けない（409）。画面が出した「作り始める」依頼に答えが返った時点で、仕事は「作っている」
    // （窓は変換データを確かめてから「作っている」にして答える）。その答えを受け取ったその場で、もう 1 つ頼む。
    // 状態を問い合わせて「作っている」間を探すと、STEP だけの短い仕事やタイマーの間引きで見逃す（Windows の CI で一度見逃した）
    const realFetch = window.fetch;
    const busyAnswer = new Promise((resolve) => {
      window.fetch = async (input, init) => {
        const response = await realFetch(input, init);
        if (init?.method === "POST" && String(input).endsWith("/api/build")) {
          window.fetch = realFetch;
          resolve(post("/api/build", { spec: { format: "other" }, target: "step" }));
        }
        return response;
      };
    });
    button.click();
    const busy = await Promise.race([busyAnswer, sleep(15000).then(() => null)]);
    window.fetch = realFetch;
    ok("作成中は次を受け付けない（409 と、作っているものの名前）", busy?.r.status === 409 && /「LS4_parts_viewer」を作っています/.test(busy?.json?.message || ""),
       busy ? busy.text : "画面の「作り始める」依頼が 15 秒たっても返りません");
    const built = await until(async () => ["done", "failed", "cancelled"].includes((await api("/api/build")).json?.state), 180000);
    const job = (await api("/api/build")).json ?? {};
    extra.job = { state: job.state, out_dir: job.out_dir, step: job.step, message: job.message };
    ok("「STEP を作る」で STEP ができる（Python の作る係）", built && job.state === "done" && /\.stp$/.test(job.step?.file || "") && job.out_dir,
       `${job.state} ${job.step?.file ?? ""} ${job.out_dir ?? ""} ${job.message ?? ""}`);
    await until(() => $("dock").dataset.tone === "ok", 5000);
    ok("画面に結果が出る（行動ドックが一致の色）", $("dock").dataset.tone === "ok", $("build-state").textContent);

    // 7) 理由の答え
    const bad = await post("/api/build", { spec: { format: "other" }, target: "step" });
    ok("作れない変換データは理由を返す（400）", bad.r.status === 400 && /この変換データからは作れません/.test(bad.json?.message || ""), bad.text);

    // 7.5) 2D の図面（サンプルの DXF）: 開くと 2D の Canvas に線が描かれ（色の付いた点を数える）、画層が並び、A3 のレイアウトに切り替えられる
    const drawingName = samples.find((x) => x.kind === "dwg")?.name;
    $("show-start")?.click();
    [...document.querySelectorAll("button.sample-row")].find((b) => b.title === drawingName)?.click();
    const inked = () => {
      const c = $("view2d");
      if (c.hidden || !c.width) return 0;
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
      return n;
    };
    const drawn = await until(() => $("file-name").textContent === drawingName && inked() > 2000, 30000);
    const layers = $("layers")?.querySelectorAll(".feature").length ?? 0;
    ok("2D の図面を開くと Canvas に描かれ、画層が並ぶ", drawingName && drawn && layers > 0, `${drawingName} · 描いた点 ${inked()} · 画層 ${layers}`);
    const tab = $("layout-tabs")?.children[1];
    tab?.click();
    const switched = await until(() => $("layout-tabs")?.children[1]?.getAttribute("aria-current") === "true" && inked() > 2000 && /A3/.test($("drawing-info").textContent), 10000);
    ok("図面のレイアウト（紙）に切り替えられる", switched, `${tab?.textContent ?? "タブが無い"} · ${$("drawing-info").textContent}`);

    // 7.6) 3D を含む PDF（サンプルの U3D）: 開くと主役の場所のタブ（図面・3D）が出て 3D が選ばれ、部品が並ぶ。図面のタブでページが描かれる
    const pdf3d = samples.find((x) => x.kind === "dwg" && /_3D\.pdf$/i.test(x.name))?.name;
    $("show-start")?.click();
    [...document.querySelectorAll("button.sample-row")].find((b) => b.title === pdf3d)?.click();
    const parts3d = () => $("model3d-parts")?.querySelectorAll(".feature").length ?? 0;
    const shown3d = await until(() => $("file-name").textContent === pdf3d && $("app").dataset.view === "3d:0" && parts3d() > 0, 30000);
    ok("3D を含む PDF を開くと 3D のタブが選ばれ、部品が並ぶ", pdf3d && shown3d,
       `${pdf3d} · タブ ${[...($("view-tab-list")?.children ?? [])].map((b) => b.textContent).join("・")} · 部品 ${parts3d()}`);
    $("view-tab-list")?.querySelector('[data-view="sheet"]')?.click();
    const sheetShown = await until(() => !$("view2d").hidden && inked() > 500, 10000);
    ok("PDF の図面のタブに切り替えると、ページが描かれる", sheetShown, `描いた点 ${inked()}`);

    // 7.7) Jw_cad の図面（サンプルの JWW）: 開くと用紙に描かれ、補助線の画層が並ぶ
    const jww = samples.find((x) => x.kind === "dwg" && /線種\.jww$/i.test(x.name))?.name;
    $("show-start")?.click();
    [...document.querySelectorAll("button.sample-row")].find((b) => b.title === jww)?.click();
    const jwwShown = await until(() => $("file-name").textContent === jww && !$("view2d").hidden && inked() > 2000 && /補助線/.test($("layers").textContent), 30000);
    ok("Jw_cad の図面を開くと用紙に描かれ、補助線の画層が並ぶ", jww && jwwShown, `${jww} · 描いた点 ${inked()} · ${$("drawing-info").textContent}`);

    // 7.8) SXF の図面（サンプルの P21）: 開くと用紙に描かれ、部分図の中の画層（外形線）が画層の一覧に並び、部分図の縮尺が出る
    const sxf = samples.find((x) => x.kind === "dwg" && /\.p21$/i.test(x.name))?.name;
    $("show-start")?.click();
    [...document.querySelectorAll("button.sample-row")].find((b) => b.title === sxf)?.click();
    const sxfShown = await until(() => $("file-name").textContent === sxf && !$("view2d").hidden && inked() > 2000 && /外形線/.test($("layers").textContent) &&
      /部分図の縮尺/.test($("drawing-info").textContent), 30000);
    ok("SXF の図面を開くと用紙に描かれ、部分図の画層と縮尺が並ぶ", sxf && sxfShown, `${sxf} · 描いた点 ${inked()} · ${$("drawing-info").textContent}`);

    // 8) HTML のモデル（隔離した iframe の three.js を取り込み、変換データを作る）。サンプルは three.js を CDN から読む
    //    CDN に届かない PC（ネットワークの制限）では測れないので、測っていないと書く（届くかは状態コードで見る。no-cors の答えは中身が見えない）
    const cdn = await fetch("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js", { cache: "no-store" }).then((r) => r.status, (e) => String(e));
    if (cdn === 200) {
      $("show-start")?.click();
      const row = [...document.querySelectorAll("button.sample-row")].find((b) => b.title === "LS4_parts_viewer.html");
      row?.click();
      const captured = await until(() => /取り込み/.test($("source-status").textContent) && /r\d+/.test($("source-status").textContent), 60000);
      ok("HTML のモデルを取り込める（隔離した iframe・WebGL）", row && captured && !$("build-step").disabled, `${$("source-status").textContent} · ${$("alert").textContent}`);
    } else {
      ok("HTML のモデルの取り込み: 測っていない（three.js の CDN に届かない環境）", true, `CDN の答え: ${cdn}`);
    }

    // 8.5) 設定（右の引き出し）: 開くと窓に問い合わせて節が並び（ショートカット・版・置き場）、✕ で閉じる。ショートカットの置き場が分かる
    const shortcut = (await api("/api/shortcut")).json ?? {};
    ok("ショートカットの状態（デスクトップ・スタートメニューの場所が分かる）", shortcut.supported && shortcut.places?.length === 2,
       (shortcut.places ?? []).map((p) => `${p.label} ${p.state}`).join("・"));
    $("show-settings")?.click();
    const opened8 = await until(() => $("settings").open && $("settings-body").querySelectorAll(".st-section").length >= 3, 10000);
    ok("設定の引き出しが開き、ショートカット・版・置き場の節が並ぶ", opened8,
       [...$("settings-body").querySelectorAll(".st-section h3")].map((h) => h.firstChild?.textContent).join("・"));
    $("settings-close")?.click();
    ok("設定の引き出しを ✕ で閉じられる", await until(() => !$("settings").open, 3000));

    // 9) 同時の問い合わせが混ざらない
    const paths = Array.from({ length: 40 }, (_, i) => (i % 2 ? "/api/build" : `/static/js/main.js?p=${i}`));
    const all = await Promise.all(paths.map((p) => api(p)));
    ok("40 本同時でも、それぞれの答えが届く", all.every((x, i) => x.r.ok && (i % 2 ? x.json?.root : /import/.test(x.text))));

    // 10) 速さ（参考）
    const avg = async (url) => { const s = performance.now(); for (let i = 0; i < 30; i++) await api(url); return (performance.now() - s) / 30; };
    const st = await avg("/api/build"), sf = await avg("/static/js/main.js?t=speed");
    ok("問い合わせの速さ（参考）", st < 300, `状態 ${st.toFixed(1)}ms / 部品 ${sf.toFixed(1)}ms`);
  } catch (e) {
    ok("例外", false, e && (e.stack || e.message || e));
  }
  const body = { ok: res.every((r) => r.ok), elapsed_ms: Math.round(performance.now() - t0), ua: navigator.userAgent, results: res, ...extra };
  await fetch("/__desktop/selftest/result", { method: "POST", headers: { "X-App-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
})();
