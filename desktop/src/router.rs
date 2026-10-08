//! 画面（WebView）からの問い合わせに答える。自前の仕組み（inventor）で受けるので、ポートを開かない（ほかの PC・ほかのアプリから届かない）。
//!
//!   GET  /                     画面（program/app/index.html。起動ごとの合言葉を埋め込む）
//!   GET  /static/…             画面の部品（program/app/static）
//!   GET  /samples/<種類>/<名前>  サンプルの中身（program/samples）
//!   GET  /api/samples          サンプルの一覧                                                     … 合言葉
//!   POST /api/launch           起動で受け取ったファイル（まとめて 1 回。received.rs）                  … 合言葉
//!   GET  /api/files/<番号>      受け取ったファイルの中身                                             … 合言葉
//!   GET  /api/build            作る仕事の状態・保存先・ライブラリと Inventor があるか・Python が無い理由   … 合言葉
//!   POST /api/build            作り始める（{spec, install, target: inventor | step}。jobs.rs）         … 合言葉
//!   POST /api/build/cancel     中止する                                                          … 合言葉
//!   POST /api/build/open       保存先をエクスプローラーで開く                                         … 合言葉
//!   GET  /api/shortcut         ショートカット（デスクトップ・スタートメニュー）が有るか（shortcut.rs）     … 合言葉
//!   POST /api/shortcut         ショートカットを作る・作り直す（{place: desktop | start}）              … 合言葉
//!   POST /api/shortcut/decline 起動のときの「デスクトップに作りますか」に「作らない」と答えた             … 合言葉
//!   GET  /api/update           版の管理の状態（置き場・配る版・版の一覧・役割。update::status）         … 合言葉
//!   GET  /api/update/progress  版を置いている途中の進み具合                                         … 合言葉
//!   POST /api/update/publish   ZIP から版を置く（{path}。ZIP は窓のファイルを選ぶ窓で選ぶ）              … 合言葉・開発者／メンテナンス者
//!   POST /api/update/release   配る版を選ぶ（{version}）                                           … 合言葉・開発者／メンテナンス者
//!   POST /api/update/delete    版を消す（{version}。配っている版は消せない）                           … 合言葉・開発者／メンテナンス者
//!   POST /api/update/policy    残す版の数（{keep}）                                               … 合言葉・開発者／メンテナンス者
//!   POST /api/update/roles     役割（{developers, maintainers}）                                  … 合言葉・開発者（最初の 1 人は自分を）
//!   POST /api/update/settings  この PC の置き場（{dir}。空なら既定）                                 … 合言葉・開発者／メンテナンス者（置き場に届かないときは誰でも）
//!   /__desktop/…               窓そのもの（自己診断など。main.rs が native として渡す）                 … 合言葉
//!
//! 合言葉: 開いた HTML のモデルは隔離した iframe（sandbox・別の生まれ）で動かす。その中のスクリプトも同じ置き場へ問い合わせを
//! 送れるので、ファイルを渡す・作るなどの依頼には、画面の <meta name="app-token"> にだけ書いた起動ごとの合言葉を求める。

use crate::jobs::Jobs;
use crate::received::Received;
use crate::shortcut::Shortcuts;
use crate::update;
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::http::{Request, Response};

/// 答え（状態・見出し・本文）
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, v: &Value) -> Reply {
        Reply {
            status,
            headers: vec![("Content-Type".into(), "application/json".into()), ("Cache-Control".into(), "no-store".into())],
            body: serde_json::to_vec(v).unwrap_or_default(),
        }
    }
    /// 誤り（画面の server.js は message を利用者に見せる）
    pub fn error(status: u16, message: &str) -> Reply {
        Reply::json(status, &json!({"message": message}))
    }
}

/// 窓そのものが答える問い合わせ（method, path, 合言葉が合っているか, 本文）→ 答え。None ならほかへ回す。
pub type Native = Box<dyn Fn(&str, &str, bool, &[u8]) -> Option<Reply> + Send + Sync>;

/// サンプルの種類（起動画面にこの順で並ぶ）と拡張子
const SAMPLE_KINDS: [(&str, &[&str]); 5] =
    [("ipt", &["ipt"]), ("iam", &["iam"]), ("stp", &["stp", "step"]), ("dwg", &["dwg", "dxf", "pdf", "jww"]), ("html", &["html", "htm"])];

