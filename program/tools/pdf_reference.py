"""PDF の読み取りの評価の基準（開発用）: PyMuPDF（MuPDF）が描いたページと、こちらが描いたページを画素で比べる。

    python tools/pdf_reference.py PDF ページ番号（0 から） こちらの画像.png こちらの文字.json

こちらの画像と同じ幅で基準の画像を描き（紙をぴったり合わせた画像どうし）、次を JSON で出す:
    ink.precision … こちらが描いたインクのうち、基準のインクの近く（2 px）にあるものの割合（余計に描いていないか）
    ink.recall    … 基準のインクのうち、こちらのインクの近くにあるものの割合（描き漏らしが無いか）
    words.recall  … 基準の文字（語）のうち、こちらの文字の並びに現れるものの割合
PyMuPDF（pip install pymupdf。AGPL）は評価にだけ使い、アプリには含めない。
"""
from __future__ import annotations

import json
import sys
from collections import Counter

import numpy as np
from PIL import Image

NEAR = 2  # px。この距離の内なら「近く」（線の太さ・字形の違いを許す）
INK = 40  # 紙の色との差（0〜255）がこれを越える画素をインクとみる


def ink_mask(img: np.ndarray, paper: np.ndarray) -> np.ndarray:
    return np.abs(img.astype(np.int16) - paper.astype(np.int16)).max(axis=2) > INK


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def main() -> None:
    import pymupdf

    pymupdf.TOOLS.mupdf_display_errors(False)  # MuPDF の警告を出力に混ぜない（出力は JSON 1 行）
    pdf, index, ours_png, texts_json = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    ours = np.asarray(Image.open(ours_png).convert("RGB"))
    page = pymupdf.open(pdf)[index]
    zoom = ours.shape[1] / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False, annots=True)
    ref = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    h = min(ref.shape[0], ours.shape[0])
    ref, ours = ref[:h], ours[:h]
    # 紙の色: 基準の画像でいちばん多い色（紙に色を塗る PDF もある）
    colors = Counter(map(tuple, ref.reshape(-1, 3)[:: max(1, ref.size // 3 // 200000)]))
    paper = np.array(colors.most_common(1)[0][0], dtype=np.uint8)
    a, b = ink_mask(ours, paper), ink_mask(ref, paper)
    precision = float((a & dilate(b, NEAR)).sum() / max(1, a.sum()))
    recall = float((b & dilate(a, NEAR)).sum() / max(1, b.sum()))
    # 文字: 基準の語が、こちらの文字の並び（空白を除いてつないだもの）に現れるか
    with open(texts_json, encoding="utf-8") as f:
        ours_text = "".join("".join(t.split()) for t in json.load(f))
    words = ["".join(w[4].split()) for w in page.get_text("words")]
    words = [w for w in words if w]
    found = sum(1 for w in words if w in ours_text)
    print(json.dumps({
        "ink": {"precision": round(precision, 4), "recall": round(recall, 4), "ours": int(a.sum()), "reference": int(b.sum())},
        "words": {"recall": round(found / len(words), 4) if words else None, "count": len(words)},
        "size": [int(ours.shape[1]), int(h)],
    }))


if __name__ == "__main__":
    main()
