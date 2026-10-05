//! 「STEP を作る」「Inventor で作る」の仕事（1 度に 1 つ。Inventor は 1 つなので、同時には作らない）。前の app/builds.py を移したもの。
//!
//!   1. 変換データを確かめる（`python -m ipt_build <写し> --check`。作れない内容なら、理由を返して始めない）
//!   2. 保存先「<出力先>/<名前>_cad」を作り（同じ名前があれば「 (2)」…。前の結果を上書きしない）、変換データの写しを置く
//!   3. Inventor で作るとき、頼まれたら Inventor の操作に使うライブラリ（pywin32）を入れる（pip）
//!   4. `python -m ipt_build <写し> --out <保存先> --events [--step-only]` を動かし、1 行ずつの進み具合を読む
//!      STEP（.stp）はどちらでも最初に書く（Inventor を使わない）。Inventor で作るときは、続けて .ipt・.iam を作る
//!
//! 確かめ方・作り方・進み具合の形（ipt_build.runner の BuildRun.status()）は Python の 1 か所が決める。
//! ここが受け持つのは、受け渡しと、中止（頼んで止まらなければ孫まで止め、Inventor をふだんの状態に戻す）・片付けだけ。

use crate::locate::Python;
use crate::proc::{self, Argv, Killer};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStdin, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 動いている状態（画面の ui/build.js の RUNNING と同じ）
const RUNNING: [&str; 5] = ["installing", "step", "connecting", "building", "assembly"];
/// Inventor を操作している状態（強制的に止めたら、Inventor をふだんの状態に戻す）
const IN_INVENTOR: [&str; 3] = ["connecting", "building", "assembly"];
/// 画面に渡す進み具合（BuildRun.status() のうち）
const PROGRESS: [&str; 8] = ["out_dir", "parts", "assembly", "good", "total", "step", "inventor", "inventor_error"];
/// 中止を頼んでから待つ時間（作りかけの 1 部品を終えて Inventor を元に戻すまで）。過ぎたら孫まで止める
pub const CANCEL_GRACE: Duration = Duration::from_secs(20);
/// Inventor をふだんの状態に戻す係を待つ時間
pub const RESTORE_WAIT: Duration = Duration::from_secs(60);
const CHECK_WAIT: Duration = Duration::from_secs(60);
const LIBRARIES_WAIT: Duration = Duration::from_secs(30);
/// 入れられなかったときに見せる pip の出力（末尾の字数）と、作る係が落ちたときに見せるエラー出力（末尾の行数）
const INSTALL_TAIL: usize = 1500;
const CRASH_TAIL: usize = 15;
pub const CANCELLED: &str = "中止しました。Inventor に作りかけの部品が開いていれば、保存せずに閉じてください";

/// 作る係の知らせ → 状態（STEP を書き終えたら、Inventor で作るときは接続へ）
fn state_of(event: &str) -> Option<&'static str> {
    match event {
        "step" | "connecting" => Some("connecting"),
        "start" | "part" => Some("building"),
        "assembly" => Some("assembly"),
        "done" => Some("done"),
        _ => None,
    }
}

fn state(job: &Map<String, Value>) -> &str {
    job.get("state").and_then(Value::as_str).unwrap_or("idle")
}

/// Python の係の起こし方（どれも引数の並び。後ろに足す引数は使う側が足す）。網では作る係などを代わりの物に差し替える。
#[derive(Clone)]
pub struct Tools {
    /// 確かめる係（後ろに `<変換データ> --check [--step-only]`）
    pub check: Argv,
    /// 作る係（後ろに `<変換データ> --out <保存先> --events [--step-only]`）
    pub build: Argv,
    /// Inventor の画面の更新とダイアログを、ふだんの状態に戻す係
    pub restore: Argv,
    /// ライブラリ（pywin32）を入れる係
    pub install: Argv,
    /// ライブラリが入っているかを答える係（`{"event": "libraries", "ready": …}` の 1 行）
    pub libraries: Argv,
    /// 作業場所（program フォルダを「使用中」にしない）と、環境
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
}

impl Tools {
    /// この PC の Python で ipt_build を動かす形。program を import でき、.pyc を program に作らず、文字は UTF-8。
    pub fn python(py: &Python, program: &Path, work: &Path) -> Tools {
        let python: Argv = std::iter::once(py.exe.clone().into_os_string()).chain(py.args.iter().map(OsString::from)).collect();
        let ipt_build: Argv = python.iter().cloned().chain(["-X", "utf8", "-m", "ipt_build"].map(OsString::from)).collect();
        let with = |base: &Argv, more: &[&str]| -> Argv { base.iter().cloned().chain(more.iter().map(OsString::from)).collect() };
        let mut install = with(&python, &["-m", "pip", "install", "--disable-pip-version-check", "-r"]);
        install.push(program.join("ipt_build").join("requirements.txt").into_os_string());
        let pythonpath = std::env::join_paths(
            std::iter::once(program.to_path_buf()).chain(std::env::var_os("PYTHONPATH").iter().flat_map(std::env::split_paths)),
        )
        .unwrap_or_else(|_| program.as_os_str().to_os_string());
        Tools {
            check: ipt_build.clone(),
            build: ipt_build.clone(),
            restore: with(&ipt_build, &["--restore-inventor"]),
            install,
            libraries: with(&ipt_build, &["--libraries"]),
            cwd: work.to_path_buf(),
            env: vec![
                ("PYTHONPATH".into(), pythonpath),
                ("PYTHONPYCACHEPREFIX".into(), work.join("pycache").into_os_string()),
                ("PYTHONIOENCODING".into(), "utf-8".into()),
                ("INVENTOR_TOOL_LOCAL_ROOT".into(), work.as_os_str().to_os_string()),
            ],
        }
    }
}

