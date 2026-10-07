"""画面の改良案の評価関数（開発用。決め方は CLAUDE.md の「UI/UX を変えるときは…」、記録は docs/ui.md）。

    python program/tools/ui_score.py program/tools/ui-proposals/比較.json

採点は、案を画像にして（ui-variants.mjs）直接見比べてから付ける。採点のファイル（JSON）:

    {"title": "…", "rounds": [
      {"name": "1 回目", "proposals": {"A 案の名前": [7 基準の点（10 段階）], …}, "seen": {"A 案の名前": "画像で見えたこと"},
       "baseline": {"現状": [7 基準の点]}},
      {"name": "2 回目", …}]}
    "baseline" は比べるための今の画面（案ではないので順位に入れない。どれだけ良くなるかを見る）。
    "record" を書いたファイルは、いまの決まりの前の記録（回の組み方は確かめない）。

決め方:
  1 回目は最低 5 案。1 位と 2 位の差が僅差の幅（2σd）より大きければ 1 位を選ぶ。
  僅差なら無理に選ばない。より良さそうな複合案を 3 つ作り、1 回目の上位 2 案を足した 5 案で選び直す（2 回目）。
  選び直しても僅差なら、無理に選ばず、上位の案の画像を添えて利用者に確かめる。
僅差の幅: 各基準の採点に ±1 段階のぶれがあるとすると、1 案の合計のぶれは σ1 = √Σ(w/10)²、2 案の差のぶれは
σd = σ1·√2。差が 2σd 未満なら、採点のぶれで順位が入れ替わりうる。
"""

import json
import math
import sys

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
MIN_PROPOSALS = 5  # 1 回目の案の数の下限
COMPOSITES = 3  # 僅差のときに作る複合案の数
KEEP = 2  # 僅差のときに残す元の案の数（上位から）


def total(scores):
    """10 段階の採点 → 100 点満点"""
    if len(scores) != len(WEIGHTS) or not all(0 <= s <= 10 for s in scores):
        raise ValueError(f"採点は 0〜10 の {len(WEIGHTS)} 個: {scores}")
    return round(sum(w * s / 10 for w, s in zip(WEIGHTS, scores)), 1)


def rank(proposals):
    """[(合計, 名前, 採点)] を高い順に。1 位と 2 位が僅差か"""
    rows = sorted(((total(s), name, s) for name, s in proposals.items()), key=lambda r: (-r[0], r[1]))
    return rows, rows[0][0] - rows[1][0] < MARGIN


def check_round(i, proposals, previous):
    """回の組み方が決まりどおりか（違えば理由の文）"""
    if i == 0:
        return None if len(proposals) >= MIN_PROPOSALS else f"1 回目の案は最低 {MIN_PROPOSALS} 案（いま {len(proposals)} 案）"
    kept = [name for _, name, _ in previous[:KEEP]]
    missing = [name for name in kept if name not in proposals]
    new = [name for name in proposals if name not in {n for _, n, _ in previous}]
    if missing:
        return f"前の回の上位 {KEEP} 案（{'・'.join(missing)}）が入っていない"
    if len(new) < COMPOSITES:
        return f"複合案は {COMPOSITES} つ（いま {len(new)} つ）"
    return None


def decide(rounds, strict=True):
    """回を順に判定する。返り値: ("選ぶ", 名前) か ("比べ直す", 残す案) か ("確かめる", 上位の案)。
    strict: 回の組み方を確かめる（決まりの前の記録では確かめない）"""
    previous = None
    for i, rnd in enumerate(rounds):
        problem = check_round(i, rnd["proposals"], previous)
        if problem and strict:
            raise ValueError(f"{rnd['name']}: {problem}")
        rows, close = rank(rnd["proposals"])
        if not close:
            return "選ぶ", rows[0][1], rows
        previous = rows
    top = [name for _, name, _ in previous[:KEEP]]
    return ("比べ直す" if len(rounds) == 1 else "確かめる"), top, previous


def report(data):
    print(f"# {data['title']}")
    if data.get("record"):
        print(f"（記録: {data['record']}）")
    print(f"σ1 = {SIGMA1:.2f}、僅差の幅 2σd = {MARGIN:.1f} 点")
    for rnd in data["rounds"]:
        rows, close = rank(rnd["proposals"])
        print(f"== {rnd['name']}（{len(rows)} 案）")
        for t, name, s in rows:
            seen = rnd.get("seen", {}).get(name, "")
            print(f"  {name:16s} {t:5.1f}  {s}  {seen}")
        for name, s in rnd.get("baseline", {}).items():
            print(f"  （{name}）{'':{max(0, 14 - len(name))}s} {total(s):5.1f}  {s}  {rnd.get('seen', {}).get(name, '')}")
        print(f"  1 位と 2 位の差 {rows[0][0] - rows[1][0]:.1f} 点 → {'僅差' if close else '差あり'}")
    kind, who, _ = decide(data["rounds"], strict=not data.get("record"))
    if kind == "選ぶ":
        print(f"→ 選ぶ: {who}")
    elif kind == "比べ直す":
        print(f"→ 僅差なので選ばない。複合案を {COMPOSITES} つ作り、上位 {KEEP} 案（{'・'.join(who)}）を足した 5 案を画像にして比べ直す")
    else:
        print(f"→ 選び直しても僅差なので選ばない。上位の案（{'・'.join(who)}）の画像を添えて、利用者に確かめる")
    return kind, who


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("使い方: python program/tools/ui_score.py 採点.json")
    with open(sys.argv[1], encoding="utf-8") as f:
        report(json.load(f))