pub struct Router {
    /// program フォルダ（画面は app、サンプルは samples）
    pub program: PathBuf,
    pub token: String,
    pub jobs: Arc<Jobs>,
    pub received: Arc<Received>,
    /// この PC に Inventor があるか（網では差し替える）
    pub inventor_installed: fn() -> bool,
    pub shortcuts: Shortcuts,
    /// 版を置いている途中の進み具合（1 つの窓で 1 つずつ）
    pub publishing: update::Progress,
    pub native: Native,
}

impl Router {
    pub fn handle(&self, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let path = percent_decode(req.uri().path());
        let sent = req.headers().get("x-app-token").and_then(|v| v.to_str().ok()).unwrap_or("");
        let reply = self.route(req.method().as_str(), &path, same(sent, &self.token), req.body());
        let mut b = Response::builder().status(reply.status);
        for (k, v) in &reply.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        b.body(reply.body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).unwrap())
    }

    fn route(&self, method: &str, path: &str, token_ok: bool, body: &[u8]) -> Reply {
        let get = matches!(method, "GET" | "HEAD");
        if path.starts_with("/__desktop/") {
            if !token_ok {
                return Reply::error(403, "この画面からの依頼ではありません");
            }
            return (self.native)(method, path, token_ok, body).unwrap_or_else(|| Reply::error(404, "ありません"));
        }
        if get && (path == "/" || path == "/index.html") {
            return self.index();
        }
        if let (true, Some(rest)) = (get, path.strip_prefix("/static/")) {
            return file_under(&self.program.join("app").join("static"), rest, "no-cache");
        }
        if let (true, Some(rest)) = (get, path.strip_prefix("/samples/")) {
            return match rest.split_once('/') {
                Some((kind, name)) if SAMPLE_KINDS.iter().any(|(k, _)| *k == kind) => {
                    file_under(&self.program.join("samples").join(kind), name, "no-cache")
                }
                _ => Reply::error(404, "ありません"),
            };
        }
        if !path.starts_with("/api/") {
            return Reply::error(404, "ありません");
        }
        if !token_ok {
            return Reply::error(403, "この画面からの依頼ではありません。アプリを開き直してください");
        }
        match (method, path) {
            ("GET", "/api/samples") => Reply::json(200, &json!({"samples": samples(&self.program.join("samples"))})),
            ("POST", "/api/launch") => Reply::json(200, &self.received.claim()),
            ("GET", "/api/build") => self.build_status(Map::new()),
            ("POST", "/api/build") => self.build_start(body),
            ("POST", "/api/build/cancel") => {
                self.jobs.cancel();
                self.build_status(Map::new())
            }
            ("POST", "/api/build/open") => Reply::json(200, &json!({"opened": self.jobs.open_output()})),
            ("GET", "/api/update") => Reply::json(200, &update::status(&self.program, &self.publishing)),
            ("GET", "/api/update/progress") => Reply::json(200, &self.publishing.get()),
            ("POST", p) if p.starts_with("/api/update/") => self.update_op(&p["/api/update/".len()..], body),
            ("GET", "/api/shortcut") => Reply::json(200, &self.shortcuts.status()),
            ("POST", "/api/shortcut/decline") => match self.shortcuts.decline() {
                Ok(v) => Reply::json(200, &v),
                Err(why) => Reply::error(500, &why),
            },
            ("POST", "/api/shortcut") => {
                let place =
                    serde_json::from_slice::<Value>(body).ok().and_then(|v| v["place"].as_str().map(str::to_string)).unwrap_or_default();
                match self.shortcuts.create(&place) {
                    Ok(status) => Reply::json(200, &status),
                    Err(why) => Reply::error(500, &why),
                }
            }
            ("GET", p) if p.starts_with("/api/files/") => match self.received.path(&p["/api/files/".len()..]) {
                Some(file) if file.is_file() => match std::fs::read(&file) {
                    Ok(bytes) => {
                        Reply { status: 200, headers: vec![("Content-Type".into(), "application/octet-stream".into())], body: bytes }
                    }
                    Err(e) => Reply::error(404, &format!("ファイルを読めません（{e}）")),
                },
                _ => Reply::error(404, "ファイルが見つかりません（移動・削除された可能性があります）"),
            },
            _ => Reply::error(404, "ありません"),
        }
    }

    /// 版の管理の操作。置き場の役割を毎回確かめる（画面の表示だけでは守らない）
    fn update_op(&self, op: &str, body: &[u8]) -> Reply {
        let v: Value = serde_json::from_slice(body).unwrap_or_default();
        let (dir, _) = update::share_dir(&self.program);
        let user = update::user_name();
        let role = if dir.is_dir() { update::role_of(&dir, &user) } else { "unknown" };
        let manage = || -> Result<(), Reply> {
            if update::can_manage(role) {
                Ok(())
            } else {
                Err(Reply::error(403, "版の管理は、開発者とメンテナンス者だけができます"))
            }
        };
        let done = |r: Result<Value, String>| match r {
            Ok(v) => Reply::json(200, &v),
            Err(why) => Reply::error(400, &why),
        };
        let text = |k: &str| v[k].as_str().unwrap_or("").trim().to_string();
        match op {
            "publish" => {
                if let Err(r) = manage() {
                    return r;
                }
                if self.publishing.running() {
                    return Reply::error(409, "いま別の版を置いています。終わってから、もう一度選んでください");
                }
                let keep = update::policy(&dir)["keep"].as_u64().unwrap_or(0) as usize;
                done(update::publish_zip(&dir, Path::new(&text("path")), &update::who(), &self.publishing, keep))
            }
            "release" => manage().map_or_else(|r| r, |_| done(update::set_release(&dir, &text("version"), &update::who()))),
            "delete" => manage().map_or_else(|r| r, |_| done(update::delete_version(&dir, &text("version")))),
            "policy" => manage().map_or_else(|r| r, |_| done(update::set_policy(&dir, v["keep"].as_u64().unwrap_or(0)))),
            "roles" => done(update::set_roles(&dir, &user, &v)),
            "settings" => {
                // 置き場に届かないときは誰でも直せる（届かない置き場からは役割も読めないため）
                if role != "unknown" {
                    if let Err(r) = manage() {
                        return r;
                    }
                }
                done(crate::settings::save(&self.program, &json!({"update": {"dir": text("dir")}})).map(|_| json!({"saved": true})))
            }
            _ => Reply::error(404, "ありません"),
        }
    }

    /// 画面。合言葉を埋め込む（毎回ディスクから読む: 画面を直したら開き直すだけで効く）
    fn index(&self) -> Reply {
        match std::fs::read_to_string(self.program.join("app").join("index.html")) {
            Ok(html) => Reply {
                status: 200,
                headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into()), ("Cache-Control".into(), "no-store".into())],
                body: html.replace("{{ token }}", &self.token).into_bytes(),
            },
            Err(e) => Reply::error(500, &format!("画面（program/app/index.html）を読めません: {e}")),
        }
    }

    /// 作る仕事の状態に、画面が先に知っておくこと（ライブラリ・Inventor があるか・保存先の親・Python が無い理由）を添える
    fn build_status(&self, extra: Map<String, Value>) -> Reply {
        let mut v = self.jobs.status();
        v.insert("ready".into(), self.jobs.ready().into());
        v.insert("inventor_installed".into(), (self.inventor_installed)().into());
        v.insert("root".into(), self.jobs.root().display().to_string().into());
        v.insert("python_missing".into(), self.jobs.python_missing().map(Value::from).unwrap_or(Value::Null));
        v.extend(extra);
        Reply::json(200, &Value::Object(v))
    }

    fn build_start(&self, body: &[u8]) -> Reply {
        let asked: Value = serde_json::from_slice(body).unwrap_or_default();
        let install = asked["install"] == true;
        let target = asked["target"].as_str().unwrap_or("inventor");
        if let Some(why) = self.jobs.python_missing() {
            return Reply::error(503, &why); // ライブラリより先に（Python が無いのに「入れて作りますか」と尋ねない）
        }
        if target == "inventor" && !install && !self.jobs.ready() {
            // 画面が「入れて作りますか」と尋ねる（まだ始めない）
            return self.build_status(Map::from_iter([("needs_install".to_string(), Value::Bool(true))]));
        }
        match self.jobs.start(&asked["spec"], install, target) {
            Ok(_) => self.build_status(Map::new()),
            Err(e) => Reply::error(e.status(), &e.message()),
        }
    }
}