/// 始められない理由（画面へは status と message で返す）。
#[derive(Debug, PartialEq)]
pub enum StartError {
    /// 作れない変換データ・作るものの指定が違う
    Spec(String),
    /// ほかの仕事を作っている（その名前）
    Busy(String),
    /// 保存先を作れない
    Dest(String),
    /// Python が無い・確かめる係が動かない
    Unavailable(String),
}

impl StartError {
    pub fn status(&self) -> u16 {
        match self {
            StartError::Spec(_) => 400,
            StartError::Busy(_) => 409,
            StartError::Dest(_) => 500,
            StartError::Unavailable(_) => 503,
        }
    }
    pub fn message(&self) -> String {
        match self {
            StartError::Spec(m) => format!("この変換データからは作れません: {m}"),
            StartError::Busy(name) => format!("「{name}」を作っています。終わってから、もう一度押してください"),
            StartError::Dest(e) => {
                format!("保存先を作れません（{e}）。program\\config\\appsettings.json の build.output_dir を確かめてください")
            }
            StartError::Unavailable(m) => m.clone(),
        }
    }
}

/// 途中で止める理由（仕事の糸の中だけで使う）
enum Stop {
    Cancelled,
    Spawn(String),
}

type Find = Box<dyn Fn() -> Result<Tools, String> + Send + Sync>;
type Opener = Box<dyn Fn(&Path) + Send + Sync>;

#[derive(Default)]
struct Inner {
    job: Map<String, Value>,
    cancelled: bool,
    /// いまの仕事の係（強制的に止めたあと、Inventor を戻すのに使う）
    tools: Option<Tools>,
    /// 動いている子（作る係・pip）。標準入力に中止を頼み、止まらなければ孫まで止める
    stdin: Option<ChildStdin>,
    killer: Option<Killer>,
    /// 起こした子の番号（中止の見張りが、自分の見ている子かを確かめる）と、その子が動いているか
    child: u64,
    alive: bool,
    /// 仕事の糸が動いている（片付けて終わりの状態を出すまで）
    working: bool,
}

pub struct Jobs {
    root: PathBuf,
    logs: PathBuf,
    find: Find,
    opener: Opener,
    grace: Duration,
    inner: Mutex<Inner>,
    changed: Condvar,
    /// ライブラリ（pywin32）が入っているか（Python に聞いた答えを覚える。入れたら聞き直す）
    ready: Mutex<Option<bool>>,
}

impl Jobs {
    /// root: 保存先の親・logs: 作る係のエラー出力と pip の出力の置き場・find: 係の起こし方（Python が無ければ理由）・
    /// opener: 保存先を開く（エクスプローラー）・grace: 中止を頼んでから強制的に止めるまで。
    pub fn new(root: PathBuf, logs: PathBuf, find: Find, opener: Opener, grace: Duration) -> Arc<Jobs> {
        let inner = Inner { job: json!({"state": "idle"}).as_object().cloned().unwrap_or_default(), ..Inner::default() };
        Arc::new(Jobs { root, logs, find, opener, grace, inner: Mutex::new(inner), changed: Condvar::new(), ready: Mutex::new(None) })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---- 状態 ----------------------------------------------------------------------------------
    pub fn status(&self) -> Map<String, Value> {
        self.lock().job.clone()
    }

    pub fn busy(&self) -> bool {
        RUNNING.contains(&state(&self.lock().job))
    }

    fn update(&self, changes: Map<String, Value>) {
        self.lock().job.extend(changes);
        self.changed.notify_all();
    }

    /// 仕事の糸が終わるまで待つ（終わったら true）。
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let g = self.lock();
        let (g, _) = self.changed.wait_timeout_while(g, timeout, |g| g.working).unwrap_or_else(|e| e.into_inner());
        !g.working
    }

    /// Python が見つからないときの理由（見つかれば None）。画面が先に案内する。
    pub fn python_missing(&self) -> Option<String> {
        (self.find)().err()
    }

    /// ライブラリ（pywin32）が入っているか。Python に 1 度聞いて覚える（Python が無ければ覚えずに false）。
    pub fn ready(&self) -> bool {
        if let Some(known) = *self.ready.lock().unwrap_or_else(|e| e.into_inner()) {
            return known;
        }
        let Ok(tools) = (self.find)() else { return false };
        let answer = output(&tools.libraries, &tools, LIBRARIES_WAIT).ok().and_then(|o| last_event(&o.stdout, "libraries"));
        let ready = answer.is_some_and(|a| a["ready"] == true);
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(ready);
        ready
    }

    /// 覚えた答えを差し替える（None で聞き直す）。
    pub fn set_ready(&self, ready: Option<bool>) {
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = ready;
    }

