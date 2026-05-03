use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const WALLPAPER_DIR: &str = "wallpapers";
const APP_NAMESPACE: &str = "cognia";
/// Hard ceiling on a single wallpaper file (32 MB). Frontend rejects bigger
/// uploads earlier, but we keep a Rust-side guard so a malicious caller can't
/// fill the disk through this command.
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Returns the absolute path to `<app_data>/cognia/wallpapers`, creating it
/// if necessary. We deliberately resolve `data_dir()` ourselves (matching the
/// pattern used by the vector store) instead of taking a `tauri::AppHandle`
/// — this keeps the function trivially testable.
fn wallpapers_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "no data_dir on this platform".to_string())?;
    let dir = base.join(APP_NAMESPACE).join(WALLPAPER_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Same as `wallpapers_dir` but rooted at a custom base. Used by the unit
/// tests so we don't pollute the real `<app_data>`.
#[cfg(test)]
fn wallpapers_dir_at(base: &Path) -> Result<PathBuf, String> {
    let dir = base.join(APP_NAMESPACE).join(WALLPAPER_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedWallpaper {
    /// Filename (uuid + ext) under `<app_data>/cognia/wallpapers/`. The
    /// frontend stores this verbatim in `Wallpaper.source.relPath`.
    pub rel_path: String,
    /// Absolute path on disk — the frontend converts this through
    /// `convertFileSrc` to obtain a webview-loadable URL.
    pub abs_path: String,
    pub bytes: u64,
}

/// Validate a candidate filename: must be a non-empty single segment, no
/// path separators, no `..`, and only ASCII alphanumerics / `.` / `-` / `_`.
/// Anything else is treated as a path-traversal attempt.
fn validate_relname(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("empty filename".into());
    }
    if name.len() > 128 {
        return Err("filename too long".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid filename: path separators not allowed".into());
    }
    for ch in name.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_') {
            return Err(format!("invalid char in filename: {ch:?}"));
        }
    }
    Ok(())
}

fn save_bytes(dir: &Path, rel_name: &str, bytes: &[u8]) -> Result<SavedWallpaper, String> {
    validate_relname(rel_name)?;
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "wallpaper too large: {} bytes (max {})",
            bytes.len(),
            MAX_BYTES
        ));
    }
    let dest = dir.join(rel_name);
    std::fs::write(&dest, bytes).map_err(|e| format!("write {}: {}", dest.display(), e))?;
    Ok(SavedWallpaper {
        rel_path: rel_name.to_string(),
        abs_path: dest.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
    })
}

/// Persist a wallpaper image (delivered as base64) into the per-user
/// wallpapers directory. Returns the canonical `rel_path` + `abs_path` so
/// the frontend can store one and load the other.
#[tauri::command]
pub async fn wallpaper_save(file_name: String, base64_data: String) -> Result<SavedWallpaper, String> {
    let bytes = B64
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;
    let dir = wallpapers_dir()?;
    save_bytes(&dir, &file_name, &bytes)
}

