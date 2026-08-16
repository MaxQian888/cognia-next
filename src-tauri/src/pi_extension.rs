//! Desktop resolution + integrity check for the bundled Cognia Pi extension
//! (ADR-0119).
//!
//! The extension is what intercepts `pi.on("tool_call")` and applies Cognia's
//! permission matrix to Pi's native `read`/`edit`/`write`/`bash` tools. Pi ships
//! no permission prompts of its own, so without the extension those tools run
//! with the full rights of the process. That makes "is this the extension we
//! shipped?" a precondition for starting a session, not a diagnostic.
//!
//! The CLI answers the same question in TypeScript
//! (`cli/src/agent/tool-host/pi-extension.ts`). The desktop cannot call into
//! that code — the renderer is a static export with no filesystem — so the
//! adapter asks its host instead, and each host answers with the same verdict
//! shape. Keeping one *contract* with two implementations is what lets the
//! adapter stay host-agnostic; keeping one *implementation* is not possible
//! here.
//!
//! Resolution deliberately reuses [`crate::claude::sidecar::sidecar_dir`], so
//! the packaged (`resource_dir/sidecar`, `resource_dir/_up_/sidecar`) and
//! checkout layouts are discovered exactly where every other sidecar asset is.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

/// Verdict for one resolution attempt. Serialized to the renderer with
/// `camelCase` keys so it deserializes as the same union the CLI produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PiExtensionVerdict {
    /// Found, and the digest matches the pinned manifest.
    #[serde(rename_all = "camelCase")]
    Ok { path: String, sha256: String },
    /// No extension on disk.
    Missing,
    /// Present but unreadable.
    #[serde(rename_all = "camelCase")]
    Unreadable { path: String, detail: String },
    /// Present, but not the bytes Cognia shipped.
    #[serde(rename_all = "camelCase")]
    Tampered {
        path: String,
        expected: String,
        actual: String,
    },
    /// Present, but there is no manifest to compare against.
    ///
    /// Reported rather than accepted: an extension whose digest cannot be
    /// checked is exactly the substitution the pin exists to catch, and
    /// "unverifiable" must not lead to the same place as "verified".
    #[serde(rename_all = "camelCase")]
    Unpinned { path: String, sha256: String },
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verify the extension inside an already-resolved `sidecar/` directory.
///
/// Split from the Tauri command so the whole matrix is testable without an
/// `AppHandle`.
pub fn verify_in_sidecar_dir(sidecar_dir: &Path) -> PiExtensionVerdict {
    let extension = sidecar_dir
        .join("pi-extension")
        .join("cognia-pi-extension.ts");
    if !extension.is_file() {
        return PiExtensionVerdict::Missing;
    }
    let path = extension.display().to_string();

    let actual = match std::fs::read(&extension) {
        Ok(bytes) => digest_bytes(&bytes),
        Err(error) => {
            return PiExtensionVerdict::Unreadable {
                path,
                detail: error.to_string(),
            }
        }
    };

    let manifest = sidecar_dir.join("pi-extension").join("integrity.json");
    let expected = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(|v| v.to_ascii_lowercase())
        });

    match expected {
        None => PiExtensionVerdict::Unpinned {
            path,
            sha256: actual,
        },
        Some(expected) if expected != actual => PiExtensionVerdict::Tampered {
            path,
            expected,
            actual,
        },
        Some(_) => PiExtensionVerdict::Ok {
            path,
            sha256: actual,
        },
    }
}

/// Resolve and verify the bundled Pi extension on this desktop host.
///
/// Returns a verdict rather than an error for every "we looked and it is not
/// usable" case: the adapter turns that into a refused session with a message
/// naming the cause, which `extension_handshake_failed` could not do (it could
/// not tell "never shipped" from "tampered" from "timed out").
#[tauri::command]
pub fn resolve_pi_extension(app: AppHandle) -> Result<PiExtensionVerdict, String> {
    let dir: PathBuf = crate::claude::sidecar::sidecar_dir(&app)?;
    Ok(verify_in_sidecar_dir(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, contents: &str) {
        let target = dir.join("pi-extension");
        std::fs::create_dir_all(&target).expect("mkdir");
        std::fs::write(target.join(name), contents).expect("write");
    }

    #[test]
    fn missing_extension_is_reported_not_guessed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            verify_in_sidecar_dir(tmp.path()),
            PiExtensionVerdict::Missing
        );
    }

    #[test]
    fn a_matching_digest_verifies() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "cognia-pi-extension.ts", "export const x = 1\n");
        let sha = digest_bytes(b"export const x = 1\n");
        write(
            tmp.path(),
            "integrity.json",
            &format!("{{\"sha256\":\"{sha}\"}}"),
        );

        match verify_in_sidecar_dir(tmp.path()) {
            PiExtensionVerdict::Ok { sha256, .. } => assert_eq!(sha256, sha),
            other => panic!("expected ok, got {other:?}"),
        }
    }

    /// The case the pin exists for: a substituted extension would otherwise
    /// take charge of the permission gate.
    #[test]
    fn an_edited_extension_is_tampered() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "cognia-pi-extension.ts", "malicious()\n");
        write(
            tmp.path(),
            "integrity.json",
            &format!("{{\"sha256\":\"{}\"}}", digest_bytes(b"original\n")),
        );

        match verify_in_sidecar_dir(tmp.path()) {
            PiExtensionVerdict::Tampered {
                expected, actual, ..
            } => assert_ne!(expected, actual),
            other => panic!("expected tampered, got {other:?}"),
        }
    }

    /// Stripping the manifest must not be a way to bypass the pin.
    #[test]
    fn a_missing_or_malformed_manifest_is_unpinned_never_ok() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "cognia-pi-extension.ts", "export const x = 1\n");
        assert!(matches!(
            verify_in_sidecar_dir(tmp.path()),
            PiExtensionVerdict::Unpinned { .. }
        ));

        write(tmp.path(), "integrity.json", "not json at all");
        assert!(matches!(
            verify_in_sidecar_dir(tmp.path()),
            PiExtensionVerdict::Unpinned { .. }
        ));

        write(tmp.path(), "integrity.json", "{\"sha256\": 42}");
        assert!(matches!(
            verify_in_sidecar_dir(tmp.path()),
            PiExtensionVerdict::Unpinned { .. }
        ));
    }

    #[test]
    fn a_pinned_digest_compares_case_insensitively() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "cognia-pi-extension.ts", "export const x = 1\n");
        let sha = digest_bytes(b"export const x = 1\n").to_uppercase();
        write(
            tmp.path(),
            "integrity.json",
            &format!("{{\"sha256\":\"{sha}\"}}"),
        );
        assert!(matches!(
            verify_in_sidecar_dir(tmp.path()),
            PiExtensionVerdict::Ok { .. }
        ));
    }

    /// The renderer deserializes this as the same tagged union the CLI emits.
    #[test]
    fn verdicts_serialize_with_the_shared_tagged_shape() {
        let value = serde_json::to_value(PiExtensionVerdict::Ok {
            path: "/x/cognia-pi-extension.ts".into(),
            sha256: "abc".into(),
        })
        .expect("serialize");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["path"], "/x/cognia-pi-extension.ts");
        assert_eq!(value["sha256"], "abc");

        let missing = serde_json::to_value(PiExtensionVerdict::Missing).expect("serialize");
        assert_eq!(missing["status"], "missing");
    }
}
