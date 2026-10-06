/* 自己診断（環境変数 INVENTOR_TOOL_SELFTEST=結果のファイル で起動したときだけ、窓が画面に流し込む）。
   本物の WebView（Windows では WebView2）の中から、利用者と同じ道を通して確かめ、/__desktop/selftest/result へ送る。窓は結果を書いて終わる。
   CI（.github/workflows/desktop.yml）は exe をサンプルの組立（.iam）を渡して起こし、合図（stage=second）を見たら、
   2 つめの exe に変換データ（.inventor.json）を渡して起こす（1 つめの窓が受け取って開く）。
   調べること: 合言葉・画面の部品の種類・起動で受け取ったファイルが開く（組立と同じフォルダの部品も届く）・サンプル・合言葉の無い依頼を断る・
   2 つめの起動のファイルが届く・「STEP を作る」ボタンから STEP ができる・作成中（409）と作れない変換データ（400）の理由・
   HTML のモデル（隔離した iframe の three.js）を取り込める・同時の問い合わせ・速さ。 */
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
    const missing = [...($("missing")?.children ?? [])].map((li) => li.textContent);
    ok("組立の部品表が組み上がり、見つからないのは Content Center の部品だけ", bom > 0 && missing.every((t) => /Content Center/.test(t)),
       `部品表 ${bom} 行 · 見つからない ${missing.length} 種類`);
    const webgl = !document.querySelector("#stage .message") && !!document.createElement("canvas").getContext("webgl2");
    ok("3D 表示（WebGL）が使える", webgl, navigator.userAgent);

    // 3) サンプル
    const samples = (await api("/api/samples")).json?.samples ?? [];
    const kinds = [...new Set(samples.map((s) => s.kind))];
    ok("サンプルの一覧（ipt・iam・stp・html の順）", kinds.join() === "ipt,iam,stp,html", `${kinds.join()} · ${samples.length} 件`);
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
    button.click();
    // 作っている間は次を受け付けない（409）。作り始めを細かく見張って、作っている間にもう 1 つ頼む
    const RUN = ["installing", "step", "connecting", "building", "assembly"];
    let busy = null;
    for (const end = performance.now() + 15000; !busy && performance.now() < end;) {
      if (RUN.includes((await api("/api/build")).json?.state)) busy = await post("/api/build", { spec: { format: "other" }, target: "step" });
      else await sleep(10);
    }
    ok("作成中は次を受け付けない（409 と、作っているものの名前）", busy?.r.status === 409 && /「LS4_parts_viewer」を作っています/.test(busy?.json?.message || ""), busy?.text);
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
