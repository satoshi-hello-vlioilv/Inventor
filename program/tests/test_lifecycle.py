"""サーバーの生き死に（app/lifecycle.py）の評価。転写距離・ピッチ解析の評価と同じ観点に、「一度もつながらない」を足した。

画面が裏に回っている間はブラウザが知らせを間引くので、短い猶予で止めてはいけない。閉じたときは短い猶予で止まる。
"""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

import tests  # noqa: F401
from app.lifecycle import Lifecycle

GRACE = 0.05


def life(**kw):
    return Lifecycle(**{"idle_grace": GRACE, "hidden_grace": 60, "no_client_grace": 60, **kw})


class Grace(unittest.TestCase):
    def test_visible_page_stops_after_idle_grace(self):
        lc = life()
        lc.beat(visible=True)
        time.sleep(GRACE * 2)
        self.assertEqual(lc._should_shutdown(), "idle_timeout")

    def test_hidden_page_is_not_stopped(self):
        lc = life()
        lc.beat(visible=False)
        time.sleep(GRACE * 2)
        self.assertIsNone(lc._should_shutdown())

    def test_closing_uses_short_grace_even_if_hidden(self):
        lc = life()
        lc.beat(visible=False, closing=True)
        time.sleep(GRACE * 2)
        self.assertEqual(lc._should_shutdown(), "idle_timeout")

    def test_resume_from_sleep_gives_fresh_grace(self):
        lc = life()
        lc.beat(visible=True)
        time.sleep(GRACE * 2)
        lc._resumed()
        self.assertIsNone(lc._should_shutdown())

    def test_waits_for_the_first_page_then_gives_up(self):
        """ブラウザが開けなかったとき、見えないサーバーを残し続けない。"""
        self.assertIsNone(life()._should_shutdown(), "起動した直後は、画面がつながるのを待つ")
        lc = life(no_client_grace=GRACE)
        time.sleep(GRACE * 2)
        self.assertEqual(lc._should_shutdown(), "no_client")

    def test_disabled_only_stops_when_asked(self):
        lc = life(enabled=False, no_client_grace=0)
        lc.beat()
        time.sleep(GRACE * 2)
        self.assertIsNone(lc._should_shutdown())
        lc.request_stop()
        self.assertEqual(lc._should_shutdown(), "explicit")


class Cleanup(unittest.TestCase):
    def test_removes_only_its_own_info(self):
        """止めるときに消す名乗り（server.json）は自分のものだけ（入れ替わりで新しいサーバーが書いたものは消さない）。"""
        folder = Path(tempfile.mkdtemp())
        info = folder / "server.json"
        info.write_text(json.dumps({"pid": os.getpid() + 1}), encoding="utf-8")
        life(info_file=info)._cleanup()
        self.assertTrue(info.exists())
        info.write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
        life(info_file=info)._cleanup()
        self.assertFalse(info.exists())


if __name__ == "__main__":
    unittest.main()
