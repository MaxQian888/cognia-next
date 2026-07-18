use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

pub const DEFAULT_TEXT_PREVIEW_BYTES: usize = 1024 * 1024;
pub const MAX_EDITOR_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceEncoding {
    Utf8,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRead {
    pub content: Option<String>,
    pub encoding: ResourceEncoding,
    pub media_type: String,
    pub size: u64,
    pub hash: String,
    pub truncated: bool,
    pub next_offset: Option<u64>,
    pub sensitive: bool,
}

pub fn is_sensitive_resource(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/").to_ascii_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name,
            "credentials.json"
                | "credentials.yaml"
                | "credentials.yml"
                | "id_rsa"
                | "id_ed25519"
                | "known_hosts"
        )
        || matches!(
            Path::new(name).extension().and_then(|value| value.to_str()),
            Some("pem" | "key" | "p12" | "pfx")
        )
}

pub fn read_text_resource(
    root: &Path,
    rel_path: &str,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ResourceRead, String> {
    let target = resolve_existing_resource(root, rel_path)?;
    if !target.is_file() {
        return Err(format!("not a file: {rel_path}"));
    }

    let size = target
        .metadata()
        .map_err(|error| format!("stat {rel_path}: {error}"))?
        .len();
    if offset > size {
        return Err(format!("offset {offset} exceeds resource size {size}"));
    }

    let mut file = File::open(&target).map_err(|error| format!("open {rel_path}: {error}"))?;
    let (hash, binary) = hash_and_detect_binary(&mut file, rel_path)?;
    let media_type = media_type_for(rel_path, binary).to_string();
    if binary {
        return Ok(ResourceRead {
            content: None,
            encoding: ResourceEncoding::Binary,
            media_type,
            size,
            hash,
            truncated: false,
            next_offset: None,
            sensitive: is_sensitive_resource(rel_path),
        });
    }

    let limit = max_bytes
        .unwrap_or(DEFAULT_TEXT_PREVIEW_BYTES)
        .clamp(1, DEFAULT_TEXT_PREVIEW_BYTES);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek {rel_path}: {error}"))?;
    let remaining = size.saturating_sub(offset);
    let to_read = remaining.min(limit as u64) as usize;
    let mut bytes = vec![0; to_read];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("read {rel_path}: {error}"))?;

    let content = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_string(),
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => {
            bytes.truncate(error.valid_up_to());
            String::from_utf8(bytes).map_err(|_| format!("invalid UTF-8 in {rel_path}"))?
        }
        Err(_) => {
            return Err(format!(
                "offset does not start at a UTF-8 boundary: {offset}"
            ))
        }
    };
    let consumed = content.len() as u64;
    let next = offset + consumed;
    let truncated = next < size;

    Ok(ResourceRead {
        content: Some(content),
        encoding: ResourceEncoding::Utf8,
        media_type,
        size,
        hash,
        truncated,
        next_offset: truncated.then_some(next),
        sensitive: is_sensitive_resource(rel_path),
    })
}

fn resolve_existing_resource(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rel_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let target = canonical_root.join(relative);
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("canonicalize {}: {error}", target.display()))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    Ok(canonical_target)
}

fn hash_and_detect_binary(file: &mut File, rel_path: &str) -> Result<(String, bool), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek {rel_path}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut sampled = Vec::with_capacity(8192);
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {rel_path}: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if sampled.len() < 8192 {
            let take = (8192 - sampled.len()).min(read);
            sampled.extend_from_slice(&buffer[..take]);
        }
    }
    let binary = sampled.contains(&0) || std::str::from_utf8(&sampled).is_err();
    Ok((hex::encode(hasher.finalize()), binary))
}

pub(crate) fn media_type_for(rel_path: &str, binary: bool) -> &'static str {
    let extension = Path::new(rel_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" | "mdx" => "text/markdown",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "js" | "jsx" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ if binary => "application/octet-stream",
        _ => "text/plain",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn reads_bounded_utf8_with_resume_metadata_and_full_file_hash() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("note.md"), "ab界cd").unwrap();

        let first = read_text_resource(dir.path(), "note.md", 0, Some(4)).unwrap();
        assert_eq!(first.content.as_deref(), Some("ab"));
        assert_eq!(first.encoding, ResourceEncoding::Utf8);
        assert_eq!(first.media_type, "text/markdown");
        assert_eq!(first.size, 7);
        assert_eq!(first.hash.len(), 64);
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));

        let second = read_text_resource(dir.path(), "note.md", 2, Some(5)).unwrap();
        assert_eq!(second.content.as_deref(), Some("界cd"));
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        assert_eq!(second.hash, first.hash);
    }

    #[test]
    fn reports_binary_without_lossy_text() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("asset.bin"), [0xff, 0x00, 0x41]).unwrap();

        let read = read_text_resource(dir.path(), "asset.bin", 0, None).unwrap();
        assert_eq!(read.encoding, ResourceEncoding::Binary);
        assert_eq!(read.content, None);
        assert_eq!(read.media_type, "application/octet-stream");
        assert!(!read.truncated);
    }

    #[test]
    fn blocks_traversal_and_symlink_escape() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();

        let traversal = read_text_resource(dir.path(), "../secret.txt", 0, None).unwrap_err();
        assert!(traversal.contains("escapes workspace"));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("link"))
                .unwrap();
            let symlink = read_text_resource(dir.path(), "link", 0, None).unwrap_err();
            assert!(symlink.contains("escapes workspace"));
        }
    }

    #[test]
    fn classifies_sensitive_paths_without_hiding_normal_source() {
        for path in [
            ".env",
            ".env.local",
            "config/credentials.json",
            "keys/id_rsa",
            "certs/client.pem",
        ] {
            assert!(is_sensitive_resource(path), "{path}");
        }
        assert!(!is_sensitive_resource("src/environment.ts"));
        assert!(!is_sensitive_resource("docs/credentials-guide.md"));
    }
}
