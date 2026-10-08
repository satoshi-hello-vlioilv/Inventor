//! この PC に聞くこと: 「作る」の保存先（設定とドキュメントの場所）・デスクトップとスタートメニューの場所・Inventor が入っているか。

use std::path::{Path, PathBuf};

/// 「作る」の保存先（この下に「<名前>_cad」を作る）。設定（config/appsettings.json の build.output_dir）が空なら
/// ドキュメントの下の「Inventor 3Dツール」。設定は %USERPROFILE% のような環境変数を書いてもよい。
pub fn output_root(program: &Path) -> PathBuf {
    let configured = configured_output_dir(&config_path(program));
    if configured.is_empty() {
        documents_dir().join(crate::locate::APP_NAME)
    } else {
        PathBuf::from(expand_vars(&configured, |k| std::env::var(k).ok()))
    }
}

/// 設定ファイル。INVENTOR_TOOL_CONFIG（開発・網）か program/config/appsettings.json。
fn config_path(program: &Path) -> PathBuf {
    std::env::var_os("INVENTOR_TOOL_CONFIG").map(PathBuf::from).unwrap_or_else(|| program.join("config").join("appsettings.json"))
}

/// build.output_dir（読めない・無いときは空。既定で動く）。
fn configured_output_dir(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or_default();
    value["build"]["output_dir"].as_str().unwrap_or("").trim().to_string()
}

/// %名前% を環境変数の値に置き換える（無い名前はそのまま残す。Windows の書き方）。
pub fn expand_vars(text: &str, get: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').map(|end| (&after[..end], end)) {
            Some((name, end)) if !name.is_empty() && get(name).is_some() => {
                out.push_str(&get(name).unwrap_or_default());
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// この PC の「ドキュメント」（OneDrive などへ移してあれば、移した先）。
pub fn documents_dir() -> PathBuf {
    known_folder(Folder::Documents).unwrap_or_else(|| home().join("Documents"))
}

/// この PC の「デスクトップ」（移してあれば、移した先。分からなければ None）
pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(Folder::Desktop)
}

/// この人の「スタートメニュー」のプログラムの場所（分からなければ None）
pub fn start_menu_dir() -> Option<PathBuf> {
    known_folder(Folder::StartMenuPrograms)
}

#[derive(Clone, Copy)]
enum Folder {
    Documents,
    Desktop,
    StartMenuPrograms,
}

/// Windows の決まった場所（Known Folder）
#[cfg(windows)]
fn known_folder(folder: Folder) -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Programs, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    let id = match folder {
        Folder::Documents => FOLDERID_Documents,
        Folder::Desktop => FOLDERID_Desktop,
        Folder::StartMenuPrograms => FOLDERID_Programs,
    };
    unsafe {
        let p = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None).ok()?;
        let path = p.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        path
    }
}

/// Windows 以外（開発・試験）: ホームの下の同じ名前の場所
#[cfg(not(windows))]
fn known_folder(folder: Folder) -> Option<PathBuf> {
    Some(match folder {
        Folder::Documents => home().join("Documents"),
        Folder::Desktop => home().join("Desktop"),
        Folder::StartMenuPrograms => home().join(".local").join("share").join("applications"),
    })
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// この PC に Inventor が入っているか（COM の登録 Inventor.Application があるか。Windows だけ）。
/// 画面が、Inventor の無い PC では「STEP を作る」を先に勧めるのに使う。
#[cfg(windows)]
pub fn inventor_installed() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
    let mut key = HKEY::default();
    unsafe {
        let found = RegOpenKeyExW(HKEY_CLASSES_ROOT, w!("Inventor.Application\\CLSID"), None, KEY_READ, &mut key).is_ok();
        if found {
            let _ = RegCloseKey(key);
        }
        found
    }
}

#[cfg(not(windows))]
pub fn inventor_installed() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_names_and_keeps_the_rest() {
        let get = |k: &str| (k == "USERPROFILE").then(|| r"C:\Users\a".to_string());
        assert_eq!(expand_vars(r"%USERPROFILE%\CAD", get), r"C:\Users\a\CAD");
        assert_eq!(expand_vars(r"%NOPE%\x", get), r"%NOPE%\x", "無い名前はそのまま");
        assert_eq!(expand_vars("100%", get), "100%");
        assert_eq!(expand_vars("%%USERPROFILE%", get), r"%C:\Users\a");
        assert_eq!(expand_vars(r"D:\作る\%USERPROFILE%", get), r"D:\作る\C:\Users\a", "日本語の途中でも切れない");
    }

    #[test]
    fn reads_the_configured_destination() {
        let dir = std::env::temp_dir().join(format!("inv-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("appsettings.json");
        std::fs::write(&path, "\u{feff}{\"build\": {\"output_dir\": \"  D:\\\\CAD  \"}}").unwrap();
        assert_eq!(configured_output_dir(&path), r"D:\CAD", "BOM 付き・前後の空白");
        std::fs::write(&path, "{").unwrap();
        assert_eq!(configured_output_dir(&path), "", "読めなければ既定");
        assert_eq!(configured_output_dir(&dir.join("none.json")), "");
        std::fs::remove_dir_all(&dir).ok();
    }
}
