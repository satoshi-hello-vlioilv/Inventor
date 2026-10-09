//! アプリのショートカット（デスクトップ・スタートメニュー）: 置き場ごとに、有るか・この exe を指すかを調べ、作る（作り直す）。
//! 配り方は ZIP を展開するだけなのでインストーラーが無い。ショートカットを消した・フォルダを移したときに、
//! 画面からいつでも作り直せるようにする（docs/desktop.md）。
//!
//! 状態: "ok"（この exe を指す）・"missing"（無い）・"other"（有るが、ほかの exe を指す: フォルダを移した・別の版）。
//! 作ると、同じ名前のショートカットを上書きする（"other" も、この exe を指すように直る）。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// ショートカットの中身（読むのは Windows の書き手だけ）
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Link<'a> {
    pub target: &'a Path,
    pub working_dir: &'a Path,
    pub description: &'a str,
}

/// 置き場（画面に出す順）
pub struct Place {
    pub key: &'static str,
    pub label: &'static str,
    /// 置くフォルダ（この PC で分からなければ None）
    pub dir: Option<PathBuf>,
}

pub struct Shortcuts {
    /// 指す exe（いま動いている窓）
    pub target: PathBuf,
    pub places: Vec<Place>,
    /// ショートカット → 指す先（読めなければ None）
    pub read: fn(&Path) -> Option<PathBuf>,
    pub write: fn(&Path, &Link) -> Result<(), String>,
    /// 起動のとき「デスクトップに作りますか」と尋ねてよいか（開発の木・自己診断では尋ねない）と、
    /// 「作らない」と答えた印のファイル（あれば尋ねない。設定の画面からはいつでも作れる）
    pub offer_allowed: bool,
    pub declined: Option<PathBuf>,
}

pub const DESCRIPTION: &str = "部品・組立・STEP・図面を見る／three.js の 3D を CAD にする";

impl Shortcuts {
    /// この PC の置き場と、本物の読み書き（Windows 以外は作れない）
    pub fn system(target: PathBuf, offer_allowed: bool) -> Shortcuts {
        Shortcuts {
            target,
            offer_allowed,
            declined: Some(crate::locate::local_root().join("shortcut_declined.json")),
            places: vec![
                Place { key: "desktop", label: "デスクトップ", dir: crate::system::desktop_dir() },
                Place { key: "start", label: "スタートメニュー", dir: crate::system::start_menu_dir() },
            ],
            read: read_link,
            write: write_link,
        }
    }

    fn file(&self, place: &Place) -> Option<PathBuf> {
        place.dir.as_ref().map(|d| d.join(format!("{}.lnk", crate::locate::APP_NAME)))
    }

    /// 置き場ごとの状態 { supported, places: [{ place, label, state, path }] }
    pub fn status(&self) -> Value {
        let places: Vec<Value> = self
            .places
            .iter()
            .filter_map(|p| {
                let file = self.file(p)?;
                let state = match file.is_file().then(|| (self.read)(&file)) {
                    None => "missing",
                    Some(Some(t)) if same_file(&t, &self.target) => "ok",
                    Some(_) => "other",
                };
                Some(json!({"place": p.key, "label": p.label, "state": state, "path": file}))
            })
            .collect();
        let supported = cfg!(windows) && !places.is_empty();
        let desktop_missing = places.iter().any(|p| p["place"] == "desktop" && p["state"] != "ok");
        let declined = self.declined.as_ref().is_some_and(|f| f.is_file());
        json!({"supported": supported, "places": places, "target": self.target, "offer": supported && self.offer_allowed && desktop_missing && !declined})
    }

    /// 「作らない」と答えた（次からは尋ねない）
    pub fn decline(&self) -> Result<Value, String> {
        if let Some(f) = &self.declined {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            std::fs::write(f, json!({"at": SystemTimeText::now()}).to_string()).map_err(|e| format!("答えを残せません（{e}）"))?;
        }
        Ok(self.status())
    }

    /// 置き場（key）にショートカットを作る（同じ名前は上書き）。答えは作った後の状態
    pub fn create(&self, key: &str) -> Result<Value, String> {
        let place = self.places.iter().find(|p| p.key == key).ok_or_else(|| format!("知らない置き場です: {key}"))?;
        let file = self.file(place).ok_or_else(|| format!("{}の場所が分かりません", place.label))?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}のフォルダを作れません（{e}）", place.label))?;
        }
        let working_dir = self.target.parent().unwrap_or(Path::new("."));
        (self.write)(&file, &Link { target: &self.target, working_dir, description: DESCRIPTION })?;
        Ok(self.status())
    }
}

/// 答えた時刻（秒）
struct SystemTimeText;
impl SystemTimeText {
    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }
}

/// 同じファイルか（Windows は大文字・小文字と区切りの違いを同じと見る）
fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('/', "\\");
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