/// 合言葉が同じか（長さが同じなら、どこで違っても同じ時間で答える）
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && !b.is_empty() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// サンプルの一覧（種類の順・種類の中は名前順）
fn samples(dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for (kind, exts) in SAMPLE_KINDS {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir.join(kind))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x))))
            .collect();
        files.sort();
        for p in files {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            out.push(json!({"kind": kind, "name": name, "size": size, "url": format!("/samples/{kind}/{}", percent_encode(&name))}));
        }
    }
    out
}

/// root の下のファイル。root の外へは出ない（.. や絶対パスは断る）。
pub fn file_under(root: &Path, rest: &str, cache: &str) -> Reply {
    let rel = Path::new(rest);
    if rest.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Reply::error(404, "ありません");
    }
    match std::fs::read(root.join(rel)) {
        Ok(body) => {
            Reply { status: 200, headers: vec![("Content-Type".into(), mime(rest).into()), ("Cache-Control".into(), cache.into())], body }
        }
        Err(_) => Reply::error(404, "ありません"),
    }
}

/// 返す種類。.js はレジストリの設定に左右されず text/javascript（モジュールとして読まれないと画面が真っ白になる）。
pub fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// URL の 1 区切りに入れられる形（英数字と - . _ ~ のほかは %XX）
pub fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[cfg(test)]
mod tests {
    //! 前の program/tests/test_server.py・test_builds.py（Api）と同じことを確かめる。
    use super::*;
    use crate::jobs::tests::{fake, fixture, jobs_with, python_c, real_tools, wait, Place};
    use crate::jobs::{Jobs, CANCEL_GRACE};

