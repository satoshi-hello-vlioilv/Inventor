//! 版の管理（WaveLog の版の配り方に合わせ、版の削除・残す数・裏での写し・入れ替えの戻しを足した）。設計は docs/desktop.md §8。
//!
//! 置き場（共有のフォルダ。既定は Box Drive の DEFAULT_DIR。設定の update.dir で変えられる）。最上位は入口の exe と versions だけ:
//!   Inventor3DTool.exe            新しい PC の入口（配る版の exe の写し。押すとこの PC へ写して開き、ショートカットを作る: main.rs）
//!   versions\release.json         配る版 {"version","setAt","setBy","previous"}
//!   versions\roles.json           版を管理できる人 {"developers": [Windows のユーザー名], "maintainers": [...]}（全 PC で同じ）
//!   versions\policy.json          残す版の数 {"keep": N}
//!   versions\<版>\                版の中身（PAYLOAD: 動かすのに要る物だけ）と manifest.json（ファイルごとの大きさ・sha256）・notes.txt
//!   versions\.<版>.<pid>.tmp\     置いている途中（"." で始まるので、一覧にも配る版にもならない）
//!   versions\.<版>.<pid>.del\     消している途中
//!   2.4.0 までは release.json・roles.json・policy.json を最上位に置いた（古い形）。読むときは versions の中が無ければ最上位を読み、
//!   最上位に release.json が残っている間は同じ物を最上位にも書く（2.4.0 までの PC は最上位の release.json だけを見てそろえる）。
//!   全ての PC が新しい版になったら、設定の「片付ける」で最上位から外す（tidy）
//!
//! 各 PC（アプリのフォルダ = exe と program の親。ふつうは入口から写した %USERPROFILE%\Inventor3DTool。ショートカットはここの exe を指す）:
//!   .update\<版>.stage\           裏で写して確かめた次の版（.ready ができたら入れ替えられる）
//!   .update\<版>.old\             入れ替える前の版（最後の 1 つだけ残す。戻すときの元）
//!   program\config\               設定（入れ替えない）
//!
//! 起動のとき、配る版と違えば、窓に進み具合を出しながら写して確かめ（stage）、入れ替えて（swap）開き直す。
//! 動いている exe は消せないが名前は変えられる（Windows）ので、exe も program の中身と同じく .old へ移して新しいものを置く。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// 置き場の既定（利用者の指定。Box Drive が各 PC の同じ場所に同期するフォルダ）
pub const DEFAULT_DIR: &str = r"C:\boxdrive\Box\(D)_仕上課\90_アプリ開発\90_Releases\Inventor";
pub const EXE: &str = "Inventor3DTool.exe";
pub const RELEASE: &str = "release.json";
pub const VERSIONS: &str = "versions";
pub const MANIFEST: &str = "manifest.json";
/// 版ごとの「変わったこと」（置き場の versions\<版>\notes.txt。目録とは別: 置いた後でも書き直せる）
pub const NOTES: &str = "notes.txt";
const NOTES_MAX: usize = 2000;
/// そろえた後に 1 度だけ見せる「変わったこと」（この PC の .update\news.json。見たら消す）
const NEWS: &str = "news.json";
pub const ROLES: &str = "roles.json";
/// 置き場の決まり {"keep": 残す版の数（0 = 全て残す）}
pub const POLICY: &str = "policy.json";
/// 置き場の管理のファイル（versions の中。2.4.0 までは最上位）
const META: [&str; 3] = [RELEASE, ROLES, POLICY];
/// アプリの版を書いたファイル（program の中。版を上げるたびに書き換える: CLAUDE.md）
pub const VERSION_FILE: &str = "program/version.json";
/// ZIP に無ければ断るもの
const REQUIRED: [&str; 3] = [EXE, VERSION_FILE, "program/app/index.html"];
/// 置き場が読めるかを待つ長さ（Box Drive がつながっていない・オンラインだけのファイルを落とす途中）
pub const REACH: Duration = Duration::from_secs(3);
/// 途中で残った .tmp・.del を、ほかの PC の作業中と見なさなくなる古さ
const STALE: Duration = Duration::from_secs(3600);
const STAGE_READY: &str = ".ready";

// ---- 版の番号 ----------------------------------------------------------------------------------------------------

/// 使える版の番号（数字で始まり、英数字・点・ハイフンだけ。41 字まで。フォルダの名前にする）
pub fn safe_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 41
        && v.starts_with(|c: char| c.is_ascii_digit())
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// 並べる鍵（数の部分を数として比べる: 2.10.0 > 2.9.0）
pub fn version_key(v: &str) -> Vec<(u64, String)> {
    v.split(['.', '-'])
        .map(|p| (p.parse::<u64>().unwrap_or(0), if p.parse::<u64>().is_ok() { String::new() } else { p.to_string() }))
        .collect()
}

/// program\version.json の版（無い・読めなければ None）
pub fn local_version(program: &Path) -> Option<String> {
    let v = json_bytes(&std::fs::read(program.join("version.json")).ok()?)?;
    v["version"].as_str().filter(|s| safe_version(s)).map(str::to_string)
}

// ---- 中身の決まり --------------------------------------------------------------------------------------------------

/// 配るもの（最小の構成）: exe・README と、program の中で動かすのに要る物（画面・作る係・版の印）だけ。
/// サンプル・試験・開発の道具・この PC の設定（program\config）・.pyc は配らない（版ごとに置き場と各 PC へ写すので軽く保つ）
pub const PAYLOAD: [&str; 6] =
    [EXE, "README.md", "program/version.json", "program/Inventor3DTool.build.json", "program/app", "program/ipt_build"];

/// 安全な相対の道か（"/" 区切り。上へ出る・ドライブ・空の区切り・.pyc の置き場を含まない）
fn clean_path(p: &str) -> bool {
    !p.starts_with('/') && !p.split('/').any(|s| s.is_empty() || s == "." || s == ".." || s.contains(':') || s == "__pycache__")
}

/// ZIP から版を置くときに配るファイルか（PAYLOAD のどれか。その中のファイル）
pub fn payload_path(p: &str) -> bool {
    clean_path(p) && PAYLOAD.iter().any(|u| p == *u || p.strip_prefix(u).is_some_and(|rest| rest.starts_with('/')))
}

/// 置き場の版を写すときに受け入れるファイルか（payload_path より広い: 2.4.0 までに置いた版は program のサンプルなども含むので、
/// 古い版へ戻すときも写せるように。設定と上へ出る道だけは断る）
pub fn accepted_path(p: &str) -> bool {
    clean_path(p)
        && match p.split('/').collect::<Vec<_>>().as_slice() {
            [EXE] | ["README.md"] => true,
            ["program", "config", ..] => false,
            ["program", _, ..] => true,
            _ => false,
        }
}

/// 入れ替える単位（exe・README.md・program の直下の 1 つずつ）
pub fn unit_of(p: &str) -> String {
    match p.split('/').collect::<Vec<_>>().as_slice() {
        ["program", first, ..] => format!("program/{first}"),
        [first, ..] => first.to_string(),
        [] => String::new(),
    }
}

/// JSON を読む（Windows の道具が書く BOM を許す）
fn json_bytes(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_text() -> String {
    // 記録に使う時刻（UTC。画面は表示のときに地方の時刻へ直す）
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// 1970-01-01 からの日数 → 年月日（Howard Hinnant の方法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// この PC で使っている人（Windows のユーザー名。役割の判定に使う）
pub fn user_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

/// 操作した人（Windows のユーザー名@PC の名前。記録に残す）
pub fn who() -> String {
    let user = user_name();
    let pc = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    if pc.is_empty() {
        user
    } else {
        format!("{user}@{pc}")
    }
}

// ---- 進み具合（画面が 0.4 秒ごとに見に来る） --------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct Progress(Arc<Mutex<Value>>);

impl Progress {
    pub fn get(&self) -> Value {
        let v = self.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if v.is_null() {
            json!({"state": "idle"})
        } else {
            v
        }
    }
    fn set(&self, v: Value) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }
    fn tick(&self, patch: Value) {
        let mut cur = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    /// 失敗にする（画面に理由を出す）
    pub fn fail(&self, why: &str) {
        if self.get()["state"] == "idle" {
            self.set(json!({}));
        }
        self.tick(json!({"state": "failed", "error": why, "endedAt": now_text()}));
    }
    pub fn running(&self) -> bool {
        self.get()["state"] == "running"
    }
}

// ---- 置き場（版を置く・配る・消す） ----------------------------------------------------------------------------------

/// 置き場の版の一覧（新しい順）。manifest.json の version がフォルダの名前と同じものだけ
pub fn versions(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(dir.join(VERSIONS))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !e.path().is_dir() {
                return None;
            }
            let m: Value = serde_json::from_slice(&std::fs::read(e.path().join(MANIFEST)).ok()?).ok()?;
            (m["version"] == name.as_str()).then(|| {
                json!({"version": name, "placedAt": m["placedAt"], "placedBy": m["placedBy"], "source": m["source"],
                       "commit": m["commit"], "files": m["files"].as_array().map(|f| f.len()).unwrap_or(0), "bytes": m["bytes"],
                       "notes": notes_of(dir, &name)})
            })
        })
        .collect();
    out.sort_by(|a, b| version_key(b["version"].as_str().unwrap_or("")).cmp(&version_key(a["version"].as_str().unwrap_or(""))));
    out
}

