//! On-demand download + verification of the pinned `code-server` (browser
//! VS Code) standalone tarball from GitHub Releases, for the optional desktop
//! "Pro IDE" mode.
//!
//! Flow (`ensure_code_server`):
//!   1. Resolve `(os, arch)` for the host (linux/macos × amd64/arm64). Windows
//!      and every other target error out — code-server ships no standalone
//!      binary there, so the UI gates the feature off.
//!   2. If the pinned version is already installed, return it (no network).
//!   3. Stream `code-server-<ver>-<os>-<arch>.tar.gz` to a `.partial` file,
//!      hashing chunks and emitting `codeserver://download-progress`.
//!   4. Verify the SHA-256 against the **embedded** per-asset constant. Unlike
//!      the `cognia` CLI, code-server publishes no `checksums.txt`, so we pin
//!      the version and bake the known-good digests in (see `expected_sha256`).
//!      Bumping `CODE_SERVER_VERSION` requires refreshing that table.
//!   5. Extract into `<app_data>/cognia/code-server/<ver>/` (stripping the
//!      tarball's leading `code-server-<ver>-<os>-<arch>/` component) and
//!      chmod +x the launcher on unix.

use ::anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

/// Cancellation handle for an in-flight first-run download.
///
/// The first run pulls 100–200MB, and until now there was no way out of it: a
/// mis-click committed the user to the whole transfer. Cancellation is modelled
/// as a `Notify` raced against the streaming future rather than a flag polled
/// inside it, because the streaming loop lives in the shared `cognia_net`
/// helper (also used by the Open VSX fetch) and must not grow a code-server
/// specific check. Dropping the future is what actually aborts the HTTP stream.
#[derive(Default)]
pub struct DownloadCancel {
    notify: Notify,
}

impl DownloadCancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Ask any in-flight download to stop. No-op when none is running.
    pub fn cancel(&self) {
        self.notify.notify_waiters();
    }
}

/// Raised when the user cancelled the download. Distinguished from a transport
/// failure so the UI can go quiet instead of showing a retryable error.
#[derive(Debug, thiserror::Error)]
#[error("code-server download cancelled")]
pub struct DownloadCancelled;

/// Pinned code-server release. Bumping this REQUIRES updating `expected_sha256`
/// with the new per-asset digests (from
/// `gh api repos/coder/code-server/releases/tags/v<ver> --jq '.assets[].digest'`).
pub const CODE_SERVER_VERSION: &str = "4.128.0";

/// GitHub repo the standalone tarballs are published under.
const CODE_SERVER_REPO: &str = "coder/code-server";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub version: String,
    pub install_dir: String,
    pub binary_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    stage: String,
    /// Bytes written so far (download stage).
    bytes_done: u64,
    /// Best-effort total from `Content-Length`; 0 when unknown.
    bytes_total: u64,
    message: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    stage: &str,
    bytes_done: u64,
    bytes_total: u64,
    msg: &str,
) {
    // Best-effort — never fail the install because a listener detached.
    let _ = app.emit(
        "codeserver://download-progress",
        ProgressEvent {
            stage: stage.to_string(),
            bytes_done,
            bytes_total,
            message: msg.to_string(),
        },
    );
}

/// Resolve the `(os, arch)` tokens code-server uses in its release asset names.
/// Returns an error on every combination that has no prebuilt standalone
/// tarball (Windows, and any exotic arch), so the caller can surface a clear
/// "use your local VS Code instead" message.
pub fn resolve_platform() -> Result<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "macos",
        other => {
            return Err(anyhow!(
                "code-server has no standalone binary for {other}; the Pro IDE mode is desktop macOS/Linux only"
            ))
        }
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => return Err(anyhow!("unsupported arch for code-server: {other}")),
    };
    Ok((os, arch))
}

/// Release asset file name for the pinned version + platform.
pub fn asset_name(os: &str, arch: &str) -> String {
    format!("code-server-{CODE_SERVER_VERSION}-{os}-{arch}.tar.gz")
}

/// Download URL for the pinned version + platform.
pub fn download_url(os: &str, arch: &str) -> String {
    format!(
        "https://github.com/{CODE_SERVER_REPO}/releases/download/v{CODE_SERVER_VERSION}/{}",
        asset_name(os, arch)
    )
}