    // ---- 始める・止める ----------------------------------------------------------------------------
    /// 変換データ（JSON を読んだもの）から作り始める。target: "inventor"（STEP と .ipt・.iam）か "step"（STEP だけ。
    /// Inventor もライブラリも使わない）。答えは始めたときの状態（作る部品を全て並べる）。
    pub fn start(self: &Arc<Self>, data: &Value, install: bool, target: &str) -> Result<Map<String, Value>, StartError> {
        if !matches!(target, "inventor" | "step") {
            return Err(StartError::Spec(format!("作るものの指定「{target}」が分かりません")));
        }
        let inventor = target == "inventor";
        let install = install && inventor;
        if let Some(name) = self.running_name() {
            return Err(StartError::Busy(name)); // 確かめる前に断る（Python を起こさない）
        }
        let tools = (self.find)().map_err(StartError::Unavailable)?;
        let (name, mut job) = self.check(&tools, data, inventor)?;
        let mut g = self.lock();
        if RUNNING.contains(&state(&g.job)) {
            return Err(StartError::Busy(g.job.get("name").and_then(Value::as_str).unwrap_or("").to_string()));
        }
        let out_dir = unique_dir(&self.root.join(format!("{name}_cad")));
        std::fs::create_dir_all(&out_dir).map_err(|e| StartError::Dest(e.to_string()))?;
        let spec_path = out_dir.join(format!("{name}.inventor.json"));
        if let Err(e) = std::fs::write(&spec_path, pretty(data)) {
            let _ = std::fs::remove_dir(&out_dir);
            return Err(StartError::Dest(e.to_string()));
        }
        job.insert("state".into(), (if install { "installing" } else { "step" }).into());
        job.insert("name".into(), name.into());
        job.insert("spec".into(), spec_path.display().to_string().into());
        job.insert("target".into(), target.into());
        job.insert("message".into(), "".into());
        job.insert("detail".into(), "".into());
        job.insert("out_dir".into(), out_dir.display().to_string().into());
        g.job = job;
        g.cancelled = false;
        g.working = true;
        g.tools = Some(tools.clone());
        let started = g.job.clone();
        drop(g);
        let me = self.clone();
        std::thread::Builder::new()
            .name("cad-build".into())
            .spawn(move || me.run(&tools, &spec_path, &out_dir, install, inventor))
            .map_err(|e| StartError::Unavailable(format!("作る仕事を始められません（{e}）")))?;
        Ok(started)
    }

    fn running_name(&self) -> Option<String> {
        let g = self.lock();
        RUNNING.contains(&state(&g.job)).then(|| g.job.get("name").and_then(Value::as_str).unwrap_or("").to_string())
    }

