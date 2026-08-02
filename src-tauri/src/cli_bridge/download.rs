//! On-demand download + verification of the `cognia` plugin-author CLI
//! from GitHub Releases.
//!
//! Flow (`download_cognia_cli`):
//!   1. Resolve the target triple from the host OS/arch.
//!   2. Fetch `<base>/cognia-<triple>.tar.gz`, its `.sig`, and `checksums.txt`.
//!   3. Verify the SHA-256 against `checksums.txt`.
//!   4. Verify the Ed25519 signature against the embedded release key
//!      (skipped, with a warning, while the key is the all-zero placeholder).
//!   5. Extract to `<dest>/cognia/cli/<version>/` (dest defaults to app data,
//!      overridable by the caller) and chmod +x on unix.
//!   6. Register the install dir so `detect_binary("cognia")` finds it, and
//!      invalidate the detection cache so the UI reflects the new install.
//!
//! Progress is emitted on the `download_cognia_cli_progress` Tauri event so
//! the install dialog can render a bar.

use ::anyhow::{anyhow, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

use super::detect;
use super::release_key;

/// Default GitHub repo to pull releases from. Overridable per-call so a
/// fork / enterprise mirror can point elsewhere without a rebuild.
const DEFAULT_REPO: &str = "MaxQian888/cognia-next";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub version: String,
    pub install_dir: String,
    pub binary_path: String,
    /// True when the Ed25519 signature was actually verified (false while
    /// the embedded key is the placeholder — SHA-256 still enforced).
    pub signature_verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    stage: String,
    /// 0.0–1.0 for the download stage; None for discrete stages.
    progress: Option<f64>,
    message: String,
}

fn emit_progress(app: &tauri::AppHandle, stage: &str, progress: Option<f64>, message: &str) {
    let _ = app.emit(
        "download_cognia_cli_progress",
        ProgressEvent {
            stage: stage.to_string(),
            progress,
            message: message.to_string(),
        },
    );
}

/// Resolve the release target triple for the current host. Returns an
/// error on an unsupported OS/arch combo so the UI can show a clear
/// "no prebuilt binary for your platform — build from source" message.
pub fn resolve_target_triple() -> Result<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => return Err(anyhow!("unsupported arch: {other}")),
    };
    let suffix = match std::env::consts::OS {
        "windows" => "pc-windows-msvc",
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-gnu",
        other => return Err(anyhow!("unsupported os: {other}")),
    };
    Ok(format!("{arch}-{suffix}"))
}

/// Artifact file name for a triple. Kept in one place so the URL builder
/// and the checksum lookup agree.
pub fn artifact_name(triple: &str) -> String {
    format!("cognia-{triple}.tar.gz")
}

/// The on-disk executable name once extracted.
fn binary_file_name() -> &'static str {
    if cfg!(windows) {
        "cognia.exe"
    } else {
        "cognia"
    }
}

/// Parse a `checksums.txt` (`<sha256hex>  <filename>` per line, the
/// `sha256sum` format) and return the digest for `artifact`.
pub fn checksum_for(checksums: &str, artifact: &str) -> Option<String> {
    for line in checksums.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Format: "<hex>␠␠<name>" — split on whitespace, last token is the
        // file (may be prefixed with `*` in binary mode).
        let mut parts = line.split_whitespace();
        let hex = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name == artifact {
            return Some(hex.to_lowercase());
        }
    }
    None
}

/// Compute the lowercase hex SHA-256 of a byte buffer.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verify a detached Ed25519 signature over `bytes` using the embedded
/// release public key. Returns Ok(true) on a good signature, Ok(false)
/// when the embedded key is still the placeholder (caller decides policy),
/// Err on a real verification failure or malformed inputs.
pub fn verify_release_signature(bytes: &[u8], signature: &[u8]) -> Result<bool> {
    use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};

    if release_key::is_placeholder_key() {
        return Ok(false);
    }
    let pk_arr = release_key::release_public_key_bytes()?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr).context("invalid release key")?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = signature
        .try_into()
        .map_err(|_| anyhow!("signature must be {SIGNATURE_LENGTH} bytes"))?;
    let sig = Signature::from_bytes(&sig_arr);
    verifying_key
        .verify_strict(bytes, &sig)
        .map(|_| true)
        .map_err(|e| anyhow!("signature verification failed: {e}"))
}

