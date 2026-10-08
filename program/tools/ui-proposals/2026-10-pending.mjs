// 2026-10（保留の 3 つ）: 僅差で利用者に確かめる案を、いま作った画面（陰影 G・階層 G・変わったこと G）に 1 つずつ足した姿。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-pending.mjs --states ipt,asm,done,news --themes light,dark
// 元の比べは 2026-10-shade・2026-10-hierarchy・2026-10-news（どれも 2 回目も僅差）。ここでは採点せず、画像を利用者に見せて選んでもらう。

export const PROPOSALS = [
  { key: "base", name: "いま（G を 3 つ作った画面）", css: "", ops: [] },
  // 陰影 I: G（補いを強く・3D の一致の緑を明るく）に、主の光を強く・全体を弱く（締まり）
  { key: "S", name: "陰影 I（主の光を強く・締まり）", css: ":root { --light-ambient: 0.7; --light-key: 2.5; --light-fill: 1.1; }", ops: [] },
  // 階層 I: G（例外を先に・要点の囲み）に、外形寸法を大きな数で
  { key: "H", name: "階層 I（外形寸法を大きな数で）", css: ".key-card .dims dd { font-size: var(--fs-xl); font-weight: 600; }", ops: [] },
  // 変わったこと I: G（右下の知らせ＋設定で読める）に、何も開いていなければ始め方の上のカードで見せる
  { key: "N", name: "変わったこと I（何も開いていなければ始め方の上に）", css: `body:has(.app.is-empty) #news { display: none; }
    .nw-welcome { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-radius: 12px; background: var(--surface); border: 1px solid var(--rule);
      max-width: 560px; font-size: var(--fs-s); } .nw-welcome ul { margin: 0; padding-inline-start: 1.2em; }`,
  ops: [["script", `const add = () => { const news = document.getElementById("news"); const empty = document.getElementById("stage-empty");
      if (!news || news.hidden || !empty || empty.querySelector(".nw-welcome")) return;
      empty.insertAdjacentHTML("afterbegin", '<section class="nw-welcome"><b>' + document.getElementById("news-head").textContent + '</b>' + document.getElementById("news-list").outerHTML + '</section>'); };
    new MutationObserver(add).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden"] }); add();`]] },
];
