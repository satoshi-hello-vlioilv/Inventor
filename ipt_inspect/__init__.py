"""Autodesk Inventor 部品ファイル (.ipt) の読み取り専用解析ツール。

層構成（下から）:
    container … OLE2 複合ドキュメント → RSe セグメント（Zstandard 展開）
    sab       … ASM/ACIS バイナリ形状データ（SAB）のトークナイザ
    brep      … B-rep トポロジを辿り、寸法・穴・R を要約
    report    … 上記を JSON 互換の辞書とテキストに整形
"""
from .container import IptFile
from .report import build

__all__ = ["IptFile", "build"]