/// Extract a gzip-compressed tarball into `dest`, returning the path of
/// the extracted `cognia` executable. Skips entries whose path would
/// escape `dest`.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<PathBuf> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    std::fs::create_dir_all(dest)?;
    let gz = GzDecoder::new(bytes);
    let mut archive = Archive::new(gz);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        // tar entries are relative; reject traversal.
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let out = dest.join(&path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&out)?;
    }
    let binary = dest.join(binary_file_name());
    if !binary.exists() {
        return Err(anyhow!(
            "extracted archive did not contain {}",
            binary_file_name()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary, perms)?;
    }
    Ok(binary)
}

/// IPC surface — download + verify + install the `cognia` CLI.
///
/// `release_tag` defaults to `latest`. `repo` defaults to the canonical
/// repo. `target_dir` overrides the install root (the user's chosen
/// download location); when omitted we use `<app_data>/cognia/cli`.
#[tauri::command]
pub async fn download_cognia_cli(
    app: tauri::AppHandle,
    release_tag: Option<String>,
    repo: Option<String>,
    target_dir: Option<String>,
) -> Result<DownloadResult, String> {
    download_inner(&app, release_tag, repo, target_dir)
        .await
        .map_err(|e| {
            log::warn!("download_cognia_cli failed: {e:#}");
            e.to_string()
        })
}

async fn download_inner(
    app: &tauri::AppHandle,
    release_tag: Option<String>,
    repo: Option<String>,
    target_dir: Option<String>,
) -> Result<DownloadResult> {
    let repo = repo.unwrap_or_else(|| DEFAULT_REPO.to_string());
    let tag = release_tag.unwrap_or_else(|| "latest".to_string());
    let triple = resolve_target_triple()?;
    let artifact = artifact_name(&triple);

    // GitHub's `latest` redirect lives at /releases/latest/download/<name>;
    // a pinned tag lives at /releases/download/<tag>/<name>.
    let base = if tag == "latest" {
        format!("https://github.com/{repo}/releases/latest/download")
    } else {
        format!("https://github.com/{repo}/releases/download/{tag}")
    };
    let artifact_url = format!("{base}/{artifact}");
    let sig_url = format!("{base}/{artifact}.sig");
    let checksums_url = format!("{base}/checksums.txt");

    let client = reqwest::Client::builder()
        .user_agent("cognia-desktop")
        .build()
        .context("build http client")?;

    emit_progress(app, "downloading", Some(0.0), "Downloading cognia CLI…");
    let artifact_bytes = fetch_bytes(&client, &artifact_url)
        .await
        .with_context(|| format!("download {artifact_url}"))?;
    emit_progress(app, "downloading", Some(0.7), "Verifying checksum…");

    // SHA-256 check (always enforced).
    let checksums = fetch_text(&client, &checksums_url)
        .await
        .with_context(|| format!("download {checksums_url}"))?;
    let expected = checksum_for(&checksums, &artifact)
        .ok_or_else(|| anyhow!("no checksum for {artifact} in checksums.txt"))?;
    let actual = sha256_hex(&artifact_bytes);
    if actual != expected {
        return Err(anyhow!(
            "checksum mismatch for {artifact}: expected {expected}, got {actual}"
        ));
    }

    // Ed25519 signature check (skipped while the key is the placeholder).
    emit_progress(app, "verifying", None, "Verifying signature…");
    let mut signature_verified = false;
    if release_key::is_placeholder_key() {
        log::warn!(
            "cognia CLI download: release signing key is a placeholder; \
             skipping Ed25519 verification (SHA-256 enforced)"
        );
    } else {
        let sig_bytes = fetch_bytes(&client, &sig_url)
            .await
            .with_context(|| format!("download {sig_url}"))?;
        // Signatures may be raw 64 bytes or base64; normalize.
        let sig = normalize_signature(&sig_bytes)?;
        signature_verified = verify_release_signature(&artifact_bytes, &sig)?;
        if !signature_verified {
            return Err(anyhow!("signature did not verify"));
        }
    }

    // Resolve the install root. We can't easily learn the published
    // version from the artifact name (it's keyed by triple, not version),
    // so we use the resolved tag as the version label; `latest` becomes a
    // stable "latest" dir that each download overwrites.
    let version_label = if tag == "latest" {
        "latest".to_string()
    } else {
        tag.clone()
    };
    let root = match target_dir {
        Some(dir) => PathBuf::from(dir),
        None => app
            .path()
            .app_data_dir()
            .context("resolve app data dir")?
            .join("cognia")
            .join("cli"),
    };
    let install_dir = root.join(&version_label);
    if install_dir.exists() {
        std::fs::remove_dir_all(&install_dir).ok();
    }

    emit_progress(app, "extracting", None, "Installing…");
    let binary_path = extract_tar_gz(&artifact_bytes, &install_dir)?;

    // Make subsequent detection find the managed copy + refresh the UI.
    detect::register_managed_dir(install_dir.clone());
    detect::invalidate("cognia");

    // The durable terminal host is a separate process and cannot see the
    // in-process managed-dir registry, so push the new PATH view across. Only
    // shells spawned from here on pick it up — a live PTY's environment was
    // fixed at `execve`.
    crate::terminal_host_bridge::resync_terminal_host_path(app).await;

    emit_progress(app, "done", Some(1.0), "Installed");
    Ok(DownloadResult {
        version: version_label,
        install_dir: install_dir.to_string_lossy().into_owned(),
        binary_path: binary_path.to_string_lossy().into_owned(),
        signature_verified,
    })
}