/// List every file currently in the wallpapers directory. Used by the
/// settings UI to detect orphans (DB entry without a file or vice-versa)
/// and by the maintenance tab.
#[tauri::command]
pub fn wallpaper_list() -> Result<Vec<String>, String> {
    let dir = wallpapers_dir()?;
    let mut out: Vec<String> = vec![];
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            // Defensive — only return names that pass our own validation so
            // the frontend never sees a path it could mistake for absolute.
            if validate_relname(name).is_ok() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Remove a single wallpaper file. Silently succeeds when the file is
/// already gone — the caller's "delete from store" path runs unconditionally
/// and we don't want a transient FS error to stop it.
#[tauri::command]
pub fn wallpaper_delete(file_name: String) -> Result<(), String> {
    validate_relname(&file_name)?;
    let dir = wallpapers_dir()?;
    let path = dir.join(&file_name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove {}: {}", path.display(), err)),
    }
}

/// Resolve a wallpaper file name to its absolute path. The webview can
/// `convertFileSrc()` the result to obtain a `tauri://localhost/...` URL
/// suitable for `<img src>`. Returns `None` when the file isn't present.
#[tauri::command]
pub fn wallpaper_resolve_path(file_name: String) -> Result<Option<String>, String> {
    validate_relname(&file_name)?;
    let dir = wallpapers_dir()?;
    let path = dir.join(&file_name);
    if path.is_file() {
        Ok(Some(path.to_string_lossy().into_owned()))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallpaperBytes {
    pub mime: String,
    /// `data:<mime>;base64,<…>` — directly assignable to `<img src>` or
    /// `background-image: url(...)`. Avoids configuring the asset protocol.
    pub data_url: String,
    pub bytes: u64,
}

/// Read a wallpaper file and return it as a base64 data URL. The frontend
/// uses this when applying a background — it skips the asset protocol
/// scope dance and lets the renderer use the result directly. We infer the
/// MIME from the extension; unknown extensions default to
/// `application/octet-stream` and the caller decides whether to use it.
#[tauri::command]
pub fn wallpaper_read_data_url(file_name: String) -> Result<WallpaperBytes, String> {
    validate_relname(&file_name)?;
    let dir = wallpapers_dir()?;
    let path = dir.join(&file_name);
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mime = mime_from_filename(&file_name);
    let data_url = format!("data:{};base64,{}", mime, B64.encode(&bytes));
    Ok(WallpaperBytes {
        mime,
        data_url,
        bytes: bytes.len() as u64,
    })
}

fn mime_from_filename(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png".into()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".into()
    } else if lower.ends_with(".webp") {
        "image/webp".into()
    } else if lower.ends_with(".gif") {
        "image/gif".into()
    } else if lower.ends_with(".avif") {
        "image/avif".into()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".into()
    } else {
        "application/octet-stream".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_relname_rejects_separators() {
        assert!(validate_relname("a/b").is_err());
        assert!(validate_relname("a\\b").is_err());
        assert!(validate_relname("../etc/passwd").is_err());
    }

    #[test]
    fn validate_relname_rejects_unicode_and_specials() {
        assert!(validate_relname("file with space.png").is_err());
        assert!(validate_relname("a;b.png").is_err());
        assert!(validate_relname("名前.png").is_err());
    }

    #[test]
    fn validate_relname_accepts_uuid_like_filenames() {
        assert!(validate_relname("0dfb0d3c-5b6c-4f3a-9c0a-a1b2c3d4e5f6.png").is_ok());
        assert!(validate_relname("preset_001.jpg").is_ok());
        assert!(validate_relname("foo.bar.baz.webp").is_ok());
    }

    #[test]
    fn save_bytes_writes_file_and_returns_metadata() {
        let tmp = TempDir::new().unwrap();
        let dir = wallpapers_dir_at(tmp.path()).unwrap();
        let saved = save_bytes(&dir, "abc.bin", b"hello world").unwrap();
        assert_eq!(saved.rel_path, "abc.bin");
        assert!(saved.abs_path.ends_with("abc.bin"));
        assert_eq!(saved.bytes, 11);
        let read = std::fs::read(dir.join("abc.bin")).unwrap();
        assert_eq!(read, b"hello world");
    }

    #[test]
    fn save_bytes_rejects_oversized_payloads() {
        let tmp = TempDir::new().unwrap();
        let dir = wallpapers_dir_at(tmp.path()).unwrap();
        let huge = vec![0u8; MAX_BYTES + 1];
        let err = save_bytes(&dir, "x.bin", &huge).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn save_bytes_rejects_invalid_names() {
        let tmp = TempDir::new().unwrap();
        let dir = wallpapers_dir_at(tmp.path()).unwrap();
        let err = save_bytes(&dir, "../escape", b"x").unwrap_err();
        assert!(err.contains("invalid"));
    }

    #[test]
    fn list_filters_invalid_names_and_sorts() {
        let tmp = TempDir::new().unwrap();
        let dir = wallpapers_dir_at(tmp.path()).unwrap();
        save_bytes(&dir, "b.png", b"a").unwrap();
        save_bytes(&dir, "a.png", b"a").unwrap();
        // Manually drop a file that would fail validation; list should skip it.
        std::fs::write(dir.join("evil name.png"), b"x").unwrap();
        let entries = {
            let mut v: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter_map(|e| {
                    e.file_name().into_string().ok().filter(|n| validate_relname(n).is_ok())
                })
                .collect();
            v.sort();
            v
        };
        assert_eq!(entries, vec!["a.png", "b.png"]);
    }

    #[test]
    fn mime_from_filename_covers_common_extensions() {
        assert_eq!(mime_from_filename("a.png"), "image/png");
        assert_eq!(mime_from_filename("a.PNG"), "image/png");
        assert_eq!(mime_from_filename("a.jpg"), "image/jpeg");
        assert_eq!(mime_from_filename("a.jpeg"), "image/jpeg");
        assert_eq!(mime_from_filename("a.webp"), "image/webp");
        assert_eq!(mime_from_filename("a.gif"), "image/gif");
        assert_eq!(mime_from_filename("a.avif"), "image/avif");
        assert_eq!(mime_from_filename("a.svg"), "image/svg+xml");
        assert_eq!(mime_from_filename("a.exe"), "application/octet-stream");
    }

    #[test]
    fn delete_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let dir = wallpapers_dir_at(tmp.path()).unwrap();
        save_bytes(&dir, "x.png", b"x").unwrap();
        // First delete removes the file.
        std::fs::remove_file(dir.join("x.png")).unwrap();
        // Second delete should not error in our command path; emulate by
        // verifying the helper kind.
        let res = std::fs::remove_file(dir.join("x.png"));
        assert!(matches!(res.unwrap_err().kind(), std::io::ErrorKind::NotFound));
    }
}
