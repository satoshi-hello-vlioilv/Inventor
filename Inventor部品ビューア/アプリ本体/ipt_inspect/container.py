"""コンテナ層: .ipt (OLE2 複合ドキュメント) から RSe セグメントを取り出す。

.ipt の外殻は Microsoft Compound File Binary (MS-CFB) で、仕様は公開されている。
設計データは ``RSeStorage`` ストレージ配下に「セグメント」単位で格納され、
各セグメントは 2 本のストリームで構成される。

* ``M<key>`` … メタ情報（ヘッダにセグメント名、以降はクラススキーマ等）
* ``B<key>`` … 本体データ（オブジェクトグラフ）

Inventor 2026 で保存したファイルでは、どちらもヘッダ直後から Zstandard 圧縮されている。
"""
from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

import olefile
import zstandard

RSE_STORAGE = "RSeStorage"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PNG_END = b"IEND"
# 圧縮フレームは非圧縮ヘッダの直後に置かれる。ヘッダ部だけを探索範囲にして誤検出を防ぐ。
_HEADER_SCAN_LIMIT = 512
# メタストリームの非圧縮ヘッダに UTF-16LE で書かれたセグメント名（例: PmBRepSegment）
_SEGMENT_NAME = re.compile(rb"(?:[A-Za-z0-9_]\x00)+?S\x00e\x00g\x00m\x00e\x00n\x00t\x00")


@dataclass(frozen=True)
class Stream:
    path: str
    size: int


@dataclass(frozen=True)
class Segment:
    """RSe セグメント 1 つ分（展開済み）。"""

    key: str
    name: str
    meta: bytes
    data: bytes
    meta_stored_size: int
    data_stored_size: int
    compressed: bool


def _decompress(raw: bytes) -> tuple[bytes, bool]:
    """ヘッダ直後の Zstandard フレームを展開する。圧縮されていなければそのまま返す。"""
    at = raw.find(ZSTD_MAGIC, 0, _HEADER_SCAN_LIMIT)
    if at < 0:
        return raw, False
    try:
        return zstandard.ZstdDecompressor().decompressobj().decompress(raw[at:]), True
    except zstandard.ZstdError:
        return raw, False


def _segment_name(meta_raw: bytes, fallback: str) -> str:
    match = _SEGMENT_NAME.search(meta_raw, 0, _HEADER_SCAN_LIMIT)
    return match.group(0).decode("utf-16-le") if match else fallback


def _extract_png(raw: bytes) -> bytes | None:
    start = raw.find(PNG_MAGIC)
    if start < 0:
        return None
    end = raw.find(PNG_END, start)
    # IEND チャンク = 種別(4) + CRC(4)
    return raw[start : end + 8] if end >= 0 else None


class IptFile:
    """.ipt ファイルの読み取り専用ビュー。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.file_size = self.path.stat().st_size
        with olefile.OleFileIO(str(self.path)) as ole:
            self.clsid = ole.root.clsid
            self.streams = [
                Stream("/".join(entry), ole.get_size("/".join(entry)))
                for entry in ole.listdir(streams=True, storages=False)
            ]
            raw = {s.path: ole.openstream(s.path).read() for s in self.streams}
        self.segments = self._load_segments(raw)
        self.thumbnail = self._find_thumbnail(raw)

    @staticmethod
    def _load_segments(raw: dict[str, bytes]) -> list[Segment]:
        prefix = RSE_STORAGE + "/"
        keys = sorted(
            p[len(prefix) + 1 :]
            for p in raw
            if p.startswith(prefix + "B") and "/" not in p[len(prefix) :]
        )
        segments = []
        for key in keys:
            data_raw = raw[f"{prefix}B{key}"]
            meta_raw = raw.get(f"{prefix}M{key}", b"")
            data, data_packed = _decompress(data_raw)
            meta, _ = _decompress(meta_raw)
            segments.append(
                Segment(
                    key=key,
                    name=_segment_name(meta_raw, fallback=key),
                    meta=meta,
                    data=data,
                    meta_stored_size=len(meta_raw),
                    data_stored_size=len(data_raw),
                    compressed=data_packed,
                )
            )
        return segments

    @staticmethod
    def _find_thumbnail(raw: dict[str, bytes]) -> bytes | None:
        # サムネイルはプロパティセット（先頭が \x05 のストリーム）に PNG として埋め込まれている
        for path, content in raw.items():
            if path.startswith("\x05"):
                png = _extract_png(content)
                if png:
                    return png
        return None

    def segment(self, name: str) -> Segment | None:
        return next((s for s in self.segments if s.name == name), None)

    @property
    def thumbnail_size(self) -> tuple[int, int] | None:
        if not self.thumbnail:
            return None
        # IHDR: シグネチャ(8) + 長さ(4) + 種別(4) の直後に幅・高さ (big endian)
        return struct.unpack(">II", self.thumbnail[16:24])
