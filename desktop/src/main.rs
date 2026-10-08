//! Inventor 3Dツール デスクトップ版の窓（Tauri）。設計と決まりは docs/desktop.md。
//!
//! 役割の分け方:
//!   - Rust（この exe）: 窓・1 つだけ起動（2 つめの起動に渡されたファイルは 1 つめの窓で開く）・画面とサンプルを配る・
//!     起動で受け取ったファイルを渡す・作る仕事（Python の作る係を起こし、進み具合を読み、中止する）・閉じる前の確かめ
//!   - Python（program/ipt_build）: 変換データの確かめと、STEP・Inventor の部品と組立を作ること（作るときだけ起こす）
//!   - 画面（WebView2）: これまでと同じ HTML/JS/CSS（program/app）。問い合わせは自前の仕組み（inventor）で Rust が受ける
//!
//! ポートを開かず、常駐するサーバーも無い（ポートの取り合い・古いサーバーの残り・生存の知らせによる推し量りが無い）。
//! 見るだけなら Python は要らない。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod jobs;
mod locate;
mod proc;
mod received;
mod router;
mod shortcut;
mod system;

use jobs::{Jobs, Tools};
use received::Received;
use router::{Native, Reply, Router};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// 自前の仕組みの名前（画面の置き場は Windows で http://inventor.localhost/、ほかは inventor://localhost/）
const SCHEME: &str = "inventor";
const SELFTEST_JS: &str = include_str!("selftest.js");
const SELFTEST_LIMIT: Duration = Duration::from_secs(300);
/// 中身（program フォルダ）が見つからないときの画面
const FAIL_HTML: &str = include_str!("fail.html");
/// 閉じるとき（×のほか、Windows の終了など）に、作る仕事の片付けを待つ長さ
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// 画面へ「起動でファイルを受け取った」と知らせる式（画面の desktop.js が受け取りに来る）
const LAUNCH_EVENT_JS: &str = "window.dispatchEvent(new Event('inventor:launch'))";

fn app_url(path: &str) -> Url {
    let base = if cfg!(windows) { "http://inventor.localhost" } else { "inventor://localhost" };
    Url::parse(&format!("{base}{path}")).expect("app url")
}

fn is_app_url(u: &Url) -> bool {
    u.scheme() == SCHEME || u.host_str() == Some("inventor.localhost")
}

/// 窓の記録（この PC の作業場所の logs/desktop.log）。起動・終わり方・確かめた事実だけを 1 行ずつ残す。
fn log(line: &str) {
    let dir = locate::local_root().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {line}");
    }
}

/// 自己診断（環境変数 INVENTOR_TOOL_SELFTEST=結果のファイル）。CI が本物の WebView2 で確かめるのに使う。
fn selftest_path() -> Option<PathBuf> {
    std::env::var_os("INVENTOR_TOOL_SELFTEST").map(PathBuf::from)
}

/// 自己診断の結果を書いて終わる（自己診断でなければ何もしない）。
fn selftest_finish(app: &AppHandle, result: &Value) {
    if let Some(path) = selftest_path() {
        let _ = std::fs::write(&path, serde_json::to_vec_pretty(result).unwrap_or_default());
        log(&format!("SELFTEST ok={}", result["ok"]));
        app.exit(if result["ok"] == true { 0 } else { 1 });
    }
}

/// 窓そのものが答える問い合わせ（窓の情報・自己診断の受け口）。窓ができる前に作るので、窓の持ち手は後から入る。
fn native(app: Arc<OnceLock<AppHandle>>, info: Value) -> Native {
    Box::new(move |method, path, _token_ok, body| {
        let body: Value = serde_json::from_slice(body).unwrap_or_default();
        match (method, path) {
            ("GET", "/__desktop/info") => Some(Reply::json(200, &info)),
            // 自己診断の途中の合図（CI が 2 つめの起動を始める時を知る）。結果のファイルの横に <結果>.<段> を置く
            ("POST", "/__desktop/selftest/stage") => {
                let stage = body["stage"].as_str().unwrap_or("").to_string();
                if let (Some(p), true) = (selftest_path(), !stage.is_empty() && stage.chars().all(|c| c.is_ascii_alphanumeric())) {
                    let _ = std::fs::write(PathBuf::from(format!("{}.{stage}", p.display())), "1");
                    log(&format!("SELFTEST stage={stage}"));
                }
                Some(Reply::json(200, &json!({"received": true})))
            }
            ("POST", "/__desktop/selftest/result") => {
                if let Some(app) = app.get() {
                    let result =
                        if body.is_object() { body } else { json!({"ok": false, "error": "自己診断の結果が読めません"}) };
                    selftest_finish(app, &result);
                }
                Some(Reply::json(200, &json!({"received": true})))
            }
            _ => None,
        }
    })
}

