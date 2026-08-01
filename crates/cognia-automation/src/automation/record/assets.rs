//! Opaque screenshot handles + the containment rules for reading them back.
//!
//! The renderer never learns a filesystem path. It gets an [`AssetId`] — a
//! canonical UUID and nothing else — and exchanges it for base64 bytes through
//! `record_read_asset`. That indirection is the whole point: a recording bundle
//! lives under the user's app-data directory, and a command that accepted a
//! caller-supplied *path* would be an arbitrary-file-read primitive reachable
//! from any renderer surface.
//!
//! Two defences, in order:
//!
//! 1. **Typed parse.** [`AssetId::parse`] / [`RecordingId::parse`] accept only a
//!    canonical `8-4-4-4-12` hex UUID. `..`, `/`, `\`, `%2e`, NUL and every
//!    other traversal shape is rejected *before* any path join happens. This is
//!    the primary defence and it is pure, so it is exhaustively testable.
//! 2. **Canonicalized prefix re-assert.** [`contained_asset_path`] resolves the
//!    real path and re-checks that it still sits under the bundle directory.
//!    Belt-and-braces: it catches a bundle directory that someone replaced with
//!    a symlink after step 1 passed.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::automation::types::{ImageFormat, Screenshot};

/// Directory name under the Cognia app-data root. Sibling of `automation/`
/// (see `automation/persist.rs`), not under it: bundles are large, disposable,
/// and must never be swept up by a settings backup.
const RECORDINGS_DIR: &str = "recordings";
const ASSETS_DIR: &str = "assets";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AssetError {
    /// The id was not a canonical UUID. Deliberately does not echo the input —
    /// a rejected id is attacker-controlled and has no business in a log line.
    #[error("malformed identifier")]
    MalformedId,
    #[error("recordings directory is unavailable")]
    NoRoot,
    #[error("asset escapes its bundle")]
    Escapes,
    #[error("asset not found")]
    NotFound,
    #[error("asset io error: {message}")]
    Io { message: String },
}