    /// 作れる変換データかを Python に確かめる（作り始めたときの進み具合と、保存先の名前が返る）。
    fn check(&self, tools: &Tools, data: &Value, inventor: bool) -> Result<(String, Map<String, Value>), StartError> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = tools.cwd.join("check");
        let path = dir.join(format!("{}-{}.json", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&path, serde_json::to_vec(data).unwrap_or_default()))
            .map_err(|e| StartError::Unavailable(format!("変換データを確かめるための写しを置けません（{}: {e}）", dir.display())))?;
        let mut argv = tools.check.clone();
        argv.extend([path.clone().into_os_string(), "--check".into()]);
        if !inventor {
            argv.push("--step-only".into());
        }
        let out = output(&argv, tools, CHECK_WAIT);
        let _ = std::fs::remove_file(&path);
        let out = out.map_err(|e| StartError::Unavailable(format!("変換データを確かめる係（Python）を起こせませんでした（{e}）")))?;
        let Some(answer) = last_event(&out.stdout, "check") else {
            return Err(StartError::Unavailable(format!(
                "変換データを確かめる係（Python）が答えませんでした（{}）。{}",
                exit_text(&out.status),
                tail_lines(&String::from_utf8_lossy(&out.stderr), 5)
            )));
        };
        if answer["ok"] != true {
            return Err(StartError::Spec(answer["message"].as_str().unwrap_or("理由が分かりません").to_string()));
        }
        let name = answer["name"].as_str().unwrap_or("").to_string();
        let one = Path::new(&name).components().collect::<Vec<_>>();
        if !matches!(one.as_slice(), [Component::Normal(_)]) {
            return Err(StartError::Spec(format!("保存先の名前「{name}」を使えません")));
        }
        Ok((name, answer["status"].as_object().cloned().unwrap_or_default()))
    }

    /// 中止する。作る係には標準入力で中止を頼む（作りかけの部品を終えたところで止まり、Inventor の画面の更新と
    /// ダイアログをふだんの状態に戻して終わる）。grace たっても止まらなければ孫まで止め、Inventor を操作していたなら、
    /// 別のプロセスで Inventor をふだんの状態に戻す（強制的に止めると、作る係は戻せない）。
    pub fn cancel(self: &Arc<Self>) -> Map<String, Value> {
        let watch = {
            let mut g = self.lock();
            if !RUNNING.contains(&state(&g.job)) {
                return g.job.clone();
            }
            g.cancelled = true;
            if let Some(stdin) = g.stdin.as_mut() {
                let _ = stdin.write_all(b"cancel\n").and_then(|_| stdin.flush());
                // 既に終わっていれば届かなくてよい
            }
            g.killer.clone().filter(|_| g.alive).map(|k| (k, g.child))
        };
        if let Some((killer, child)) = watch {
            let me = self.clone();
            let _ = std::thread::Builder::new().name("cad-build-cancel".into()).spawn(move || me.stop_after_grace(&killer, child));
        }
        self.status()
    }

    fn stop_after_grace(&self, killer: &Killer, child: u64) {
        let g = self.lock();
        let (g, _) = self.changed.wait_timeout_while(g, self.grace, |g| g.alive && g.child == child).unwrap_or_else(|e| e.into_inner());
        if !(g.alive && g.child == child) {
            return; // 頼んだとおり止まった
        }
        let restore = IN_INVENTOR.contains(&state(&g.job)).then(|| g.tools.clone()).flatten();
        drop(g);
        killer.kill();
        if let Some(tools) = restore {
            let _ = output(&tools.restore, &tools, RESTORE_WAIT); // Inventor が答えない・Python を起こせない: 画面の案内に任せる
        }
    }

    /// アプリを閉じるとき: 中止を頼み、wait のあいだに止まらなければ孫まで止める（Inventor を操作していたら戻す）。
    pub fn shutdown(self: &Arc<Self>, wait: Duration) {
        if !self.busy() {
            return;
        }
        self.cancel();
        if self.wait_idle(wait) {
            return;
        }
        let (killer, restore) = {
            let g = self.lock();
            (g.killer.clone(), IN_INVENTOR.contains(&state(&g.job)).then(|| g.tools.clone()).flatten())
        };
        if let Some(k) = killer {
            k.kill();
        }
        if let Some(tools) = restore {
            let _ = output(&tools.restore, &tools, Duration::from_secs(10));
        }
    }

    /// いまの（直前の）仕事の保存先を開く。仕事の保存先のほかは開かない。
    pub fn open_output(&self) -> bool {
        let out = self.lock().job.get("out_dir").and_then(Value::as_str).map(PathBuf::from);
        match out {
            Some(dir) if dir.is_dir() => {
                (self.opener)(&dir);
                true
            }
            _ => false,
        }
    }

    // ---- 仕事の糸 ----------------------------------------------------------------------------------
    /// 仕事の本体（別の糸）。終わりの状態（done・failed・cancelled）は、片付けまで済ませてから 1 度に出す
    /// （画面が「終わった」と読んだときには、保存先が決まっている）。
    fn run(&self, tools: &Tools, spec: &Path, out_dir: &Path, install: bool, inventor: bool) {
        let mut last = match self.work(tools, spec, out_dir, install, inventor) {
            Ok(last) => last,
            Err(Stop::Cancelled) => fields(&[("state", "cancelled".into()), ("message", CANCELLED.into())]),
            Err(Stop::Spawn(e)) => failed(format!("部品を作る係を起こせませんでした（{e}）"), None),
        };
        if last.get("state") != Some(&Value::from("done")) && tidy(out_dir, spec) {
            last.insert("out_dir".into(), Value::Null);
        }
        let mut g = self.lock();
        g.job.extend(last);
        g.working = false;
        g.tools = None;
        drop(g);
        self.changed.notify_all();
    }

    fn work(&self, tools: &Tools, spec: &Path, out_dir: &Path, install: bool, inventor: bool) -> Result<Map<String, Value>, Stop> {
        let _ = std::fs::create_dir_all(&tools.cwd);
        let _ = std::fs::create_dir_all(&self.logs);
        if install {
            let log = self.logs.join("install.log");
            let (out, err) = log_file(&log)?;
            let mut child = self.spawn(&tools.install, tools, out, err)?;
            let status = child.child.wait();
            self.ended();
            self.set_ready(None); // 入れた（入れようとした）ので聞き直す
            if self.lock().cancelled {
                return Err(Stop::Cancelled);
            }
            if !status.is_ok_and(|s| s.success()) {
                let said = std::fs::read_to_string(&log).unwrap_or_default();
                return Ok(failed("Inventor の操作に使うライブラリを入れられませんでした".into(), Some(tail_chars(&said, INSTALL_TAIL))));
            }
            self.update(fields(&[("state", "step".into())]));
        }
        let mut argv = tools.build.clone();
        argv.extend([spec.as_os_str().into(), "--out".into(), out_dir.as_os_str().into(), "--events".into()]);
        if !inventor {
            argv.push("--step-only".into());
        }
        let console = self.logs.join("builder_console.log");
        let (_, err) = log_file(&console)?;
        let mut child = self.spawn(&argv, tools, Stdio::piped(), err)?;
        let (mut done, mut error) = (false, None);
        if let Some(stdout) = child.child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
                self.apply(&String::from_utf8_lossy(&line), &mut done, &mut error);
                line.clear();
            }
        }
        let status = child.child.wait();
        self.ended();
        if self.lock().cancelled {
            return Err(Stop::Cancelled);
        }
        Ok(if done {
            fields(&[("state", "done".into())])
        } else if let Some(message) = error {
            failed(message, None)
        } else {
            // 「終わった」と知らせずに終わった（落ちた）
            let said = std::fs::read_to_string(&console).unwrap_or_default();
            let code = status.map(|s| exit_text(&s)).unwrap_or_else(|e| e.to_string());
            failed(format!("部品を作る係が途中で終わりました（{code}）"), Some(tail_lines(&said, CRASH_TAIL)))
        })
    }

    /// 子を起こして見張りに登録する（中止を頼まれていたら起こさない）。標準入力は中止を頼む口。出力の向け先は呼ぶ側が決める。
    fn spawn(&self, argv: &Argv, tools: &Tools, stdout: Stdio, stderr: Stdio) -> Result<proc::Spawned, Stop> {
        let mut g = self.lock();
        if g.cancelled {
            return Err(Stop::Cancelled);
        }
        let mut s = proc::spawn(argv, &tools.cwd, &tools.env, Stdio::piped(), stdout, stderr).map_err(|e| Stop::Spawn(e.to_string()))?;
        g.stdin = s.child.stdin.take();
        g.killer = Some(s.killer());
        g.child += 1;
        g.alive = true;
        Ok(s)
    }

    fn ended(&self) {
        let mut g = self.lock();
        g.alive = false;
        g.stdin = None;
        g.killer = None;
        drop(g);
        self.changed.notify_all();
    }

    /// 作る係の 1 行（{"event": …, 進み具合}）を状態に当てる。JSON でない行は無視する。
    fn apply(&self, line: &str, done: &mut bool, error: &mut Option<String>) {
        let Ok(Value::Object(mut event)) = serde_json::from_str::<Value>(line.trim()) else { return };
        let kind = match event.remove("event") {
            Some(Value::String(k)) => k,
            _ => return,
        };
        if kind == "error" {
            *error = Some(match event.get("message") {
                Some(Value::String(m)) => m.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            });
            return; // 終わりの状態は、片付けてから出す
        }
        let Some(next) = state_of(&kind) else { return };
        *done = kind == "done";
        let step_only = kind == "step" && event.get("inventor") == Some(&Value::Bool(false));
        let mut changes: Map<String, Value> = event.into_iter().filter(|(k, _)| PROGRESS.contains(&k.as_str())).collect();
        if !*done && !step_only {
            changes.insert("state".into(), next.into());
        }
        self.update(changes);
    }
}