/// 画面の置き場（program フォルダ）を見つけ、問い合わせの受け手を作る。見つからなければ理由（窓は理由の画面を出す）。
fn shell(token: String, received: Arc<Received>, launched: Vec<String>, app: Arc<OnceLock<AppHandle>>) -> Result<Router, String> {
    let program = locate::program_dir()?;
    let work = locate::local_root();
    let root = system::output_root(&program);
    let python = locate::python();
    let python_text = match &python {
        Ok(p) => format!("{} {}", p.exe.display(), p.args.join(" ")).trim().to_string(),
        Err(why) => {
            log(&format!("PYTHON {}", why.replace('\n', " / ")));
            String::new()
        }
    };
    log(&format!(
        "START version={} commit={} program={} python={} output={}",
        env!("CARGO_PKG_VERSION"),
        env!("INVENTOR_TOOL_BUILD_COMMIT"),
        program.display(),
        if python_text.is_empty() { "（見つからない）" } else { &python_text },
        root.display()
    ));
    let info = json!({
        "name": locate::APP_NAME, "version": env!("CARGO_PKG_VERSION"), "commit": env!("INVENTOR_TOOL_BUILD_COMMIT"),
        "program": program, "exe": std::env::current_exe().unwrap_or_default(), "local_root": work, "output_root": root,
        "python": python_text, "url": app_url("/").as_str(), "launched": launched,
    });
    // Python は作るたびに探す（アプリを開いたまま Python を入れても、開き直さずに作れる）
    let find = {
        let (program, work) = (program.clone(), work.clone());
        move || match locate::python() {
            Ok(py) => Ok(Tools::python(&py, &program, &work)),
            Err(why) => Err(why.lines().next().unwrap_or(locate::PYTHON_MISSING).to_string()), // 探した場所は START の記録にある
        }
    };
    let opener = |dir: &Path| {
        if let Err(e) = tauri_plugin_opener::open_path(dir, None::<&str>) {
            log(&format!("OPEN 保存先を開けません: {} ({e})", dir.display()));
        }
    };
    let jobs = Jobs::new(root, work.join("logs"), Box::new(find), Box::new(opener), jobs::CANCEL_GRACE);
    let shortcuts = shortcut::Shortcuts::system(std::env::current_exe().unwrap_or_default());
    Ok(Router { program, token, jobs, received, inventor_installed: system::inventor_installed, shortcuts, native: native(app, info) })
}

/// 中身が見つからないときの画面（理由と、次にすること）
fn fail_page(why: &str) -> Reply {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let html = FAIL_HTML
        .replace("{{ detail }}", &escape(why))
        .replace("{{ log }}", &escape(&locate::local_root().join("logs").display().to_string()));
    Reply { status: 200, headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into())], body: html.into_bytes() }
}

/// 閉じる前の確かめ。作っている途中なら、中止して閉じるかを聞く（作っていなければ、そのまま閉じる）。
fn on_close_requested(w: &tauri::Window, api: &tauri::CloseRequestApi, jobs: &Arc<Jobs>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    static ASKING: AtomicBool = AtomicBool::new(false);
    if w.label() != "main" || !jobs.busy() {
        return;
    }
    api.prevent_close();
    if ASKING.swap(true, Ordering::SeqCst) {
        return; // 尋ねている・中止を待っている最中（同じ確認を 2 枚出さない）
    }
    let name = jobs.status().get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let (app, jobs) = (w.app_handle().clone(), jobs.clone());
    let mut dialog = app
        .dialog()
        .message(format!("「{name}」を作っている途中です。\n\n閉じると、作るのを中止します（作り終えたものは保存先に残ります）。"))
        .title(locate::APP_NAME)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("中止して閉じる".into(), "作り続ける".into()));
    if let Some(main) = app.get_webview_window("main") {
        dialog = dialog.parent(&main);
    }
    dialog.show(move |close| {
        if !close {
            ASKING.store(false, Ordering::SeqCst);
            return;
        }
        log(&format!("EXIT 作っている途中で閉じた（「{name}」を中止してから閉じる）"));
        std::thread::spawn(move || {
            jobs.cancel();
            jobs.wait_idle(jobs::CANCEL_GRACE + jobs::RESTORE_WAIT + EXIT_WAIT);
            app.exit(0);
        });
    });
}