/// Embedded SHA-256 digests for the pinned release's standalone tarballs.
/// Source: `gh api repos/coder/code-server/releases/tags/v4.128.0`.
/// Keep in lockstep with `CODE_SERVER_VERSION`.
pub fn expected_sha256(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "amd64") => {
            Some("79ba26bf186e5268a22b7c17b30a5f288a16c37791f0b86c27859e8fef103188")
        }
        ("linux", "arm64") => {
            Some("f8f02c2a81d1a433a4d132716a6f0405f690f6d70dd955942e95e87356db8a10")
        }
        ("macos", "amd64") => {
            Some("4c002ff4ccfe62b3865eb1403f3fd80029fac3b5579fa04b59d13f334978400d")
        }
        ("macos", "arm64") => {
            Some("72326a25a8171b508e02b9c956daf29459801fe01ddd0b67ef2bf2ad4a212092")
        }
        _ => None,
    }
}

/// The launcher script inside an extracted install (`<dir>/bin/code-server`).
pub fn binary_path_in(install_dir: &Path) -> PathBuf {
    install_dir.join("bin").join("code-server")
}

/// Root under which every pinned version is installed:
/// `<app_data>/cognia/code-server`.
pub fn code_server_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .context("resolve app data dir")?
        .join("cognia")
        .join("code-server"))
}

/// Install dir for the pinned version: `<root>/<version>`.
pub fn install_dir_for(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(code_server_root(app)?.join(CODE_SERVER_VERSION))
}

/// Sibling directories of the version installs that hold code-server's own
/// state (`process::state_subdir`), never reclaimable as "old versions".
const STATE_DIRS: [&str; 2] = ["user-data", "extensions"];

/// Install + disk state for the Pro IDE settings card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerDiskUsage {
    /// The pinned version this build installs.
    pub version: String,
    pub root: String,
    /// Whether the pinned version's launcher is present on disk.
    pub installed: bool,
    /// Every byte under the code-server root: installs plus user-data.
    pub total_bytes: u64,
    /// Bytes held by non-pinned installs and abandoned `.partial` downloads.
    pub reclaimable_bytes: u64,
    /// Directory names of the non-pinned versions still on disk.
    pub stale_versions: Vec<String>,
}

/// Recursive size of `path`, following no symlinks (a code-server tarball ships
/// them, and following would both double-count and risk a loop).
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += dir_size(&entry.path());
        } else if file_type.is_file() {
            total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    total
}

/// Paths under the root that a cleanup may delete: installs of other versions
/// and leftover partial downloads. The pinned install and the state dirs are
/// never included.
fn reclaimable_paths(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == CODE_SERVER_VERSION || STATE_DIRS.contains(&name.as_ref()) {
                return false;
            }
            entry.file_type().is_ok_and(|kind| {
                !kind.is_symlink() && (kind.is_dir() || name.ends_with(".partial"))
            })
        })
        .map(|entry| entry.path())
        .collect()
}

/// Snapshot the install for the settings card. Never fails on a missing root —
/// "nothing installed yet" is a normal state, reported as zeroes.
pub fn disk_usage(app: &tauri::AppHandle) -> Result<CodeServerDiskUsage> {
    let root = code_server_root(app)?;
    let reclaimable = reclaimable_paths(&root);
    Ok(CodeServerDiskUsage {
        version: CODE_SERVER_VERSION.to_string(),
        installed: binary_path_in(&install_dir_for(app)?).exists(),
        total_bytes: dir_size(&root),
        reclaimable_bytes: reclaimable.iter().map(|p| dir_size(p)).sum(),
        stale_versions: reclaimable
            .iter()
            .filter(|p| p.is_dir())
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect(),
        root: root.to_string_lossy().into_owned(),
    })
}

/// Delete non-pinned installs and partial downloads, or — when `everything` —
/// the whole code-server root including the pinned install and user data.
/// Returns the bytes freed.
pub fn uninstall(app: &tauri::AppHandle, everything: bool) -> Result<u64> {
    let root = code_server_root(app)?;
    if !root.exists() {
        return Ok(0);
    }
    if everything {
        let freed = dir_size(&root);
        std::fs::remove_dir_all(&root).context("remove code-server root")?;
        return Ok(freed);
    }
    remove_paths(reclaimable_paths(&root))
}