/// 版の「変わったこと」（無ければ空）
pub fn notes_of(dir: &Path, version: &str) -> String {
    std::fs::read_to_string(dir.join(VERSIONS).join(version).join(NOTES)).map(|t| t.trim().to_string()).unwrap_or_default()
}

/// 版の「変わったこと」を書く（空なら消す。長すぎる物は断る）
pub fn set_notes(dir: &Path, version: &str, text: &str) -> Result<Value, String> {
    let folder = dir.join(VERSIONS).join(version);
    if !safe_version(version) || !folder.join(MANIFEST).is_file() {
        return Err(format!("版 {version} は置き場にありません"));
    }
    let text = text.trim().replace("\r\n", "\n");
    if text.chars().count() > NOTES_MAX {
        return Err(format!("変わったことは {NOTES_MAX} 字までにしてください"));
    }
    let file = folder.join(NOTES);
    let done = if text.is_empty() {
        std::fs::remove_file(&file).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
    } else {
        write_atomic(&file, text.as_bytes())
    };
    done.map_err(|e| format!("変わったことを書けません（{e}）"))?;
    Ok(json!({"version": version, "notes": text}))
}

/// 置き場の管理のファイルを読む（versions の中。無ければ古い形の最上位）
fn read_meta(dir: &Path, name: &str) -> std::io::Result<Vec<u8>> {
    match std::fs::read(dir.join(VERSIONS).join(name)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::read(dir.join(name)),
        r => r,
    }
}

/// 置き場の管理のファイルを書く（versions の中）。古い形の最上位に release.json が残っている間は、最上位にも同じ物を書く
/// （2.4.0 までの PC は最上位を読む。片付けるまで、古い PC も配る版へそろい、役割も食い違わない）
fn write_meta(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join(VERSIONS))?;
    write_atomic(&dir.join(VERSIONS).join(name), bytes)?;
    if dir.join(RELEASE).is_file() {
        write_atomic(&dir.join(name), bytes)?;
    }
    Ok(())
}

/// 最上位に残っている古い形の管理のファイル（無ければ空）
pub fn legacy(dir: &Path) -> Vec<&'static str> {
    META.into_iter().filter(|n| dir.join(n).is_file()).collect()
}

/// 古い形を片付ける: 最上位の管理のファイルを versions の中へ移す（versions の中にもう有れば、最上位の物を外す）。
/// 答えは片付けた名前。これ以降、2.4.0 までの PC は配る版を見つけられない（そろわない）ので、全ての PC が新しい版になってから行う
pub fn tidy(dir: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(dir.join(VERSIONS)).map_err(|e| format!("置き場へ書けません（{e}）"))?;
    let mut moved = Vec::new();
    // release.json は最後に（残っている間は write_meta が最上位にも書くので、先に外すと途中の失敗で食い違う）
    for name in [ROLES, POLICY, RELEASE] {
        let (top, inner) = (dir.join(name), dir.join(VERSIONS).join(name));
        if !top.is_file() {
            continue;
        }
        let done = if inner.is_file() { std::fs::remove_file(&top) } else { std::fs::rename(&top, &inner) };
        done.map_err(|e| format!("{name} を片付けられません（{e}）"))?;
        moved.push(name);
    }
    Ok(json!({"tidied": moved}))
}

/// 配る版（release.json。無ければ None = まだ選んでいない）
pub fn release(dir: &Path) -> Result<Option<Value>, String> {
    match read_meta(dir, RELEASE) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map(Some).map_err(|e| format!("release.json を読めません（{e}）")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("release.json を読めません（{e}）")),
    }
}

/// 一時の物を書いてから名前を変える（読む側が書きかけを見ない）
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// 途中で止まった .tmp・.del のうち、古いもの（ほかの PC が置いている途中ではないもの）を片付ける
pub fn sweep(dir: &Path) {
    for e in std::fs::read_dir(dir.join(VERSIONS)).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE);
        if name.starts_with('.') && (name.ends_with(".tmp") || name.ends_with(".del")) && old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// ZIP の中の、アプリの根（GitHub の「Download ZIP」は "Inventor-main/" の下に入る）
fn zip_root(names: &[String]) -> Option<String> {
    names.iter().find_map(|n| n.strip_suffix(VERSION_FILE).map(str::to_string)).filter(|r| r.is_empty() || r.ends_with('/'))
}

/// ZIP から版を置く。答えは置いた版 {version, files, bytes}
pub fn publish_zip(dir: &Path, zip_path: &Path, by: &str, progress: &Progress, keep: usize) -> Result<Value, String> {
    let source = zip_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    progress.set(json!({"state": "running", "stage": "check", "source": source, "startedAt": now_text()}));
    let result = publish_inner(dir, zip_path, &source, by, progress, keep);
    match &result {
        Ok(v) => progress.tick(json!({"state": "done", "result": v, "endedAt": now_text()})),
        Err(e) => progress.tick(json!({"state": "failed", "error": e, "endedAt": now_text()})),
    }
    result
}

