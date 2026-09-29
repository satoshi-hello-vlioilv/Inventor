# -*- coding: utf-8 -*-
"""起動の入口（Start.vbs が pythonw で、診断起動の start.bat が python で実行する）。ドロップされたファイルは引数で受け取る。

.pyc の置き場を手元の作業場所にしてから（program フォルダに __pycache__ を作らない）、起動の係（launch_guard.py）へ渡す。
Python が古いと、起動の係を読み込む前に知らせて終わる（古い Python では読み込めない書き方があるため、ここは古い書き方だけで書く）。
"""
import os
import sys

MIN_PYTHON = (3, 10)

if __name__ == "__main__":
    if sys.version_info < MIN_PYTHON:
        text = ("Python %d.%d 以上が必要です（この PC の Python は %d.%d）。\n\npython.org から新しい Python を入れてください。"
                % (MIN_PYTHON + sys.version_info[:2]))
        if os.name == "nt":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, "Inventor 3Dツール", 0x30 | 0x40000)
        else:
            print(text)
        sys.exit(1)

    sys.dont_write_bytecode = True  # 置き場を決める settings 自身の .pyc も、program フォルダに作らない
    import settings

    settings.PYCACHE.mkdir(parents=True, exist_ok=True)
    sys.pycache_prefix = str(settings.PYCACHE)  # これから読み込むモジュールの .pyc は、手元の作業場所へ
    sys.dont_write_bytecode = False
    import launch_guard

    sys.exit(launch_guard.main())
