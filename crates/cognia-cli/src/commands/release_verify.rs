//! `cognia release-verify` - verify downloaded CLI release artifacts.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::engine::release_key;
use crate::ui::{style, RuntimeUi};

const ACTION: &str = "release-verify";
const STATUS_VERIFIED: &str = "verified";
const STATUS_SKIPPED_PLACEHOLDER: &str = "skipped-placeholder-key";
const STATUS_NOT_CHECKED: &str = "not-checked";
const STATUS_MISSING: &str = "missing";
const STATUS_INVALID: &str = "invalid";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ReleaseVerifyJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    artifact: String,
    #[serde(rename = "artifactName")]
    artifact_name: String,
    checksums: String,
    #[serde(rename = "expectedSha256")]
    expected_sha256: Option<String>,
    #[serde(rename = "actualSha256")]
    actual_sha256: String,
    #[serde(rename = "checksumVerified")]
    checksum_verified: bool,
    signature: Option<String>,
    #[serde(rename = "signatureVerified")]
    signature_verified: bool,
    #[serde(rename = "signatureStatus")]
    signature_status: &'static str,
    #[serde(rename = "releaseKeyPlaceholder")]
    release_key_placeholder: bool,
    #[serde(rename = "releaseKeyFingerprint")]
    release_key_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn run(
    artifact: PathBuf,
    checksums: PathBuf,
    artifact_name: Option<String>,
    signature: Option<PathBuf>,
    json: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let payload = verify_release_artifact(&artifact, &checksums, artifact_name, signature)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        print_human(&payload);
    }
    if payload.error.is_some() && json {
        return Err(crate::shared::JsonFailureExit.into());
    }
    if let Some(error) = &payload.error {
        bail!("{error}");
    }
    Ok(())
}

fn verify_release_artifact(
    artifact: &Path,
    checksums: &Path,
    artifact_name: Option<String>,
    signature: Option<PathBuf>,
) -> Result<ReleaseVerifyJsonPayload> {
    let release_key_placeholder = release_key::is_placeholder_key();
    let release_key_fingerprint = release_key::release_key_fingerprint_hex()?;
    let artifact_name = match artifact_name.or_else(|| {
        artifact
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }) {
        Some(artifact_name) => artifact_name,
        None => {
            return Ok(release_verify_payload(
                artifact,
                checksums,
                String::new(),
                String::new(),
                release_key_placeholder,
                release_key_fingerprint,
                Some(format!(
                    "artifact name is required for {}; pass --artifact-name",
                    artifact.display()
                )),
            ));
        }
    };
    if let Err(err) = validate_artifact_name(&artifact_name) {
        return Ok(release_verify_payload(
            artifact,
            checksums,
            artifact_name,
            String::new(),
            release_key_placeholder,
            release_key_fingerprint,
            Some(err.to_string()),
        ));
    }
    let artifact_bytes = match std::fs::read(artifact) {
        Ok(bytes) => bytes,
        Err(err) => {
            return Ok(release_verify_payload(
                artifact,
                checksums,
                artifact_name,
                String::new(),
                release_key_placeholder,
                release_key_fingerprint,
                Some(format!("read {}: {err}", artifact.display())),
            ));
        }
    };
    let checksums_text = match std::fs::read_to_string(checksums) {
        Ok(text) => text,
        Err(err) => {
            let actual_sha256 = sha256_hex(&artifact_bytes);
            return Ok(release_verify_payload(
                artifact,
                checksums,
                artifact_name,
                actual_sha256,
                release_key_placeholder,
                release_key_fingerprint,
                Some(format!("read {}: {err}", checksums.display())),
            ));
        }
    };
    let actual_sha256 = sha256_hex(&artifact_bytes);
    let expected_sha256 = checksum_for(&checksums_text, &artifact_name);
    let checksum_verified = expected_sha256
        .as_deref()
        .map(|expected| actual_sha256 == expected)
        .unwrap_or(false);
    let signature_path = signature.unwrap_or_else(|| sig_path_for(artifact));
    let mut payload = ReleaseVerifyJsonPayload {
        schema_version: 1,
        ok: false,
        action: ACTION,
        artifact: artifact.display().to_string(),
        artifact_name,
        checksums: checksums.display().to_string(),
        expected_sha256,
        actual_sha256,
        checksum_verified,
        signature: None,
        signature_verified: false,
        signature_status: STATUS_NOT_CHECKED,
        release_key_placeholder,
        release_key_fingerprint,
        error: None,
    };

    if payload.expected_sha256.is_none() {
        payload.error = Some(format!(
            "no checksum for {} in {}",
            payload.artifact_name, payload.checksums
        ));
        return Ok(payload);
    }

    if !payload.checksum_verified {
        let expected = payload.expected_sha256.as_deref().unwrap_or("<missing>");
        payload.error = Some(format!(
            "checksum mismatch for {}: expected {}, got {}",
            payload.artifact_name, expected, payload.actual_sha256
        ));
        return Ok(payload);
    }

    if payload.release_key_placeholder {
        payload.ok = true;
        payload.signature_status = STATUS_SKIPPED_PLACEHOLDER;
        return Ok(payload);
    }

    payload.signature = Some(signature_path.display().to_string());
    let sig_bytes = match std::fs::read(&signature_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            payload.signature_status = if err.kind() == ErrorKind::NotFound {
                STATUS_MISSING
            } else {
                STATUS_INVALID
            };
            payload.error = Some(format!("read {}: {err}", signature_path.display()));
            return Ok(payload);
        }
    };
    let normalized = match normalize_signature(&sig_bytes) {
        Ok(signature) => signature,
        Err(err) => {
            payload.signature_status = STATUS_INVALID;
            payload.error = Some(err.to_string());
            return Ok(payload);
        }
    };
    if let Err(err) = verify_release_signature(&artifact_bytes, &normalized) {
        payload.signature_status = STATUS_INVALID;
        payload.error = Some(err.to_string());
        return Ok(payload);
    }
    payload.ok = true;
    payload.signature_verified = true;
    payload.signature_status = STATUS_VERIFIED;
    Ok(payload)
}