/// 外のページ（リンク）は、いつものブラウザで開く。
fn open_outside(u: &Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>);
    }
}

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url("/")))
        .title(locate::APP_NAME)
        .inner_size(1600.0, 1000.0)
        .min_inner_size(960.0, 600.0)
        .maximized(true)
        .background_color(tauri::window::Color(0xe8, 0xec, 0xf0, 0xff)) // 画面の地（app.css の --bg）。読み込みの間に白く光らない
        // ファイルのドロップは画面が読む（ui/files.js）。Tauri は既定で窓へのドロップを横取りするので切る
        .disable_drag_drop_handler()
        .on_navigation(|u| {
            let inside = is_app_url(u) || matches!(u.scheme(), "about" | "blob" | "data");
            if !inside {
                open_outside(u);
            }
            inside
        })
        .on_new_window(|u, _features| {
            open_outside(&u);
            NewWindowResponse::Deny
        })
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished && is_app_url(p.url()) && p.url().path() == "/" && selftest_path().is_some() {
                let _ = w.eval(SELFTEST_JS);
            }
        })
        .build()
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let received = Arc::new(Received::default());
    let first = received::paths_from_args(std::env::args().skip(1), &cwd);
    let launched = first.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
    received.push(first);
    let handle: Arc<OnceLock<AppHandle>> = Arc::default();
    let shell = Arc::new(shell(received::random_hex(24), received.clone(), launched, handle.clone()));
    if let Err(why) = shell.as_ref() {
        log(&format!("FAIL {}", why.replace('\n', " / ")));
    }
    let jobs = shell.as_ref().as_ref().ok().map(|r| r.jobs.clone());
    let close_jobs = jobs.clone();
    let proto = shell.clone();

    let app = tauri::Builder::default()
        // 2 つめの起動: 渡されたファイルを 1 つめの窓へ回し、窓を前に出す（2 つめはすぐ終わる）
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| {
            let n = received.push(received::paths_from_args(args.into_iter().skip(1), Path::new(&cwd)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                if n > 0 {
                    log(&format!("LAUNCH 2 つめの起動から {n} 件"));
                    let _ = w.eval(LAUNCH_EVENT_JS);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(move |w, ev| {
            if let (WindowEvent::CloseRequested { api, .. }, Some(jobs)) = (ev, close_jobs.as_ref()) {
                on_close_requested(w, api, jobs);
            }
        })
        // 画面からの問い合わせ。1 つずつ別の糸で答える（作り始め・大きなファイルが画面を止めない）
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |_ctx, req, responder| {
            let shell = proto.clone();
            std::thread::spawn(move || {
                let resp = match shell.as_ref() {
                    Ok(r) => r.handle(&req),
                    Err(why) => {
                        let reply = if req.uri().path() == "/" { fail_page(why) } else { Reply::error(404, "ありません") };
                        let mut b = tauri::http::Response::builder().status(reply.status);
                        for (k, v) in reply.headers {
                            b = b.header(k, v);
                        }
                        b.body(reply.body).unwrap()
                    }
                };
                responder.respond(resp);
            });
        })
        .setup(move |app| {
            let _ = handle.set(app.handle().clone());
            window(app.handle())?;
            if selftest_path().is_some() {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(SELFTEST_LIMIT);
                    selftest_finish(&h, &json!({"ok": false, "error": format!("{} 秒で終わりませんでした", SELFTEST_LIMIT.as_secs())}));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("起動できません");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            if let Some(jobs) = jobs.as_ref() {
                jobs.shutdown(EXIT_WAIT); // ×で確かめずに終わるとき（Windows の終了など）も、作る係を残さない
            }
            log("EXIT 窓を閉じた");
        }
    });
}