/// Canonical-UUID check. The *only* accepted shape, deliberately hand-written
/// rather than delegated to `uuid::Uuid::parse_str`, which also accepts braced,
/// URN and simple (dash-free) forms — three extra shapes we would then have to
/// re-normalize before using the string as a path component.
fn is_canonical_uuid(raw: &str) -> bool {
    if raw.len() != 36 {
        return false;
    }
    for (i, b) in raw.bytes().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Opaque, renderer-facing screenshot handle. Wire form is a bare UUID string —
/// no path component, no extension, no bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssetId(String);

impl AssetId {
    /// UUIDv7 so lexical order matches capture order — the bundle's `assets/`
    /// listing sorts into the sequence the user performed.
    pub fn new() -> Self {
        Self(uuid::Uuid::now_v7().hyphenated().to_string())
    }

    pub fn parse(raw: &str) -> Result<Self, AssetError> {
        if is_canonical_uuid(raw) {
            Ok(Self(raw.to_ascii_lowercase()))
        } else {
            Err(AssetError::MalformedId)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for AssetId {
    fn default() -> Self {
        Self::new()
    }
}

/// The caller-supplied recording identifier. Same fail-closed rule as
/// [`AssetId`] — it names a directory, so it is the more dangerous of the two.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecordingId(String);

impl RecordingId {
    pub fn new() -> Self {
        Self(uuid::Uuid::now_v7().hyphenated().to_string())
    }

    pub fn parse(raw: &str) -> Result<Self, AssetError> {
        if is_canonical_uuid(raw) {
            Ok(Self(raw.to_ascii_lowercase()))
        } else {
            Err(AssetError::MalformedId)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for RecordingId {
    fn default() -> Self {
        Self::new()
    }
}

/// Everything the renderer may know about a stored frame. Dimensions and byte
/// length only — enough to lay out a thumbnail grid and show a size, nothing
/// that hints at where the file lives.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub width: u32,
    pub height: u32,
    pub byte_len: u64,
    pub format: ImageFormat,
    pub captured_at: i64,
}

/// Returned by `record_read_asset`: base64 bytes, never a path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    pub asset_id: AssetId,
    pub mime_type: String,
    pub bytes: String,
    pub meta: AssetMeta,
}

pub fn mime_for(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
    }
}

pub fn extension_for(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
    }
}

/// `<data_dir>/cognia/recordings`. `None` when the platform has no data dir,
/// which is the signal for `record_preflight` to report storage-unavailable
/// rather than silently recording into a temp dir that gets swept.
pub fn recordings_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join(RECORDINGS_DIR))
}

pub fn bundle_dir(root: &Path, id: &RecordingId) -> PathBuf {
    root.join(id.as_str())
}

pub fn assets_dir(root: &Path, id: &RecordingId) -> PathBuf {
    bundle_dir(root, id).join(ASSETS_DIR)
}

/// Resolve `<root>/<recording>/assets/<asset>.<ext>` and prove it is still
/// inside the bundle.
///
/// Both ids are already typed (so they cannot carry a separator), which makes
/// the join itself safe. The canonicalization below exists for the case the
/// type system cannot cover: a bundle directory that is — or contains — a
/// symlink pointing somewhere else. Only the *parent* is canonicalized, because
/// the asset file may legitimately not exist yet on the write path.
pub fn contained_asset_path(
    root: &Path,
    id: &RecordingId,
    asset: &AssetId,
    format: ImageFormat,
) -> Result<PathBuf, AssetError> {
    let dir = assets_dir(root, id);
    let real_root = root.canonicalize().map_err(|_| AssetError::NoRoot)?;
    let real_dir = dir.canonicalize().map_err(|_| AssetError::NotFound)?;
    if !real_dir.starts_with(&real_root) {
        return Err(AssetError::Escapes);
    }
    Ok(real_dir.join(format!("{}.{}", asset.as_str(), extension_for(format))))
}

/// Persist a captured frame under the bundle and hand back its opaque handle.
///
/// The screenshot arrives base64-encoded from the capture layer; we decode once
/// here so the on-disk bundle holds real image bytes (a bundle a human can open
/// in Preview is worth the decode).
pub fn write_asset(
    root: &Path,
    id: &RecordingId,
    shot: &Screenshot,
) -> Result<(AssetId, AssetMeta), AssetError> {
    let dir = assets_dir(root, id);
    std::fs::create_dir_all(&dir).map_err(|e| AssetError::Io {
        message: e.to_string(),
    })?;
    let raw = general_purpose::STANDARD
        .decode(shot.bytes.as_bytes())
        .map_err(|_| AssetError::Io {
            message: "screenshot payload was not valid base64".into(),
        })?;
    let asset = AssetId::new();
    let path = dir.join(format!("{}.{}", asset.as_str(), extension_for(shot.format)));
    std::fs::write(&path, &raw).map_err(|e| AssetError::Io {
        message: e.to_string(),
    })?;
    let meta = AssetMeta {
        width: shot.width,
        height: shot.height,
        byte_len: raw.len() as u64,
        format: shot.format,
        captured_at: shot.captured_at,
    };
    Ok((asset, meta))
}

/// Read a stored frame back as base64. `meta` is supplied by the caller from
/// the journal rather than re-derived from the file: the journal is the record
/// of what was captured, and trusting the file's own header would let a swapped
/// file misreport its dimensions.
pub fn read_asset(
    root: &Path,
    id: &RecordingId,
    asset: &AssetId,
    meta: AssetMeta,
) -> Result<AssetPayload, AssetError> {
    let path = contained_asset_path(root, id, asset, meta.format)?;
    let raw = std::fs::read(&path).map_err(|_| AssetError::NotFound)?;
    Ok(AssetPayload {
        asset_id: asset.clone(),
        mime_type: mime_for(meta.format).to_string(),
        bytes: general_purpose::STANDARD.encode(&raw),
        meta: AssetMeta {
            byte_len: raw.len() as u64,
            ..meta
        },
    })
}

/// Delete a single frame. The only deletion permitted inside a live bundle —
/// it backs undo-last, whose journal side is a tombstone, never a truncation.
pub fn delete_asset(
    root: &Path,
    id: &RecordingId,
    asset: &AssetId,
    format: ImageFormat,
) -> Result<(), AssetError> {
    let path = contained_asset_path(root, id, asset, format)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AssetError::Io {
            message: e.to_string(),
        }),
    }
}

