//! 作る前の準備: アイコンを描いてから Tauri の準備へ渡す（WaveLog と同じ作り）。
//! アイコンの絵は `program/tools/app_icon.py` の 1 か所が描く。`.ico` をリポジトリへ置くと同じ絵が 2 か所になるので、作るたびに書き出す。
use std::path::Path;
use std::process::Command;

fn main() {
    // exe が名乗る「作ったコミット」。CI が渡す（desktop.yml の INVENTOR_TOOL_BUILD_COMMIT）。手元で作った exe は空
    println!("cargo:rerun-if-env-changed=INVENTOR_TOOL_BUILD_COMMIT");
    println!("cargo:rustc-env=INVENTOR_TOOL_BUILD_COMMIT={}", std::env::var("INVENTOR_TOOL_BUILD_COMMIT").unwrap_or_default());
    println!("cargo:rerun-if-changed=../program/tools/app_icon.py");
    println!("cargo:rerun-if-env-changed=INVENTOR_TOOL_PYTHON");
    let fresh = Path::new("icons/icon.ico").is_file()
        && std::fs::metadata("icons/icon.ico").and_then(|m| m.modified()).ok()
            >= std::fs::metadata("../program/tools/app_icon.py").and_then(|m| m.modified()).ok();
    if !fresh {
        let py = std::env::var("INVENTOR_TOOL_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
        let ok = Command::new(&py)
            .args(["../program/tools/app_icon.py", "icons"])
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok && !Path::new("icons/icon.ico").is_file() {
            panic!("アイコンを描けません（{py} で program/tools/app_icon.py を呼べません）。Python を入れるか INVENTOR_TOOL_PYTHON で場所を渡してください");
        }
    }
    tauri_build::build()
}