fn remove_paths(paths: impl IntoIterator<Item = PathBuf>) -> Result<u64> {
    let mut freed = 0;
    for path in paths {
        let size = dir_size(&path);
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.with_context(|| format!("remove {}", path.display()))?;
        freed += size;
    }
    Ok(freed)
}

/// Strip the leading path component (the `code-server-<ver>-<os>-<arch>/`
/// wrapper dir) and reject anything that would escape via `..`. Returns `None`
/// for entries to skip (the bare wrapper dir, or a traversal attempt).
fn safe_stripped_path(path: &Path) -> Option<PathBuf> {
    let stripped: PathBuf = path.components().skip(1).collect();
    if stripped.as_os_str().is_empty() {
        return None;
    }
    if stripped
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(stripped)
}

/// Extract a gzip tarball at `archive` into `dest`, stripping the leading path
/// component so the launcher lands at `<dest>/bin/code-server`. Traversal
/// entries are skipped (belt-and-suspenders on top of `tar`'s own guard).
fn extract_tar_gz_strip1(archive: &Path, dest: &Path) -> Result<()> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    std::fs::create_dir_all(dest)?;
    let file = std::fs::File::open(archive)?;
    let gz = GzDecoder::new(std::io::BufReader::new(file));
    let mut tar = Archive::new(gz);
    tar.set_preserve_permissions(true);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Some(stripped) = safe_stripped_path(&path) else {
            continue;
        };
        let out = dest.join(&stripped);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&out)?;
    }
    Ok(())
}