#[cfg(windows)]
mod imp {
    use super::Link;
    use std::path::{Path, PathBuf};
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    /// この糸で COM を使えるようにする（すでに別の形で始めてあれば、それを使う）
    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
    }

    pub fn read(file: &Path) -> Option<PathBuf> {
        com();
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(file), STGM_READ).ok()?;
            let mut buf = [0u16; 32768];
            link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            (len > 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len])))
        }
    }

    pub fn write(file: &Path, l: &Link) -> Result<(), String> {
        com();
        let why = |what: &str, e: windows::core::Error| format!("ショートカットを作れません（{what}: {}）", e.message());
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| why("準備", e))?;
            link.SetPath(&HSTRING::from(l.target)).map_err(|e| why("指す先", e))?;
            link.SetWorkingDirectory(&HSTRING::from(l.working_dir)).map_err(|e| why("作業フォルダ", e))?;
            link.SetIconLocation(&HSTRING::from(l.target), 0).map_err(|e| why("アイコン", e))?;
            link.SetDescription(&HSTRING::from(l.description)).map_err(|e| why("説明", e))?;
            let persist: IPersistFile = link.cast().map_err(|e| why("保存の準備", e))?;
            persist.Save(&HSTRING::from(file), true).map_err(|e| why("保存", e))
        }
    }
}

#[cfg(windows)]
fn read_link(file: &Path) -> Option<PathBuf> {
    imp::read(file)
}

#[cfg(windows)]
fn write_link(file: &Path, link: &Link) -> Result<(), String> {
    imp::write(file, link)
}

#[cfg(not(windows))]
fn read_link(_file: &Path) -> Option<PathBuf> {
    None
}

#[cfg(not(windows))]
fn write_link(_file: &Path, _link: &Link) -> Result<(), String> {
    Err("ショートカットは Windows でだけ作れます".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 試験の読み書き: ショートカットの代わりに、指す先を 1 行書いたファイル
    fn fake_read(file: &Path) -> Option<PathBuf> {
        std::fs::read_to_string(file).ok().map(|s| PathBuf::from(s.lines().next().unwrap_or("")))
    }
    fn fake_write(file: &Path, l: &Link) -> Result<(), String> {
        std::fs::write(file, format!("{}\n{}\n{}", l.target.display(), l.working_dir.display(), l.description)).map_err(|e| e.to_string())
    }

    fn shortcuts(root: &Path) -> Shortcuts {
        Shortcuts {
            target: root.join("app").join("Inventor3DTool.exe"),
            places: vec![
                Place { key: "desktop", label: "デスクトップ", dir: Some(root.join("Desktop")) },
                Place { key: "start", label: "スタートメニュー", dir: Some(root.join("Start").join("Programs")) },
                Place { key: "none", label: "分からない場所", dir: None },
            ],
            read: fake_read,
            write: fake_write,
            offer_allowed: true,
            declined: Some(root.join("declined.json")),
        }
    }

    fn states(v: &Value) -> Vec<(String, String)> {
        v["places"].as_array().unwrap().iter().map(|p| (p["place"].as_str().unwrap().into(), p["state"].as_str().unwrap().into())).collect()
    }

    #[test]
    fn reports_missing_then_creates_and_repairs() {
        let root = std::env::temp_dir().join(format!("inv-shortcut-{}", std::process::id()));
        let s = shortcuts(&root);
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        // 場所の分からない置き場は出さない
        assert_eq!(states(&s.status()), vec![pair("desktop", "missing"), pair("start", "missing")]);

        // 作る（無いフォルダも作る）。名前はアプリの名前、作業フォルダは exe の場所
        let after = s.create("start").unwrap();
        assert_eq!(states(&after), vec![pair("desktop", "missing"), pair("start", "ok")]);
        let file = root.join("Start").join("Programs").join(format!("{}.lnk", crate::locate::APP_NAME));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains(&root.join("app").display().to_string()) && text.contains(DESCRIPTION), "{text}");

        // ほかの exe を指すもの（フォルダを移した）は "other"。作り直すと直る
        let desk = root.join("Desktop");
        std::fs::create_dir_all(&desk).unwrap();
        std::fs::write(desk.join(format!("{}.lnk", crate::locate::APP_NAME)), "D:\\old\\Inventor3DTool.exe").unwrap();
        assert_eq!(states(&s.status())[0], pair("desktop", "other"));
        assert_eq!(states(&s.create("desktop").unwrap())[0], pair("desktop", "ok"));

        assert!(s.create("none").unwrap_err().contains("場所が分かりません"));
        assert!(s.create("nope").unwrap_err().contains("知らない置き場"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn compares_paths_like_the_os() {
        assert!(same_file(Path::new("a/b.exe"), Path::new("a\\b.exe")));
        assert_eq!(same_file(Path::new("A/B.exe"), Path::new("a/b.exe")), cfg!(windows));
    }
}
