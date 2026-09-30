"""ブラウザのアプリが出力した変換データ（JSON）から、Inventor API で部品（.ipt）と組立（.iam）を作る。

層構成:
    spec      … 変換データの読み込み・検証と、断面の幾何量（体積・表面積の期待値の再計算）
    inventor  … Inventor API（COM）での作成と、作った部品の体積・表面積の照合
    runner    … 一連の作成（接続 → 部品 → 組立 → 結果の保存）と、進み具合の知らせ
    libraries … Inventor の操作に使うライブラリ（pywin32）があるか・入れ方
"""
from .spec import SpecError, load_spec, parse_spec

__all__ = ["SpecError", "load_spec", "parse_spec"]
