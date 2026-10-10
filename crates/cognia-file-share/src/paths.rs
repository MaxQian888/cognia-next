//! FileSpace path grammar, mirrored from `lib/filespace/paths.ts`.
//!
//! A FileSpace path is POSIX, absolute, NFC-normalized, with empty segments
//! collapsed and `.`/`..` refused rather than resolved. The gateway accepts a
//! path from a WebDAV or SFTP client only through [`normalize`], so the two
//! implementations must agree byte for byte; `lib/filespace/path-fixtures.json`
//! holds the shared vectors both test suites read.

use unicode_normalization::UnicodeNormalization;

/// Longest accepted path, in UTF-16 code units (the TS rule's unit).
pub const MAX_PATH_UTF16: usize = 4096;

/// Normalize `input` into a FileSpace path, or `None` when it is not one.
/// `/` alone is the FileSpace root.
pub fn normalize(input: &str) -> Option<String> {
    let composed: String = input.nfc().collect();
    let units = composed.encode_utf16().count();
    if units == 0 || units > MAX_PATH_UTF16 {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in composed.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." {
            return None;
        }
        if segment
            .chars()
            .any(|c| (c as u32) <= 0x1f || c == '\u{7f}' || c == '\\')
        {
            return None;
        }
        if segments.is_empty() && is_drive_designator(segment) {
            return None;
        }
        segments.push(segment);
    }
    Some(format!("/{}", segments.join("/")))
}

fn is_drive_designator(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Whether `path` is `prefix` itself or sits under it, segment-wise.
pub fn is_within(path: &str, prefix: &str) -> bool {
    if prefix == "/" {
        return true;
    }
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes()[prefix.len()] == b'/')
}

/// The remainder of `path` inside `prefix` (`""` for the prefix itself), or
/// `None` when it is not within it.
pub fn relative_to<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    if !is_within(path, prefix) {
        return None;
    }
    if prefix == "/" {
        return Some(path.trim_start_matches('/'));
    }
    if path.len() == prefix.len() {
        Some("")
    } else {
        Some(&path[prefix.len() + 1..])
    }
}

/// Join a normalized prefix and a relative tail (`""` returns the prefix).
pub fn join(prefix: &str, rel: &str) -> String {
    match (prefix, rel) {
        (_, "") => prefix.to_string(),
        ("/", _) => format!("/{rel}"),
        _ => format!("{prefix}/{rel}"),
    }
}

/// The parent of a normalized path (`/` is its own parent).
pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &path[..index],
    }
}

/// The last segment of a normalized path (`""` for the root).
pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Fixture {
        normalize: Vec<NormalizeCase>,
    }

    #[derive(serde::Deserialize)]
    struct NormalizeCase {
        input: String,
        expected: Option<String>,
    }

    #[test]
    fn normalization_matches_the_shared_typescript_vectors() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../lib/filespace/path-fixtures.json"
        ))
        .expect("path fixtures parse");
        assert!(fixture.normalize.len() >= 20);
        for case in fixture.normalize {
            assert_eq!(
                normalize(&case.input),
                case.expected,
                "normalize({:?})",
                case.input
            );
        }
    }

    #[test]
    fn the_length_bound_counts_utf16_units_like_typescript() {
        // "𝄞" is one char, two UTF-16 units: 2048 of them sit exactly at the bound.
        let at_bound = "/".to_string() + &"𝄞".repeat(2047) + "a";
        assert_eq!(at_bound.encode_utf16().count(), 4096);
        assert!(normalize(&at_bound).is_some());
        let over = format!("{at_bound}b");
        assert!(normalize(&over).is_none());
    }

    #[test]
    fn prefixes_relatives_and_joins_are_segment_wise() {
        assert!(is_within("/workspace/a", "/workspace"));
        assert!(is_within("/workspace", "/workspace"));
        assert!(!is_within("/workspaces", "/workspace"));
        assert!(is_within("/anything", "/"));
        assert_eq!(relative_to("/workspace/src/a.ts", "/workspace"), Some("src/a.ts"));
        assert_eq!(relative_to("/workspace", "/workspace"), Some(""));
        assert_eq!(relative_to("/workspacex", "/workspace"), None);
        assert_eq!(relative_to("/workspace/a", "/"), Some("workspace/a"));
        assert_eq!(join("/workspace", "src"), "/workspace/src");
        assert_eq!(join("/workspace", ""), "/workspace");
        assert_eq!(join("/", "workspace"), "/workspace");
        assert_eq!(parent("/workspace/src"), "/workspace");
        assert_eq!(parent("/workspace"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(file_name("/workspace/src/a.ts"), "a.ts");
        assert_eq!(file_name("/"), "");
    }
}
