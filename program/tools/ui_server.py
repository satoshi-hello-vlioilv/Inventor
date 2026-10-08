"""画面だけを確かめるための開発用サーバー（窓 desktop/ の代わり。利用者の起動の道ではない）。

窓（desktop/src/router.rs）と同じ置き場・同じ答えの形で、画面（app/）・サンプル・受け取ったファイルを配り、
「STEP を作る」「Inventor で作る」は Python を起こさずに進み具合を模擬する（画面の見た目と流れを確かめるため）。
ブラウザ（Playwright の Chromium など。WebView2 と同じ系統）で開き、program/tools/ui-check.mjs が撮影と測定に使う。

    python tools/ui_server.py [ポート] [受け取ったことにするファイル ...]

模擬の操作（測定の台本が使う。合言葉は要らない）:
    POST /__dev/freeze          作る仕事を自動で進めない（撮影のため、決まった段階で止める）
    POST /__dev/step?n=3        3 段進める（STEP → 接続 → 部品 1 つずつ → 組立 → 完了）
    POST /__dev/launch          受け取ったファイルを預け直し、画面へ届いたことにする（引数のファイル）
    POST /__dev/env?ready=0&inventor=0&python=0   ライブラリ・Inventor・Python があるかを変える
    POST /__dev/mix?mismatch=4,11&failed=19       次に作る仕事で、その番目（1 から）の部品を不一致・失敗にする（無しで全て一致）
    POST /__dev/shortcut?desktop=missing&start=ok  ショートカットの状態を変える（ok・missing・other。窓の shortcut.rs と同じ形で答える）
    POST /__dev/update?role=developer&reachable=1  版の管理の役割（developer・maintainer・user・unset）・置き場に届くかを変える（update.rs と同じ形）
"""
from __future__ import annotations

import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

PROGRAM = Path(__file__).resolve().parents[1]
APP = PROGRAM / "app"
SAMPLES = PROGRAM / "samples"
TOKEN = "dev-" + "0" * 44  # 画面が添える合言葉（48 字。窓と同じ長さ）
KINDS = {"ipt": (".ipt",), "iam": (".iam",), "stp": (".stp", ".step"), "dwg": (".dwg", ".dxf", ".pdf", ".jww"), "html": (".html", ".htm")}
TYPES = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png"}
TICK = 0.45  # 秒。自動で 1 段進む間隔


