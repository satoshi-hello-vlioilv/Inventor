//! 画面で作ったファイル（直した図面の DXF・SXF、変換データなど）を、利用者が保存の窓で選んだ場所へ書く。
//! 画面は中身を base64 で送る（`/__desktop/save-file`。文字の符号化（Shift_JIS など）は画面が済ませる）。
//! 保存の窓そのものは main.rs（窓の持ち手が要る）。ここは窓に頼らない部分（依頼の読み取り・書き込み）で、試験できる。

use serde_json::Value;
use std::path::Path;

/// 保存の依頼: 既定のファイル名・窓の題・ファイルの種類（名前と拡張子）・中身
#[derive(Debug, PartialEq)]
pub struct SaveRequest {
    pub name: String,
    pub title: String,
    pub filter: (String, Vec<String>),
    pub data: Vec<u8>,
}

/// 依頼の JSON（{ name, title, filter: { label, extensions }, data: base64 }）を読む。足りなければ利用者に見せる理由
pub fn parse_request(body: &Value) -> Result<SaveRequest, String> {
    let name = body["name"].as_str().filter(|s| !s.trim().is_empty()).ok_or("保存するファイルの名前がありません")?;
    let data = decode_base64(body["data"].as_str().ok_or("保存する中身がありません")?)?;
    let label = body["filter"]["label"].as_str().unwrap_or("ファイル").to_string();
    let extensions: Vec<String> = body["filter"]["extensions"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| e.as_str()).map(|e| e.trim_start_matches('.').to_string()).filter(|e| !e.is_empty()).collect())
        .unwrap_or_default();
    let title = body["title"].as_str().unwrap_or("保存する").to_string();
    Ok(SaveRequest { name: file_name(name), title, filter: (label, extensions), data })
}

/// 既定のファイル名から、フォルダの区切りと Windows で使えない文字を除く（保存の窓が名前の欄に出す）
fn file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let clean: String =
        base.chars().map(|c| if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c }).collect();
    if clean.trim().is_empty() {
        "無題".to_string()
    } else {
        clean
    }
}

/// 書く（途中で失敗して半端なファイルを残さないよう、隣に書いてから名前を変える）
pub fn write(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".saving");
    let temp = Path::new(&temp);
    std::fs::write(temp, data).and_then(|_| std::fs::rename(temp, path)).map_err(|e| {
        let _ = std::fs::remove_file(temp);
        format!("{} に保存できませんでした: {e}", path.display())
    })
}

/// base64（標準の文字。改行・空白は飛ばす。末尾の = は省いてもよい）→ バイト列
pub fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let digits: Vec<u8> = text.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body = digits.strip_suffix(b"==").or_else(|| digits.strip_suffix(b"=")).unwrap_or(&digits);
    if body.len() % 4 == 1 {
        return Err("保存する中身（base64）の長さが合いません".to_string());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c).ok_or("保存する中身（base64）に使えない文字があります")? << (18 - 6 * i);
        }
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("Zg==").unwrap(), b"f");
        assert_eq!(decode_base64("Zm8=").unwrap(), b"fo");
        assert_eq!(decode_base64("Zm9v").unwrap(), b"foo");
        assert_eq!(decode_base64("Zm9vYg").unwrap(), b"foob"); // 末尾の = を省いた形
        assert_eq!(decode_base64("Zm9v\r\nYmFy").unwrap(), b"foobar");
        assert_eq!(decode_base64("//79").unwrap(), [0xff, 0xfe, 0xfd]);
        assert!(decode_base64("Zm9vY").is_err());
        assert!(decode_base64("Zm9-").is_err());
    }

    #[test]
    fn request_reads_name_filter_and_bytes() {
        let body = json!({ "name": "C:\\x\\図面<1>.dxf", "title": "DXF で保存", "filter": { "label": "DXF", "extensions": [".dxf"] }, "data": "MAo=" });
        let r = parse_request(&body).unwrap();
        assert_eq!(
            r,
            SaveRequest {
                name: "図面_1_.dxf".into(),
                title: "DXF で保存".into(),
                filter: ("DXF".into(), vec!["dxf".into()]),
                data: b"0\n".to_vec()
            }
        );
        assert!(parse_request(&json!({ "data": "MAo=" })).is_err());
        assert!(parse_request(&json!({ "name": "a.dxf" })).is_err());
    }

    #[test]
    fn write_replaces_the_file_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("inventor-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.dxf");
        write(&path, b"old").unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!dir.join("a.dxf.saving").exists());
        assert!(write(&dir.join("無い/a.dxf"), b"x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
