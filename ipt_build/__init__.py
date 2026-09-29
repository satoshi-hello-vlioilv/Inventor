"""ブラウザのアプリが出力した変換データ（JSON）から、Inventor API で部品（.ipt）と組立（.iam）を作る。

層構成:
    spec      … 変換データの読み込み・検証と、断面の幾何量（体積・表面積の期待値の再計算）
    inventor  … Inventor API（COM）での作成と、作った部品の体積・表面積の照合
"""
from .spec import SpecError, load_spec

__all__ = ["SpecError", "load_spec"]