fn fields(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn failed(message: String, detail: Option<String>) -> Map<String, Value> {
    let mut m = fields(&[("state", "failed".into()), ("message", message.into())]);
    if let Some(d) = detail {
        m.insert("detail".into(), d.into());
    }
    m
}

/// まだ無いフォルダの名前（在れば「 (2)」「 (3)」…を付ける）。
pub fn unique_dir(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut candidate = path.to_path_buf();
    let mut n = 1;
    while candidate.exists() {
        n += 1;
        candidate = path.with_file_name(format!("{name} ({n})"));
    }
    candidate
}

/// 何も作れなかった試みの保存先を片付ける（自分が置いた変換データの写しだけのときに限る）。→ 片付けたか
fn tidy(out_dir: &Path, spec: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(out_dir) else { return false };
    let names: Vec<OsString> = entries.flatten().map(|e| e.file_name()).collect();
    if names.len() != 1 || Some(names[0].as_os_str()) != spec.file_name() {
        return false;
    }
    std::fs::remove_file(spec).is_ok() && std::fs::remove_dir(out_dir).is_ok()
}

/// 変換データの写し（字下げ 1・日本語はそのまま。前の版と同じ書き方）
fn pretty(data: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    let _ = data.serialize(&mut ser);
    out
}

/// 出力の置き場（同じファイルへ stdout と stderr の両方を書く）
fn log_file(path: &Path) -> Result<(Stdio, Stdio), Stop> {
    let file = std::fs::File::create(path).map_err(|e| Stop::Spawn(format!("{}: {e}", path.display())))?;
    let copy = file.try_clone().map_err(|e| Stop::Spawn(e.to_string()))?;
    Ok((file.into(), copy.into()))
}

/// 終わり方の一言（終了コード 3 / 止められた）
fn exit_text(status: &ExitStatus) -> String {
    status.code().map(|c| format!("終了コード {c}")).unwrap_or_else(|| "外から止められた".into())
}

/// 最後の行から探した、その知らせ（{"event": kind, …}）
fn last_event(stdout: &[u8], kind: &str) -> Option<Value> {
    String::from_utf8_lossy(stdout).lines().rev().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).find(|v| v["event"] == kind)
}

fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn tail_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(n)).collect()
}