fn publish_inner(dir: &Path, zip_path: &Path, source: &str, by: &str, progress: &Progress, keep: usize) -> Result<Value, String> {
    if !dir.is_dir() {
        return Err(format!("置き場が見つかりません: {}", dir.display()));
    }
    sweep(dir);
    let file = std::fs::File::open(zip_path).map_err(|e| format!("ZIP を開けません（{e}）"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "ZIP ファイルとして読めません（GitHub の「Code → Download ZIP」で落とした物を選んでください）。".to_string())?;
    // 中の名前（区切りが "\\" の ZIP もあるので "/" にそろえる）: (番号, 名前, 大きさ)。フォルダは除く
    let entries: Vec<(usize, String, u64)> = (0..zip.len())
        .filter_map(|i| {
            let f = zip.by_index_raw(i).ok()?;
            let name = f.name().replace('\\', "/");
            (!f.is_dir() && !name.ends_with('/')).then_some((i, name, f.size()))
        })
        .collect();
    let names: Vec<String> = entries.iter().map(|e| e.1.clone()).collect();
    let root = zip_root(&names).ok_or_else(|| format!("アプリの ZIP ではありません（{VERSION_FILE} が入っていません）。"))?;
    let index_of = |rel: &str| entries.iter().find(|e| e.1 == format!("{root}{rel}")).map(|e| e.0);
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|r| index_of(r).is_none()).collect();
    if !missing.is_empty() {
        return Err(format!("欠かせない物が入っていません: {}", missing.join("・")));
    }
    let read_entry = |zip: &mut zip::ZipArchive<std::fs::File>, i: usize| -> Result<Vec<u8>, String> {
        let mut f = zip.by_index(i).map_err(|e| format!("ZIP の中を読めません（{e}）"))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| format!("{} を読めません（{e}）", f.name()))?;
        Ok(buf)
    };
    let vjson = json_bytes(&read_entry(&mut zip, index_of(VERSION_FILE).unwrap_or(0))?).unwrap_or_default();
    let version = vjson["version"].as_str().unwrap_or("").to_string();
    if !safe_version(&version) {
        return Err(format!("版を読めません（{VERSION_FILE} の version）: '{version}'"));
    }
    let dest = dir.join(VERSIONS).join(&version);
    if dest.exists() {
        return Err(format!("版 {version} はもう置いてあります。版を上げた ZIP を選んでください（同じ番号で中身を変えると、もう写した PC と食い違うため）。"));
    }
    // 中身のコミット: ZIP の注記（GitHub の ZIP と、配る ZIP（pack）は注記がコミット）。無ければ exe を作ったコミット
    let commit = Some(String::from_utf8_lossy(zip.comment()).trim().to_string())
        .filter(|c| !c.is_empty())
        .or_else(|| {
            index_of("program/Inventor3DTool.build.json")
                .and_then(|i| read_entry(&mut zip, i).ok())
                .and_then(|b| json_bytes(&b))
                .and_then(|v| v["commit"].as_str().map(str::to_string))
        })
        .unwrap_or_default();

    // 配るファイルだけを選ぶ: (番号, 版の中の道, 大きさ)
    let picked: Vec<(usize, String, u64)> = entries
        .iter()
        .filter_map(|(i, n, size)| n.strip_prefix(&root).filter(|rel| payload_path(rel)).map(|rel| (*i, rel.to_string(), *size)))
        .collect();
    let total_bytes: u64 = picked.iter().map(|p| p.2).sum();
    progress.tick(json!({"stage": "copy", "version": version, "done": 0, "total": picked.len(), "bytes": 0, "totalBytes": total_bytes}));

    let tmp = dir.join(VERSIONS).join(format!(".{version}.{}.tmp", std::process::id()));
    let mut write_all = || -> Result<Vec<Value>, String> {
        std::fs::create_dir_all(&tmp).map_err(|e| format!("置き場へ書けません（{}）: {e}", dir.display()))?;
        let mut files = Vec::new();
        let mut bytes = 0u64;
        for (n, (index, rel, _)) in picked.iter().enumerate() {
            let data = read_entry(&mut zip, *index)?;
            let path = tmp.join(rel);
            std::fs::create_dir_all(path.parent().unwrap_or(&tmp)).map_err(|e| format!("置き場へ書けません: {e}"))?;
            std::fs::File::create(&path).and_then(|mut f| f.write_all(&data)).map_err(|e| format!("置き場へ書けません（{rel}）: {e}"))?;
            bytes += data.len() as u64;
            files.push(json!({"path": rel, "size": data.len(), "sha256": sha256_hex(&data)}));
            progress.tick(json!({"done": n + 1, "bytes": bytes}));
        }
        Ok(files)
    };
    let files = write_all().inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&tmp);
    })?;
    progress.tick(json!({"stage": "finish"}));
    let mut payload: Vec<String> = files.iter().map(|f| unit_of(f["path"].as_str().unwrap_or(""))).collect();
    payload.sort();
    payload.dedup();
    let manifest = json!({"version": version, "payload": payload, "files": files, "bytes": total_bytes,
                          "placedAt": now_text(), "placedBy": by, "source": source, "commit": commit});
    let finish = || -> std::io::Result<()> {
        std::fs::write(tmp.join(MANIFEST), serde_json::to_vec_pretty(&manifest)?)?;
        std::fs::rename(&tmp, &dest)
    };
    finish().map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("置き場へ書けません（{}）: {e}", dir.display())
    })?;
    let pruned = if keep > 0 { prune(dir, keep) } else { Vec::new() };
    Ok(json!({"version": version, "files": files.len(), "bytes": total_bytes, "pruned": pruned}))
}

/// 配る ZIP を作る（main へ入ったときに CI が作る。exe と、リポジトリの中の PAYLOAD だけ）。中は "Inventor3DTool-<版>/" の下、
/// 注記はコミット（commit が空なら program の build.json の commit）。答えは {version, files, bytes, zip}
pub fn pack(root: &Path, out: &Path, commit: &str) -> Result<Value, String> {
    let version = local_version(&root.join("program")).ok_or_else(|| format!("版を読めません（{}）", root.join(VERSION_FILE).display()))?;
    let mut files = Vec::new();
    let mut walk = vec![];
    for unit in PAYLOAD {
        let path = root.join(unit);
        if path.is_file() {
            files.push(unit.to_string());
        } else if path.is_dir() {
            walk.push(unit.to_string());
        } else if REQUIRED.contains(&unit) {
            return Err(format!("欠かせない物がありません: {unit}"));
        }
    }
    while let Some(rel) = walk.pop() {
        let entries = std::fs::read_dir(root.join(&rel)).map_err(|e| format!("{rel} を読めません（{e}）"))?;
        for e in entries.flatten() {
            let child = format!("{rel}/{}", e.file_name().to_string_lossy());
            if e.path().is_dir() {
                walk.push(child);
            } else if payload_path(&child) {
                files.push(child);
            }
        }
    }
    files.sort();
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|r| !files.iter().any(|f| f == r)).collect();
    if !missing.is_empty() {
        return Err(format!("欠かせない物がありません: {}", missing.join("・")));
    }
    let commit = Some(commit.trim().to_string()).filter(|c| !c.is_empty()).unwrap_or_else(|| {
        json_bytes(&std::fs::read(root.join("program/Inventor3DTool.build.json")).unwrap_or_default())
            .and_then(|v| v["commit"].as_str().map(str::to_string))
            .unwrap_or_default()
    });
    let tmp = out.with_extension(format!("{}.tmp", std::process::id()));
    let write = || -> Result<u64, String> {
        let mut z = zip::ZipWriter::new(std::fs::File::create(&tmp).map_err(|e| format!("{} を作れません（{e}）", out.display()))?);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut bytes = 0u64;
        for rel in &files {
            let data = std::fs::read(root.join(rel)).map_err(|e| format!("{rel} を読めません（{e}）"))?;
            z.start_file(format!("{}-{version}/{rel}", crate::locate::APP_ID), opt).map_err(|e| e.to_string())?;
            z.write_all(&data).map_err(|e| e.to_string())?;
            bytes += data.len() as u64;
        }
        z.set_comment(commit.clone());
        z.finish().map_err(|e| e.to_string())?;
        Ok(bytes)
    };
    let bytes = write().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    std::fs::rename(&tmp, out).map_err(|e| format!("{} を置けません（{e}）", out.display()))?;
    let zipped = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"version": version, "files": files.len(), "bytes": bytes, "zip": out, "zipBytes": zipped, "commit": commit}))
}

/// 配る版を選ぶ（前の版は previous に残す。戻すときも選び直すだけ）。新しい PC の入口 exe も置き直す
pub fn set_release(dir: &Path, version: &str, by: &str) -> Result<Value, String> {
    if !versions(dir).iter().any(|v| v["version"] == version) {
        return Err(format!("版 {version} は置き場にありません。先に ZIP から置いてください。"));
    }
    let previous =
        release(dir).ok().flatten().and_then(|r| r["version"].as_str().map(str::to_string)).filter(|p| p != version).unwrap_or_default();
    let rel = json!({"version": version, "setAt": now_text(), "setBy": by, "previous": previous});
    write_meta(dir, RELEASE, &serde_json::to_vec_pretty(&rel).unwrap_or_default())
        .map_err(|e| format!("release.json を書けません（{e}）"))?;
    let mut notes = Vec::new();
    // 新しい PC の入口（中身が同じなら書かない。開いている PC があると書けないので、知らせるだけ）
    let src = dir.join(VERSIONS).join(version).join(EXE);
    let entry = dir.join(EXE);
    let same = std::fs::read(&src).ok().zip(std::fs::read(&entry).ok()).is_some_and(|(a, b)| a == b);
    if !same {
        let copied = std::fs::read(&src).and_then(|b| write_atomic(&entry, &b));
        if let Err(e) = copied {
            notes.push(format!(
                "新しい PC の入口（{}）を置き直せませんでした（{e}）。どこかの PC で入口が開いたままかもしれません。",
                entry.display()
            ));
        }
    }
    Ok(json!({"release": rel, "notes": notes}))
}

/// 版を消す。配っている版は消せない（各 PC がそろえる元）。名前を変えてから消す（消す途中の物を一覧に出さない）
pub fn delete_version(dir: &Path, version: &str) -> Result<Value, String> {
    if !safe_version(version) || !dir.join(VERSIONS).join(version).is_dir() {
        return Err(format!("版 {version} は置き場にありません。"));
    }
    if release(dir).ok().flatten().is_some_and(|r| r["version"] == version) {
        return Err(format!("版 {version} は配っている版なので消せません。先にほかの版を配ってください。"));
    }
    let trash = dir.join(VERSIONS).join(format!(".{version}.{}.del", std::process::id()));
    std::fs::rename(dir.join(VERSIONS).join(version), &trash).map_err(|e| format!("版 {version} を消せません（{e}）"))?;
    let _ = std::fs::remove_dir_all(&trash); // 残っても sweep が後で片付ける
    Ok(json!({"deleted": version}))
}