/// Remove a whole bundle. Used by `record_delete_bundle` and by the versions UI.
pub fn delete_bundle(root: &Path, id: &RecordingId) -> Result<(), AssetError> {
    let dir = bundle_dir(root, id);
    if !dir.exists() {
        return Ok(());
    }
    // Re-assert containment before a recursive delete — the one operation where
    // a symlinked bundle directory would be catastrophic rather than merely wrong.
    let real_root = root.canonicalize().map_err(|_| AssetError::NoRoot)?;
    let real_dir = dir.canonicalize().map_err(|_| AssetError::NotFound)?;
    if !real_dir.starts_with(&real_root) || real_dir == real_root {
        return Err(AssetError::Escapes);
    }
    std::fs::remove_dir_all(&real_dir).map_err(|e| AssetError::Io {
        message: e.to_string(),
    })
}

/// Total bytes a bundle occupies (journal + manifest + every frame).
pub fn bundle_bytes(root: &Path, id: &RecordingId) -> u64 {
    dir_bytes(&bundle_dir(root, id))
}

pub(crate) fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total = total.saturating_add(dir_bytes(&entry.path())),
            Ok(meta) => total = total.saturating_add(meta.len()),
            Err(_) => {}
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(bytes: &str) -> Screenshot {
        Screenshot {
            bytes: general_purpose::STANDARD.encode(bytes),
            width: 8,
            height: 4,
            captured_at: 42,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        }
    }

    #[test]
    fn asset_id_rejects_traversal() {
        // Every one of these is a real shape an attacker would try; each must
        // die at the parse, long before it can reach a path join.
        for bad in [
            "..",
            "../x",
            "a/b",
            "a\\b",
            "%2e%2e",
            "%2e%2e%2f",
            "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01.png",
            "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01/../../etc/passwd",
            "",
            "0191b0e2_1c3a_7a11_9c1a_4d2f6b8c9e01",
            "0191b0e21c3a7a119c1a4d2f6b8c9e01",
            "{0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01}",
            "urn:uuid:0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
            "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e0z",
            "\0",
        ] {
            assert_eq!(
                AssetId::parse(bad),
                Err(AssetError::MalformedId),
                "must reject {bad:?}"
            );
            assert_eq!(
                RecordingId::parse(bad),
                Err(AssetError::MalformedId),
                "must reject {bad:?}"
            );
        }
    }

    #[test]
    fn asset_id_rejects_overlong_input() {
        let long = "a".repeat(300);
        assert_eq!(AssetId::parse(&long), Err(AssetError::MalformedId));
    }

    #[test]
    fn asset_id_roundtrips_uuid() {
        let id = AssetId::new();
        let back = AssetId::parse(id.as_str()).expect("freshly minted id must parse");
        assert_eq!(id, back);
        assert_eq!(id.as_str().len(), 36);
    }

    #[test]
    fn asset_id_parse_normalizes_case() {
        let upper = "0191B0E2-1C3A-7A11-9C1A-4D2F6B8C9E01";
        let parsed = AssetId::parse(upper).unwrap();
        assert_eq!(parsed.as_str(), upper.to_ascii_lowercase());
    }

    #[test]
    fn recording_id_rejects_non_uuid() {
        assert!(RecordingId::parse("my-recording").is_err());
        assert!(RecordingId::parse(RecordingId::new().as_str()).is_ok());
    }

    #[test]
    fn asset_ids_are_unique_and_ordered() {
        let a = AssetId::new();
        let b = AssetId::new();
        assert_ne!(a, b);
        // v7 is time-ordered, so lexical order tracks capture order.
        assert!(a.as_str() <= b.as_str());
    }

    #[test]
    fn write_then_read_asset_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let id = RecordingId::new();
        let (asset, meta) = write_asset(tmp.path(), &id, &shot("hello-frame")).unwrap();
        assert_eq!(meta.width, 8);
        assert_eq!(meta.byte_len, "hello-frame".len() as u64);

        let payload = read_asset(tmp.path(), &id, &asset, meta).unwrap();
        assert_eq!(payload.mime_type, "image/png");
        assert_eq!(payload.asset_id, asset);
        let decoded = general_purpose::STANDARD.decode(payload.bytes).unwrap();
        assert_eq!(decoded, b"hello-frame");
    }

    #[test]
    fn read_asset_of_unknown_id_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let id = RecordingId::new();
        write_asset(tmp.path(), &id, &shot("x")).unwrap();
        let meta = AssetMeta {
            width: 1,
            height: 1,
            byte_len: 1,
            format: ImageFormat::Png,
            captured_at: 0,
        };
        assert_eq!(
            read_asset(tmp.path(), &id, &AssetId::new(), meta),
            Err(AssetError::NotFound)
        );
    }

    #[test]
    fn contained_path_rejects_unknown_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = RecordingId::new();
        assert_eq!(
            contained_asset_path(tmp.path(), &missing, &AssetId::new(), ImageFormat::Png),
            Err(AssetError::NotFound)
        );
    }

    #[cfg(unix)]
    #[test]
    fn contained_path_rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("assets")).unwrap();

        let id = RecordingId::new();
        // The bundle directory itself is a symlink out of the recordings root —
        // the typed id cannot catch this, so the canonicalized prefix check must.
        std::os::unix::fs::symlink(outside.path(), root.path().join(id.as_str())).unwrap();

        assert_eq!(
            contained_asset_path(root.path(), &id, &AssetId::new(), ImageFormat::Png),
            Err(AssetError::Escapes)
        );
    }

    #[cfg(unix)]
    #[test]
    fn delete_bundle_rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("precious.txt"), b"keep me").unwrap();

        let id = RecordingId::new();
        std::os::unix::fs::symlink(outside.path(), root.path().join(id.as_str())).unwrap();

        assert_eq!(delete_bundle(root.path(), &id), Err(AssetError::Escapes));
        assert!(
            outside.path().join("precious.txt").exists(),
            "a symlinked bundle must never be followed into a recursive delete"
        );
    }

    #[test]
    fn delete_asset_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let id = RecordingId::new();
        let (asset, meta) = write_asset(tmp.path(), &id, &shot("frame")).unwrap();
        assert!(delete_asset(tmp.path(), &id, &asset, meta.format).is_ok());
        // Undo-then-undo must not fail; a second delete of a gone frame is fine.
        assert!(delete_asset(tmp.path(), &id, &asset, meta.format).is_ok());
    }

    #[test]
    fn delete_bundle_removes_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let id = RecordingId::new();
        write_asset(tmp.path(), &id, &shot("a")).unwrap();
        write_asset(tmp.path(), &id, &shot("bb")).unwrap();
        assert!(bundle_bytes(tmp.path(), &id) >= 3);
        delete_bundle(tmp.path(), &id).unwrap();
        assert!(!bundle_dir(tmp.path(), &id).exists());
        assert_eq!(bundle_bytes(tmp.path(), &id), 0);
    }

    #[test]
    fn delete_bundle_of_missing_dir_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(delete_bundle(tmp.path(), &RecordingId::new()).is_ok());
    }

    #[test]
    fn asset_payload_never_serializes_a_path() {
        let payload = AssetPayload {
            asset_id: AssetId::new(),
            mime_type: "image/png".into(),
            bytes: "AAAA".into(),
            meta: AssetMeta {
                width: 2,
                height: 2,
                byte_len: 3,
                format: ImageFormat::Png,
                captured_at: 7,
            },
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"assetId\""));
        assert!(json.contains("\"byteLen\":3"));
        assert!(
            !json.contains("path"),
            "payload must not carry a path: {json}"
        );
    }

    #[test]
    fn asset_id_serializes_as_a_bare_string() {
        let id = AssetId::parse("0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01").unwrap();
        assert_eq!(
            serde_json::to_string(&id).unwrap(),
            "\"0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01\""
        );
    }

    #[test]
    fn recordings_root_is_under_cognia() {
        if let Some(root) = recordings_root() {
            assert!(root.ends_with("cognia/recordings") || root.ends_with("cognia\\recordings"));
        }
    }

    #[test]
    fn dir_bytes_of_missing_dir_is_zero() {
        assert_eq!(dir_bytes(Path::new("/definitely/not/here/at/all")), 0);
    }
}