/// Accept either a raw 64-byte signature or a base64-encoded one.
fn normalize_signature(bytes: &[u8]) -> Result<Vec<u8>> {
    use base64::Engine as _;
    if bytes.len() == 64 {
        return Ok(bytes.to_vec());
    }
    // Try base64 (GitHub release `.sig` files are often base64 text).
    let text = std::str::from_utf8(bytes).context("signature is neither raw 64 bytes nor utf8")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(text.trim().as_bytes())
        .context("decode base64 signature")?;
    Ok(decoded)
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let resp = client.get(url).send().await?.error_for_status()?;
    Ok(resp.bytes().await?.to_vec())
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String> {
    let resp = client.get(url).send().await?.error_for_status()?;
    Ok(resp.text().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_target_triple_is_nonempty_on_this_host() {
        // On the CI/dev host this resolves; on an exotic arch it errors —
        // either way it shouldn't panic.
        let r = resolve_target_triple();
        if let Ok(t) = r {
            assert!(t.contains('-'));
        }
    }

    #[test]
    fn artifact_name_includes_triple() {
        assert_eq!(
            artifact_name("x86_64-pc-windows-msvc"),
            "cognia-x86_64-pc-windows-msvc.tar.gz"
        );
    }

    #[test]
    fn checksum_for_parses_sha256sum_format() {
        let checksums = "\
abc123  cognia-x86_64-pc-windows-msvc.tar.gz
def456  cognia-aarch64-apple-darwin.tar.gz
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
    fn checksum_for_handles_binary_star_prefix() {
        let checksums = "deadbeef *cognia-x86_64-unknown-linux-gnu.tar.gz\n";
        assert_eq!(
            checksum_for(checksums, "cognia-x86_64-unknown-linux-gnu.tar.gz"),
            Some("deadbeef".to_string())
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
    fn verify_release_signature_returns_false_for_placeholder_key() {
        // With the placeholder key, verification is "not provisioned" → false,
        // not an error.
        let result = verify_release_signature(b"payload", &[0u8; 64]).unwrap();
        assert!(!result);
    }

    #[test]
    fn normalize_signature_accepts_raw_64_bytes() {
        let raw = vec![1u8; 64];
        assert_eq!(normalize_signature(&raw).unwrap(), raw);
    }

    #[test]
    fn normalize_signature_decodes_base64() {
        use base64::Engine as _;
        let raw = vec![7u8; 64];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(normalize_signature(b64.as_bytes()).unwrap(), raw);
    }
}