/// 新しい順に keep 個だけ残し、ほかを消す（配っている版と、その前に配った版は残す）。消した版の一覧
pub fn prune(dir: &Path, keep: usize) -> Vec<String> {
    let rel = release(dir).ok().flatten().unwrap_or_default();
    let protect = [rel["version"].as_str().unwrap_or(""), rel["previous"].as_str().unwrap_or("")];
    versions(dir)
        .iter()
        .skip(keep)
        .filter_map(|v| v["version"].as_str().map(str::to_string))
        .filter(|v| !protect.contains(&v.as_str()))
        .filter(|v| delete_version(dir, v).is_ok())
        .collect()
}

// ---- 版を管理できる人 -------------------------------------------------------------------------------------------------

/// 役割: "developer"（版の管理と役割の変更）・"maintainer"（版の管理）・"user"（見るだけ）。
/// roles.json がまだ無ければ "unset"（最初の 1 人が自分を開発者にする）
pub fn role_of(dir: &Path, user: &str) -> &'static str {
    let Ok(bytes) = read_meta(dir, ROLES) else { return "unset" };
    let roles: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let has = |k: &str| roles[k].as_array().into_iter().flatten().any(|u| u.as_str().is_some_and(|u| u.eq_ignore_ascii_case(user)));
    if has("developers") {
        "developer"
    } else if has("maintainers") {
        "maintainer"
    } else {
        "user"
    }
}

pub fn roles(dir: &Path) -> Value {
    read_meta(dir, ROLES).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({"developers": [], "maintainers": []}))
}

/// 役割の一覧を書き換える（開発者だけ。roles.json が無いときは、自分を開発者にすることだけできる）。
/// 開発者が 0 人になる変更は断る（誰も戻せなくなる）
pub fn set_roles(dir: &Path, by_user: &str, next: &Value) -> Result<Value, String> {
    let role = role_of(dir, by_user);
    let clean = |k: &str| -> Vec<String> {
        let mut v: Vec<String> = next[k]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|u| u.as_str())
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect();
        v.sort_by_key(|u| u.to_lowercase());
        v.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        v
    };
    let (devs, maints) = (clean("developers"), clean("maintainers"));
    match role {
        "developer" => {}
        "unset" if devs.len() == 1 && devs[0].eq_ignore_ascii_case(by_user) && maints.is_empty() => {}
        "unset" => return Err("最初は、自分を開発者にすることだけできます".into()),
        _ => return Err("役割を変えられるのは開発者だけです".into()),
    }
    if devs.is_empty() {
        return Err("開発者を 1 人は残してください（0 人にすると、誰も役割を戻せなくなります）".into());
    }
    let roles = json!({"developers": devs, "maintainers": maints, "setAt": now_text(), "setBy": by_user});
    write_meta(dir, ROLES, &serde_json::to_vec_pretty(&roles).unwrap_or_default())
        .map_err(|e| format!("roles.json を書けません（{e}）"))?;
    Ok(roles)
}

/// 版を管理できるか（開発者・メンテナンス者）
pub fn can_manage(role: &str) -> bool {
    matches!(role, "developer" | "maintainer")
}

/// 置き場（設定の update.dir。空なら既定。%USERPROFILE% などを展開）と、どこから決めたか
pub fn share_dir(program: &Path) -> (PathBuf, &'static str) {
    let configured = crate::settings::text(program, "update.dir");
    if configured.is_empty() {
        (PathBuf::from(DEFAULT_DIR), "default")
    } else {
        (PathBuf::from(crate::system::expand_vars(&configured, |k| std::env::var(k).ok())), "settings")
    }
}

/// 置き場から写すときの、この PC のアプリのフォルダ（%USERPROFILE%\Inventor3DTool。INVENTOR_TOOL_INSTALL_ROOT で変えられる）。
/// AppData の下にしない（Microsoft Store の Python は AppData への書き込みを別の場所へ移すので、作る係と窓で食い違う。WaveLog と同じ）
pub fn home_app() -> PathBuf {
    if let Some(p) = std::env::var_os("INVENTOR_TOOL_INSTALL_ROOT") {
        return PathBuf::from(p);
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::locate::APP_ID)
}

/// 置き場の決まり（残す版の数）
pub fn policy(dir: &Path) -> Value {
    let v: Value = read_meta(dir, POLICY).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    json!({"keep": v["keep"].as_u64().unwrap_or(0)})
}

pub fn set_policy(dir: &Path, keep: u64) -> Result<Value, String> {
    let v = json!({"keep": keep});
    write_meta(dir, POLICY, &serde_json::to_vec_pretty(&v).unwrap_or_default()).map_err(|e| format!("policy.json を書けません（{e}）"))?;
    Ok(v)
}

/// 置き場を limit の間に読む（Box Drive がつながっていない・オンラインだけのファイルを落とす途中でも、画面を止めない）
fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit).ok()
}

/// 設定の画面に出す版の管理の状態
pub fn status(program: &Path, progress: &Progress) -> Value {
    let (dir, source) = share_dir(program);
    let user = user_name();
    let local = local_version(program);
    let d = dir.clone();
    let u = user.clone();
    let read = within(REACH, move || {
        if !d.is_dir() {
            return Err(format!("置き場が見つかりません（{}）", d.display()));
        }
        sweep(&d);
        let rel = release(&d)?;
        Ok((rel, versions(&d), role_of(&d, &u), roles(&d), policy(&d), d.join(EXE).is_file(), legacy(&d)))
    });
    let base = json!({"dir": dir, "dirSource": source, "defaultDir": DEFAULT_DIR, "user": user, "local": local,
                      "publishing": progress.running(), "app": program.parent()});
    let mut v = base;
    if let Some(n) = program.parent().and_then(news) {
        v["news"] = n;
    }
    match read {
        None => {
            v["why"] = json!(format!("置き場が {} 秒で答えませんでした（Box Drive がつながっているか確かめてください）", REACH.as_secs()))
        }
        Some(Err(why)) => v["why"] = json!(why),
        Some(Ok((rel, list, role, roles, policy, entry, legacy))) => {
            let release_version = rel.as_ref().and_then(|r| r["version"].as_str().map(str::to_string));
            v["reachable"] = json!(true);
            v["release"] = rel.unwrap_or(Value::Null);
            v["pending"] = json!(release_version.is_some() && release_version != v["local"].as_str().map(str::to_string));
            v["versions"] = json!(list);
            v["role"] = json!(role);
            v["canManage"] = json!(can_manage(role));
            v["policy"] = policy;
            v["entry"] = json!({"path": dir.join(EXE), "exists": entry});
            v["legacy"] = json!(legacy);
            if role == "developer" || role == "unset" {
                v["roles"] = roles;
            }
        }
    }
    if v["reachable"].is_null() {
        v["reachable"] = json!(false);
        v["role"] = json!("unknown");
        v["canManage"] = json!(false);
    }
    v
}

// ---- 各 PC（配る版にそろえる） -------------------------------------------------------------------------------------

/// そろえた後に見せる「変わったこと」（いまの版のものだけ。前の版の物が残っていれば見せない）
pub fn news(app: &Path) -> Option<Value> {
    let v: Value = serde_json::from_slice(&std::fs::read(app.join(".update").join(NEWS)).ok()?).ok()?;
    (v["version"].as_str() == local_version(&app.join("program")).as_deref()).then_some(v)
}

/// 「変わったこと」を見た（次からは見せない）
pub fn seen_news(app: &Path) -> Result<Value, String> {
    match std::fs::remove_file(app.join(".update").join(NEWS)) {
        Ok(()) => Ok(json!({"seen": true})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"seen": true})),
        Err(e) => Err(format!("見た印を残せません（{e}）")),
    }
}

/// 置き場を見た結果
#[derive(Debug, PartialEq)]
pub enum Peek {
    /// 配る版と同じ
    Same,
    /// 配る版が違う（新しい・古い。戻すときも同じ道）
    Differs(String),
    /// 確かめない・確かめられない（理由）
    Skip(String),
}

