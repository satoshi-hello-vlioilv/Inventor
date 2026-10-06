"""画面の改良案の評価関数（開発用。docs/ui.md の 2〜4 節）: 重み付きの合計（100 点満点）・順位・僅差の判定。

    python program/tools/ui_score.py

僅差の幅: 各基準の採点に ±1 段階（10 段階）のぶれがあるとすると、1 案の合計のぶれは σ1 = √Σ(w/10)²、
2 案の差のぶれは σd = σ1·√2。1 位と 2 位の差が 2σd 未満なら、採点のぶれで順位が入れ替わりうる（僅差）ので、
上位の案を組み合わせた複合案を混ぜて比べ直す。それでも僅差なら、次の行動 → 作り直しの確かさ → 合計 の順で決める。
"""

import math

CRITERIA = [  # (名前, 重み)
    ("次の行動がすぐ分かる", 20),
    ("状態と進み具合が見える", 15),
    ("読む量・判断の数が少ない", 15),
    ("どこに何があるかが一定", 15),
    ("見栄え・視覚の階層", 15),
    ("3D の見やすさ・操作の短さ", 10),
    ("作り直しの確かさ・保守性", 10),
]
WEIGHTS = [w for _, w in CRITERIA]
SIGMA1 = math.sqrt(sum((w / 10) ** 2 for w in WEIGHTS))
MARGIN = 2 * SIGMA1 * math.sqrt(2)

ROUND1 = {
    "A 磨き上げ": [5, 4, 6, 6, 6, 7, 10],
    "B 段階型": [9, 9, 8, 5, 7, 6, 5],
    "C 3 ペイン": [6, 5, 6, 9, 8, 6, 6],
    "D カード": [6, 7, 5, 5, 9, 6, 5],
    "E 行動ドック": [9, 8, 8, 8, 8, 8, 8],
    "F 3D 全画面": [6, 5, 8, 6, 8, 10, 6],
}
ROUND2 = {  # 1 回目の上位（E・B・F・C）を組み合わせた案と、1 位の E
    "E": ROUND1["E 行動ドック"],
    "E×B": [10, 10, 8, 8, 9, 8, 7],
    "E×F": [9, 8, 8, 7, 8, 10, 7],
    "E×B×F": [10, 10, 8, 7, 9, 10, 6],
    "E×C": [9, 8, 7, 9, 8, 6, 6],
}


def total(scores):
    """10 段階の採点 → 100 点満点"""
    return round(sum(w * s / 10 for w, s in zip(WEIGHTS, scores)), 1)


def rank(proposals):
    """[(合計, 名前, 採点)] を高い順に。1 位と 2 位が僅差か"""
    rows = sorted(((total(s), name, s) for name, s in proposals.items()), reverse=True)
    return rows, rows[0][0] - rows[1][0] < MARGIN


def tie_break(a, b):
    """なお僅差のとき: 次の行動 → 作り直しの確かさ → 合計"""
    return max(a, b, key=lambda r: (r[2][0], r[2][6], r[0]))


def choose(rounds):
    """比べた回ごとの表を出し、選んだ案の名前を返す"""
    for i, proposals in enumerate(rounds, 1):
        rows, close = rank(proposals)
        print(f"== {i} 回目（{len(rows)} 案。僅差の幅 {MARGIN:.1f} 点）")
        for t, name, s in rows:
            print(f"  {name:12s} {t:5.1f}  {s}")
        print(f"  1 位と 2 位の差 {rows[0][0] - rows[1][0]:.1f} 点 → {'僅差' if close else '差あり'}")
        if not close:
            return rows[0][1]
    return tie_break(rows[0], rows[1])[1]


if __name__ == "__main__":
    print(f"σ1 = {SIGMA1:.2f}、僅差の幅 2σd = {MARGIN:.1f} 点")
    print(f"選んだ案: {choose([ROUND1, ROUND2])}")
