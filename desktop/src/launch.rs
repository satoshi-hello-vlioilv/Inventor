//! 起動の流れ（版の管理: docs/desktop.md §8）。
//!   置き場の入口 exe → この PC のアプリのフォルダ（%USERPROFILE%\Inventor3DTool）へ exe を写して渡し、すぐ終わる（handoff_from_share）
//!   アプリのフォルダの exe → 配る版と違えば、窓に進み具合を出してそろえ、開き直す（main.rs）
//!   開き直した exe は、前の窓が終わるのを待ってから始める（--after-pid。1 つだけ起動の仕組みが前の窓へ回さないように）

use std::path::{Path, PathBuf};
use std::time::Duration;

/// 窓が自分に渡す印（ファイルの引数と分ける）
#[derive(Default, Debug, PartialEq)]
pub struct Flags {
    pub after_pid: Option<u32>,
    pub from_share: Option<PathBuf>,
}

/// 引数を、窓の印とファイルに分ける
pub fn split_args(args: Vec<String>) -> (Flags, Vec<String>) {
    let mut flags = Flags::default();
    let mut files = Vec::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--after-pid" => flags.after_pid = it.next().and_then(|p| p.parse().ok()),
            "--from-share" => flags.from_share = it.next().map(PathBuf::from),
            _ => files.push(a),
        }
    }
    (flags, files)
}

/// 前の窓（pid）が終わるのを待つ（長くても limit まで）
pub fn wait_for_exit(pid: u32, limit: Duration) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            let _ = WaitForSingleObject(h, limit.as_millis() as u32);
            let _ = windows::Win32::Foundation::CloseHandle(h);
        }
    }
    #[cfg(not(windows))]
    {
        let start = std::time::Instant::now();
        while Path::new(&format!("/proc/{pid}")).exists() && start.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// このアプリのフォルダで、この窓が最初の 1 つか（同じフォルダの窓がもう開いていれば false。そのときはそろえない:
/// 開いている窓の中身を入れ替えないため）。答えが true なら、印（名前付きのミューテックス）を終わるまで持つ
pub fn first_instance(app: &Path) -> bool {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows::Win32::System::Threading::CreateMutexW;
        let key = app.to_string_lossy().to_lowercase();
        let digest: String = sha2::Sha256::digest(key.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
        let name = HSTRING::from(format!("Local\\{}-{digest}", crate::locate::APP_ID));
        unsafe {
            match CreateMutexW(None, false, &name) {
                // 閉じずに持ち続ける（窓が終わると OS が閉じる）
                Ok(_held) => GetLastError() != ERROR_ALREADY_EXISTS,
                Err(_) => false,
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        true
    }
}
#[cfg(windows)]
use sha2::Digest;

/// 置き場の入口 exe から: この PC のアプリのフォルダへ exe を写し（中身が同じなら写さない）、その exe に渡す。
/// 渡せたら Ok（呼んだ側はすぐ終わる）。写せない・起こせないときは理由（呼んだ側はそのまま置き場から動く）
pub fn handoff_from_share(exe: &Path, share: &Path, files: &[String]) -> Result<PathBuf, String> {
    let home = crate::update::home_app();
    std::fs::create_dir_all(&home).map_err(|e| format!("{} を作れません（{e}）", home.display()))?;
    let target = home.join(crate::update::EXE);
    let same = std::fs::read(exe).ok().zip(std::fs::read(&target).ok()).is_some_and(|(a, b)| a == b);
    if !same {
        let tmp = target.with_extension("exe.tmp");
        std::fs::copy(exe, &tmp).map_err(|e| format!("exe を写せません（{e}）"))?;
        strip_mark_of_the_web(&tmp);
        // 開いている窓が使っていれば置き換えられない（その窓が次の起動でそろえる）
        if std::fs::rename(&tmp, &target).is_err() {
            let _ = std::fs::remove_file(&tmp);
            if !target.is_file() {
                return Err("exe を置けません".into());
            }
        }
    }
    std::process::Command::new(&target)
        .args(files)
        .arg("--from-share")
        .arg(share)
        .current_dir(&home)
        .spawn()
        .map_err(|e| format!("{} を起こせません（{e}）", target.display()))?;
    Ok(target)
}

/// ネットから来た印（Zone.Identifier）を写しから外す（初めて開くときの警告を出さない。元のファイルには触れない）
fn strip_mark_of_the_web(path: &Path) {
    if cfg!(windows) {
        let _ = std::fs::remove_file(format!("{}:Zone.Identifier", path.display()));
    }
}

/// そろえた後、アプリのフォルダの exe を開き直す（この窓が終わるのを待たせる）
pub fn relaunch(app: &Path, files: &[String]) -> Result<(), String> {
    let exe = app.join(crate::update::EXE);
    std::process::Command::new(&exe)
        .args(files)
        .arg("--after-pid")
        .arg(std::process::id().to_string())
        .current_dir(app)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{} を開き直せません（{e}）", exe.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_flags_from_files() {
        let args = ["a.ipt", "--after-pid", "42", "--from-share", r"D:\share", "b.iam"].map(String::from).to_vec();
        let (flags, files) = split_args(args);
        assert_eq!(flags, Flags { after_pid: Some(42), from_share: Some(PathBuf::from(r"D:\share")) });
        assert_eq!(files, ["a.ipt", "b.iam"]);
        assert_eq!(split_args(vec!["--after-pid".into(), "x".into()]).0.after_pid, None, "数でなければ無視");
    }

    #[test]
    fn waits_only_while_the_process_lives() {
        let start = std::time::Instant::now();
        wait_for_exit(u32::MAX - 1, Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(1), "無いプロセスは待たない");
    }
}
