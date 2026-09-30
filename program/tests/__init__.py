"""評価（Python）。program フォルダで:

    python -m unittest discover -s tests -t .

各テストはこのパッケージを先に読み込む。program フォルダを import の探索先に入れ、
作業場所（settings.LOCAL_ROOT）・ポート（settings.PORT）・「Inventor で作る」の保存先を評価だけのものにする
（評価がこの PC の本物の作業場所・ドキュメントに触らず、動いているアプリとぶつからないように）。
"""
import json
import os
import socket
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # program フォルダ


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


if "INVENTOR_TOOL_LOCAL_ROOT" not in os.environ:
    _work = Path(tempfile.mkdtemp(prefix="inventor-3d-tool-test-"))
    _config = _work / "appsettings.json"
    _config.write_text(json.dumps({"server": {"port": _free_port()}, "build": {"output_dir": str(_work / "built")}}), encoding="utf-8")
    os.environ.update(INVENTOR_TOOL_LOCAL_ROOT=str(_work / "local"), INVENTOR_TOOL_CONFIG=str(_config))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