/// 終わるまで待って出力を集める（時間を過ぎたら孫まで止めて誤り）。標準入力は渡さない。
fn output(argv: &Argv, tools: &Tools, wait: Duration) -> std::io::Result<std::process::Output> {
    std::fs::create_dir_all(&tools.cwd)?; // 初めての PC では作業場所がまだ無い
    let mut s = proc::spawn(argv, &tools.cwd, &tools.env, Stdio::null(), Stdio::piped(), Stdio::piped())?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(s.child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(s.child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let end = Instant::now() + wait;
    let status = loop {
        if let Some(status) = s.child.try_wait()? {
            break status;
        }
        if Instant::now() >= end {
            s.kill_tree();
            let _ = s.child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{} 秒たっても終わりません", wait.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(std::process::Output { status, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

#[cfg(test)]
pub(crate) mod tests {
    //! 前の program/tests/test_builds.py の Jobs と同じことを確かめる。作る係は本物の別のプロセス（python -m ipt_build --events）で
    //! 動かし、Inventor だけを代替オブジェクト（tests/fake_inventor.py）にする。確かめる係はいつも本物。
    use super::*;
    use std::fs;

    pub fn program() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("program")
    }

    pub fn fixture(name: &str) -> Value {
        let path = program().join("tests").join("fixtures").join("builder").join(format!("{name}.inventor.json"));
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    /// 網の作業場所（終わったら消す）
    pub struct Place {
        pub dir: PathBuf,
    }
    impl Place {
        pub fn new(label: &str) -> Place {
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!("inv-jobs-{}-{label}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(dir.join("out")).unwrap();
            Place { dir }
        }
        pub fn out(&self) -> PathBuf {
            self.dir.join("out")
        }
        pub fn logs(&self) -> PathBuf {
            self.dir.join("logs")
        }
    }
    impl Drop for Place {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    pub fn real_tools(place: &Place) -> Tools {
        let py = crate::locate::python().expect("網には Python が要る");
        Tools::python(&py, &program(), &place.dir.join("work"))
    }

    pub fn python_c(tools: &Tools, code: &str) -> Argv {
        let mut argv: Argv = tools.check.iter().take_while(|a| a.to_str() != Some("-X")).cloned().collect();
        argv.extend(["-c".into(), code.into()]);
        argv
    }

    /// 本物の ipt_build。Inventor への接続だけを代替オブジェクトにする
    pub const FAKE: &str = "import sys; import tests.fake_inventor as f, ipt_build.inventor as inv; \
        inv.connect = lambda visible=True: f.FakeInventor(); from ipt_build.__main__ import main; sys.exit(main(sys.argv[1:]))";

    pub fn fake(tools: &Tools) -> Argv {
        python_c(tools, FAKE)
    }

    pub fn jobs_with(place: &Place, tools: Tools, grace: Duration) -> (Arc<Jobs>, Arc<Mutex<Vec<PathBuf>>>) {
        let opened: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let seen = opened.clone();
        let jobs = Jobs::new(
            place.out(),
            place.logs(),
            Box::new(move || Ok(tools.clone())),
            Box::new(move |p| seen.lock().unwrap().push(p.to_path_buf())),
            grace,
        );
        (jobs, opened)
    }

    pub fn wait(jobs: &Jobs, seconds: u64) -> Map<String, Value> {
        let end = Instant::now() + Duration::from_secs(seconds);
        while (jobs.busy() || jobs.lock().working) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        jobs.status()
    }

    fn with_build(place: &Place, build: impl Fn(&Tools) -> Argv) -> Tools {
        let mut t = real_tools(place);
        t.build = build(&t);
        t
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn builds_and_reports_every_part_and_the_assembly() {
        let place = Place::new("reel");
        let (jobs, opened) = jobs_with(&place, with_build(&place, fake), CANCEL_GRACE);
        let started = jobs.start(&fixture("reel"), false, "inventor").unwrap();
        assert_eq!(started["state"], "step", "まず STEP を書く");
        let verdicts: Vec<&Value> = started["parts"].as_array().unwrap().iter().map(|p| &p["verdict"]).collect();
        assert_eq!(verdicts, vec![&Value::Null; 25], "始めた時点で、作る部品を全て並べる");
        let done = wait(&jobs, 120);
        assert_eq!(done["state"], "done", "{done:?}");
        assert_eq!((done["good"].as_u64(), done["total"].as_u64()), (Some(25), Some(25)));
        assert_eq!(done["assembly"], json!({"file": "spool_reel_assembly_v2.iam", "placed": 459, "error": null}));
        let out = PathBuf::from(done["out_dir"].as_str().unwrap());
        assert_eq!(out, place.out().join("spool_reel_assembly_v2_cad"));
        let copy: Value = serde_json::from_slice(&fs::read(out.join("spool_reel_assembly_v2.inventor.json")).unwrap()).unwrap();
        assert_eq!(copy, fixture("reel"), "作った変換データの写しを保存先に置く（値はそのまま）");
        assert!(out.join("build-report.json").exists());
        assert_eq!(done["step"]["file"], "spool_reel_assembly_v2.stp");
        assert!(out.join("spool_reel_assembly_v2.stp").exists(), "STEP も同じ保存先に置く");
        assert!(jobs.open_output());
        assert_eq!(*opened.lock().unwrap(), vec![out]);
    }

    #[test]
    fn step_only_needs_neither_inventor_nor_the_library() {
        let place = Place::new("wire");
        let code = format!("import sys\nif '--step-only' not in sys.argv: raise SystemExit('Inventor を使ってはいけない')\n{FAKE}");
        let mut tools = with_build(&place, |t| python_c(t, &code));
        tools.install = python_c(&tools, "raise SystemExit('ライブラリを入れてはいけない')");
        let (jobs, _) = jobs_with(&place, tools, CANCEL_GRACE);
        jobs.set_ready(Some(false));
        let started = jobs.start(&fixture("wire"), true, "step").unwrap();
        assert_eq!(started["state"], "step", "STEP だけなら、ライブラリを入れない");
        let done = wait(&jobs, 120);
        assert_eq!(done["state"], "done", "{done:?}");
        assert_eq!(done["inventor"], false);
        assert_eq!((done["step"]["placed"].as_u64(), done["step"]["assembly"].as_bool()), (Some(25), Some(true)));
        let how: Vec<&str> = done["step"]["parts"].as_array().unwrap().iter().map(|p| p["how"].as_str().unwrap()).collect();
        assert_eq!(how, [vec!["exact"; 3], vec!["faceted"; 12]].concat());
        let out = PathBuf::from(done["out_dir"].as_str().unwrap());
        let mut kinds: Vec<String> = entries(&out).iter().map(|n| n.rsplit('.').next().unwrap().to_string()).collect();
        kinds.sort();
        assert_eq!(kinds, ["json", "json", "stp"], "STEP・変換データの写し・結果だけ");
    }

    #[test]
    fn never_overwrites_an_earlier_result() {
        let place = Place::new("twice");
        let (jobs, _) = jobs_with(&place, with_build(&place, fake), CANCEL_GRACE);
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let first = wait(&jobs, 60);
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let second = wait(&jobs, 60);
        let name = |j: &Map<String, Value>| Path::new(j["out_dir"].as_str().unwrap()).file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name(&second), format!("{} (2)", name(&first)));
        assert_eq!(second["state"], "done");
    }

    #[test]
    fn refuses_what_it_cannot_build_before_starting() {
        let place = Place::new("refuse");
        let (jobs, _) = jobs_with(&place, with_build(&place, fake), CANCEL_GRACE);
        let empty = {
            let mut f = fixture("finger");
            f["parts"] = json!([]);
            f
        };
        for data in [json!({"format": "other"}), empty, Value::Null] {
            let e = jobs.start(&data, false, "inventor").unwrap_err();
            assert!(matches!(e, StartError::Spec(_)), "{data:.30}: {e:?}");
            assert_eq!(e.status(), 400);
            assert!(e.message().starts_with("この変換データからは作れません: "));
        }
        assert!(matches!(jobs.start(&fixture("finger"), false, "ipt").unwrap_err(), StartError::Spec(_)), "作るものの指定が違う");
        assert!(entries(&place.out()).is_empty(), "何も作らない");
        assert_eq!(jobs.status()["state"], "idle");
    }

    #[test]
    fn one_build_at_a_time_and_it_can_be_cancelled() {
        // 中止を頼んでも止まらない作る係（標準入力を読まない）は、待つ時間を過ぎたら強制的に止める
        let place = Place::new("busy");
        let (jobs, _) = jobs_with(&place, with_build(&place, |t| python_c(t, "import time; time.sleep(30)")), Duration::from_millis(200));
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let busy = jobs.start(&fixture("blade"), false, "inventor").unwrap_err();
        assert_eq!(busy, StartError::Busy("LS4_parts_viewer".into()));
        assert_eq!((busy.status(), busy.message().contains("作っています")), (409, true));
        std::thread::sleep(Duration::from_millis(300));
        let t0 = Instant::now();
        jobs.cancel();
        let cancelled = wait(&jobs, 10);
        assert_eq!(cancelled["state"], "cancelled");
        assert!(cancelled["message"].as_str().unwrap().contains("保存せずに閉じて"));
        assert!(t0.elapsed() < Duration::from_secs(5), "眠ったままの係を待たない（{:?}）", t0.elapsed());
        assert!(entries(&place.out()).is_empty(), "中止して何も作らなかったら、保存先を残さない");
    }

    #[test]
    fn cancel_asks_the_builder_to_stop_before_forcing_it() {
        // 作る係は標準入力の「cancel」で自分から止まる（作りかけの部品を終え、Inventor をふだんの状態に戻してから）
        let place = Place::new("polite");
        let polite = "import sys\nfor line in sys.stdin:\n    if line.strip() == 'cancel':\n        print('stopped by request', file=sys.stderr); sys.exit(0)";
        let (jobs, _) = jobs_with(&place, with_build(&place, |t| python_c(t, polite)), Duration::from_secs(30));
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let t0 = Instant::now();
        jobs.cancel();
        assert_eq!(wait(&jobs, 10)["state"], "cancelled");
        assert!(t0.elapsed() < Duration::from_secs(5), "待つ時間（30 秒）を待たずに止まる");
        assert!(fs::read_to_string(place.logs().join("builder_console.log")).unwrap().contains("stopped by request"));
    }

    #[test]
    fn forcing_the_builder_to_stop_while_it_uses_inventor_restores_inventor() {
        // 強制的に止めると作る係は Inventor を戻せないので、別のプロセス（--restore-inventor）で戻す
        let place = Place::new("restore");
        let marker = place.dir.join("restored");
        let stuck = "import json, time\nprint(json.dumps({'event': 'connecting'}), flush=True)\ntime.sleep(30)";
        let mut tools = with_build(&place, |t| python_c(t, stuck));
        tools.restore = python_c(&tools, &format!("open({:?}, 'w').write('ok')", marker.display().to_string()));
        let (jobs, _) = jobs_with(&place, tools, Duration::from_millis(200));
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let end = Instant::now() + Duration::from_secs(20);
        while jobs.status()["state"] != "connecting" && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        jobs.cancel();
        assert_eq!(wait(&jobs, 10)["state"], "cancelled");
        let end = Instant::now() + Duration::from_secs(20);
        while !marker.exists() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(marker.exists(), "Inventor をふだんの状態に戻す係を動かした");
    }

    #[test]
    fn installs_the_library_first_then_builds_in_a_new_process() {
        let place = Place::new("install");
        let mut tools = with_build(&place, fake);
        tools.install = python_c(&tools, "print('Successfully installed pywin32')");
        tools.libraries = python_c(&tools, "print('{\"event\": \"libraries\", \"ready\": true}')");
        let (jobs, _) = jobs_with(&place, tools, CANCEL_GRACE);
        jobs.set_ready(Some(false));
        assert_eq!(jobs.start(&fixture("finger"), true, "inventor").unwrap()["state"], "installing");
        assert_eq!(wait(&jobs, 60)["state"], "done");
        assert!(jobs.ready(), "入れたあとは聞き直す");
        assert!(fs::read_to_string(place.logs().join("install.log")).unwrap().contains("Successfully installed"));
    }

    #[test]
    fn a_failed_install_shows_what_pip_said() {
        let place = Place::new("pipfail");
        let mut tools = with_build(&place, fake);
        tools.install = python_c(&tools, "import sys; print('ERROR: No matching distribution found for pywin32'); sys.exit(1)");
        let (jobs, _) = jobs_with(&place, tools, CANCEL_GRACE);
        jobs.start(&fixture("finger"), true, "inventor").unwrap();
        let failed = wait(&jobs, 60);
        assert_eq!(failed["state"], "failed");
        assert!(failed["message"].as_str().unwrap().contains("ライブラリを入れられませんでした"));
        assert!(failed["detail"].as_str().unwrap().contains("No matching distribution"));
        assert!(failed["out_dir"].is_null(), "何も作らなかった保存先は片付ける");
    }

    #[test]
    fn a_partial_result_is_kept() {
        // 途中まで作った部品があれば、失敗しても保存先を残す（作った .ipt を消さない）
        let place = Place::new("partial");
        let partial = "import sys, pathlib; out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1]); (out / 'p01.ipt').write_text('x'); sys.exit(3)";
        let (jobs, _) = jobs_with(&place, with_build(&place, |t| python_c(t, partial)), CANCEL_GRACE);
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let failed = wait(&jobs, 60);
        assert_eq!(failed["state"], "failed");
        assert!(Path::new(failed["out_dir"].as_str().unwrap()).join("p01.ipt").exists());
        assert!(Path::new(failed["spec"].as_str().unwrap()).exists(), "変換データの写しも残す（作った部品の元の記録）");
    }

    #[test]
    fn a_crash_is_explained_with_its_output() {
        let place = Place::new("crash");
        let (jobs, _) = jobs_with(
            &place,
            with_build(&place, |t| python_c(t, "import sys; sys.stderr.write('Traceback: boom\\n'); sys.exit(3)")),
            CANCEL_GRACE,
        );
        jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let failed = wait(&jobs, 60);
        assert_eq!(failed["state"], "failed");
        assert!(failed["message"].as_str().unwrap().contains("終了コード 3"), "{failed:?}");
        assert!(failed["detail"].as_str().unwrap().contains("boom"));
    }

    #[test]
    fn inventor_errors_are_passed_on() {
        let place = Place::new("refuse-inventor");
        let refuse = "import sys; import tests.fake_inventor as f, ipt_build.inventor as inv; \
            inv.connect = lambda visible=True: (_ for _ in ()).throw(f.FakeComError('Inventor を起動できません')); \
            from ipt_build.__main__ import main; sys.exit(main(sys.argv[1:]))";
        let (jobs, opened) = jobs_with(&place, with_build(&place, |t| python_c(t, refuse)), CANCEL_GRACE);
        let started = jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let done = wait(&jobs, 60);
        assert_eq!(
            (done["state"].as_str(), done["inventor_error"].as_str()),
            (Some("done"), Some("Inventor を起動できません")),
            "理由を伝える"
        );
        assert_eq!(done["step"]["file"], "LS4_parts_viewer.stp", "Inventor で作れなくても STEP は残す");
        assert!(Path::new(started["out_dir"].as_str().unwrap()).join("LS4_parts_viewer.stp").exists());
        assert!(jobs.open_output());
        assert_eq!(opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn nothing_made_leaves_no_folder() {
        let place = Place::new("nothing");
        let broken = "import sys; print('{\"event\": \"error\", \"message\": \"壊れた変換データ\"}'); sys.exit(2)";
        let (jobs, _) = jobs_with(&place, with_build(&place, |t| python_c(t, broken)), CANCEL_GRACE);
        let started = jobs.start(&fixture("finger"), false, "inventor").unwrap();
        let failed = wait(&jobs, 60);
        assert_eq!((failed["state"].as_str(), failed["message"].as_str()), (Some("failed"), Some("壊れた変換データ")));
        assert!(failed["out_dir"].is_null(), "何も作れなかった試みの保存先は片付ける");
        assert!(!Path::new(started["out_dir"].as_str().unwrap()).exists());
        assert!(!jobs.open_output());
    }

    #[test]
    fn an_unwritable_destination_is_explained() {
        let place = Place::new("blocked");
        let blocked = place.dir.join("file");
        fs::write(&blocked, "x").unwrap(); // 保存先の親がファイル → フォルダを作れない
        let tools = with_build(&place, fake);
        let jobs = Jobs::new(blocked, place.logs(), Box::new(move || Ok(tools.clone())), Box::new(|_| {}), CANCEL_GRACE);
        let e = jobs.start(&fixture("finger"), false, "inventor").unwrap_err();
        assert!(matches!(e, StartError::Dest(_)), "{e:?}");
        assert_eq!(e.status(), 500);
        assert!(e.message().contains("build.output_dir"), "直し方（設定の場所）を示す");
    }

    #[test]
    fn without_python_it_says_so_before_starting() {
        let place = Place::new("nopython");
        let jobs = Jobs::new(place.out(), place.logs(), Box::new(|| Err("Python が見つかりません".into())), Box::new(|_| {}), CANCEL_GRACE);
        assert_eq!(jobs.python_missing().as_deref(), Some("Python が見つかりません"));
        assert!(!jobs.ready());
        let e = jobs.start(&fixture("finger"), false, "step").unwrap_err();
        assert_eq!((e.status(), e.message()), (503, "Python が見つかりません".to_string()));
    }

    #[test]
    fn the_library_answer_is_remembered() {
        let place = Place::new("ready");
        let marker = place.dir.join("asked");
        let mut tools = real_tools(&place);
        let code =
            format!("open({:?}, 'a').write('x'); print('{{\"event\": \"libraries\", \"ready\": false}}')", marker.display().to_string());
        tools.libraries = python_c(&tools, &code);
        let (jobs, _) = jobs_with(&place, tools, CANCEL_GRACE);
        assert!(!jobs.ready());
        assert!(!jobs.ready());
        assert_eq!(fs::read_to_string(&marker).unwrap(), "x", "Python に聞くのは 1 度だけ（画面は何度も尋ねる）");
    }

    #[test]
    fn real_library_check_answers() {
        // 本物の --libraries（この網の PC に pywin32 は無い想定でも、答えの形が読めること）
        let place = Place::new("libraries");
        let tools = real_tools(&place);
        let out = output(&tools.libraries, &tools, LIBRARIES_WAIT).unwrap();
        let answer = last_event(&out.stdout, "libraries").expect("--libraries が 1 行で答える");
        assert!(answer["ready"].is_boolean(), "{answer}");
    }

    #[test]
    fn events_move_the_state() {
        let place = Place::new("events");
        let (jobs, _) = jobs_with(&place, real_tools(&place), CANCEL_GRACE);
        let mut seen = vec![];
        let (mut done, mut error) = (false, None);
        jobs.update(fields(&[("state", "step".into())]));
        for line in [
            r#"{"event": "step", "inventor": false, "step": {"file": "a.stp"}, "noise": 1}"#,
            "STEP を書きました（JSON でない行）",
            r#"{"event": "step", "inventor": true}"#,
            r#"{"event": "start", "total": 2}"#,
            r#"{"event": "part", "good": 1}"#,
            r#"{"event": "assembly"}"#,
            r#"{"event": "unknown"}"#,
            r#"{"event": "done", "good": 2}"#,
        ] {
            jobs.apply(line, &mut done, &mut error);
            seen.push(jobs.status()["state"].as_str().unwrap().to_string());
        }
        assert_eq!(
            seen,
            ["step", "step", "connecting", "building", "building", "assembly", "assembly", "assembly"],
            "STEP だけなら接続へ進まない・終わりの状態は片付けてから出す"
        );
        let job = jobs.status();
        assert_eq!(
            (job["step"]["file"].as_str(), job["good"].as_u64(), job["total"].as_u64()),
            (Some("a.stp"), Some(2), Some(2)),
            "進み具合を写す"
        );
        assert!(job.get("noise").is_none(), "進み具合のほかは写さない");
        assert!(done && error.is_none());
        jobs.apply(r#"{"event": "error", "message": "壊れた"}"#, &mut done, &mut error);
        assert_eq!(error.as_deref(), Some("壊れた"));
    }

    #[test]
    fn unique_names_and_tails() {
        let place = Place::new("unique");
        let a = place.out().join("x_cad");
        assert_eq!(unique_dir(&a), a);
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(place.out().join("x_cad (2)")).unwrap();
        assert_eq!(unique_dir(&a), place.out().join("x_cad (3)"));
        assert_eq!(tail_lines("a\nb\nc", 2), "b\nc");
        assert_eq!(tail_chars("あいうえお", 2), "えお", "字で数える（バイトで切らない）");
    }
}
