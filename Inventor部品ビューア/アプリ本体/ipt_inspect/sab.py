"""SAB 層: Autodesk ShapeManager (ASM) / ACIS のバイナリ形状データを読む。

Inventor の形状カーネル ASM は ACIS から派生しており、B-rep を ACIS と同系統の
タグ付きバイナリ（SAB）で書き出す。1 レコード = 1 エンティティで、

    [SUBIDENT…] IDENT  フィールド…  TERMINATOR

という並びになる（例: ``cone`` + ``surface`` → ``cone-surface``）。
エンティティ間の参照は ``REF`` タグが持つレコード番号（先頭ヘッダが 0 番）で表される。

ロールバック用の履歴（``history_stream`` / ``delta_state``）は
``Begin-of-ASM-History-Data`` 〜 ``End-of-ASM-History-Section`` の間に置かれ、
エンティティ番号には数えられない。区間マーカーと終端 ``End-of-ASM-data`` は
TERMINATOR を伴わないため、名前トークンの並びで判定する。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum
from functools import cached_property

MAGICS = (b"ASM BinaryFile4", b"ACIS BinaryFile")
_MAGIC_LEN = 15
_HEADER = struct.Struct("<4i")  # version, record 数, entity 数, flags


class Tag(IntEnum):
    CHAR = 0x02
    SHORT = 0x03
    LONG = 0x04
    FLOAT = 0x05
    DOUBLE = 0x06
    STR8 = 0x07
    STR16 = 0x08
    STR32 = 0x09
    TRUE = 0x0A
    FALSE = 0x0B
    REF = 0x0C
    IDENT = 0x0D
    SUBIDENT = 0x0E
    SUB_OPEN = 0x0F
    SUB_CLOSE = 0x10
    TERMINATOR = 0x11
    STR32B = 0x12
    POSITION = 0x13
    VECTOR = 0x14
    ENUM = 0x15
    VECTOR2 = 0x16
    INT64 = 0x17


_FIXED = {
    tag: struct.Struct(fmt)
    for tag, fmt in {
        Tag.CHAR: "<B",
        Tag.SHORT: "<h",
        Tag.LONG: "<i",
        Tag.FLOAT: "<f",
        Tag.DOUBLE: "<d",
        Tag.REF: "<i",
        Tag.ENUM: "<i",
        Tag.POSITION: "<3d",
        Tag.VECTOR: "<3d",
        Tag.VECTOR2: "<2d",
        Tag.INT64: "<q",
    }.items()
}
_TUPLE_TAGS = {Tag.POSITION, Tag.VECTOR, Tag.VECTOR2}
_STRING_LEN = {
    tag: struct.Struct(fmt)
    for tag, fmt in {
        Tag.STR8: "<B",
        Tag.IDENT: "<B",
        Tag.SUBIDENT: "<B",
        Tag.STR16: "<H",
        Tag.STR32: "<I",
        Tag.STR32B: "<I",
    }.items()
}
_CONSTANT = {Tag.TRUE: True, Tag.FALSE: False, Tag.SUB_OPEN: None, Tag.SUB_CLOSE: None, Tag.TERMINATOR: None}
_NAME_TAGS = {Tag.IDENT, Tag.SUBIDENT}
_KERNELS = ("ASM", "ACIS")
_HISTORY_BEGIN = {f"Begin-of-{k}-History-Data" for k in _KERNELS}
_HISTORY_END = {f"End-of-{k}-History-Section" for k in _KERNELS}
_DATA_END = {f"End-of-{k}-data" for k in _KERNELS}
_STRING_TAGS = {Tag.STR8, Tag.STR16, Tag.STR32, Tag.STR32B}


class SabError(ValueError):
    pass


@dataclass(frozen=True)
class Entity:
    """1 レコード。フィールドは型ごとに取り出せる（位置の意味はエンティティ種別で決まる）。"""

    index: int
    type: str
    fields: tuple[tuple[Tag, object], ...]

    def _values(self, *tags: Tag) -> list:
        return [value for tag, value in self.fields if tag in tags]

    @cached_property
    def refs(self) -> list[int]:
        return self._values(Tag.REF)

    @cached_property
    def doubles(self) -> list[float]:
        return self._values(Tag.DOUBLE)

    @cached_property
    def bools(self) -> list[bool]:
        return self._values(Tag.TRUE, Tag.FALSE)

    @cached_property
    def positions(self) -> list[tuple[float, float, float]]:
        return self._values(Tag.POSITION)

    @cached_property
    def vectors(self) -> list[tuple[float, float, float]]:
        return self._values(Tag.VECTOR)

    @cached_property
    def strings(self) -> list[str]:
        return self._values(*_STRING_TAGS)


@dataclass(frozen=True)
class SabDocument:
    offset: int
    end: int
    version: int
    product: str
    kernel: str
    saved_at: str
    mm_per_unit: float
    resabs: float
    resnor: float
    entities: tuple[Entity, ...]
    history: tuple[Entity, ...]

    def get(self, ref: int) -> Entity | None:
        return self.entities[ref] if 0 <= ref < len(self.entities) else None

    def of_type(self, type_name: str) -> list[Entity]:
        return [e for e in self.entities if e.type == type_name]


class _Reader:
    def __init__(self, buf: bytes, pos: int):
        self.buf = buf
        self.pos = pos

    def token(self) -> tuple[Tag, object]:
        buf, pos = self.buf, self.pos
        if pos >= len(buf):
            raise SabError("SAB データが終端レコードの前で途切れています")
        try:
            tag = Tag(buf[pos])
        except ValueError:
            raise SabError(f"未知のタグ 0x{buf[pos]:02x} (offset 0x{pos:x})") from None
        pos += 1
        if tag in _FIXED:
            fmt = _FIXED[tag]
            values = fmt.unpack_from(buf, pos)
            value = values if tag in _TUPLE_TAGS else values[0]
            pos += fmt.size
        elif tag in _STRING_LEN:
            fmt = _STRING_LEN[tag]
            (length,) = fmt.unpack_from(buf, pos)
            pos += fmt.size
            value = buf[pos : pos + length].decode("utf-8", errors="replace")
            pos += length
        else:
            value = _CONSTANT[tag]
        self.pos = pos
        return tag, value


def find_blocks(buf: bytes) -> list[int]:
    """バッファ中の SAB ブロック開始位置をすべて返す。"""
    found = []
    for magic in MAGICS:
        at = buf.find(magic)
        while at >= 0:
            found.append(at)
            at = buf.find(magic, at + 1)
    return sorted(found)


def parse(buf: bytes, offset: int) -> SabDocument:
    if buf[offset : offset + _MAGIC_LEN] not in MAGICS:
        raise SabError(f"offset 0x{offset:x} は SAB の先頭ではありません")
    version, _, _, _ = _HEADER.unpack_from(buf, offset + _MAGIC_LEN)
    reader = _Reader(buf, offset + _MAGIC_LEN + _HEADER.size)
    product, kernel, saved_at, mm_per_unit, resabs, resnor = (reader.token()[1] for _ in range(6))

    entities: list[Entity] = []
    history: list[Entity] = []
    record: list[tuple[Tag, object]] = []
    in_history = False
    while True:
        tag, value = reader.token()
        record.append((tag, value))
        if tag in _NAME_TAGS and all(t in _NAME_TAGS for t, _ in record):
            marker = "-".join(str(v) for _, v in record)
            if marker in _DATA_END:
                break
            if marker in _HISTORY_BEGIN or marker in _HISTORY_END:
                in_history = marker in _HISTORY_BEGIN
                record = []
        elif tag is Tag.TERMINATOR:
            table = history if in_history else entities
            table.append(_make_entity(len(table), record))
            record = []

    return SabDocument(
        offset=offset,
        end=reader.pos,
        version=version,
        product=product,
        kernel=kernel,
        saved_at=saved_at,
        mm_per_unit=mm_per_unit,
        resabs=resabs,
        resnor=resnor,
        entities=tuple(entities),
        history=tuple(history),
    )


def _make_entity(index: int, record: list[tuple[Tag, object]]) -> Entity:
    split = next((i for i, (tag, _) in enumerate(record) if tag not in _NAME_TAGS), len(record))
    type_name = "-".join(str(value) for _, value in record[:split])
    fields = tuple((tag, value) for tag, value in record[split:] if tag is not Tag.TERMINATOR)
    return Entity(index, type_name, fields)
