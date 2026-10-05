//! 置き場所を探す: アプリの中身（program フォルダ）・この PC の作業場所・Python。WaveLog の locate.rs と同じ決まり。

use std::env;
use std::path::{Path, PathBuf};

/// アプリの名前（作業場所のフォルダ名・ドキュメントの下の保存先の名前）。
pub const APP_ID: &str = "Inventor3DTool";
pub const APP_NAME: &str = "Inventor 3Dツール";
/// program フォルダの目印（画面の本体）。
const MARKER: &str = "app/index.html";

/// program フォルダ。探す順: 環境変数 INVENTOR_TOOL_PROGRAM_DIR（開発・網）→ この exe の置き場所から上へたどって
/// `program/app/index.html` がある所（配る exe は program の中・作る途中は desktop/target/release の 3 つ上）。
pub fn program_dir() -> Result<PathBuf, String> {
    if let Some(p) = env::var_os("INVENTOR_TOOL_PROGRAM_DIR").map(PathBuf::from) {
        return if p.join(MARKER).is_file() {
            Ok(p)
        } else {
            Err(format!("指定された program フォルダに {MARKER} がありません: {}", p.display()))
        };
    }
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    find_program_from(&exe).ok_or_else(|| {
        format!(
            "アプリの中身（program フォルダ）が見つかりません。exe は、配られたフォルダの program の中に置いたまま起動してください。\n探し始めた場所: {}",
            exe.parent().unwrap_or(&exe).display()
        )
    })
}

/// exe の置き場所から上へ 6 段まで、`program` か、その場所自身が program フォルダか。
pub fn find_program_from(start: &Path) -> Option<PathBuf> {
    start.ancestors().skip(1).take(6).flat_map(|d| [d.to_path_buf(), d.join("program")]).find(|p| p.join(MARKER).is_file())
}

/// この PC の作業場所（記録・Python の .pyc・作る係のエラー出力）: LOCALAPPDATA → XDG_DATA_HOME → ~/.local/share の下の APP_ID。
pub fn local_root() -> PathBuf {
    if let Some(p) = env::var_os("INVENTOR_TOOL_LOCAL_ROOT") {
        return PathBuf::from(p);
    }
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"));
    base.join(APP_ID)
}

fn home() -> PathBuf {
    env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Python の起こし方（exe と、前に付ける引数。py ランチャーは -3）。
#[derive(Clone, Debug, PartialEq)]
pub struct Python {
    pub exe: PathBuf,
    pub args: Vec<String>,
}

/// Python が見つからないときの理由（1 行目。画面にはこれだけを出し、探した場所は記録に残す）。
pub const PYTHON_MISSING: &str = "Python が見つかりません。「STEP を作る」「Inventor で作る」には Python（3.10 以上）が要ります。https://www.python.org/ から入れ、入れるときに「Add python.exe to PATH」に印を付けてください（見るだけなら Python は要りません）。";

/// Python を探す（この PC の Python を使う）。見つからなければ、1 行目が理由・続けて探した場所。
pub fn python() -> Result<Python, String> {
    let path: Vec<PathBuf> = env::var_os("PATH").map(|p| env::split_paths(&p).collect()).unwrap_or_default();
    let cands = python_candidates(env::var_os("INVENTOR_TOOL_PYTHON").map(PathBuf::from), &path);
    cands.iter().find(|c| exists(&c.exe)).cloned().ok_or_else(|| {
        let tried: Vec<String> = cands.iter().take(8).map(|c| format!("  {}", c.exe.display())).collect();
        format!("{PYTHON_MISSING}\n探した場所:\n{}", tried.join("\n"))
    })
}

/// 在るか。リンクをたどらずに見る（Microsoft Store 版の入口 WindowsApps\python.exe は、たどると「無い」と答えることがある）。
fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// 探す順（先にあるほど優先）。INVENTOR_TOOL_PYTHON（開発・CI）→ PATH を前から見て、pythonw.exe がある場所の python.exe →
/// PATH の最初の python.exe → py ランチャー（WaveLog と同じ。いつも同じ Python を使う）。
pub fn python_candidates(given: Option<PathBuf>, path: &[PathBuf]) -> Vec<Python> {
    let plain = |exe: PathBuf| Python { exe, args: vec![] };
    let mut out = Vec::new();
    if let Some(p) = given {
        out.push(plain(p));
    }
    if cfg!(windows) {
        for dir in path {
            if exists(&dir.join("pythonw.exe")) {
                out.push(plain(dir.join("python.exe")));
            }
        }
        out.extend(path.iter().map(|d| plain(d.join("python.exe"))));
        let windir = env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        out.push(Python { exe: windir.join("py.exe"), args: vec!["-3".into()] });
    } else {
        out.extend(path.iter().map(|d| plain(d.join("python3"))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_program_next_to_or_above_the_exe() {
        let tmp = env::temp_dir().join(format!("inv-locate-{}", std::process::id()));
        let prog = tmp.join("program");
        std::fs::create_dir_all(prog.join("app")).unwrap();
        std::fs::write(prog.join(MARKER), "").unwrap();
        let deep = tmp.join("desktop").join("target").join("release");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_program_from(&prog.join("Inventor3DTool.exe")), Some(prog.clone()), "配る exe（program の中）");
        assert_eq!(find_program_from(&tmp.join("Inventor3DTool.exe")), Some(prog.clone()), "program と並ぶ");
        assert_eq!(find_program_from(&deep.join("Inventor3DTool.exe")), Some(prog.clone()), "作る途中（3 つ上）");
        assert_eq!(find_program_from(&env::temp_dir().join("nowhere-inv").join("x.exe")), None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn given_python_comes_first_and_path_order_is_kept() {
        let a = PathBuf::from("/opt/a");
        let b = PathBuf::from("/opt/b");
        let c = python_candidates(Some(PathBuf::from("/given/python")), &[a.clone(), b.clone()]);
        assert_eq!(c[0].exe, PathBuf::from("/given/python"), "指定された Python が先");
        if !cfg!(windows) {
            assert_eq!(c[1].exe, a.join("python3"), "PATH の順は並べ替えない（いつも同じ Python）");
            assert_eq!(c[2].exe, b.join("python3"));
        }
    }
}
