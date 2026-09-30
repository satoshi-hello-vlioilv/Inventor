"""STEP ファイル（ISO 10303-21）を書く道具: 実体（#番号 = 名前(引数…)）を並べ、ヘッダーを付けて文字列にする。

- 実数は小数点を必ず含む（1. / 1.5E-07）。-0 は 0 にする
- 文字列はアポストロフィとバックスラッシュを重ね、ASCII 以外は \\X2\\（UTF-16 の 16 進）で書く（日本語の部品名）
- 列挙は .T. / .MILLI. のように、未設定は $、派生は * で書く
- 同じ引数の点・方向などは dedupe=True で 1 つにまとめる（ファイルを小さくする）
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

SCHEMA = "AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }"  # AP214（Inventor が書き出す STEP と同じ）
LINE_LIMIT = 80  # これより長い実体は、引数の区切りで改行する（Inventor が書く STEP と同じくらいの行の長さ）
NEWLINE = "\r\n"  # 改行（Inventor が書く STEP と同じ CR+LF。どの OS で書いても同じにする）


@dataclass(frozen=True)
class Ref:
    """実体への参照（#番号）"""

    id: int

    def __str__(self) -> str:
        return f"#{self.id}"


@dataclass(frozen=True)
class Enum:
    """列挙の値（.T. / .MILLI.）"""

    name: str


@dataclass(frozen=True)
class Typed:
    """型を明示した値（LENGTH_MEASURE(0.01) など）"""

    name: str
    value: object


class _Derived:
    def __repr__(self) -> str:
        return "*"


DERIVED = _Derived()  # 派生（*）


def real(x: float) -> str:
    if not math.isfinite(x):
        raise ValueError(f"STEP に書けない数です: {x}")
    if x == 0:
        return "0."
    text = repr(float(x)).upper()
    mantissa, _, exponent = text.partition("E")
    if "." not in mantissa:
        mantissa += "."
    return f"{mantissa}E{exponent}" if exponent else mantissa


def string(text: str) -> str:
    out = []
    for ch in text:
        if ch == "'":
            out.append("''")
        elif ch == "\\":
            out.append("\\\\")
        elif 32 <= ord(ch) < 127:
            out.append(ch)
        else:
            units = ch.encode("utf-16-be")
            out.append("\\X2\\" + units.hex().upper() + "\\X0\\")
    # 隣り合う \X2\…\X0\ はまとめる（読みやすさとファイルの大きさのため）
    return "'" + "".join(out).replace("\\X0\\\\X2\\", "") + "'"


def encode(value) -> str:
    if value is None:
        return "$"
    if value is DERIVED:
        return "*"
    if isinstance(value, bool):
        return ".T." if value else ".F."
    if isinstance(value, Ref):
        return str(value)
    if isinstance(value, Enum):
        return f".{value.name}."
    if isinstance(value, Typed):
        return f"{value.name}({encode(value.value)})"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return real(value)
    if isinstance(value, str):
        return string(value)
    if isinstance(value, (list, tuple)):
        return "(" + ",".join(encode(v) for v in value) + ")"
    raise TypeError(f"STEP に書けない値です: {value!r}")


class P21Writer:
    """実体を順に登録し、ファイルの文字列を作る。"""

    def __init__(self) -> None:
        self._records: list[str] = []
        self._seen: dict[str, Ref] = {}

    def add(self, name: str, *params, dedupe: bool = False) -> Ref:
        body = f"{name}({','.join(encode(p) for p in params)})"
        return self._record(body, dedupe)

    def complex(self, *parts: tuple) -> Ref:
        """複合の実体: (A(…)B(…)C())。parts は (名前, 引数…) の並び（名前の辞書順に並べる。規格の決まり）"""
        body = "(" + "".join(f"{name}({','.join(encode(p) for p in params)})" for name, *params in sorted(parts, key=lambda p: p[0])) + ")"
        return self._record(body, False)

    def _record(self, body: str, dedupe: bool) -> Ref:
        if dedupe and body in self._seen:
            return self._seen[body]
        ref = Ref(len(self._records) + 1)
        self._records.append(body)
        if dedupe:
            self._seen[body] = ref
        return ref

    def forget(self) -> None:
        """使い回す実体の記録を消す（ここから先は、前に書いた実体を共有しない）"""
        self._seen.clear()

    def __len__(self) -> int:
        return len(self._records)

    def text(self, file_name: str, description: str, system: str, time: datetime | None = None) -> str:
        stamp = (time or datetime.now().astimezone()).isoformat(timespec="seconds")
        header = [
            "ISO-10303-21;",
            "HEADER;",
            f"FILE_DESCRIPTION(({encode(description)}),'2;1');",
            f"FILE_NAME({encode(file_name)},{encode(stamp)},(''),(''),{encode(system)},{encode(system)},'');",
            f"FILE_SCHEMA(({encode(SCHEMA)}));",
            "ENDSEC;",
            "DATA;",
        ]
        body = [_wrap(f"#{i}={record};") for i, record in enumerate(self._records, start=1)]
        return NEWLINE.join(header + body + ["ENDSEC;", "END-ISO-10303-21;", ""])


def _wrap(line: str) -> str:
    """長い行を、文字列の外の区切り（,）の後で改行する"""
    if len(line) <= LINE_LIMIT:
        return line
    out, start, quoted = [], 0, False
    for i, ch in enumerate(line):
        if ch == "'":
            quoted = not quoted
        elif ch == "," and not quoted and i - start >= LINE_LIMIT - 16:
            out.append(line[start : i + 1])
            start = i + 1
    out.append(line[start:])
    return NEWLINE.join(out)
