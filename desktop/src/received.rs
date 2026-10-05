//! 起動で受け取ったファイル（exe へのドロップ・「プログラムから開く」・2 つめの起動から回ってきたもの）を画面へ渡す。
//!
//!   1. 窓が、起動の引数（と、2 つめの起動の引数）のパスを預かる（push）
//!   2. 画面が POST /api/launch で、預かったものをまとめて受け取る（claim。受け取ったら空になる）
//!      2 つめの起動から回ってきたときは、窓が画面へ `inventor:launch` を知らせ、画面が受け取りに来る
//!   3. 画面へは番号だけを渡し、中身は GET /api/files/<番号> で読む（渡したものだけを読めるようにする）
//!
//! 組立（.iam）を受け取ったら、同じフォルダの部品（.ipt）も添える（組立が参照する部品を、画面がファイル名で探す置き場）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Received {
    pending: Mutex<Vec<PathBuf>>,
    given: Mutex<HashMap<String, PathBuf>>,
}

impl Received {
    /// 預かる。→ 預かった数
    pub fn push(&self, paths: Vec<PathBuf>) -> usize {
        let n = paths.len();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
        n
    }

    /// 預かったものをまとめて渡す: {files: ドロップされたもの, parts: 組立と同じフォルダの部品, missing: 見つからなくなった名前}
    pub fn claim(&self) -> Value {
        let taken = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        let mut paths: Vec<PathBuf> = Vec::new();
        for p in taken {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
        let (mut files, mut parts, mut missing) = (Vec::new(), Vec::<PathBuf>::new(), Vec::new());
        for path in &paths {
            if path.is_dir() {
                continue; // フォルダは開かない
            }
            if !path.is_file() {
                missing.push(name_of(path)); // 起動してから画面が受け取るまでに、消された・移された
                continue;
            }
            files.push(self.entry(path));
            if has_ext(path, "iam") {
                for part in companions(path) {
                    if !paths.contains(&part) && !parts.contains(&part) {
                        parts.push(part);
                    }
                }
            }
        }
        let parts: Vec<Value> = parts.iter().map(|p| self.entry(p)).collect();
        json!({"files": files, "parts": parts, "missing": missing})
    }

    /// 渡した番号のファイル（渡していない番号は None）
    pub fn path(&self, key: &str) -> Option<PathBuf> {
        self.given.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
    }

    fn entry(&self, path: &Path) -> Value {
        let key = random_hex(8);
        self.given.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), path.to_path_buf());
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        json!({"name": name_of(path), "size": size, "url": format!("/api/files/{key}")})
    }
}

/// 起動の引数をパスにする（相対パスは起動したフォルダから見る）。exe 自身（先頭）は呼ぶ側が除く。
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter().filter(|a| !a.is_empty()).map(|a| cwd.join(a)).collect()
}

/// 組立（.iam）と同じフォルダの部品（.ipt）。名前順。
fn companions(assembly: &Path) -> Vec<PathBuf> {
    let Some(dir) = assembly.parent() else { return Vec::new() };
    let mut parts: Vec<PathBuf> =
        std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| has_ext(p, "ipt") && p.is_file()).collect();
    parts.sort();
    parts
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// 推し量れない番号（OS の乱数）。合言葉にも使う。
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS の乱数を読めません");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_over_once_with_the_parts_next_to_an_assembly() {
        let dir = std::env::temp_dir().join(format!("inv-received-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for name in ["a.iam", "b.ipt", "c.IPT", "note.txt", "x.stp"] {
            std::fs::write(dir.join(name), name).unwrap();
        }
        let r = Received::default();
        let args = vec!["a.iam".to_string(), "b.ipt".into(), "gone.ipt".into(), "sub".into(), "a.iam".into(), "".into()];
        assert_eq!(r.push(paths_from_args(args, &dir)), 5);
        let got = r.claim();
        let names = |k: &str| got[k].as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names("files"), ["a.iam", "b.ipt"], "同じものは 1 つ・フォルダは開かない");
        assert_eq!(names("parts"), ["c.IPT"], "組立と同じフォルダの部品（受け取ったものは重ねない・大文字の拡張子も）");
        assert_eq!(got["missing"], json!(["gone.ipt"]), "起動してから消えたもの");
        let url = got["files"][0]["url"].as_str().unwrap();
        assert_eq!(got["files"][0]["size"], 5);
        let key = url.strip_prefix("/api/files/").unwrap();
        assert_eq!(r.path(key), Some(dir.join("a.iam")), "渡した番号で読める");
        assert_eq!(r.path("0123456789abcdef"), None, "渡していない番号は読めない");
        assert_eq!(r.claim(), json!({"files": [], "parts": [], "missing": []}), "受け取ったら空");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keys_are_not_guessable() {
        let a = random_hex(8);
        assert_eq!(a.len(), 16);
        assert_ne!(a, random_hex(8));
    }
}