/// 置き場の配る版と、この PC の版を比べる。置き場が REACH の間に読めなければ Skip（Box Drive がつながっていないなど）
pub fn peek(dir: &Path, local: Option<&str>) -> Peek {
    let d = dir.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(if d.is_dir() { release(&d) } else { Err(format!("置き場が見つかりません（{}）", d.display())) });
    });
    match rx.recv_timeout(REACH) {
        Err(_) => Peek::Skip(format!("置き場が {} 秒で答えませんでした", REACH.as_secs())),
        Ok(Err(why)) => Peek::Skip(why),
        Ok(Ok(None)) => Peek::Skip("配る版がまだ選ばれていません".into()),
        Ok(Ok(Some(rel))) => match rel["version"].as_str() {
            Some(v) if !safe_version(v) => Peek::Skip(format!("配る版の番号が使えません: {v}")),
            Some(v) if Some(v) == local => Peek::Same,
            Some(v) => Peek::Differs(v.to_string()),
            None => Peek::Skip("release.json に版がありません".into()),
        },
    }
}

fn stage_dir(app: &Path, version: &str) -> PathBuf {
    app.join(".update").join(format!("{version}.stage"))
}

/// 写して確かめ終えた次の版（無ければ None。試験で写し終えたかを見る）
#[cfg(test)]
pub fn staged(app: &Path) -> Option<String> {
    std::fs::read_dir(app.join(".update"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".stage").map(str::to_string))
        .find(|v| safe_version(v) && stage_dir(app, v).join(STAGE_READY).is_file())
}

/// 置き場の版を、この PC の .update\<版>.stage へ写し、大きさと sha256 を目録と比べる（違えば止める。入れ替えはしない）
pub fn stage(app: &Path, dir: &Path, version: &str, progress: &Progress) -> Result<(), String> {
    if !safe_version(version) {
        return Err(format!("版の番号が使えません: {version}"));
    }
    let src = dir.join(VERSIONS).join(version);
    let m: Value = serde_json::from_slice(&std::fs::read(src.join(MANIFEST)).map_err(|e| format!("目録を読めません（{e}）"))?)
        .map_err(|e| format!("目録を読めません（{e}）"))?;
    let files = m["files"].as_array().cloned().unwrap_or_default();
    let units: Vec<String> = m["payload"].as_array().into_iter().flatten().filter_map(|u| u.as_str().map(str::to_string)).collect();
    if units.is_empty()
        || units.iter().any(|u| {
            unit_of(u) != *u || !accepted_path(&format!("{u}/x").replace(&format!("{EXE}/x"), EXE).replace("README.md/x", "README.md"))
        })
    {
        return Err("目録の中身の一覧がおかしいので、入れ替えません".into());
    }
    let dst = stage_dir(app, version);
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::create_dir_all(&dst).map_err(|e| format!("写す場所を作れません（{e}）"))?;
    let total = files.len();
    progress.set(json!({"state": "running", "stage": "stage", "version": version, "done": 0, "total": total, "startedAt": now_text()}));
    let copy = || -> Result<(), String> {
        for (i, f) in files.iter().enumerate() {
            let rel = f["path"].as_str().unwrap_or("");
            if !accepted_path(rel) || !units.contains(&unit_of(rel)) {
                return Err(format!("目録に配らないはずのファイルがあります: {rel}"));
            }
            let data = std::fs::read(src.join(rel)).map_err(|e| format!("{rel} を写せません（{e}）"))?;
            if data.len() as u64 != f["size"].as_u64().unwrap_or(u64::MAX) || sha256_hex(&data) != f["sha256"].as_str().unwrap_or("") {
                return Err(format!("{rel} が目録と違います（置き場の同期の途中かもしれません）"));
            }
            let path = dst.join(rel);
            std::fs::create_dir_all(path.parent().unwrap_or(&dst)).map_err(|e| e.to_string())?;
            std::fs::write(&path, &data).map_err(|e| format!("{rel} を書けません（{e}）"))?;
            progress.tick(json!({"done": i + 1}));
        }
        std::fs::write(dst.join(MANIFEST), serde_json::to_vec(&m).unwrap_or_default()).map_err(|e| e.to_string())?;
        std::fs::write(dst.join(STAGE_READY), version).map_err(|e| e.to_string())
    };
    let result = copy();
    match &result {
        Ok(()) => progress.tick(json!({"state": "done", "endedAt": now_text()})),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dst);
            progress.tick(json!({"state": "failed", "error": e, "endedAt": now_text()}));
        }
    }
    result
}

/// 名前を変える（ほかのアプリが一時的に開いている: ウイルス対策・エクスプローラーのプレビューなら、少し待って試し直す）
fn rename_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    let start = std::time::Instant::now();
    loop {
        match std::fs::rename(from, to) {
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) && start.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(150))
            }
            r => return r,
        }
    }
}