class Build:
    """作る仕事の模擬（窓の jobs.rs と同じ形の状態を返す）。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.job = {"state": "idle"}
        self.frozen = False
        self.steps: list[dict] = []
        self.mix: dict[int, str] = {}  # 部品の番目（1 から） → "mismatch" か "failed"（無ければ一致）

    def start(self, spec: dict, target: str) -> dict:
        parts = spec.get("parts") or []
        name = Path(str((spec.get("source") or {}).get("file") or "変換データ")).stem
        inventor = target == "inventor"
        rows = [{"key": p.get("key"), "name": p.get("name", p.get("key")), "instances": len(p.get("instances") or []), "verdict": None,
                 "file": None, "volume_diff": None, "area_diff": None, "extent": None, "error": None} for p in parts]
        placed = sum(r["instances"] for r in rows)
        out = str(Path.home() / "Documents" / "Inventor 3Dツール" / f"{name}_cad")
        step_done = {"file": f"{name}.stp", "placed": placed, "assembly": placed > 1,
                     "parts": [{"key": r["key"], "how": "faceted" if p.get("kind") == "mesh" else "exact", "note": ""} for r, p in zip(rows, parts)]}
        assembly = {"file": f"{name}.iam", "placed": placed, "error": None} if inventor and placed > 1 else None
        base = {"name": name, "target": target, "spec": f"{out}/{name}.inventor.json", "out_dir": out, "message": "", "detail": "",
                "parts": rows, "assembly": assembly, "good": 0, "total": len(rows), "step": None, "inventor": inventor, "inventor_error": None}
        steps = [{"state": "step"}, {"step": step_done, **({"state": "connecting"} if inventor else {})}]
        if inventor:
            steps.append({"state": "building"})
            results = [self.result(j + 1, r) for j, r in enumerate(rows)]
            for i in range(len(rows)):
                made = [results[j] if j <= i else r for j, r in enumerate(rows)]
                steps.append({"parts": made, "good": sum(r["verdict"] == "ok" for r in made[: i + 1])})
            if assembly:
                steps.append({"state": "assembly"})
        steps.append({"state": "done"})
        with self.lock:
            if self.job.get("state") in ("installing", "step", "connecting", "building", "assembly"):
                raise RuntimeError(f"「{self.job['name']}」を作っています。終わってから、もう一度押してください")
            self.job = {**base, **steps[0]}
            self.steps = steps[1:]
        return self.status()

    def result(self, number: int, row: dict) -> dict:
        """部品 1 つの照合の結果（mix で決めた番目は不一致・失敗）"""
        kind = self.mix.get(number)
        if kind == "failed":
            return dict(row, verdict="failed", error="Inventor でこの形を作れませんでした（回転の断面が閉じていません）")
        if kind == "mismatch":
            return dict(row, verdict="mismatch", volume_diff=0.0342, area_diff=0.0127, extent="外形の差 1.20 mm", file=f"{row['key']}.ipt")
        return dict(row, verdict="ok", volume_diff=1e-11, area_diff=-2e-11, extent="外形の差 0.0000 mm", file=f"{row['key']}.ipt")

    def step(self, n: int = 1) -> None:
        with self.lock:
            for _ in range(n):
                if self.steps:
                    self.job.update(self.steps.pop(0))

    def cancel(self) -> None:
        with self.lock:
            if self.job.get("state") not in ("idle", "done", "failed", "cancelled"):
                self.steps = []
                self.job.update(state="cancelled", message="中止しました。Inventor に作りかけの部品が開いていれば、保存せずに閉じてください")

    def status(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.job))

    def run(self) -> None:
        while True:
            time.sleep(TICK)
            if not self.frozen:
                self.step()


BUILD = Build()
ENV = {"ready": True, "inventor": True, "python": True}
LAUNCH: list[Path] = []
GIVEN: dict[str, Path] = {}
PENDING: list[Path] = []
UPDATE = {"role": "developer", "reachable": True, "local": "2.1.0", "release": "2.1.0", "previous": "2.0.3", "keep": 5,
          "versions": [("2.1.0", "2026-10-08T09:12:00Z", "sato@PC-SHIAGE01", "Inventor-main.zip", 812, 41_532_118),
                       ("2.0.3", "2026-10-01T16:40:00Z", "sato@PC-SHIAGE01", "Inventor-main (3).zip", 790, 40_118_207),
                       ("2.0.2", "2026-09-24T11:05:00Z", "tanaka@PC-SHIAGE07", "Inventor-main (2).zip", 788, 40_002_311),
                       ("2.0.0", "2026-09-10T08:30:00Z", "sato@PC-SHIAGE01", "Inventor-main.zip", 702, 35_220_004)],
          "roles": {"developers": ["sato"], "maintainers": ["tanaka", "suzuki"]}}
SHORTCUTS = {"desktop": "ok", "start": "missing"}  # ショートカットの状態の模擬（既定はデスクトップにある: いつもの起動。無いときは /__dev/shortcut で）
SHORTCUT_LABELS = {"desktop": "デスクトップ", "start": "スタートメニュー"}


def update_status() -> dict:
    """窓の update::status と同じ形"""
    base = {"dir": "C:\\boxdrive\\Box\\(D)_仕上課\\90_アプリ開発\\90_Releases\\Inventor", "dirSource": "default",
            "defaultDir": "C:\\boxdrive\\Box\\(D)_仕上課\\90_アプリ開発\\90_Releases\\Inventor", "user": "sato", "local": UPDATE["local"],
            "publishing": False, "app": "C:\\Users\\sato\\Inventor3DTool"}
    if not UPDATE["reachable"]:
        return {**base, "reachable": False, "role": "unknown", "canManage": False, "why": "置き場が 3 秒で答えませんでした（Box Drive がつながっているか確かめてください）"}
    role = UPDATE["role"]
    v = {**base, "reachable": True, "role": role, "canManage": role in ("developer", "maintainer"),
         "release": {"version": UPDATE["release"], "setAt": "2026-10-08T09:15:00Z", "setBy": "sato@PC-SHIAGE01", "previous": UPDATE["previous"]},
         "pending": UPDATE["release"] != UPDATE["local"], "policy": {"keep": UPDATE["keep"]},
         "versions": [{"version": a, "placedAt": b, "placedBy": c, "source": d, "commit": "acba55d", "files": e, "bytes": f} for a, b, c, d, e, f in UPDATE["versions"]],
         "entry": {"path": base["dir"] + "\\Inventor3DTool.exe", "exists": True}}
    if role in ("developer", "unset"):
        v["roles"] = UPDATE["roles"] if role == "developer" else {"developers": [], "maintainers": []}
    return v


def shortcut_status() -> dict:
    """窓の shortcut.rs と同じ形"""
    return {"supported": True, "offer": SHORTCUTS["desktop"] != "ok", "target": "C:\\Users\\you\\Inventor3DTool\\Inventor3DTool.exe", "places": [{"place": k, "label": SHORTCUT_LABELS[k], "state": v,
                                           "path": f"C:\\Users\\you\\{SHORTCUT_LABELS[k]}\\Inventor 3Dツール.lnk"} for k, v in SHORTCUTS.items()]}


def entry(path: Path) -> dict:
    key = secrets.token_hex(8)
    GIVEN[key] = path
    return {"name": path.name, "size": path.stat().st_size, "url": f"/api/files/{key}"}


def claim() -> dict:
    paths, PENDING[:] = list(PENDING), []
    files, parts, missing = [], [], []
    for p in paths:
        if not p.is_file():
            missing.append(p.name)
            continue
        files.append(entry(p))
        if p.suffix.lower() == ".iam":
            parts += [entry(q) for q in sorted(p.parent.glob("*.ipt")) if q not in paths]
    return {"files": files, "parts": parts, "missing": missing}


def samples() -> list[dict]:
    out = []
    for kind, exts in KINDS.items():
        for p in sorted((SAMPLES / kind).iterdir()) if (SAMPLES / kind).is_dir() else []:
            if p.is_file() and p.suffix.lower() in exts:
                out.append({"kind": kind, "name": p.name, "size": p.stat().st_size, "url": f"/samples/{kind}/{quote(p.name)}"})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静かにする
        pass

    def send(self, status: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, status: int = 200) -> None:
        self.send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json")

    def file(self, root: Path, rel: str) -> None:
        path = (root / rel).resolve()
        if root.resolve() not in path.parents or not path.is_file():
            return self.json({"message": "ありません"}, 404)
        self.send(200, path.read_bytes(), TYPES.get(path.suffix.lower(), "application/octet-stream"), "no-cache")

    def build_status(self, **extra) -> None:
        missing = None if ENV["python"] else "Python が見つかりません。「STEP を作る」「Inventor で作る」には Python（3.10 以上）が要ります。"
        self.json({**BUILD.status(), "ready": ENV["ready"], "inventor_installed": ENV["inventor"],
                   "root": str(Path.home() / "Documents" / "Inventor 3Dツール"), "python_missing": missing, **extra})

    def route(self, method: str) -> None:
        url = urlparse(self.path)
        path, query = unquote(url.path), parse_qs(url.query)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if method == "POST" else b""
        if path in ("/", "/index.html"):
            return self.send(200, (APP / "index.html").read_text(encoding="utf-8").replace("{{ token }}", TOKEN).encode("utf-8"), TYPES[".html"])
        if path.startswith("/static/"):
            return self.file(APP / "static", path[len("/static/"):])
        if path.startswith("/samples/"):
            return self.file(SAMPLES, path[len("/samples/"):])
        if path == "/__desktop/pick-zip":
            return self.json({"path": "C:\\Users\\sato\\Downloads\\Inventor-main.zip"})
        if path.startswith("/__dev/"):
            if path == "/__dev/freeze":
                BUILD.frozen = True
            elif path == "/__dev/step":
                BUILD.step(int(query.get("n", ["1"])[0]))
            elif path == "/__dev/launch":
                PENDING[:] = list(LAUNCH)
            elif path == "/__dev/mix":
                BUILD.mix = {int(n): kind for kind in ("mismatch", "failed") for n in (query.get(kind, [""])[0].split(",")) if n}
            elif path == "/__dev/shortcut":
                for k in SHORTCUTS:
                    if k in query:
                        SHORTCUTS[k] = query[k][0]
            elif path == "/__dev/update":
                if "role" in query:
                    UPDATE["role"] = query["role"][0]
                if "reachable" in query:
                    UPDATE["reachable"] = query["reachable"][0] == "1"
            elif path == "/__dev/env":
                for k in ENV:
                    if k in query:
                        ENV[k] = query[k][0] == "1"
            return self.json({"ok": True, "job": BUILD.status()})
        if not path.startswith("/api/"):
            return self.json({"message": "ありません"}, 404)
        if self.headers.get("X-App-Token") != TOKEN:
            return self.json({"message": "この画面からの依頼ではありません"}, 403)
        if path == "/api/samples":
            return self.json({"samples": samples()})
        if path == "/api/launch" and method == "POST":
            return self.json(claim())
        if path.startswith("/api/files/"):
            p = GIVEN.get(path.rsplit("/", 1)[1])
            return self.send(200, p.read_bytes(), "application/octet-stream") if p and p.is_file() else self.json({"message": "ありません"}, 404)
        if path == "/api/build" and method == "GET":
            return self.build_status()
        if path == "/api/build" and method == "POST":
            asked = json.loads(body or b"{}")
            if not ENV["python"]:
                return self.json({"message": "Python が見つかりません。"}, 503)
            target = asked.get("target", "inventor")
            if target == "inventor" and not asked.get("install") and not ENV["ready"]:
                return self.build_status(needs_install=True)
            spec = asked.get("spec")
            if not isinstance(spec, dict) or spec.get("format") != "inventor-builder":
                return self.json({"message": "この変換データからは作れません: 変換データ（format: inventor-builder）ではありません"}, 400)
            try:
                BUILD.start(spec, target)
            except RuntimeError as error:
                return self.json({"message": str(error)}, 409)
            return self.build_status()
        if path == "/api/build/cancel":
            BUILD.cancel()
            return self.build_status()
        if path == "/api/build/open":
            return self.json({"opened": True})
        if path == "/api/update" and method == "GET":
            return self.json(update_status())
        if path == "/api/update/progress":
            return self.json({"state": "idle"})
        if path.startswith("/api/update/") and method == "POST":
            op, asked = path.rsplit("/", 1)[1], json.loads(body or b"{}")
            if op != "settings" and UPDATE["role"] not in ("developer", "maintainer") and op != "roles":
                return self.json({"message": "版の管理は、開発者とメンテナンス者だけができます"}, 403)
            if op == "release":
                UPDATE["previous"], UPDATE["release"] = UPDATE["release"], asked.get("version")
                return self.json({"release": {"version": UPDATE["release"]}, "notes": []})
            if op == "delete":
                if asked.get("version") == UPDATE["release"]:
                    return self.json({"message": "配っている版なので消せません。"}, 400)
                UPDATE["versions"] = [v for v in UPDATE["versions"] if v[0] != asked.get("version")]
                return self.json({"deleted": asked.get("version")})
            if op == "publish":
                UPDATE["versions"].insert(0, ("2.2.0", "2026-10-08T12:00:00Z", "sato@PC-SHIAGE01", "Inventor-main.zip", 820, 41_900_000))
                return self.json({"version": "2.2.0", "files": 820, "bytes": 41_900_000, "pruned": []})
            if op == "policy":
                UPDATE["keep"] = int(asked.get("keep") or 0)
                return self.json({"keep": UPDATE["keep"]})
            if op == "roles":
                UPDATE["roles"] = {"developers": asked.get("developers", []), "maintainers": asked.get("maintainers", [])}
                return self.json(UPDATE["roles"])
            return self.json({"saved": True})
        if path == "/api/shortcut/decline":
            return self.json(shortcut_status())
        if path == "/api/shortcut":
            if method == "POST":
                place = json.loads(body or b"{}").get("place")
                if place not in SHORTCUTS:
                    return self.json({"message": f"知らない置き場です: {place}"}, 500)
                SHORTCUTS[place] = "ok"
            return self.json(shortcut_status())
        return self.json({"message": "ありません"}, 404)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")


def main(argv: list[str]) -> int:
    port = int(argv[1]) if len(argv) > 1 else 8765
    LAUNCH[:] = [Path(a).resolve() for a in argv[2:]]
    PENDING[:] = list(LAUNCH)
    threading.Thread(target=BUILD.run, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"http://127.0.0.1:{port}/", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