fn release_verify_payload(
    artifact: &Path,
    checksums: &Path,
    artifact_name: String,
    actual_sha256: String,
    release_key_placeholder: bool,
    release_key_fingerprint: String,
    error: Option<String>,
) -> ReleaseVerifyJsonPayload {
    ReleaseVerifyJsonPayload {
        schema_version: 1,
        ok: false,
        action: ACTION,
        artifact: artifact.display().to_string(),
        artifact_name,
        checksums: checksums.display().to_string(),
        expected_sha256: None,
        actual_sha256,
        checksum_verified: false,
        signature: None,
        signature_verified: false,
        signature_status: STATUS_NOT_CHECKED,
        release_key_placeholder,
        release_key_fingerprint,
        error,
    }
}

fn validate_artifact_name(artifact_name: &str) -> Result<()> {
    let trimmed = artifact_name.trim();
    if trimmed.is_empty() {
        bail!("artifact name is required; pass --artifact-name with a release asset filename");
    }
    if trimmed != artifact_name {
        bail!("artifact name must not include leading or trailing whitespace: {artifact_name:?}");
    }
    if artifact_name == "." || artifact_name == ".." {
        bail!("artifact name must be a release asset filename, not {artifact_name:?}");
    }
    if artifact_name.contains('/') || artifact_name.contains('\\') {
        bail!("artifact name must be a release asset filename, not a path: {artifact_name}");
    }
    Ok(())
}

fn checksum_for(checksums: &str, artifact: &str) -> Option<String> {
    for line in checksums.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hex) = parts.next() else {
            continue;
        };
        let Some(name) = parts.next() else {
            continue;
        };
        let name = name.trim_start_matches('*');
        if name == artifact {
            return Some(hex.to_lowercase());
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn sig_path_for(artifact: &Path) -> PathBuf {
    let mut path = artifact.to_path_buf();
    let name = artifact
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.set_file_name(format!("{name}.sig"));
    path
}

fn normalize_signature(bytes: &[u8]) -> Result<Vec<u8>> {
    use base64::Engine as _;
    if bytes.len() == 64 {
        return Ok(bytes.to_vec());
    }
    let text = std::str::from_utf8(bytes).context("signature is neither raw 64 bytes nor utf8")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(text.trim().as_bytes())
        .context("decode base64 signature")?;
    Ok(decoded)
}

fn verify_release_signature(bytes: &[u8], signature: &[u8]) -> Result<()> {
    use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};

    let pk_arr = release_key::release_public_key_bytes()?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr).context("invalid release key")?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = signature
        .try_into()
        .map_err(|_| anyhow!("signature must be {SIGNATURE_LENGTH} bytes"))?;
    let sig = Signature::from_bytes(&sig_arr);
    verifying_key
        .verify_strict(bytes, &sig)
        .map_err(|e| anyhow!("signature verification failed: {e}"))?;
    Ok(())
}

