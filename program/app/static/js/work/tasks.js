// 裏で計算する仕事（work/pool.js が Worker で動かす。Worker が使えなければ同じ表で画面の流れのまま動かす）。
// 仕事 = { module（読むモジュール）, run(モジュール, 引数, progress), explain?(モジュール, 誤り) → 利用者に見せる説明 }。
// Worker と画面の流れで同じ表を使うので、どちらで動いても結果は同じ（docs/app-architecture.md「裏で計算する」）。
// 引数と結果は、写せる物（数・文字・配列・素の物・Map・型付き配列）だけ。結果の型付き配列は写さずに渡す（pool.js）。
//   progress({ stage, done, total }) … 進み具合（stage: 何をしているか。done / total: 数えられるとき）
//   引数の中の関数（例: 組立の部品を探す findPart）は、画面の側で動かして答えを返す（pool.js・worker.js）

const explainRead = async () => (await import("../formats/open.js")).explainError;

export const TASKS = {
  /**
   * ファイルを読んでモデルにする（formats/open.js の readModel。[バイト列, 名前, { findPart }]）。画面の流れで重い計算をしないよう、
   * 部品・組立は面の三角形（viewer/tessellate.js の prepareMeshes）、図面は 3D の立体の 2D の稜線（formats/acis の attachWires）も先に作る
   */
  readModel: {
    module: async () => ({ ...(await import("../formats/open.js")), ...(await import("../viewer/tessellate.js")), ...(await import("../formats/acis/index.js")) }),
    run: async (m, [bytes, name, options], progress) => {
      progress({ stage: "ファイルを読んでいます" });
      const model = await m.readModel(bytes, name, options);
      if (model.kind === "drawing") m.attachWires(model.drawing);
      else m.prepareMeshes(model, progress);
      return model;
    },
    explain: (m, error) => m.explainError(error),
  },
  /** 図面の中の 3D（3D の PDF の U3D・図面の 3D ソリッド）を表示のメッシュにする（formats/model3d.js の read3d。[models3d の 1 つ]） */
  read3d: {
    module: () => import("../formats/model3d.js"),
    run: (m, [entry], progress) => m.read3d(entry, { progress }),
    explain: async (m, error) => (await explainRead())(error),
  },
  /**
   * HTML から取り込んだシーンを認識し（convert/recognize の recognizeSnapshot。[シーン, { unit }]）、表示の形と稜線も作る
   * → { recognition, display（html/describe.js の buildDisplayMeshes に稜線 edges を足したもの。viewer.show({ meshes }) に渡す） }
   */
  recognize: {
    module: async () => ({ ...(await import("../convert/recognize/index.js")), ...(await import("../html/describe.js")), ...(await import("../viewer/tessellate.js")) }),
    run: (m, [snapshot, options], progress) => {
      const recognition = m.recognizeSnapshot(snapshot, { ...options, progress });
      progress({ stage: "表示の形と稜線を作っています" });
      const display = m.buildDisplayMeshes(snapshot, recognition).map((d) => ({ ...d, edges: m.edgeLines(d.positions, d.index) }));
      return { recognition, display };
    },
  },
};
