//! この PC の設定（program\config\appsettings.json。版を入れ替えても残す）の読み書き。
//!   build.output_dir … 「作る」の保存先（空なら ドキュメント\Inventor 3Dツール。system.rs）
//!   update.dir       … 版の置き場（空なら update::DEFAULT_DIR）
//! 開発・網では INVENTOR_TOOL_CONFIG で別のファイルを使える。

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub fn path(program: &Path) -> PathBuf {
    std::env::var_os("INVENTOR_TOOL_CONFIG").map(PathBuf::from).unwrap_or_else(|| program.join("config").join("appsettings.json"))
}

/// 設定（無い・読めなければ空。BOM を許す）
pub fn load(program: &Path) -> Value {
    let text = std::fs::read_to_string(path(program)).unwrap_or_default();
    serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// 文字の設定（"build.output_dir" のように点で区切る。前後の空白を除く）
pub fn text(program: &Path, key: &str) -> String {
    key.split('.').fold(&load(program), |v, k| &v[k]).as_str().unwrap_or("").trim().to_string()
}

/// 設定を重ねて書く（patch に無い項目は残す。書きかけを読まれないよう、一時のファイルから名前を変える）
pub fn save(program: &Path, patch: &Value) -> Result<(), String> {
    let mut cur = load(program);
    merge(&mut cur, patch);
    let p = path(program);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("設定のフォルダを作れません（{e}）"))?;
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&cur).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &p)).map_err(|e| format!("設定を書けません（{}）: {e}", p.display()))
}

fn merge(base: &mut Value, patch: &Value) {
    match (base.as_object_mut(), patch.as_object()) {
        (Some(b), Some(p)) => {
            for (k, v) in p {
                merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        _ => *base = patch.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_and_keeps_other_items() {
        let dir = std::env::temp_dir().join(format!("inv-settings-merge-{}", std::process::id()));
        let program = dir.join("program");
        std::fs::create_dir_all(program.join("config")).unwrap();
        std::fs::write(path(&program), "\u{feff}{\"build\": {\"output_dir\": \"  D:\\\\CAD \"}}").unwrap();
        assert_eq!(text(&program, "build.output_dir"), r"D:\CAD", "BOM 付き・前後の空白");
        save(&program, &json!({"update": {"dir": r"E:\share"}})).unwrap();
        assert_eq!((text(&program, "build.output_dir").as_str(), text(&program, "update.dir").as_str()), (r"D:\CAD", r"E:\share"));
        std::fs::write(path(&program), "{").unwrap();
        assert_eq!(text(&program, "update.dir"), "", "読めなければ既定");
        std::fs::remove_dir_all(&dir).ok();
    }
}