fn print_human(payload: &ReleaseVerifyJsonPayload) {
    println!("{}Release artifact verification", style::bold("cognia "));
    println!("  artifact:   {}", payload.artifact);
    println!("  name:       {}", payload.artifact_name);
    println!("  checksums:  {}", payload.checksums);
    if payload.checksum_verified {
        println!("  checksum:   {}", style::ok("verified"));
    } else {
        println!("  checksum:   {}", style::error("mismatch"));
    }
    let expected_sha256 = payload.expected_sha256.as_deref().unwrap_or("<missing>");
    println!("  expected:   {}", style::dim(expected_sha256));
    println!("  actual:     {}", style::dim(&payload.actual_sha256));
    println!("  signature:  {}", payload.signature_status);
    println!(
        "  release key: {}",
        if payload.release_key_placeholder {
            style::warn("placeholder")
        } else {
            style::ok("provisioned")
        }
    );
    println!(
        "  fingerprint: {}",
        style::dim(&payload.release_key_fingerprint)
    );
    if let Some(error) = &payload.error {
        eprintln!("{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn checksum_for_parses_sha256sum_format() {
        let checksums = "\
abc123  cognia-x86_64-pc-windows-msvc.tar.gz
def456 *cognia-aarch64-apple-darwin.tar.gz
";
        assert_eq!(
            checksum_for(checksums, "cognia-x86_64-pc-windows-msvc.tar.gz"),
            Some("abc123".to_string())
        );
        assert_eq!(
            checksum_for(checksums, "cognia-aarch64-apple-darwin.tar.gz"),
            Some("def456".to_string())
        );
        assert_eq!(checksum_for(checksums, "missing.tar.gz"), None);
    }

    #[test]
    fn checksum_for_skips_malformed_lines_before_matching_artifact() {
        let checksums = "\
missing-filename-token
abc123  cognia-x86_64-pc-windows-msvc.tar.gz
";

        assert_eq!(
            checksum_for(checksums, "cognia-x86_64-pc-windows-msvc.tar.gz"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn normalize_signature_accepts_raw_64_bytes() {
        let raw = vec![7u8; 64];
        assert_eq!(normalize_signature(&raw).unwrap(), raw);
    }

    #[test]
    fn normalize_signature_decodes_base64_text() {
        use base64::Engine as _;

        let raw = vec![9u8; 64];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);

        assert_eq!(normalize_signature(encoded.as_bytes()).unwrap(), raw);
    }

    #[test]
    fn verify_release_artifact_reports_checksum_mismatch_as_payload() {
        let tmp = tempdir().unwrap();
        let artifact = tmp.path().join("cognia-test.tar.gz");
        std::fs::write(&artifact, b"artifact").unwrap();
        let checksums = tmp.path().join("checksums.txt");
        std::fs::write(
            &checksums,
            format!("{}  cognia-test.tar.gz\n", "0".repeat(64)),
        )
        .unwrap();

        let payload = verify_release_artifact(&artifact, &checksums, None, None).unwrap();

        assert!(!payload.ok);
        assert!(!payload.checksum_verified);
        assert_eq!(payload.actual_sha256, sha256_hex(b"artifact"));
        assert!(payload
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("checksum mismatch"));
    }

    #[test]
    fn verify_release_artifact_rejects_invalid_artifact_name_override() {
        let tmp = tempdir().unwrap();
        let artifact = tmp.path().join("downloaded.tar.gz");
        let bytes = b"artifact";
        std::fs::write(&artifact, bytes).unwrap();
        let checksums = tmp.path().join("checksums.txt");
        std::fs::write(
            &checksums,
            format!("{}  cognia-test.tar.gz\n", sha256_hex(bytes)),
        )
        .unwrap();

        for artifact_name in [
            "",
            "   ",
            "dist/cognia-test.tar.gz",
            r"dist\cognia-test.tar.gz",
        ] {
            let payload = verify_release_artifact(
                &artifact,
                &checksums,
                Some(artifact_name.to_string()),
                None,
            )
            .unwrap();

            assert!(!payload.ok, "invalid name should fail: {artifact_name:?}");
            assert_eq!(payload.artifact_name, artifact_name);
            assert_eq!(payload.expected_sha256, None);
            assert_eq!(payload.actual_sha256, "");
            assert_eq!(payload.signature_status, STATUS_NOT_CHECKED);
            assert!(
                payload
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("artifact name"),
                "payload should carry artifact-name validation error for {artifact_name:?}: {payload:?}"
            );
        }
    }

    #[test]
    fn verify_release_artifact_skips_signature_for_placeholder_key() {
        let tmp = tempdir().unwrap();
        let artifact = tmp.path().join("cognia-test.tar.gz");
        let bytes = b"artifact";
        std::fs::write(&artifact, bytes).unwrap();
        let checksums = tmp.path().join("checksums.txt");
        std::fs::write(
            &checksums,
            format!("{}  cognia-test.tar.gz\n", sha256_hex(bytes)),
        )
        .unwrap();

        let payload = verify_release_artifact(&artifact, &checksums, None, None).unwrap();

        assert!(payload.ok);
        assert!(payload.checksum_verified);
        assert_eq!(payload.signature, None);
        assert_eq!(payload.signature_status, STATUS_SKIPPED_PLACEHOLDER);
        assert!(!payload.signature_verified);
        assert!(payload.release_key_placeholder);
    }
}