    fn router(place: &Place, program: &Path) -> (Router, Arc<std::sync::Mutex<Vec<PathBuf>>>) {
        let mut tools = real_tools(place);
        tools.build = fake(&tools);
        let (jobs, opened) = jobs_with(place, tools, CANCEL_GRACE);
        let r = Router {
            program: program.to_path_buf(),
            token: "t0k3n".into(),
            jobs,
            received: Arc::default(),
            inventor_installed: || true,
            shortcuts: crate::shortcut::Shortcuts {
                target: program.join("Inventor3DTool.exe"),
                places: vec![],
                read: |_| None,
                write: |_, _| Ok(()),
                offer_allowed: false,
                declined: None,
            },
            publishing: Default::default(),
            native: Box::new(|m, p, _, _| (m == "GET" && p == "/__desktop/info").then(|| Reply::json(200, &json!({"shell": "test"})))),
        };
        (r, opened)
    }

    fn call(r: &Router, method: &str, uri: &str, token: Option<&str>, body: &Value) -> (u16, Value, Response<Vec<u8>>) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("X-App-Token", t);
        }
        let body = if body.is_null() { Vec::new() } else { serde_json::to_vec(body).unwrap() };
        let resp = r.handle(&b.body(body).unwrap());
        let v = serde_json::from_slice(resp.body()).unwrap_or(Value::Null);
        (resp.status().as_u16(), v, resp)
    }

    fn program() -> PathBuf {
        crate::jobs::tests::program()
    }

    #[test]
    fn serves_the_page_with_the_token_and_the_parts() {
        let place = Place::new("page");
        let (r, _) = router(&place, &program());
        let (status, _, page) = call(&r, "GET", "inventor://localhost/", None, &Value::Null);
        let html = String::from_utf8_lossy(page.body());
        assert_eq!(status, 200);
        assert!(html.contains(r#"<meta name="app-token" content="t0k3n">"#), "合言葉を埋め込む");
        assert!(!html.contains("{{"), "埋め込み忘れが無い");
        assert_eq!(page.headers()["cache-control"], "no-store");
        let (status, _, js) = call(&r, "GET", "http://inventor.localhost/static/js/main.js", None, &Value::Null);
        assert_eq!(
            (status, js.headers()["content-type"].to_str().unwrap()),
            (200, "text/javascript; charset=utf-8"),
            "モジュールとして読める種類"
        );
        assert_eq!(js.headers()["cache-control"], "no-cache");
        for bad in [
            "/static/../index.html",
            "/static/js/%2e%2e/%2e%2e/index.html",
            "/static//etc/passwd",
            "/static/none.js",
            "/samples/../app/index.html",
            "/samples/x/y.ipt",
            "/nowhere",
        ] {
            assert_eq!(call(&r, "GET", &format!("inventor://localhost{bad}"), None, &Value::Null).0, 404, "{bad}");
        }
    }

    #[test]
    fn shortcut_status_and_create() {
        use crate::shortcut::{Place as Where, Shortcuts};
        let place = Place::new("shortcut");
        let (r, _) = router(&place, &program());
        let desk = place.dir.join("Desktop");
        let r = Router {
            shortcuts: Shortcuts {
                target: place.dir.join("Inventor3DTool.exe"),
                places: vec![Where { key: "desktop", label: "デスクトップ", dir: Some(desk.clone()) }],
                read: |f| std::fs::read_to_string(f).ok().map(PathBuf::from),
                write: |f, l| std::fs::write(f, l.target.display().to_string()).map_err(|e| e.to_string()),
                offer_allowed: false,
                declined: None,
            },
            ..r
        };
        let (status, v, _) = call(&r, "GET", "inventor://localhost/api/shortcut", Some("t0k3n"), &Value::Null);
        assert_eq!((status, v["places"][0]["state"].as_str()), (200, Some("missing")));
        let (status, v, _) = call(&r, "POST", "inventor://localhost/api/shortcut", Some("t0k3n"), &json!({"place": "desktop"}));
        assert_eq!((status, v["places"][0]["state"].as_str()), (200, Some("ok")));
        assert!(desk.join(format!("{}.lnk", crate::locate::APP_NAME)).is_file());
        let (status, v, _) = call(&r, "POST", "inventor://localhost/api/shortcut", Some("t0k3n"), &json!({"place": "x"}));
        assert_eq!(status, 500);
        assert!(v["message"].as_str().unwrap().contains("知らない置き場"));
    }

    #[test]
    fn every_api_call_needs_the_token() {
        let place = Place::new("token");
        let (r, _) = router(&place, &program());
        for (m, p) in [
            ("GET", "/api/samples"),
            ("POST", "/api/launch"),
            ("GET", "/api/files/x"),
            ("GET", "/api/build"),
            ("POST", "/api/build"),
            ("POST", "/api/build/cancel"),
            ("POST", "/api/build/open"),
            ("GET", "/api/shortcut"),
            ("POST", "/api/shortcut"),
            ("GET", "/__desktop/info"),
        ] {
            assert_eq!(call(&r, m, &format!("inventor://localhost{p}"), None, &Value::Null).0, 403, "{p}");
            assert_eq!(call(&r, m, &format!("inventor://localhost{p}"), Some("t0k3n-x"), &Value::Null).0, 403, "{p} 違う合言葉");
        }
        assert_eq!(
            call(&r, "GET", "inventor://localhost/__desktop/info", Some("t0k3n"), &Value::Null).1["shell"],
            "test",
            "窓のことは native"
        );
    }

    #[test]
    fn lists_samples_in_kind_order_and_serves_them() {
        let place = Place::new("samples");
        let (r, _) = router(&place, &program());
        let (status, v, _) = call(&r, "GET", "inventor://localhost/api/samples", Some("t0k3n"), &Value::Null);
        assert_eq!(status, 200);
        let list = v["samples"].as_array().unwrap();
        let kinds: Vec<&str> = list.iter().map(|s| s["kind"].as_str().unwrap()).collect();
        let mut order: Vec<&str> = kinds.clone();
        order.dedup();
        assert_eq!(order, ["ipt", "iam", "stp", "dwg", "html"], "種類の順（起動画面の並び）");
        for s in list {
            let (status, _, file) = call(&r, "GET", &format!("inventor://localhost{}", s["url"].as_str().unwrap()), None, &Value::Null);
            assert_eq!((status, file.body().len() as u64), (200, s["size"].as_u64().unwrap()), "{}", s["name"]);
        }
    }

    #[test]
    fn hands_received_files_over_by_key() {
        let place = Place::new("launch");
        let (r, _) = router(&place, &program());
        let file = place.dir.join("受け取った 部品.ipt");
        std::fs::write(&file, b"abc").unwrap();
        r.received.push(vec![file.clone()]);
        let (_, got, _) = call(&r, "POST", "inventor://localhost/api/launch", Some("t0k3n"), &Value::Null);
        assert_eq!(got["files"][0]["name"], "受け取った 部品.ipt");
        let url = got["files"][0]["url"].as_str().unwrap();
        let (status, _, body) = call(&r, "GET", &format!("inventor://localhost{url}"), Some("t0k3n"), &Value::Null);
        assert_eq!((status, body.body().as_slice()), (200, b"abc".as_slice()));
        std::fs::remove_file(&file).unwrap();
        assert_eq!(call(&r, "GET", &format!("inventor://localhost{url}"), Some("t0k3n"), &Value::Null).0, 404, "消えたら 404");
        assert_eq!(call(&r, "GET", "inventor://localhost/api/files/nope", Some("t0k3n"), &Value::Null).0, 404);
    }

    #[test]
    fn asks_before_installing_the_library() {
        let place = Place::new("ask");
        let (r, _) = router(&place, &program());
        r.jobs.set_ready(Some(false));
        let (status, got, _) = call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": fixture("finger")}));
        assert_eq!(status, 200);
        assert_eq!(got["needs_install"], true);
        assert_eq!((got["state"].as_str(), got["ready"].as_bool()), (Some("idle"), Some(false)), "尋ねるまで始めない");
        assert_eq!(got["root"], place.out().display().to_string(), "保存先を先に示す");
        assert_eq!(got["inventor_installed"], true);
        assert!(got["python_missing"].is_null());
    }

    #[test]
    fn without_python_the_reason_comes_before_the_library_question() {
        let place = Place::new("nopython-api");
        let (r, _) = router(&place, &program());
        let jobs =
            Jobs::new(place.out(), place.logs(), Box::new(|| Err("Python が見つかりません。".into())), Box::new(|_| {}), CANCEL_GRACE);
        let r = Router { jobs, ..r };
        let (status, got, _) = call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": fixture("finger")}));
        assert_eq!((status, got["message"].as_str()), (503, Some("Python が見つかりません。")), "入れて作るかを尋ねない");
        let (_, state, _) = call(&r, "GET", "inventor://localhost/api/build", Some("t0k3n"), &Value::Null);
        assert_eq!(state["python_missing"], "Python が見つかりません。", "画面が押す前に出す");
    }

    #[test]
    fn start_poll_and_open() {
        let place = Place::new("start");
        let (r, opened) = router(&place, &program());
        r.jobs.set_ready(Some(true));
        let (status, started, _) = call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": fixture("finger")}));
        assert_eq!(status, 200, "{started}");
        wait(&r.jobs, 60);
        let (_, done, _) = call(&r, "GET", "inventor://localhost/api/build", Some("t0k3n"), &Value::Null);
        assert_eq!((done["state"].as_str(), done["good"].as_u64(), done["total"].as_u64()), (Some("done"), Some(1), Some(1)));
        assert_eq!(call(&r, "POST", "inventor://localhost/api/build/open", Some("t0k3n"), &Value::Null).1["opened"], true);
        assert_eq!(*opened.lock().unwrap(), vec![PathBuf::from(done["out_dir"].as_str().unwrap())]);
    }

    #[test]
    fn bad_data_and_busy_are_explained() {
        let place = Place::new("busy-api");
        let mut tools = real_tools(&place);
        tools.build = python_c(&tools, "import time; time.sleep(30)");
        let (jobs, _) = jobs_with(&place, tools, std::time::Duration::from_millis(200));
        let (r, _) = router(&place, &program());
        let r = Router { jobs, ..r };
        r.jobs.set_ready(Some(true));
        let (status, bad, _) = call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": {"format": "other"}}));
        assert_eq!(status, 400);
        assert!(bad["message"].as_str().unwrap().contains("この変換データからは作れません"));
        call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": fixture("finger")}));
        let (status, busy, _) = call(&r, "POST", "inventor://localhost/api/build", Some("t0k3n"), &json!({"spec": fixture("finger")}));
        assert_eq!(status, 409);
        assert!(busy["message"].as_str().unwrap().contains("作っています"));
        let (_, cancelling, _) = call(&r, "POST", "inventor://localhost/api/build/cancel", Some("t0k3n"), &Value::Null);
        assert!(["step", "cancelled"].contains(&cancelling["state"].as_str().unwrap()));
        assert_eq!(wait(&r.jobs, 10)["state"], "cancelled");
    }

    #[test]
    fn encode_and_decode() {
        assert_eq!(percent_decode("a%20b%E6%97%A5"), "a b日");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("a%4"), "a%4");
        assert_eq!(percent_decode(&percent_encode("部品 (2)#.ipt")), "部品 (2)#.ipt");
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc", "名前の / は区切りにしない");
        assert!(same("abc", "abc") && !same("abd", "abc") && !same("ab", "abc") && !same("", ""));
    }
}