/// 写し終えた版へ入れ替える（単位ごとに、今のものを .old へ移して新しいものを置く。途中で失敗したら全て戻す）。
/// 答えは exe が変わったか（変わったら開き直す）
pub fn swap(app: &Path, version: &str, have: &str) -> Result<bool, String> {
    let stage = stage_dir(app, version);
    if !stage.join(STAGE_READY).is_file() {
        return Err(format!("版 {version} はまだ写し終えていません"));
    }
    let m: Value = serde_json::from_slice(&std::fs::read(stage.join(MANIFEST)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut units: Vec<String> = m["payload"].as_array().into_iter().flatten().filter_map(|u| u.as_str().map(str::to_string)).collect();
    // 今の版にだけある単位（program の直下の古いフォルダなど）も .old へ移す（設定は残す）
    for e in std::fs::read_dir(app.join("program")).into_iter().flatten().flatten() {
        let unit = format!("program/{}", e.file_name().to_string_lossy());
        if unit != "program/config" && unit != "program/__pycache__" && !units.contains(&unit) {
            units.push(unit);
        }
    }
    let old = app.join(".update").join(format!("{}.old", if safe_version(have) { have } else { "unknown" }));
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(old.join("program")).map_err(|e| format!("入れ替えの準備ができません（{e}）"))?;
    let exe_before = std::fs::read(app.join(EXE)).ok().map(|b| sha256_hex(&b));
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new(); // 戻すための記録（移した先 → 元）
    let undo = |done: &mut Vec<(PathBuf, PathBuf)>| {
        while let Some((to, from)) = done.pop() {
            let _ = std::fs::rename(&to, &from);
        }
    };
    for unit in &units {
        let (cur, new, keep) = (app.join(unit), stage.join(unit), old.join(unit));
        if cur.exists() {
            if let Err(e) = rename_patiently(&cur, &keep) {
                undo(&mut done);
                return Err(format!("{unit} を入れ替えられません（{e}）。開いているファイルを閉じてから、もう一度開いてください。"));
            }
            done.push((keep, cur.clone()));
        }
        if new.exists() {
            if let Err(e) = rename_patiently(&new, &cur) {
                undo(&mut done);
                return Err(format!("{unit} を置けません（{e}）"));
            }
            done.push((cur.clone(), new));
        }
    }
    let _ = std::fs::remove_dir_all(&stage);
    // 古い .old は最後の 1 つだけ残す（動いていた exe が入っていれば消せないので、次の起動で消える）
    for e in std::fs::read_dir(app.join(".update")).into_iter().flatten().flatten() {
        if e.path() != old && e.file_name().to_string_lossy().ends_with(".old") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    let exe_after = std::fs::read(app.join(EXE)).ok().map(|b| sha256_hex(&b));
    Ok(exe_before != exe_after)
}

/// 開発の木（.git か desktop/Cargo.toml がある）では、そろえない（INVENTOR_TOOL_UPDATE_FORCE で試せる）
pub fn is_dev_tree(app: &Path) -> bool {
    std::env::var_os("INVENTOR_TOOL_UPDATE_FORCE").is_none()
        && (app.join(".git").exists() || app.join("desktop").join("Cargo.toml").is_file())
}

/// 置き場から入れる（新しい PC）: 置き場の入口 exe か（同じフォルダに versions があり、配る版が決まっている。古い形の最上位の release.json も）
pub fn is_share_entry(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    let released = dir.join(VERSIONS).join(RELEASE).is_file() || dir.join(RELEASE).is_file();
    (exe.file_name()? == EXE && dir.join(VERSIONS).is_dir() && released).then(|| dir.to_path_buf())
}

/// 配る版へそろえる（写して確かめ、入れ替える）。新しい PC（program がまだ無い）にも使う。
/// 置き場を設定に書くのは、既定の置き場と違うとき（入口の exe を押した置き場を覚える）。答えは exe が変わったか
pub fn bring(app: &Path, dir: &Path, version: &str, progress: &Progress) -> Result<bool, String> {
    std::fs::create_dir_all(app.join("program")).map_err(|e| format!("{} を作れません（{e}）", app.display()))?;
    let have = local_version(&app.join("program")).unwrap_or_else(|| "none".into());
    stage(app, dir, version, progress)?;
    progress.tick(json!({"stage": "swap"}));
    let changed = swap(app, version, &have)?;
    // 版が変わった（新しい PC へ入れたときは除く）: 「変わったこと」を、次に開いた画面で 1 度だけ見せる
    let notes = notes_of(dir, version);
    if have != "none" && have != version && !notes.is_empty() {
        let news = json!({"version": version, "from": have, "notes": notes});
        let _ = write_atomic(&app.join(".update").join(NEWS), &serde_json::to_vec_pretty(&news).unwrap_or_default());
    }
    let program = app.join("program");
    if share_dir(&program).0 != dir {
        crate::settings::save(&program, &json!({"update": {"dir": dir}}))?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn temp(label: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "inv-update-{}-{label}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// GitHub の「Download ZIP」と同じ形の ZIP（"Inventor-main/" の下）
    pub fn make_zip(path: &Path, version: &str, extra: &[(&str, &str)]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut files: Vec<(String, String)> = vec![
            (EXE.into(), format!("exe {version}")),
            (VERSION_FILE.into(), format!("{{\"version\": \"{version}\"}}")),
            ("program/app/index.html".into(), "<html>".into()),
            ("program/Inventor3DTool.build.json".into(), "{\"commit\": \"abc123\"}".into()),
            ("program/config/appsettings.json".into(), "{}".into()),
            ("program/app/__pycache__/x.pyc".into(), "pyc".into()),
            ("desktop/Cargo.toml".into(), "[package]".into()),
            ("docs/a.md".into(), "doc".into()),
            ("README.md".into(), "readme".into()),
            ("program/samples/ipt/a.ipt".into(), "sample".into()),
            ("program/tests/test_a.py".into(), "test".into()),
            ("program/tools/ui-check.mjs".into(), "tool".into()),
        ];
        files.extend(extra.iter().map(|(a, b)| (a.to_string(), b.to_string())));
        for (name, body) in files {
            z.start_file(format!("Inventor-main/{name}"), opt).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn version_rules() {
        assert!(
            safe_version("2.1.0")
                && safe_version("2.1.0-ci")
                && !safe_version("")
                && !safe_version("a1")
                && !safe_version("1/2")
                && !safe_version("1..\\x")
        );
        assert!(version_key("2.10.0") > version_key("2.9.0"));
        assert!(
            payload_path(EXE)
                && payload_path("program/app/index.html")
                && payload_path("README.md")
                && payload_path("program/version.json")
        );
        for bad in [
            "program/config/appsettings.json",
            "desktop/Cargo.toml",
            "program/../x",
            "program/app/__pycache__/b.pyc",
            "/program/x",
            "program/C:/x",
            "docs/a.md",
            "program/samples/ipt/a.ipt",
            "program/tests/test_layout.py",
            "program/tools/ui-check.mjs",
            "program/appendix/x",
        ] {
            assert!(!payload_path(bad), "{bad}");
        }
        // 写すときは広く受け入れる（2.4.0 までに置いた版はサンプルなども含む。古い版へ戻せるように）。設定と上へ出る道は断る
        assert!(accepted_path("program/samples/ipt/a.ipt") && accepted_path("program/tools/x.mjs") && accepted_path(EXE));
        for bad in ["program/config/appsettings.json", "program/../x", "docs/a.md", "program/a/__pycache__/b.pyc"] {
            assert!(!accepted_path(bad), "{bad}");
        }
        assert_eq!((unit_of("program/app/js/a.js"), unit_of(EXE)), ("program/app".into(), EXE.into()));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20734), (2026, 10, 8));
    }

    #[test]
    fn publish_release_delete_and_prune() {
        let share = temp("share");
        let zips = temp("zips");
        std::fs::create_dir_all(share.join(VERSIONS)).unwrap();
        let p = Progress::default();
        for v in ["2.1.0", "2.2.0", "2.10.0"] {
            make_zip(&zips.join(format!("{v}.zip")), v, &[]);
            let r = publish_zip(&share, &zips.join(format!("{v}.zip")), "me@pc", &p, 0).unwrap();
            assert_eq!(r["version"], v);
        }
        assert_eq!(p.get()["state"], "done");
        // 配るファイルだけ（設定・.pyc・desktop・docs は入らない）。目録の sha256 は中身と一致
        let d = share.join(VERSIONS).join("2.1.0");
        assert!(
            d.join(EXE).is_file() && d.join("README.md").is_file() && !d.join("program/config").exists() && !d.join("desktop").exists()
        );
        assert!(!d.join("program/app/__pycache__").exists());
        for gone in ["program/samples", "program/tests", "program/tools"] {
            assert!(!d.join(gone).exists(), "サンプル・試験・道具は配らない: {gone}");
        }
        let m: Value = serde_json::from_slice(&std::fs::read(d.join(MANIFEST)).unwrap()).unwrap();
        for f in m["files"].as_array().unwrap() {
            assert_eq!(f["sha256"].as_str().unwrap(), sha256_hex(&std::fs::read(d.join(f["path"].as_str().unwrap())).unwrap()));
        }
        assert_eq!(m["commit"], "abc123");
        assert_eq!(
            versions(&share).iter().map(|v| v["version"].as_str().unwrap().to_string()).collect::<Vec<_>>(),
            ["2.10.0", "2.2.0", "2.1.0"]
        );

        // 同じ版・ZIP でない物・アプリでない ZIP は断り、途中の物を残さない
        assert!(publish_zip(&share, &zips.join("2.1.0.zip"), "me", &p, 0).unwrap_err().contains("もう置いてあります"));
        std::fs::write(zips.join("bad.zip"), "not a zip").unwrap();
        assert!(publish_zip(&share, &zips.join("bad.zip"), "me", &p, 0).unwrap_err().contains("ZIP ファイルとして読めません"));
        assert_eq!(p.get()["state"], "failed");
        assert!(std::fs::read_dir(share.join(VERSIONS)).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));

        // 配る・前に配った版・入口の exe
        assert!(set_release(&share, "9.9.9", "me").unwrap_err().contains("置き場にありません"));
        set_release(&share, "2.2.0", "me").unwrap();
        let r = set_release(&share, "2.10.0", "me").unwrap();
        assert_eq!((r["release"]["version"].as_str(), r["release"]["previous"].as_str()), (Some("2.10.0"), Some("2.2.0")));
        assert_eq!(std::fs::read_to_string(share.join(EXE)).unwrap(), "exe 2.10.0");

        // 配っている版は消せない。ほかは消せる
        assert!(delete_version(&share, "2.10.0").unwrap_err().contains("配っている版"));
        delete_version(&share, "2.1.0").unwrap();
        assert!(!share.join(VERSIONS).join("2.1.0").exists());
        // 残す数: 新しい順に 1 つ。ただし配っている版と前に配った版は残す
        make_zip(&zips.join("1.0.0.zip"), "1.0.0", &[]);
        let r = publish_zip(&share, &zips.join("1.0.0.zip"), "me", &p, 1).unwrap();
        assert_eq!(r["pruned"], json!(["1.0.0"]));
        assert_eq!(versions(&share).len(), 2);
        std::fs::remove_dir_all(&share).ok();
        std::fs::remove_dir_all(&zips).ok();
    }

    #[test]
    fn peek_stage_swap_keeps_settings_and_rolls_back() {
        let share = temp("share2");
        let zips = temp("zips2");
        let app = temp("app");
        std::fs::create_dir_all(share.join(VERSIONS)).unwrap();
        make_zip(&zips.join("a.zip"), "2.1.0", &[("program/app/new.js", "new")]);
        publish_zip(&share, &zips.join("a.zip"), "me", &Progress::default(), 0).unwrap();

        // 今の PC: 2.0.0（設定と、新しい版には無いフォルダ）
        std::fs::create_dir_all(app.join("program/app")).unwrap();
        std::fs::create_dir_all(app.join("program/config")).unwrap();
        std::fs::create_dir_all(app.join("program/retired")).unwrap();
        std::fs::write(app.join(EXE), "exe 2.0.0").unwrap();
        std::fs::write(app.join("program/version.json"), r#"{"version": "2.0.0"}"#).unwrap();
        std::fs::write(app.join("program/config/appsettings.json"), r#"{"build": {"output_dir": "D:\\CAD"}}"#).unwrap();

        assert_eq!(peek(&share, Some("2.0.0")), Peek::Skip("配る版がまだ選ばれていません".into()));
        set_release(&share, "2.1.0", "me").unwrap();
        assert_eq!(peek(&share, Some("2.0.0")), Peek::Differs("2.1.0".into()));
        assert_eq!(peek(&share, Some("2.1.0")), Peek::Same);
        assert!(matches!(peek(&share.join("nope"), None), Peek::Skip(w) if w.contains("見つかりません")));

        // 置き場のファイルが目録と違えば（同期の途中）、写すのをやめ、何も残さない
        std::fs::write(share.join(VERSIONS).join("2.1.0").join("program/app/new.js"), "changed").unwrap();
        assert!(stage(&app, &share, "2.1.0", &Progress::default()).unwrap_err().contains("目録と違います"));
        assert_eq!(staged(&app), None);
        std::fs::write(share.join(VERSIONS).join("2.1.0").join("program/app/new.js"), "new").unwrap();
        stage(&app, &share, "2.1.0", &Progress::default()).unwrap();
        assert_eq!(staged(&app), Some("2.1.0".into()));

        assert!(swap(&app, "2.1.0", "2.0.0").unwrap(), "exe が変わった");
        assert_eq!(local_version(&app.join("program")), Some("2.1.0".into()));
        assert_eq!(std::fs::read_to_string(app.join("program/app/new.js")).unwrap(), "new");
        assert!(std::fs::read_to_string(app.join("program/config/appsettings.json")).unwrap().contains("D:"), "設定は残す");
        assert!(!app.join("program/retired").exists() && app.join(".update/2.0.0.old/program/retired").exists(), "古いものは .old へ");
        assert_eq!(staged(&app), None);
        std::fs::remove_dir_all(&share).ok();
        std::fs::remove_dir_all(&zips).ok();
        std::fs::remove_dir_all(&app).ok();
    }

    #[test]
    fn swap_rolls_back_when_a_unit_cannot_move() {
        // exe は入れ替えられるが、program/zzz は置く先（program フォルダ）が無いので置けない → exe も元に戻す
        let app = temp("rollback");
        let stage = stage_dir(&app, "2.1.0");
        std::fs::create_dir_all(stage.join("program/zzz")).unwrap();
        std::fs::write(stage.join(EXE), "new exe").unwrap();
        std::fs::write(stage.join(MANIFEST), json!({"payload": [EXE, "program/zzz"]}).to_string()).unwrap();
        std::fs::write(stage.join(STAGE_READY), "2.1.0").unwrap();
        std::fs::write(app.join(EXE), "old exe").unwrap();
        let err = swap(&app, "2.1.0", "2.0.0").unwrap_err();
        assert!(err.contains("program/zzz"), "{err}");
        assert_eq!(std::fs::read_to_string(app.join(EXE)).unwrap(), "old exe", "入れ替えた分を戻す");
        assert_eq!(std::fs::read_to_string(stage.join(EXE)).unwrap(), "new exe", "写した物も元の場所へ");
        std::fs::remove_dir_all(&app).ok();
    }

    #[test]
    fn reads_zips_with_backslash_names_and_a_bom() {
        let share = temp("share-bs");
        let zips = temp("zips-bs");
        std::fs::create_dir_all(share.join(VERSIONS)).unwrap();
        let mut z = zip::ZipWriter::new(std::fs::File::create(zips.join("w.zip")).unwrap());
        let opt = zip::write::SimpleFileOptions::default();
        for (name, body) in [(EXE, "exe"), (VERSION_FILE, "\u{feff}{\"version\": \"3.0.0\"}"), ("program/app/index.html", "<html>")] {
            z.start_file(format!("pkg\\{}", name.replace('/', "\\")), opt).unwrap();
            std::io::Write::write_all(&mut z, body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
        let r = publish_zip(&share, &zips.join("w.zip"), "me", &Progress::default(), 0).unwrap();
        assert_eq!((r["version"].as_str(), r["files"].as_u64()), (Some("3.0.0"), Some(3)));
        assert!(share.join(VERSIONS).join("3.0.0").join("program/app/index.html").is_file());
        std::fs::remove_dir_all(&share).ok();
        std::fs::remove_dir_all(&zips).ok();
    }

    #[test]
    fn roles_guard_the_management() {
        let share = temp("roles");
        assert_eq!(role_of(&share, "sato"), "unset");
        assert!(set_roles(&share, "sato", &json!({"developers": ["tanaka"]})).unwrap_err().contains("自分を開発者に"));
        set_roles(&share, "sato", &json!({"developers": ["sato"]})).unwrap();
        assert_eq!((role_of(&share, "SATO"), role_of(&share, "tanaka")), ("developer", "user"), "名前の大文字・小文字は区別しない");
        set_roles(&share, "sato", &json!({"developers": ["sato", " "], "maintainers": ["tanaka", "Tanaka"]})).unwrap();
        assert_eq!(role_of(&share, "tanaka"), "maintainer");
        assert_eq!(roles(&share)["maintainers"], json!(["tanaka"]), "空と重なりは除く");
        assert!(set_roles(&share, "tanaka", &json!({"developers": ["tanaka"]})).unwrap_err().contains("開発者だけ"));
        assert!(set_roles(&share, "sato", &json!({"developers": []})).unwrap_err().contains("1 人は残して"));
        assert!(can_manage("developer") && can_manage("maintainer") && !can_manage("user") && !can_manage("unset"));
        std::fs::remove_dir_all(&share).ok();
    }

    #[test]
    fn notes_are_written_per_version_and_shown_once_after_an_update() {
        let share = temp("share4");
        let zips = temp("zips4");
        let app = temp("home4").join("Inventor3DTool");
        std::fs::create_dir_all(share.join(VERSIONS)).unwrap();
        for v in ["2.1.0", "2.2.0"] {
            make_zip(&zips.join(format!("{v}.zip")), v, &[]);
            publish_zip(&share, &zips.join(format!("{v}.zip")), "me", &Progress::default(), 0).unwrap();
        }
        // 書く・一覧に出る・空で消す・長すぎる・無い版
        set_notes(&share, "2.2.0", "  ・SXF を開ける\r\n・設定の画面  ").unwrap();
        assert_eq!(notes_of(&share, "2.2.0"), "・SXF を開ける\n・設定の画面");
        assert_eq!(versions(&share)[0]["notes"], "・SXF を開ける\n・設定の画面");
        assert!(set_notes(&share, "2.2.0", &"あ".repeat(NOTES_MAX + 1)).unwrap_err().contains("字まで"));
        assert!(set_notes(&share, "9.9.9", "x").unwrap_err().contains("ありません"));
        // 新しい PC へ入れたときは見せない
        set_release(&share, "2.1.0", "me").unwrap();
        set_notes(&share, "2.1.0", "最初の版").unwrap();
        bring(&app, &share, "2.1.0", &Progress::default()).unwrap();
        assert!(news(&app).is_none());
        // 版が変わったら 1 度だけ見せる（見たら消える）
        set_release(&share, "2.2.0", "me").unwrap();
        bring(&app, &share, "2.2.0", &Progress::default()).unwrap();
        let n = news(&app).unwrap();
        assert_eq!((n["version"].as_str(), n["from"].as_str()), (Some("2.2.0"), Some("2.1.0")));
        seen_news(&app).unwrap();
        assert!(news(&app).is_none() && seen_news(&app).is_ok(), "2 度目の「見た」も失敗にしない");
        // 変わったことの無い版へは何も見せない
        set_notes(&share, "2.1.0", "").unwrap();
        assert!(!share.join(VERSIONS).join("2.1.0").join(NOTES).exists());
        set_release(&share, "2.1.0", "me").unwrap();
        bring(&app, &share, "2.1.0", &Progress::default()).unwrap();
        assert!(news(&app).is_none());
        for d in [&share, &zips] {
            std::fs::remove_dir_all(d).ok();
        }
        std::fs::remove_dir_all(app.parent().unwrap()).ok();
    }

    #[test]
    fn bring_installs_a_new_pc_and_remembers_the_share() {
        let share = temp("share3");
        let zips = temp("zips3");
        let app = temp("home").join("Inventor3DTool");
        std::fs::create_dir_all(share.join(VERSIONS)).unwrap();
        make_zip(&zips.join("a.zip"), "2.1.0", &[]);
        publish_zip(&share, &zips.join("a.zip"), "me", &Progress::default(), 0).unwrap();
        set_release(&share, "2.1.0", "me").unwrap();
        let p = Progress::default();
        assert!(bring(&app, &share, "2.1.0", &p).unwrap());
        assert_eq!(local_version(&app.join("program")), Some("2.1.0".into()));
        assert_eq!(share_dir(&app.join("program")), (share.clone(), "settings"), "入口の置き場を覚える");
        assert_eq!(p.get()["stage"], "swap");
        assert!(is_share_entry(&share.join(EXE)).is_some() && is_share_entry(&app.join(EXE)).is_none());
        std::fs::remove_dir_all(&share).ok();
        std::fs::remove_dir_all(&zips).ok();
        std::fs::remove_dir_all(app.parent().unwrap()).ok();
    }

    #[test]
    fn the_share_keeps_only_the_entry_and_versions_on_top_and_reads_the_old_layout() {
        let share = temp("layout");
        let zips = temp("layout-zips");
        make_zip(&zips.join("a.zip"), "2.5.0", &[]);
        // 新しい置き場: 管理のファイルは全て versions の中。最上位は入口の exe と versions だけ
        set_roles(&share, "sato", &json!({"developers": ["sato"]})).unwrap();
        set_policy(&share, 3).unwrap();
        publish_zip(&share, &zips.join("a.zip"), "me", &Progress::default(), 0).unwrap();
        set_release(&share, "2.5.0", "me").unwrap();
        let mut top: Vec<String> =
            std::fs::read_dir(&share).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        top.sort();
        assert_eq!(top, [EXE, VERSIONS]);
        assert!(META.iter().all(|n| share.join(VERSIONS).join(n).is_file()));
        assert!(legacy(&share).is_empty() && is_share_entry(&share.join(EXE)).is_some());
        assert_eq!((role_of(&share, "sato"), policy(&share)["keep"].as_u64()), ("developer", Some(3)));

        // 古い形（2.4.0 まで: 最上位の release.json・roles.json・policy.json）も読み、片付けるまでは最上位にも同じ物を書く
        let old = temp("layout-old");
        std::fs::create_dir_all(old.join(VERSIONS)).unwrap();
        publish_zip(&old, &zips.join("a.zip"), "me", &Progress::default(), 0).unwrap();
        std::fs::write(old.join(RELEASE), r#"{"version": "2.5.0"}"#).unwrap();
        std::fs::write(old.join(ROLES), r#"{"developers": ["tanaka"], "maintainers": []}"#).unwrap();
        std::fs::write(old.join(POLICY), r#"{"keep": 2}"#).unwrap();
        std::fs::write(old.join(EXE), "exe").unwrap();
        assert_eq!(peek(&old, Some("2.4.0")), Peek::Differs("2.5.0".into()));
        assert_eq!((role_of(&old, "tanaka"), policy(&old)["keep"].as_u64()), ("developer", Some(2)));
        assert!(is_share_entry(&old.join(EXE)).is_some());
        assert_eq!(legacy(&old), [RELEASE, ROLES, POLICY]);
        set_release(&old, "2.5.0", "tanaka").unwrap();
        let top_release: Value = serde_json::from_slice(&std::fs::read(old.join(RELEASE)).unwrap()).unwrap();
        assert_eq!(top_release["setBy"], "tanaka", "2.4.0 までの PC が読む最上位にも書く");
        assert!(old.join(VERSIONS).join(RELEASE).is_file());
        // 片付ける: 最上位から versions の中へ（中に有る物は中を残す）。その後は最上位へ書かない
        assert_eq!(tidy(&old).unwrap()["tidied"], json!([ROLES, POLICY, RELEASE]));
        assert!(legacy(&old).is_empty());
        assert_eq!((role_of(&old, "tanaka"), policy(&old)["keep"].as_u64()), ("developer", Some(2)));
        set_policy(&old, 4).unwrap();
        assert!(!old.join(POLICY).exists());
        assert_eq!(peek(&old, Some("2.5.0")), Peek::Same);
        assert_eq!(tidy(&old).unwrap()["tidied"], json!([]));
        for d in [&share, &zips, &old] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn pack_makes_a_small_zip_that_can_be_published() {
        // リポジトリの形: exe・README・program（配る物と配らない物）・docs・desktop
        let repo = temp("repo");
        let files = [
            (EXE, "exe"),
            ("README.md", "readme"),
            (VERSION_FILE, r#"{"version": "2.5.0"}"#),
            ("program/Inventor3DTool.build.json", r#"{"commit": "fromexe"}"#),
            ("program/app/index.html", "<html>"),
            ("program/app/static/js/main.js", "js"),
            ("program/ipt_build/__main__.py", "py"),
            ("program/ipt_build/__pycache__/x.pyc", "pyc"),
            ("program/samples/ipt/a.ipt", "sample"),
            ("program/tests/test_a.py", "test"),
            ("program/tools/ui-check.mjs", "tool"),
            ("program/config/appsettings.json", "{}"),
            ("docs/a.md", "doc"),
            ("desktop/Cargo.toml", "[package]"),
        ];
        for (rel, body) in files {
            let path = repo.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let out = temp("pack-out").join("Inventor3DTool-2.5.0.zip");
        let r = pack(&repo, &out, "abc999").unwrap();
        assert_eq!((r["version"].as_str(), r["files"].as_u64()), (Some("2.5.0"), Some(7)));
        let z = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut names: Vec<String> = z.file_names().map(str::to_string).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "Inventor3DTool-2.5.0/Inventor3DTool.exe",
                "Inventor3DTool-2.5.0/README.md",
                "Inventor3DTool-2.5.0/program/Inventor3DTool.build.json",
                "Inventor3DTool-2.5.0/program/app/index.html",
                "Inventor3DTool-2.5.0/program/app/static/js/main.js",
                "Inventor3DTool-2.5.0/program/ipt_build/__main__.py",
                "Inventor3DTool-2.5.0/program/version.json",
            ]
        );
        assert_eq!(z.comment(), b"abc999");
        drop(z);
        // 置き場へ置ける（中身のコミットは注記）
        let share = temp("pack-share");
        publish_zip(&share, &out, "me", &Progress::default(), 0).unwrap();
        let m: Value = serde_json::from_slice(&std::fs::read(share.join(VERSIONS).join("2.5.0").join(MANIFEST)).unwrap()).unwrap();
        assert_eq!((m["files"].as_array().unwrap().len(), m["commit"].as_str()), (7, Some("abc999")));
        // 欠かせない物が無ければ作らない
        std::fs::remove_file(repo.join("program/app/index.html")).unwrap();
        assert!(pack(&repo, &out, "").unwrap_err().contains("program/app/index.html"));
        for d in [&repo, &share, &out.parent().unwrap().to_path_buf()] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    /// このリポジトリの配る中身が最小か（サンプル・試験・道具を含まず、exe を除いて BUDGET 以下）。大きさは出力に出す
    #[test]
    fn the_repository_payload_is_small() {
        const BUDGET: u64 = 4 * 1024 * 1024;
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let (mut all, mut payload, mut count) = (0u64, 0u64, 0usize);
        let mut walk = vec![String::from("program")];
        while let Some(rel) = walk.pop() {
            for e in std::fs::read_dir(repo.join(&rel)).unwrap().flatten() {
                let child = format!("{rel}/{}", e.file_name().to_string_lossy());
                if e.path().is_dir() {
                    walk.push(child);
                    continue;
                }
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                all += size;
                if payload_path(&child) {
                    payload += size;
                    count += 1;
                    assert!(!child.starts_with("program/samples/") && !child.starts_with("program/tests/"), "{child}");
                }
            }
        }
        println!("配る program: {count} ファイル・{:.1} MB（program 全体 {:.1} MB）", payload as f64 / 1048576.0, all as f64 / 1048576.0);
        assert!(payload > 0 && payload <= BUDGET, "配る中身 {payload} バイト（基準 {BUDGET}）");
    }
}
