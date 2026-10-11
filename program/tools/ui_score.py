"""画面の改良案の評価関数（開発用。決め方は CLAUDE.md の「UI/UX を変えるときは…」、記録は docs/ui.md）。

    python program/tools/ui_score.py program/tools/ui-proposals/比較.json

採点は、案を画像にして（ui-variants.mjs）直接見比べてから付ける。採点のファイル（JSON）:

    {"title": "…", "rule": 2, "rounds": [
      {"name": "1 回目", "proposals": {"A 案の名前": [7 基準の点（10 段階）], …}, "diverse": ["方向の違う案 F", "G"],
       "seen": {"A 案の名前": "画像で見えたこと"}, "baseline": {"現状": [7 基準の点]}},
      {"name": "2 回目", "proposals": {…}, "essence": {"組合せ案 H": "どの案のどのエッセンスを合わせたか"}}]}
    "baseline" は比べるための今の画面（案ではないので順位に入れない。どれだけ良くなるかを見る）。
    "record" を書いたファイルは、決まりができる前の記録（回の組み方は確かめない）。

決め方（rule 2。2026-10-11〜。CLAUDE.md の「UI/UX を変えるときは…」）:
  1 回目: 5 案を出し、アイデアが偏らないよう方向の違う解決策を 2 案足した 7 案（"diverse" に足した 2 案の名前）。
    1 位が十分に良く（GOOD 点以上）、2 位との差が僅差の幅（2σd）より大きければ 1 位を選ぶ。
  1 位でも点が低いか、僅差で選べなければ 2 回目: 案のエッセンスを抜き出し、効きそうなアイデアにまとめ直した組合せ案を 4 つ作り、
    1 回目の上位 3 案と合わせた 7 案を採点し直す（"essence" に組合せの中身）。
  2 回目は必ず 1 案に決める（実装する）。僅差なら、重みの大きい基準から順に点の高い案（次の行動がすぐ分かる → 状態と進み具合 → …）。
rule 1（〜2026-11 の記録。"rule" が無いファイル）: 1 回目は最低 5 案。僅差なら複合案 3 つ＋上位 2 案の 5 案で選び直し、
  それでも僅差なら利用者に確かめる。
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
# rule 2
FIRST = 7  # 1 回目の案の数（5 案 ＋ 方向の違う 2 案）
DIVERSE = 2  # 偏らないよう足す、方向の違う案の数
COMBOS = 4  # 2 回目に作る組合せ案の数
KEEP = 3  # 2 回目に残す 1 回目の上位の案の数
GOOD = 80.0  # 1 回目でそのまま選んでよい点（100 点満点。全ての基準で 10 段階の 8 にあたる）
# rule 1（古い記録）
MIN_PROPOSALS_1 = 5
COMPOSITES_1 = 3
KEEP_1 = 2


def total(scores):
    """10 段階の採点 → 100 点満点"""
    if len(scores) != len(WEIGHTS) or not all(0 <= s <= 10 for s in scores):
        raise ValueError(f"採点は 0〜10 の {len(WEIGHTS)} 個: {scores}")
    return round(sum(w * s / 10 for w, s in zip(WEIGHTS, scores)), 1)


def rank(proposals, rule=2):
    """[(合計, 名前, 採点)] を高い順に（同点は rule 2 なら重みの大きい基準から順に点の高い方、rule 1 は名前の順）。1 位と 2 位が僅差か"""
    tie = (lambda r: [-v for v in r[2]]) if rule == 2 else (lambda r: [])
    rows = sorted(((total(s), name, s) for name, s in proposals.items()), key=lambda r: (-r[0], tie(r), r[1]))
    return rows, rows[0][0] - rows[1][0] < MARGIN


def by_priority(rows):
    """僅差の案（1 位との差が僅差の幅の内）を、重みの大きい基準から順に点の高い順に並べ直す（2 回目に 1 案に決めるとき）"""
    close = [r for r in rows if rows[0][0] - r[0] < MARGIN]
    return sorted(close, key=lambda r: ([-v for v in r[2]], -r[0], r[1]))


def check_round(rule, i, rnd, previous):
    """回の組み方が決まりどおりか（違えば理由の文）"""
    proposals = rnd["proposals"]
    names = set(proposals)
    if rule == 1:
        if i == 0:
            return None if len(proposals) >= MIN_PROPOSALS_1 else f"1 回目の案は最低 {MIN_PROPOSALS_1} 案（いま {len(proposals)} 案）"
        missing = [n for _, n, _ in previous[:KEEP_1] if n not in names]
        new = names - {n for _, n, _ in previous}
        if missing:
            return f"前の回の上位 {KEEP_1} 案（{'・'.join(missing)}）が入っていない"
        return None if len(new) >= COMPOSITES_1 else f"複合案は {COMPOSITES_1} つ（いま {len(new)} つ）"
    if i == 0:
        diverse = rnd.get("diverse", [])
        if len(proposals) < FIRST:
            return f"1 回目は {FIRST} 案（5 案 ＋ 方向の違う {DIVERSE} 案。いま {len(proposals)} 案）"
        if len(diverse) < DIVERSE or not set(diverse) <= names:
            return f"方向の違う {DIVERSE} 案を diverse に書く（いま {diverse}）"
        return None
    if i > 1:
        return "rule 2 は 2 回まで（2 回目で 1 案に決める）"
    missing = [n for _, n, _ in previous[:KEEP] if n not in names]
    new = names - {n for _, n, _ in previous}
    if missing:
        return f"1 回目の上位 {KEEP} 案（{'・'.join(missing)}）が入っていない"
    if len(new) < COMBOS:
        return f"組合せ案は {COMBOS} つ（いま {len(new)} つ）"
    if not set(rnd.get("essence", {})) >= new:
        return "組合せ案ごとに、どのエッセンスを合わせたかを essence に書く"
    return None


def decide(data, strict=True):
    """回を順に判定する。返り値: (判定, 名前か案の並び, 並べた行)。判定:
    rule 2 … "選ぶ"（1 回目で十分・2 回目は必ず）・"比べ直す"（1 回目の上位 3 案を残して 2 回目へ）
    rule 1 … "選ぶ"・"比べ直す"・"確かめる"（利用者に）
    strict: 回の組み方を確かめる（決まりができる前の記録では確かめない）"""
    rule = data.get("rule", 1)
    rounds = data["rounds"]
    previous = None
    for i, rnd in enumerate(rounds):
        problem = check_round(rule, i, rnd, previous)
        if problem and strict:
            raise ValueError(f"{rnd['name']}: {problem}")
        rows, close = rank(rnd["proposals"], rule)
        if rule == 2 and i >= 1:
            return "選ぶ", by_priority(rows)[0][1], rows
        if not close and (rule == 1 or rows[0][0] >= GOOD):
            return "選ぶ", rows[0][1], rows
        previous = rows
    if rule == 2:
        return "比べ直す", [name for _, name, _ in previous[:KEEP]], previous
    top = [name for _, name, _ in previous[:KEEP_1]]
    return ("比べ直す" if len(rounds) == 1 else "確かめる"), top, previous


def report(data):
    print(f"# {data['title']}")
    if data.get("record"):
        print(f"（記録: {data['record']}）")
    print(f"σ1 = {SIGMA1:.2f}、僅差の幅 2σd = {MARGIN:.1f} 点")
    for rnd in data["rounds"]:
        rows, close = rank(rnd["proposals"], data.get("rule", 1))
        print(f"== {rnd['name']}（{len(rows)} 案）")
        for t, name, s in rows:
            seen = rnd.get("seen", {}).get(name, "")
            print(f"  {name:16s} {t:5.1f}  {s}  {seen}")
        for name, s in rnd.get("baseline", {}).items():
            print(f"  （{name}）{'':{max(0, 14 - len(name))}s} {total(s):5.1f}  {s}  {rnd.get('seen', {}).get(name, '')}")
        print(f"  1 位と 2 位の差 {rows[0][0] - rows[1][0]:.1f} 点 → {'僅差' if close else '差あり'}")
    rule = data.get("rule", 1)
    kind, who, rows = decide(data, strict=not data.get("record"))
    if kind == "選ぶ":
        close = len(rows) > 1 and rows[0][0] - rows[1][0] < MARGIN
        print(f"→ 選ぶ: {who}" + ("（僅差なので、重みの大きい基準から順に点の高い案）" if close and rule == 2 else ""))
    elif kind == "比べ直す" and rule == 2:
        why = "1 位でも点が低い" if rows[0][0] < GOOD else "僅差で選べない"
        print(f"→ {why}（{rows[0][0]:.1f} 点・選んでよい点 {GOOD:.0f}）。エッセンスを抜き出した組合せ案を {COMBOS} つ作り、"
              f"上位 {KEEP} 案（{'・'.join(who)}）と合わせた {COMBOS + KEEP} 案を画像にして採点し直す")
    elif kind == "比べ直す":
        print(f"→ 僅差なので選ばない。複合案を {COMPOSITES_1} つ作り、上位 {KEEP_1} 案（{'・'.join(who)}）を足した 5 案を画像にして比べ直す")
    else:
        print(f"→ 選び直しても僅差なので選ばない。上位の案（{'・'.join(who)}）の画像を添えて、利用者に確かめる")
    return kind, who


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("使い方: python program/tools/ui_score.py 採点.json")
    with open(sys.argv[1], encoding="utf-8") as f:
        report(json.load(f))