/// Ensure the pinned code-server is installed, downloading + verifying it on
/// first use. Idempotent: a present install short-circuits with no network.
pub async fn ensure_code_server(
    app: &tauri::AppHandle,
    cancel: Option<Arc<DownloadCancel>>,
) -> Result<InstallInfo> {
    let (os, arch) = resolve_platform()?;
    let install_dir = install_dir_for(app)?;
    let binary = binary_path_in(&install_dir);

    if binary.exists() {
        return Ok(InstallInfo {
            version: CODE_SERVER_VERSION.to_string(),
            install_dir: install_dir.to_string_lossy().into_owned(),
            binary_path: binary.to_string_lossy().into_owned(),
        });
    }

    let expected = expected_sha256(os, arch)
        .ok_or_else(|| anyhow!("no pinned checksum for code-server {os}-{arch}"))?;
    let url = download_url(os, arch);

    let root = code_server_root(app)?;
    std::fs::create_dir_all(&root).context("create code-server root")?;
    let partial = root.join(format!("{CODE_SERVER_VERSION}-{os}-{arch}.tar.gz.partial"));

    // 1. Stream to the .partial file, hashing as we go.
    emit_progress(
        app,
        "downloading",
        0,
        0,
        "Downloading VS Code (code-server)…",
    );
    let actual = match stream_to_file(app, &url, &partial, cancel).await {
        Ok(digest) => digest,
        Err(err) => {
            // Either way the `.partial` is dead weight: there is no resume
            // support, so a leftover would just occupy disk until the next
            // successful run overwrote it.
            let _ = std::fs::remove_file(&partial);
            if err.is::<DownloadCancelled>() {
                emit_progress(app, "cancelled", 0, 0, "Download cancelled");
            }
            return Err(err).with_context(|| format!("download {url}"));
        }
    };

    // 2. Verify against the embedded digest before touching the install dir.
    emit_progress(app, "verifying", 0, 0, "Verifying download…");
    if actual != expected {
        let _ = std::fs::remove_file(&partial);
        return Err(anyhow!(
            "code-server checksum mismatch: expected {expected}, got {actual}"
        ));
    }

    // 3. Extract into a fresh install dir (remove a half-baked prior attempt).
    emit_progress(app, "extracting", 0, 0, "Installing…");
    if install_dir.exists() {
        std::fs::remove_dir_all(&install_dir).ok();
    }
    extract_tar_gz_strip1(&partial, &install_dir).context("extract code-server")?;
    let _ = std::fs::remove_file(&partial);

    if !binary.exists() {
        return Err(anyhow!("extracted archive did not contain bin/code-server"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary, perms)?;
    }

    emit_progress(app, "done", 0, 0, "Installed");
    Ok(InstallInfo {
        version: CODE_SERVER_VERSION.to_string(),
        install_dir: install_dir.to_string_lossy().into_owned(),
        binary_path: binary.to_string_lossy().into_owned(),
    })
}

/// GET `url`, streaming the body into `dest`, and return the lowercase hex
/// SHA-256 of what was written. Emits per-chunk download progress.
///
/// The streaming loop itself lives in `cognia_net::http_download` — it is
/// shared with the Open VSX `.vsix` fetch. This wrapper supplies only the
/// code-server policy: the user agent, and where progress is emitted. No byte
/// ceiling: the asset is a pinned release whose digest is baked in, so its
/// size is known-good rather than attacker-chosen.
async fn stream_to_file(
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
    cancel: Option<Arc<DownloadCancel>>,
) -> Result<String> {
    let client = reqwest::Client::builder()
        .user_agent("cognia-desktop")
        .build()
        .context("build http client")?;

    // Bound to a `let` rather than passed inline: the future is held across a
    // `select!` below, so the closure must outlive the statement that built it.
    let mut on_progress = |bytes_done: u64, bytes_total: u64| {
        emit_progress(app, "downloading", bytes_done, bytes_total, "Downloading…");
    };
    let download =
        cognia_net::http_download::stream_to_file(&client, url, dest, None, &mut on_progress);

    // Race rather than poll: dropping the streaming future on the cancel branch
    // is what tears down the HTTP connection. A flag checked between chunks
    // would leave the socket open until the next chunk arrived, which on a
    // stalled transfer is exactly when the user is most likely to cancel.
    let outcome = match cancel {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.notify.notified() => return Err(DownloadCancelled.into()),
                result = download => result,
            }
        }
        None => download.await,
    }
    .with_context(|| format!("stream {url} to {}", dest.display()))?;

    Ok(outcome.sha256_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pending `cancel()` must be observed by a waiter that is already
    /// parked — this is the whole contract the `select!` in `stream_to_file`
    /// relies on.
    #[tokio::test]
    async fn cancel_wakes_a_parked_waiter() {
        let token = DownloadCancel::new();
        let waiter = token.clone();

        let parked = tokio::spawn(async move {
            waiter.notify.notified().await;
            true
        });
        // Give the task a chance to reach the await before signalling.
        tokio::task::yield_now().await;
        token.cancel();

        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), parked)
                .await
                .expect("cancel did not wake the waiter")
                .unwrap()
        );
    }

    /// `notify_waiters` only reaches waiters that are already parked, so a
    /// cancel with nothing downloading must simply evaporate rather than arm
    /// the next download. The UI fires this button without checking first.
    #[tokio::test]
    async fn cancel_with_no_download_in_flight_is_inert() {
        let token = DownloadCancel::new();
        token.cancel();

        let waiter = token.clone();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            async move { waiter.notify.notified().await },
        )
        .await;

        assert!(result.is_err(), "a stale cancel armed the next download");
    }

    /// Build a plausible code-server root: the pinned install, an older one,
    /// both state dirs, and an abandoned partial download.
    fn seed_root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for version in [CODE_SERVER_VERSION, "4.100.0"] {
            let bin = root.join(version).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("code-server"), vec![b'x'; 10]).unwrap();
        }
        for state in STATE_DIRS {
            std::fs::create_dir_all(root.join(state)).unwrap();
            std::fs::write(root.join(state).join("settings.json"), vec![b'y'; 5]).unwrap();
        }
        std::fs::write(
            root.join("4.128.0-macos-arm64.tar.gz.partial"),
            vec![b'z'; 7],
        )
        .unwrap();
        dir
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let dir = seed_root();
        // 2 installs × 10B + 2 state files × 5B + 7B partial.
        assert_eq!(dir_size(dir.path()), 10 + 10 + 5 + 5 + 7);
    }

    #[test]
    fn dir_size_of_a_missing_path_is_zero() {
        assert_eq!(dir_size(Path::new("/definitely/not/here/xyzzy")), 0);
    }

    #[cfg(unix)]
    #[test]
    fn dir_size_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("data"), vec![b'x'; 7]).unwrap();
        symlink(dir.path(), dir.path().join("cycle")).unwrap();

        assert_eq!(dir_size(dir.path()), 7);
    }

    #[test]
    fn partial_cleanup_propagates_removal_errors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("already-gone.partial");

        let error = remove_paths([missing]).unwrap_err();

        assert!(error.to_string().contains("already-gone.partial"));
    }

    #[test]
    fn reclaimable_skips_the_pinned_install_and_state_dirs() {
        let dir = seed_root();
        let names: Vec<String> = reclaimable_paths(dir.path())
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(names.contains(&"4.100.0".to_string()));
        assert!(names.contains(&"4.128.0-macos-arm64.tar.gz.partial".to_string()));
        // Never reclaim what we are about to run, or the user's editor state.
        assert!(!names.contains(&CODE_SERVER_VERSION.to_string()));
        for state in STATE_DIRS {
            assert!(!names.contains(&state.to_string()));
        }
    }

    #[test]
    fn reclaimable_paths_of_a_missing_root_is_empty() {
        assert!(reclaimable_paths(Path::new("/definitely/not/here/xyzzy")).is_empty());
    }

    #[test]
    fn resolve_platform_does_not_panic() {
        // Ok on linux/macos, Err elsewhere — never panics.
        let _ = resolve_platform();
    }

    #[test]
    fn asset_name_matches_code_server_scheme() {
        assert_eq!(
            asset_name("macos", "arm64"),
            "code-server-4.128.0-macos-arm64.tar.gz"
        );
    }

    #[test]
    fn download_url_points_at_pinned_tag() {
        assert_eq!(
            download_url("linux", "amd64"),
            "https://github.com/coder/code-server/releases/download/v4.128.0/code-server-4.128.0-linux-amd64.tar.gz"
        );
    }

    #[test]
    fn expected_sha256_present_for_every_supported_combo() {
        for (os, arch) in [
            ("linux", "amd64"),
            ("linux", "arm64"),
            ("macos", "amd64"),
            ("macos", "arm64"),
        ] {
            let d = expected_sha256(os, arch).expect("digest for supported combo");
            assert_eq!(d.len(), 64, "sha256 hex is 64 chars for {os}-{arch}");
            assert!(d.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn expected_sha256_absent_for_unsupported() {
        assert!(expected_sha256("windows", "amd64").is_none());
        assert!(expected_sha256("linux", "riscv").is_none());
    }

    #[test]
    fn binary_path_is_bin_code_server() {
        let p = binary_path_in(Path::new("/tmp/cs/4.128.0"));
        assert!(p.ends_with("bin/code-server"));
    }

    #[test]
    fn safe_stripped_path_drops_wrapper_and_keeps_nested() {
        assert_eq!(
            safe_stripped_path(Path::new("code-server-4.128.0-macos-arm64/bin/code-server")),
            Some(PathBuf::from("bin/code-server"))
        );
        assert_eq!(
            safe_stripped_path(Path::new("wrapper/lib/node")),
            Some(PathBuf::from("lib/node"))
        );
    }

    #[test]
    fn safe_stripped_path_rejects_traversal_and_bare_root() {
        // Bare wrapper dir (nothing left after strip) → skip.
        assert_eq!(safe_stripped_path(Path::new("wrapper")), None);
        // Traversal attempt surviving the strip → skip.
        assert_eq!(safe_stripped_path(Path::new("wrapper/../../evil")), None);
        assert_eq!(
            safe_stripped_path(Path::new("w/a/../../../etc/passwd")),
            None
        );
    }

    #[test]
    fn extract_strips_leading_component() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write as _;

        // Build a tiny gz tarball: wrapper/bin/code-server + wrapper/lib/node.
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, payload) in [
                (
                    "code-server-4.128.0-macos-arm64/bin/code-server",
                    &b"#!/bin/sh\necho hi\n"[..],
                ),
                ("code-server-4.128.0-macos-arm64/lib/node", &b"NODE"[..]),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(payload.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, payload).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut gz = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut gz, Compression::fast());
            enc.write_all(&tar_buf).unwrap();
            enc.finish().unwrap();
        }

        let dir = std::env::temp_dir().join(format!("cs-extract-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let archive = dir.join("a.tar.gz");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&archive, &gz).unwrap();

        extract_tar_gz_strip1(&archive, &dir.join("out")).unwrap();

        // Leading component stripped → files land under `out/` directly.
        assert!(dir.join("out").join("bin").join("code-server").exists());
        assert!(dir.join("out").join("lib").join("node").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
