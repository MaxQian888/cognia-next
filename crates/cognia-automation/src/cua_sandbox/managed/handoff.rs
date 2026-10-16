//! Immutable source transfer for ADR-0228. Host callers authorize the delivery
//! and own a read-only GitProxy for the entire preparation future. No browser
//! path, upstream URL, credential or arbitrary command enters this API.
//! Host Git transfer requires Unix process-group isolation; unsupported Hosts
//! fail closed before spawning Git, including Windows until tree cleanup exists.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use cognia_e2b::envd::{DesktopBootstrap, ProcessEvent, ProcessInput, StartSpec};
use cognia_desktop_guest::source_tree::{self, SourceTreeBuilder, SourceTreeEntry, SourceTreeProof};
use cognia_desktop_guest::observation::{ObservationPhase, ProcessBoundaryReport};
use cognia_exec_sandbox::proc_group::{apply_process_group, kill_process_group};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

pub const MAX_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_ACCEPTANCE_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_ACCEPTANCE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ACCEPTANCE_FILES: usize = 100;
const MAX_STAGING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

/// Constructed only after a durable delivery/revision/source authorization.
/// Deliberately not Deserialize: client payloads cannot assert this authority.
pub struct TrustedHandoffSource {
    pub commit: String,
    pub readonly_proxy_port: u16,
    pub recovery: Option<RecoverySource>,
}
#[derive(Clone)]
pub struct RecoverySource {
    pub path: PathBuf,
    pub trusted_root: PathBuf,
    pub expected_sha256: Option<String>,
}
#[derive(Clone)]
pub struct HandoffBudget {
    pub deadline_at_ms: i64,
    pub cancel: watch::Receiver<bool>,
}
impl HandoffBudget {
    pub fn check(&self) -> Result<()> {
        if *self.cancel.borrow() { return Err("managed_handoff_cancelled".into()); }
        if chrono::Utc::now().timestamp_millis() >= self.deadline_at_ms {
            return Err("managed_handoff_deadline".into());
        }
        Ok(())
    }
    async fn run<T>(&self, work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        self.check()?;
        let mut cancelled = self.cancel.clone();
        let wait_cancel = async move {
            loop {
                if *cancelled.borrow() { break; }
                // Losing the operation owner revokes transfer authority.
                if cancelled.changed().await.is_err() { break; }
            }
        };
        let remaining = (self.deadline_at_ms - chrono::Utc::now().timestamp_millis()).max(0) as u64;
        tokio::select! {
            answer = work => { self.check()?; answer }
            _ = wait_cancel => Err("managed_handoff_cancelled".into()),
            _ = tokio::time::sleep(Duration::from_millis(remaining)) => Err("managed_handoff_deadline".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffLaunch { pub script: String }
pub fn parse_launch(argv: &[String]) -> Result<Option<HandoffLaunch>> {
    if argv.is_empty() { return Ok(None); }
    if argv.len() != 3 || argv[0] != "npm" || argv[1] != "run"
        || argv[2].is_empty() || argv[2].len() > 100
        || !argv[2].bytes().next().is_some_and(|b| b.is_ascii_alphanumeric() || b"_:".contains(&b))
        || !argv[2].bytes().all(|b| b.is_ascii_alphanumeric() || b"_:.-".contains(&b))
    { return Err("managed_handoff_launch_invalid".into()); }
    Ok(Some(HandoffLaunch { script: argv[2].clone() }))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferFile { path: String, bytes: u64, sha256: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferManifest {
    version: u32,
    commit: String,
    bundle_bytes: u64,
    bundle_sha256: String,
    source_tree_sha256: String,
    source_file_count: u64,
    source_bytes: u64,
    files: Vec<TransferFile>,
}
struct HandoffStaging(Option<tempfile::TempDir>);
impl HandoffStaging {
    fn path(&self) -> &Path { self.0.as_ref().expect("live handoff staging").path() }
}
impl Drop for HandoffStaging {
    fn drop(&mut self) {
        if let Some(directory) = self.0.take() {
            // Recursive deletion may be large. Keep ownership inside the
            // blocking worker so runtime cancellation cannot orphan the tree.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(move || drop(directory));
            } else {
                drop(directory);
            }
        }
    }
}
pub struct PreparedHandoff {
    // TempDir removes all partial objects and selected files on every outcome.
    staging: Arc<HandoffStaging>,
    manifest: TransferManifest,
    digest: String,
    recovery: bool,
}
impl PreparedHandoff {
    pub fn manifest_digest(&self) -> &str { &self.digest }
    pub fn commit(&self) -> &str { &self.manifest.commit }
    pub(crate) fn mode(&self) -> &'static str { if self.recovery { "bundle" } else { "commit" } }
    pub(crate) fn validate_installed(&self, installed: &InstalledHandoff, operation: &str) -> Result<()> {
        validate_receipt(installed, operation, &self.manifest, &self.digest, true)
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledHandoff {
    pub receipt_version: u32,
    pub boundary_generation: String,
    pub source_tree_sha256: String,
    pub source_file_count: u64,
    pub source_bytes: u64,
    pub operation_id: String,
    pub commit: String,
    pub manifest_digest: String,
    pub workspace: String,
    pub launched: bool,
    pub importer_boundary: ProcessBoundaryReport,
    pub acceptance_boundary: Option<ProcessBoundaryReport>,
}
fn hash(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }
fn object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn acceptance_path(path: &str) -> Result<()> {
    let value = Path::new(path);
    if path.is_empty() || path.len() > 1024 || path.contains('\\')
        || path.chars().any(char::is_control) || value.is_absolute()
        || path.split('/').any(|s| s.is_empty() || s == "." || s == "..")
        || value.components().any(|c| !matches!(c, Component::Normal(_)))
    { return Err("managed_handoff_file_path_invalid".into()); }
    for part in path.split('/') {
        let part = part.to_ascii_lowercase();
        if part == ".git" || part == ".env" || part.starts_with(".env.")
            || matches!(part.as_str(), ".ssh" | ".aws" | ".npmrc" | ".pypirc" | ".netrc" | "credentials" | "cookies" | "cookies.sqlite" | "login data" | "local state" | "id_rsa" | "id_ed25519")
            || part.ends_with(".pem") || part.ends_with(".key")
        { return Err("managed_handoff_secret_file_refused".into()); }
    }
    Ok(())
}
fn io_error(_: impl std::fmt::Display) -> String { "managed_handoff_io_failed".into() }
fn git_command(root: &Path, args: &[&str]) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command.env_clear().env("PATH", "/usr/bin:/bin")
        .env("HOME", root).env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/false").env("GIT_NO_REPLACE_OBJECTS", "1")
        .arg("-c").arg("core.hooksPath=/dev/null")
        .arg("-c").arg("protocol.file.allow=never")
        .arg("-c").arg("http.followRedirects=false")
        .arg("-c").arg("credential.helper=")
        .args(args).current_dir(root).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    command
}
fn staging_size_blocking(root: &Path) -> Result<u64> {
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0_u64;
    let mut entries = 0_usize;
    while let Some(path) = pending.pop() {
        let directory = match std::fs::read_dir(path) {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error(error)),
        };
        for item in directory {
            let item = item.map_err(io_error)?;
            // Git atomically removes lock/temporary pack files during a walk.
            let metadata = match std::fs::symlink_metadata(item.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(io_error(error)),
            };
            let meta = metadata.file_type();
            entries += 1;
            if entries > 100_000 { return Err("managed_handoff_staging_limit".into()); }
            if meta.is_dir() { pending.push(item.path()); }
            else if meta.is_file() { bytes = bytes.saturating_add(metadata.len()); }
            else { return Err("managed_handoff_special_file".into()); }
            if bytes > MAX_STAGING_BYTES { return Err("managed_handoff_staging_limit".into()); }
        }
    }
    Ok(bytes)
}
struct GitRepository {
    path: PathBuf,
    staging: Arc<HandoffStaging>,
}
async fn staging_size(repository: &GitRepository) -> Result<u64> {
    let root = repository.path.clone();
    let owner = repository.staging.clone();
    tokio::task::spawn_blocking(move || {
        // Keep the directory alive if cancellation drops the JoinHandle while
        // this bounded walk is still running on the blocking pool.
        let _owner = owner;
        staging_size_blocking(&root)
    }).await.map_err(io_error)?
}
async fn git(repository: &GitRepository, args: &[&str], limit: u64, budget: &HandoffBudget) -> Result<Vec<u8>> {
    run_git_command(repository, git_command(&repository.path, args), limit, budget).await
}
struct GitProcessGroup(Option<u32>);
impl Drop for GitProcessGroup {
    fn drop(&mut self) {
        // The leader can exit before its fetch/index-pack descendants. Keep
        // the original group ID and kill it even on successful leader exit.
        kill_process_group(self.0);
    }
}
async fn run_git_command(repository: &GitRepository, mut command: tokio::process::Command, limit: u64, budget: &HandoffBudget) -> Result<Vec<u8>> {
    // The shared primitive is a no-op on Windows. Do not start a transfer
    // whose descendants cannot be stopped when its authority is revoked.
    if !cfg!(unix) { return Err("managed_handoff_process_isolation_unavailable".into()); }
    budget.run(async {
        apply_process_group(&mut command);
        command.kill_on_drop(true);
        let mut process = command.spawn().map_err(io_error)?;
        // Declared after the Child so group cleanup runs before leader drop
        // on cancellation, deadline, read/size errors, and future abortion.
        let _process_group = GitProcessGroup(process.id());
        let stdout = process.stdout.take().ok_or("managed_handoff_git_failed")?;
        let mut limited = stdout.take(limit + 1);
        let mut output = Vec::new();
        {
            let collect = async { limited.read_to_end(&mut output).await.map_err(io_error) };
            tokio::pin!(collect);
            loop {
                tokio::select! {
                    read = &mut collect => { read?; break; }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => { staging_size(repository).await?; }
                }
            }
        }
        if output.len() as u64 > limit { return Err("managed_handoff_git_output_limit".into()); }
        let status = loop {
            tokio::select! {
                status = process.wait() => break status.map_err(io_error)?,
                _ = tokio::time::sleep(Duration::from_millis(100)) => { staging_size(repository).await?; }
            }
        };
        if !status.success() { return Err("managed_handoff_git_failed".into()); }
        staging_size(repository).await?;
        Ok(output)
    }).await
}

struct SourceBlob {
    path: Vec<u8>,
    executable: bool,
    bytes: u64,
    object_id: String,
}
fn source_tree_error(_: impl std::fmt::Display) -> String { "managed_handoff_source_tree_invalid".into() }
fn parse_source_tree_listing(listing: &[u8]) -> Result<Vec<SourceBlob>> {
    if listing.len() > source_tree::MAX_SOURCE_METADATA_BYTES || (!listing.is_empty() && listing.last() != Some(&0)) {
        return Err("managed_handoff_source_tree_limit".into());
    }
    let mut entries = Vec::new();
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    let mut metadata = 0_usize;
    if listing.is_empty() { return Ok(entries); }
    for record in listing[..listing.len() - 1].split(|byte| *byte == 0) {
        let separator = record.iter().position(|byte| *byte == b'\t').ok_or("managed_handoff_source_tree_invalid")?;
        let fields = record[..separator].split(|byte| *byte == b' ').filter(|field| !field.is_empty()).collect::<Vec<_>>();
        if fields.len() != 4 { return Err("managed_handoff_source_tree_invalid".into()); }
        let executable = source_tree::git_executable(fields[0], fields[1]).map_err(source_tree_error)?;
        let id = std::str::from_utf8(fields[2]).map_err(source_tree_error)?;
        if !object_id(id) || fields[3].is_empty() || !fields[3].iter().all(u8::is_ascii_digit) {
            return Err("managed_handoff_source_tree_invalid".into());
        }
        let bytes = std::str::from_utf8(fields[3]).map_err(source_tree_error)?.parse::<u64>().map_err(source_tree_error)?;
        let path = record[separator + 1..].to_vec();
        source_tree::validate_path(&path).map_err(source_tree_error)?;
        if !names.insert(path.clone()) { return Err("managed_handoff_source_tree_invalid".into()); }
        total = total.checked_add(bytes).ok_or("managed_handoff_source_tree_limit")?;
        metadata = metadata.checked_add(path.len() * 2 + 45).ok_or("managed_handoff_source_tree_limit")?;
        if entries.len() >= source_tree::MAX_SOURCE_FILES || total > source_tree::MAX_SOURCE_BYTES
            || metadata > source_tree::MAX_SOURCE_METADATA_BYTES {
            return Err("managed_handoff_source_tree_limit".into());
        }
        entries.push(SourceBlob { path, executable, bytes, object_id: id.into() });
    }
    for path in &names {
        if path.iter().enumerate().any(|(index, byte)| *byte == b'/' && names.contains(&path[..index])) {
            return Err("managed_handoff_source_tree_invalid".into());
        }
    }
    Ok(entries)
}

async fn source_tree_proof(repository: &GitRepository, commit: &str, budget: &HandoffBudget) -> Result<SourceTreeProof> {
    let listing = git(repository, &["ls-tree", "-r", "-z", "--full-tree", "-l", commit],
        source_tree::MAX_SOURCE_METADATA_BYTES as u64, budget).await?;
    let entries = parse_source_tree_listing(&listing)?;
    drop(listing);
    budget.check()?;
    if entries.is_empty() { return SourceTreeBuilder::new().finish().map_err(source_tree_error); }
    // One bounded raw-object reader avoids both checkout filters and buffering
    // a potentially multi-gigabyte source file in the Host process.
    budget.run(async {
        let mut command = git_command(&repository.path, &["cat-file", "--batch"]);
        command.stdin(Stdio::piped());
        apply_process_group(&mut command);
        let mut process = command.spawn().map_err(io_error)?;
        let _process_group = GitProcessGroup(process.id());
        let mut input = process.stdin.take().ok_or("managed_handoff_git_failed")?;
        let mut output = tokio::io::BufReader::new(process.stdout.take().ok_or("managed_handoff_git_failed")?);
        let mut proof = SourceTreeBuilder::new();
        let mut buffer = vec![0; 64 * 1024];
        for entry in entries {
            budget.check()?;
            input.write_all(format!("{}\n", entry.object_id).as_bytes()).await.map_err(io_error)?;
            let mut header = Vec::new();
            loop {
                let byte = output.read_u8().await.map_err(io_error)?;
                header.push(byte);
                if header.len() > 128 { return Err("managed_handoff_source_tree_invalid".into()); }
                if byte == b'\n' { break; }
            }
            if header != format!("{} blob {}\n", entry.object_id, entry.bytes).as_bytes() {
                return Err("managed_handoff_source_tree_invalid".into());
            }
            let mut remaining = entry.bytes;
            let mut content = Sha256::new();
            while remaining > 0 {
                budget.check()?;
                let count = remaining.min(buffer.len() as u64) as usize;
                output.read_exact(&mut buffer[..count]).await.map_err(io_error)?;
                content.update(&buffer[..count]);
                remaining -= count as u64;
            }
            if output.read_u8().await.map_err(io_error)? != b'\n' { return Err("managed_handoff_source_tree_invalid".into()); }
            proof.push(SourceTreeEntry { path: entry.path, executable: entry.executable, bytes: entry.bytes,
                content_sha256: content.finalize().into() }).map_err(source_tree_error)?;
        }
        drop(input);
        if output.read(&mut buffer[..1]).await.map_err(io_error)? != 0 { return Err("managed_handoff_source_tree_invalid".into()); }
        if !process.wait().await.map_err(io_error)?.success() { return Err("managed_handoff_git_failed".into()); }
        staging_size(repository).await?;
        proof.finish().map_err(source_tree_error)
    }).await
}
async fn fetch(repository: &GitRepository, port: u16, commit: &str, budget: &HandoffBudget) -> Result<()> {
    if port == 0 || !object_id(commit) { return Err("managed_handoff_source_invalid".into()); }
    let url = format!("http://127.0.0.1:{port}/repo.git");
    git(repository, &["fetch", "--no-tags", "--no-write-fetch-head", "--", &url, commit], 4096, budget).await?;
    Ok(())
}
fn open_recovery(source: &RecoverySource) -> Result<(std::fs::File, u64)> {
    let root = source.trusted_root.canonicalize().map_err(io_error)?;
    let path = source.path.canonicalize().map_err(io_error)?;
    if !path.starts_with(&root) || path == root { return Err("managed_handoff_bundle_path_invalid".into()); }
    let relative = source.path.strip_prefix(&source.trusted_root).map_err(|_| "managed_handoff_bundle_path_invalid")?;
    let mut check = source.trusted_root.clone();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) { return Err("managed_handoff_bundle_path_invalid".into()); }
        check.push(component);
        if std::fs::symlink_metadata(&check).map_err(io_error)?.file_type().is_symlink() {
            return Err("managed_handoff_bundle_path_invalid".into());
        }
    }
    let meta = std::fs::symlink_metadata(&path).map_err(io_error)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BUNDLE_BYTES {
        return Err("managed_handoff_bundle_limit".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0);
    }
    let opened_file = options.open(&path).map_err(io_error)?;
    let opened = opened_file.metadata().map_err(io_error)?;
    if opened.len() != meta.len() || !opened.is_file() { return Err("managed_handoff_bundle_changed".into()); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() { return Err("managed_handoff_bundle_changed".into()); }
    }
    Ok::<_, String>((opened_file, meta.len()))
}
async fn copy_recovery(source: &RecoverySource, destination: &Path, budget: &HandoffBudget) -> Result<String> {
    let owned_source = source.clone();
    let (opened_file, source_len) = budget.run(async {
        tokio::task::spawn_blocking(move || open_recovery(&owned_source)).await.map_err(io_error)?
    }).await?;
    let mut input = tokio::fs::File::from_std(opened_file);
    let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(destination).await.map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        budget.check()?;
        let read = budget.run(async { input.read(&mut buffer).await.map_err(io_error) }).await?;
        if read == 0 { break; }
        total += read as u64;
        if total > MAX_BUNDLE_BYTES { return Err("managed_handoff_bundle_limit".into()); }
        digest.update(&buffer[..read]);
        output.write_all(&buffer[..read]).await.map_err(io_error)?;
    }
    if total != source_len { return Err("managed_handoff_bundle_changed".into()); }
    let digest = hex::encode(digest.finalize());
    if source.expected_sha256.as_ref().is_some_and(|expected| expected != &digest) {
        return Err("managed_handoff_bundle_hash_mismatch".into());
    }
    output.sync_all().await.map_err(io_error)?;
    Ok(digest)
}
fn bundle_prerequisites(header: &[u8]) -> Result<Vec<String>> {
    let mut lines = header.split(|b| *b == b'\n');
    if !matches!(lines.next(), Some(b"# v2 git bundle") | Some(b"# v3 git bundle")) {
        return Err("managed_handoff_bundle_invalid".into());
    }
    let mut prerequisites = BTreeSet::new();
    for line in lines {
        if line.is_empty() { return Ok(prerequisites.into_iter().collect()); }
        if let Some(line) = line.strip_prefix(b"-") {
            let id = std::str::from_utf8(line.split(|b| *b == b' ').next().unwrap_or_default())
                .map_err(|_| "managed_handoff_bundle_invalid")?;
            if !object_id(id) || prerequisites.len() >= 256 { return Err("managed_handoff_bundle_invalid".into()); }
            prerequisites.insert(id.to_string());
        }
    }
    Err("managed_handoff_bundle_invalid".into())
}

struct StagingReservation {
    parent: Option<PathBuf>,
    minimum_free_bytes: u64,
    reserve_bytes: u64,
}

pub async fn prepare_source(source: &TrustedHandoffSource, acceptance_paths: &[String], budget: &HandoffBudget) -> Result<PreparedHandoff> {
    prepare_source_with_reservation(source, acceptance_paths, budget, StagingReservation {
        parent: None,
        minimum_free_bytes: MAX_STAGING_BYTES * 2,
        reserve_bytes: MAX_BUNDLE_BYTES * 2 + MAX_ACCEPTANCE_BYTES,
    }).await
}

// Only disk capacity/location is injected for tiny offline fixtures; validation,
// fetching, object reconstruction, selection, hashing and cleanup stay identical.
async fn prepare_source_with_reservation(
    source: &TrustedHandoffSource, acceptance_paths: &[String], budget: &HandoffBudget,
    reservation_policy: StagingReservation,
) -> Result<PreparedHandoff> {
    budget.check()?;
    if !object_id(&source.commit) || source.readonly_proxy_port == 0 { return Err("managed_handoff_source_invalid".into()); }
    if acceptance_paths.len() > MAX_ACCEPTANCE_FILES { return Err("managed_handoff_file_limit".into()); }
    let mut names = BTreeSet::new();
    for name in acceptance_paths {
        acceptance_path(name)?;
        if !names.insert(name) { return Err("managed_handoff_file_duplicate".into()); }
    }
    let staging = budget.run(async {
        tokio::task::spawn_blocking(move || {
            let mut builder = tempfile::Builder::new();
            builder.prefix("cognia-acceptance-");
            let staging = match reservation_policy.parent {
                Some(parent) => builder.tempdir_in(parent),
                None => builder.tempdir(),
            }.map_err(io_error)?;
            // Reserve real blocks before transfer. The worker owns TempDir until
            // allocation completes even if cancellation drops its JoinHandle.
            if fs2::available_space(staging.path()).map_err(io_error)? < reservation_policy.minimum_free_bytes {
                return Err("managed_handoff_disk_unavailable".into());
            }
            let reservation = std::fs::OpenOptions::new().write(true).create_new(true)
                .open(staging.path().join(".reservation")).map_err(io_error)?;
            fs2::FileExt::allocate(&reservation, reservation_policy.reserve_bytes).map_err(io_error)?;
            Ok::<_, String>(Arc::new(HandoffStaging(Some(staging))))
        }).await.map_err(io_error)?
    }).await?;
    // Reservation is outside the recursively monitored bare repository.
    let repo = GitRepository { path: staging.path().join("repository"), staging: staging.clone() };
    tokio::fs::create_dir(&repo.path).await.map_err(io_error)?;
    let format = if source.commit.len() == 64 { "--object-format=sha256" } else { "--object-format=sha1" };
    git(&repo, &["init", "--bare", format, "."], 4096, budget).await?;
    if let Some(recovery) = &source.recovery {
        let bundle = staging.path().join("recovery.bundle");
        copy_recovery(recovery, &bundle, budget).await?;
        let mut header = Vec::new();
        tokio::fs::File::open(&bundle).await.map_err(io_error)?.take(128 * 1024).read_to_end(&mut header).await.map_err(io_error)?;
        for prerequisite in bundle_prerequisites(&header)? {
            fetch(&repo, source.readonly_proxy_port, &prerequisite, budget).await?;
        }
        let path = bundle.to_str().ok_or("managed_handoff_bundle_path_invalid")?;
        git(&repo, &["bundle", "verify", path], 4096, budget).await?;
        git(&repo, &["bundle", "unbundle", path], 1024 * 1024, budget).await?;
    } else { fetch(&repo, source.readonly_proxy_port, &source.commit, budget).await?; }
    let commit_expr = format!("{}^{{commit}}", source.commit);
    let verified = git(&repo, &["rev-parse", "--verify", &commit_expr], 100, budget).await?;
    if verified != format!("{}\n", source.commit).as_bytes() { return Err("managed_handoff_commit_mismatch".into()); }
    let source_tree = source_tree_proof(&repo, &source.commit, budget).await?;
    git(&repo, &["update-ref", "refs/cognia/acceptance", &source.commit], 4096, budget).await?;
    let bundle = repo.path.join("source.bundle");
    git(&repo, &["bundle", "create", bundle.to_str().ok_or("managed_handoff_io_failed")?, "refs/cognia/acceptance"], 4096, budget).await?;
    let size = tokio::fs::metadata(&bundle).await.map_err(io_error)?.len();
    if size == 0 || size > MAX_BUNDLE_BYTES { return Err("managed_handoff_bundle_limit".into()); }
    let digest = file_hash(&bundle, MAX_BUNDLE_BYTES, budget).await?;
    tokio::fs::rename(&bundle, staging.path().join("source.bundle")).await.map_err(io_error)?;
    let mut files = Vec::new();
    let mut total = 0_u64;
    for (index, name) in acceptance_paths.iter().enumerate() {
        let tree = git(&repo, &["ls-tree", "-z", &source.commit, "--", name], 2048, budget).await?;
        let expected = format!("\t{name}\0");
        if !(tree.starts_with(b"100644 blob ") || tree.starts_with(b"100755 blob "))
            || !tree.ends_with(expected.as_bytes()) || tree.iter().filter(|b| **b == 0).count() != 1
        { return Err("managed_handoff_special_file".into()); }
        let bytes = git(&repo, &["show", &format!("{}:{name}", source.commit)], MAX_ACCEPTANCE_FILE_BYTES, budget).await?;
        total += bytes.len() as u64;
        if total > MAX_ACCEPTANCE_BYTES { return Err("managed_handoff_file_limit".into()); }
        files.push(TransferFile { path: name.clone(), bytes: bytes.len() as u64, sha256: hash(&bytes) });
        tokio::fs::write(staging.path().join(format!("file-{index}")), &bytes).await.map_err(io_error)?;
    }
    // The confined importer and native promotion independently verify this
    // Host-derived raw tree proof before acknowledging the handoff.
    let manifest = TransferManifest { version: 2, commit: source.commit.clone(), bundle_bytes: size, bundle_sha256: digest,
        source_tree_sha256: source_tree.source_tree_sha256, source_file_count: source_tree.source_file_count,
        source_bytes: source_tree.source_bytes, files };
    let digest = hash(&serde_json::to_vec(&manifest).map_err(io_error)?);
    budget.check()?;
    Ok(PreparedHandoff { staging, manifest, digest, recovery: source.recovery.is_some() })
}
async fn file_hash(path: &Path, max: u64, budget: &HandoffBudget) -> Result<String> {
    let mut input = tokio::fs::File::open(path).await.map_err(io_error)?;
    let mut buffer = vec![0; 64 * 1024];
    let mut total = 0;
    let mut digest = Sha256::new();
    loop {
        budget.check()?;
        let n = input.read(&mut buffer).await.map_err(io_error)?;
        if n == 0 { break; }
        total += n as u64;
        if total > max { return Err("managed_handoff_bundle_limit".into()); }
        digest.update(&buffer[..n]);
    }
    Ok(hex::encode(digest.finalize()))
}

/// Installs only our fixed program. Any error after dispatch has an uncertain
/// guest outcome: the owning service MUST quarantine and destroy that desktop.
pub async fn install_on_desktop(
    bootstrap: &DesktopBootstrap,
    prepared: &PreparedHandoff,
    operation_id: &str,
    launch: Option<&HandoffLaunch>,
    budget: &HandoffBudget,
) -> Result<InstalledHandoff> {
    if uuid::Uuid::parse_str(operation_id).map(|id| id.to_string()).ok().as_deref() != Some(operation_id) {
        return Err("managed_handoff_operation_invalid".into());
    }
    if let Some(launch) = launch {
        parse_launch(&["npm".into(), "run".into(), launch.script.clone()])?;
    }
    let spec = StartSpec {
        cmd: "/usr/local/bin/cognia-desktop-guest".into(),
        args: vec!["handoff".into()],
        envs: BTreeMap::new(), cwd: Some("/".into()), stdin: true,
    };
    budget.run(async {
        let mut stream = cognia_e2b::envd::start_protected(bootstrap, &spec).await
            .map_err(|_| "managed_handoff_guest_unavailable")?;
        let pid = match stream.next_event().await.map_err(|_| "managed_handoff_guest_unavailable")? {
            Some(ProcessEvent::Start { pid }) if pid > 0 => pid,
            _ => return Err("managed_handoff_guest_protocol".into()),
        };
        let input = ProcessInput::for_desktop(bootstrap, pid).map_err(|_| "managed_handoff_guest_unavailable")?;
        let send = async {
            let manifest_json = serde_json::to_string(&prepared.manifest).map_err(io_error)?;
            let mut header = serde_json::to_vec(&serde_json::json!({
                "operationId": operation_id, "manifest": manifest_json,
                "manifestDigest": prepared.digest, "deadlineAtMs": budget.deadline_at_ms,
                "launch": launch,
            })).map_err(io_error)?;
            header.push(b'\n');
            if header.len() > 128 * 1024 { return Err("managed_handoff_file_limit".into()); }
            input.send(&header).await.map_err(|_| "managed_handoff_guest_unavailable")?;
            let paths = std::iter::once(prepared.staging.path().join("source.bundle"))
                .chain((0..prepared.manifest.files.len()).map(|i| prepared.staging.path().join(format!("file-{i}"))));
            let mut transferred = 0_u64;
            for path in paths {
                let mut file = tokio::fs::File::open(path).await.map_err(io_error)?;
                let mut buffer = vec![0; 64 * 1024];
                loop {
                    budget.check()?;
                    let n = file.read(&mut buffer).await.map_err(io_error)?;
                    if n == 0 { break; }
                    transferred += n as u64;
                    if transferred > MAX_BUNDLE_BYTES + MAX_ACCEPTANCE_BYTES { return Err("managed_handoff_file_limit".into()); }
                    input.send(&buffer[..n]).await.map_err(|_| "managed_handoff_guest_unavailable")?;
                }
            }
            input.close().await.map_err(|_| "managed_handoff_guest_unavailable")?;
            Ok::<_, String>(())
        };
        let receive = async {
            let mut stdout = Vec::new();
            let mut output_bytes = 0;
            loop {
                match stream.next_event().await.map_err(|_| "managed_handoff_guest_unavailable")? {
                    Some(ProcessEvent::Stdout(bytes)) => {
                        output_bytes += bytes.len();
                        if output_bytes > 64 * 1024 { return Err("managed_handoff_guest_output_limit".into()); }
                        stdout.extend_from_slice(&bytes);
                    }
                    Some(ProcessEvent::Stderr(bytes)) => {
                        output_bytes += bytes.len();
                        if output_bytes > 64 * 1024 { return Err("managed_handoff_guest_output_limit".into()); }
                    }
                    Some(ProcessEvent::Keepalive) => (),
                    Some(ProcessEvent::End(status)) if status.code() == Some(0) => break,
                    _ => return Err("managed_handoff_guest_failed".into()),
                }
            }
            let installed: InstalledHandoff = serde_json::from_slice(&stdout).map_err(|_| "managed_handoff_guest_protocol")?;
            validate_receipt(&installed, operation_id, &prepared.manifest, &prepared.digest, launch.is_some())?;
            Ok::<InstalledHandoff, String>(installed)
        };
        let (_, result) = tokio::try_join!(send, receive)?;
        Ok(result)
    }).await
}

fn validate_receipt(installed: &InstalledHandoff, operation_id: &str, manifest: &TransferManifest, digest: &str, launched: bool) -> Result<()> {
    if installed.receipt_version != 3
        || uuid::Uuid::parse_str(&installed.boundary_generation).map(|id| !id.is_nil() && id.to_string() == installed.boundary_generation).ok() != Some(true)
        || installed.source_tree_sha256 != manifest.source_tree_sha256
        || installed.source_file_count != manifest.source_file_count
        || installed.source_bytes != manifest.source_bytes
        || installed.operation_id != operation_id || installed.commit != manifest.commit
        || installed.manifest_digest != digest
        || installed.workspace != format!("/workspace/{operation_id}/workspace")
        || installed.launched != launched
    { return Err("managed_handoff_guest_protocol".into()); }
    installed.importer_boundary.validate(1001).map_err(str::to_owned)?;
    if installed.importer_boundary.boundary_generation != installed.boundary_generation
        || installed.acceptance_boundary.is_some() != launched {
        return Err("managed_handoff_guest_protocol".into());
    }
    if let Some(acceptance) = &installed.acceptance_boundary {
        acceptance.validate(1000).map_err(str::to_owned)?;
        if acceptance.phase != ObservationPhase::AcceptanceAdmission
            || acceptance.boundary_generation != installed.boundary_generation {
            return Err("managed_handoff_guest_protocol".into());
        }
    }
    Ok(())
}

/// Correlate protected admission observations with the independently observed
/// live desktop, not just the generation echoed in the handoff response.
pub fn validate_installed_boundary(installed: &InstalledHandoff, desktop: &ProcessBoundaryReport) -> Result<()> {
    desktop.validate(1000).map_err(str::to_owned)?;
    installed.importer_boundary.validate(1001).map_err(str::to_owned)?;
    if desktop.phase != ObservationPhase::DesktopLive
        || installed.boundary_generation != desktop.boundary_generation
        || installed.importer_boundary.provider_namespaces != desktop.provider_namespaces
        || desktop.namespaces.iter().any(|(name, ns)| installed.importer_boundary.namespaces.get(name) == Some(ns)) {
        return Err("managed_handoff_boundary_mismatch".into());
    }
    if let Some(acceptance) = &installed.acceptance_boundary {
        acceptance.validate(1000).map_err(str::to_owned)?;
        if acceptance.phase != ObservationPhase::AcceptanceAdmission
            || acceptance.boundary_generation != desktop.boundary_generation
            || acceptance.namespaces != desktop.namespaces
            || acceptance.provider_namespaces != desktop.provider_namespaces
            || acceptance.namespace_init_pid != desktop.namespace_init_pid
            || acceptance.namespace_init_start_time != desktop.namespace_init_start_time {
            return Err("managed_handoff_boundary_mismatch".into());
        }
    }
    Ok(())
}

pub fn validate_commit(commit: &str) -> Result<()> {
    if object_id(commit) { Ok(()) } else { Err("managed_handoff_source_invalid".into()) }
}
pub fn validate_acceptance_paths(paths: &[String]) -> Result<()> {
    if paths.len() > MAX_ACCEPTANCE_FILES { return Err("managed_handoff_file_limit".into()); }
    let mut seen = BTreeSet::new();
    for path in paths {
        acceptance_path(path)?;
        if !seen.insert(path) { return Err("managed_handoff_file_duplicate".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // The fixture exercises real Git smart HTTP on loopback; no provider,
    // credential helper or caller's repository/configuration is involved.
    struct SourceFixture {
        _root: tempfile::TempDir,
        published: PathBuf,
        base_only: PathBuf,
        recovery: PathBuf,
        bundle: PathBuf,
        staging: PathBuf,
        base: String,
        commit: String,
    }
    fn fixture_git(cwd: &Path, args: &[&str]) -> Vec<u8> {
        let output = std::process::Command::new("/usr/bin/git")
            .env_clear().env("PATH", "/usr/bin:/bin").env("HOME", cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(args).current_dir(cwd).output().unwrap();
        assert!(output.status.success(), "fixture git failed: {}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    }
    impl SourceFixture {
        async fn new() -> Self {
            tokio::task::spawn_blocking(|| {
                let root = tempfile::tempdir().unwrap();
                let work = root.path().join("work");
                let published = root.path().join("published");
                let base_only = root.path().join("base-only");
                let recovery = root.path().join("recovery");
                let staging = root.path().join("staging");
                for path in [&work, &published, &base_only, &recovery, &staging] { std::fs::create_dir(path).unwrap(); }
                fixture_git(&work, &["-c", "init.defaultBranch=main", "init", "."]);
                fixture_git(&work, &["config", "user.name", "Fixture"]);
                fixture_git(&work, &["config", "user.email", "fixture@example.invalid"]);
                std::fs::write(work.join("check.json"), b"base").unwrap();
                fixture_git(&work, &["add", "."]);
                fixture_git(&work, &["commit", "-m", "base"]);
                let base = String::from_utf8(fixture_git(&work, &["rev-parse", "HEAD"])).unwrap().trim().to_string();
                fixture_git(&base_only, &["clone", "--bare", work.to_str().unwrap(), "repo.git"]);
                std::fs::write(work.join("check.json"), b"pinned acceptance bytes").unwrap();
                fixture_git(&work, &["add", "."]);
                fixture_git(&work, &["commit", "-m", "delivered"]);
                let commit = String::from_utf8(fixture_git(&work, &["rev-parse", "HEAD"])).unwrap().trim().to_string();
                let bundle = recovery.join("task.bundle");
                fixture_git(&work, &["bundle", "create", bundle.to_str().unwrap(), "HEAD", &format!("^{base}")]);
                // The published branch advances; the earlier immutable SHA is
                // still reachable, but its file content must not be replaced.
                std::fs::write(work.join("check.json"), b"later branch bytes").unwrap();
                fixture_git(&work, &["add", "."]);
                fixture_git(&work, &["commit", "-m", "later"]);
                fixture_git(&published, &["clone", "--bare", work.to_str().unwrap(), "repo.git"]);
                Self { _root: root, published, base_only, recovery, bundle, staging, base, commit }
            }).await.unwrap()
        }
        fn reservation(&self) -> StagingReservation {
            StagingReservation { parent: Some(self.staging.clone()), minimum_free_bytes: 0, reserve_bytes: 4096 }
        }
    }
    struct GitHttpFixture {
        port: u16,
        task: tokio::task::JoinHandle<()>,
        requested: Arc<tokio::sync::Notify>,
        bodies: Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
    }
    impl Drop for GitHttpFixture { fn drop(&mut self) { self.task.abort(); } }
    impl GitHttpFixture {
        async fn start(root: PathBuf, stall: bool) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requested = Arc::new(tokio::sync::Notify::new());
            let seen = requested.clone();
            let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
            let saved = bodies.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") { break index + 4; }
                        let mut buffer = [0; 4096];
                        let n = socket.read(&mut buffer).await.unwrap();
                        assert!(n > 0 && bytes.len() + n < 65536);
                        bytes.extend_from_slice(&buffer[..n]);
                    };
                    let header = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                    let mut first = header.lines().next().unwrap().split_whitespace();
                    let method = first.next().unwrap();
                    let uri = first.next().unwrap();
                    let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
                    assert!(matches!((method, path, query),
                        ("GET", "/repo.git/info/refs", "service=git-upload-pack") |
                        ("POST", "/repo.git/git-upload-pack", "")));
                    let field = |name: &str| header.lines().filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim()).unwrap_or("");
                    let length = field("content-length").parse::<usize>().unwrap_or(0);
                    assert!(length <= 1024 * 1024);
                    while bytes.len() - header_end < length {
                        let mut buffer = [0; 4096];
                        let n = socket.read(&mut buffer).await.unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buffer[..n]);
                    }
                    let body = &bytes[header_end..header_end + length];
                    saved.lock().unwrap().push(body.to_vec());
                    seen.notify_one();
                    if stall { std::future::pending::<()>().await; }
                    let mut command = tokio::process::Command::new("/usr/bin/git");
                    command.arg("http-backend").env_clear().env("PATH", "/usr/bin:/bin")
                        .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
                        .env("GIT_PROJECT_ROOT", &root).env("GIT_HTTP_EXPORT_ALL", "1")
                        .env("REQUEST_METHOD", method).env("PATH_INFO", path).env("QUERY_STRING", query)
                        .env("CONTENT_TYPE", field("content-type")).env("CONTENT_LENGTH", length.to_string())
                        .env("HTTP_GIT_PROTOCOL", field("git-protocol"))
                        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
                    let mut process = command.spawn().unwrap();
                    let mut input = process.stdin.take().unwrap();
                    input.write_all(body).await.unwrap(); drop(input);
                    let output = process.wait_with_output().await.unwrap();
                    assert!(output.status.success());
                    let split = output.stdout.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                    let headers = String::from_utf8(output.stdout[..split].to_vec()).unwrap();
                    let payload = &output.stdout[split + 4..];
                    let status = headers.lines().find_map(|line| line.strip_prefix("Status: ")).unwrap_or("200 OK");
                    let filtered = headers.lines().filter(|line| !line.starts_with("Status:")).collect::<Vec<_>>().join("\r\n");
                    socket.write_all(format!("HTTP/1.1 {status}\r\n{filtered}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).as_bytes()).await.unwrap();
                    socket.write_all(payload).await.unwrap();
                    socket.shutdown().await.unwrap();
                }
            });
            Self { port, task, requested, bodies }
        }
    }
    fn fixture_budget() -> (watch::Sender<bool>, HandoffBudget) {
        let (sender, cancel) = watch::channel(false);
        (sender, HandoffBudget { deadline_at_ms: chrono::Utc::now().timestamp_millis() + 30000, cancel })
    }
    async fn staging_is_empty(path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if tokio::fs::read_dir(path).await.unwrap().next_entry().await.unwrap().is_none() { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    }

    #[test]
    fn receipt_cannot_substitute_source_proof_generation_or_destination() {
        let operation = uuid::Uuid::new_v4().to_string();
        let manifest = TransferManifest { version: 2, commit: "a".repeat(40), bundle_bytes: 1,
            bundle_sha256: "b".repeat(64), source_tree_sha256: "c".repeat(64), source_file_count: 2,
            source_bytes: 16, files: vec![] };
        let generation = uuid::Uuid::new_v4().to_string();
        let receipt = serde_json::json!({ "receiptVersion": 3, "boundaryGeneration": generation,
            "operationId": operation, "commit": manifest.commit, "manifestDigest": "d".repeat(64),
            "sourceTreeSha256": manifest.source_tree_sha256, "sourceFileCount": 2, "sourceBytes": 16,
            "workspace": format!("/workspace/{operation}/workspace"), "launched": false,
            "importerBoundary":boundary_fixture(&generation, 1001, 3), "acceptanceBoundary":null });
        let valid: InstalledHandoff = serde_json::from_value(receipt.clone()).unwrap();
        assert!(validate_receipt(&valid, &operation, &manifest, &"d".repeat(64), false).is_ok());
        for (key, value) in [
            ("receiptVersion", serde_json::json!(2)), ("boundaryGeneration", serde_json::json!(uuid::Uuid::nil().to_string())),
            ("sourceTreeSha256", serde_json::json!("f".repeat(64))), ("sourceFileCount", serde_json::json!(3)),
            ("manifestDigest", serde_json::json!("f".repeat(64))),
            ("sourceBytes", serde_json::json!(17)), ("workspace", serde_json::json!("/tmp/workspace")),
            ("launched", serde_json::json!(true)), ("commit", serde_json::json!("e".repeat(40))),
        ] {
            let mut changed = receipt.clone(); changed[key] = value;
            let changed: InstalledHandoff = serde_json::from_value(changed).unwrap();
            assert!(validate_receipt(&changed, &operation, &manifest, &"d".repeat(64), false).is_err(), "{key}");
        }
        let mut installed: InstalledHandoff = serde_json::from_value(receipt).unwrap();
        let desktop = boundary_fixture(&generation, 1000, 2);
        assert!(validate_installed_boundary(&installed, &desktop).is_ok());
        installed.importer_boundary.namespaces = desktop.namespaces.clone();
        assert!(validate_installed_boundary(&installed, &desktop).is_err());
        installed.importer_boundary = boundary_fixture(&generation, 1001, 3);
        let mut acceptance = desktop.clone();
        acceptance.phase = ObservationPhase::AcceptanceAdmission;
        for fd in [3,4] {
            acceptance.descriptors.insert(fd, cognia_desktop_guest::observation::DescriptorObservation {
                target:format!("pipe:[{fd}]"),flags:0o2000000,socket_scope:None,
            });
        }
        installed.acceptance_boundary = Some(acceptance.clone());
        installed.launched = true;
        assert!(validate_receipt(&installed, &operation, &manifest, &"d".repeat(64), true).is_ok());
        assert!(validate_installed_boundary(&installed, &desktop).is_ok());
        installed.acceptance_boundary.as_mut().unwrap().namespaces.insert("net".into(), "net:[44]".into());
        assert!(validate_installed_boundary(&installed, &desktop).is_err());
        installed.acceptance_boundary = Some(acceptance);
        installed.acceptance_boundary.as_mut().unwrap().status = desktop.status.replace("NoNewPrivs:1", "NoNewPrivs:0");
        assert!(validate_receipt(&installed, &operation, &manifest, &"d".repeat(64), true).is_err());
    }

    fn boundary_fixture(generation: &str, uid: u32, inode: u64) -> ProcessBoundaryReport {
        use cognia_desktop_guest::observation::{DescriptorObservation, NAMESPACES};
        ProcessBoundaryReport {
            report_version:1, workload_isolation_revision:1, boundary_generation:generation.into(),
            phase:if uid == 1001 {ObservationPhase::ImporterAdmission} else {ObservationPhase::DesktopLive},
            namespace_init_pid:20, namespace_init_start_time:1, workload_pid:21, workload_start_time:2,
            namespaces:NAMESPACES.into_iter().map(|name|(name.into(),format!("{name}:[{inode}]"))).collect(),
            provider_namespaces:NAMESPACES.into_iter().map(|name|(name.into(),format!("{name}:[1]"))).collect(),
            status:format!("Uid:{uid} {uid} {uid} {uid}\nGid:{uid} {uid} {uid} {uid}\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n"),
            network_devices:"header\nheader\n lo: 0\n".into(), ipv4_routes:"header\n".into(), ipv6_routes:String::new(),
            descriptors:(0..=2).map(|fd|(fd,DescriptorObservation{target:if uid == 1001 && fd == 0 {"pipe:[5]".into()} else {"/dev/null".into()},flags:0,socket_scope:None})).collect(),
        }
    }

    fn assert_pinned_source_proof(prepared: &PreparedHandoff) {
        assert_eq!(prepared.manifest.version, 2);
        assert_eq!(prepared.manifest.source_file_count, 1);
        assert_eq!(prepared.manifest.source_bytes, 23);
        assert_eq!(prepared.manifest.source_tree_sha256,
            "0980bdafbb539c3901d0f53098e5ebff484794df9466ccc593ff67ccf3de5013");
        let wire = serde_json::to_value(&prepared.manifest).unwrap();
        assert_eq!(wire["sourceFileCount"], 1);
        assert_eq!(wire["sourceBytes"], 23);
        assert_eq!(wire["sourceTreeSha256"], prepared.manifest.source_tree_sha256);
        assert_eq!(prepared.digest, hash(&serde_json::to_vec(&prepared.manifest).unwrap()));
    }

    #[test]
    fn source_listing_refuses_symlinks_gitlinks_duplicate_and_traversal_paths() {
        let id = "a".repeat(40);
        for listing in [
            format!("120000 blob {id} 1\tlink\0"),
            format!("160000 commit {id} -\tsubmodule\0"),
            format!("100644 blob {id} 1\t../escape\0"),
            format!("100644 blob {id} 1\t.git/HEAD\0"),
            format!("100644 blob {id} 1\ta\0" ).repeat(2),
            format!("100644 blob {id} 1\ta\0" ) + &format!("100644 blob {id} 1\ta-b\0" ) + &format!("100644 blob {id} 1\ta/b\0" ),
            format!("100644 blob {id} 1\tunterminated"),
            format!("100644 blob {id} {}\tlarge\0", source_tree::MAX_SOURCE_BYTES + 1),
        ] { assert!(parse_source_tree_listing(listing.as_bytes()).is_err()); }
        assert!(parse_source_tree_listing(&[]).unwrap().is_empty());
        let mut raw = format!("100755 blob {id}       0\t").into_bytes();
        raw.extend_from_slice(b"raw\xff\nname\0");
        let parsed = parse_source_tree_listing(&raw).unwrap();
        assert_eq!(parsed[0].path, b"raw\xff\nname");
        assert!(parsed[0].executable);
    }

    #[tokio::test]
    async fn host_preparation_fetches_exact_commit_after_branch_moves_and_extracts_pinned_blobs() {
        let fixture = SourceFixture::new().await;
        let proxy = GitHttpFixture::start(fixture.published.clone(), false).await;
        let (_sender, budget) = fixture_budget();
        let source = TrustedHandoffSource { commit: fixture.commit.clone(), readonly_proxy_port: proxy.port, recovery: None };
        let prepared = prepare_source_with_reservation(&source, &["check.json".into()], &budget, fixture.reservation()).await.unwrap();
        assert_eq!(prepared.commit(), fixture.commit);
        assert_pinned_source_proof(&prepared);
        assert_eq!(tokio::fs::read(prepared.staging.path().join("file-0")).await.unwrap(), b"pinned acceptance bytes");
        assert_eq!(prepared.manifest.files[0].sha256, hash(b"pinned acceptance bytes"));
        assert!(!proxy.bodies.lock().unwrap().is_empty());
        let path = prepared.staging.path().join("source.bundle");
        let check = tokio::task::spawn_blocking(move || fixture_git(path.parent().unwrap(), &["bundle", "list-heads", path.to_str().unwrap()])).await.unwrap();
        assert_eq!(String::from_utf8(check).unwrap(), format!("{} refs/cognia/acceptance\n", fixture.commit));
        drop(prepared);
        staging_is_empty(&fixture.staging).await;
    }

    #[tokio::test]
    async fn source_proof_uses_raw_objects_even_when_committed_attributes_transform_checkout() {
        let fixture = SourceFixture::new().await;
        let work = fixture._root.path().join("work");
        let published = fixture.published.join("repo.git");
        let commit = tokio::task::spawn_blocking(move || {
            std::fs::write(work.join(".gitattributes"), b"check.json ident\n").unwrap();
            std::fs::write(work.join("check.json"), b"$Id$\n").unwrap();
            fixture_git(&work, &["add", "."]);
            fixture_git(&work, &["commit", "-m", "raw object fixture"]);
            let commit = String::from_utf8(fixture_git(&work, &["rev-parse", "HEAD"])).unwrap().trim().to_string();
            fixture_git(&published, &["fetch", work.to_str().unwrap(), &format!("{commit}:refs/heads/raw")]);
            std::fs::remove_file(work.join("check.json")).unwrap();
            fixture_git(&work, &["checkout", "--", "check.json"]);
            assert_ne!(std::fs::read(work.join("check.json")).unwrap(), b"$Id$\n");
            commit
        }).await.unwrap();
        let proxy = GitHttpFixture::start(fixture.published.clone(), false).await;
        let (_sender, budget) = fixture_budget();
        let source = TrustedHandoffSource { commit, readonly_proxy_port: proxy.port, recovery: None };
        let prepared = prepare_source_with_reservation(&source, &[], &budget, fixture.reservation()).await.unwrap();
        let mut expected = SourceTreeBuilder::new();
        for (path, content) in [(b".gitattributes".as_slice(), b"check.json ident\n".as_slice()), (b"check.json", b"$Id$\n")] {
            expected.push(SourceTreeEntry { path: path.to_vec(), executable: false, bytes: content.len() as u64,
                content_sha256: Sha256::digest(content).into() }).unwrap();
        }
        let expected = expected.finish().unwrap();
        assert_eq!(prepared.manifest.source_tree_sha256, expected.source_tree_sha256);
        assert_eq!(prepared.manifest.source_file_count, expected.source_file_count);
        assert_eq!(prepared.manifest.source_bytes, expected.source_bytes);
        drop(prepared);
        staging_is_empty(&fixture.staging).await;
    }

    #[tokio::test]
    async fn host_preparation_imports_incremental_bundle_after_fetching_base_and_rejects_bad_hash() {
        let fixture = SourceFixture::new().await;
        let proxy = GitHttpFixture::start(fixture.base_only.clone(), false).await;
        let (_sender, budget) = fixture_budget();
        let expected = hash(&tokio::fs::read(&fixture.bundle).await.unwrap());
        let mut source = TrustedHandoffSource {
            commit: fixture.commit.clone(), readonly_proxy_port: proxy.port,
            recovery: Some(RecoverySource { path: fixture.bundle.clone(), trusted_root: fixture.recovery.clone(), expected_sha256: Some(expected) }),
        };
        let prepared = prepare_source_with_reservation(&source, &["check.json".into()], &budget, fixture.reservation()).await.unwrap();
        assert_eq!(prepared.commit(), fixture.commit);
        assert_pinned_source_proof(&prepared);
        assert_eq!(tokio::fs::read(prepared.staging.path().join("file-0")).await.unwrap(), b"pinned acceptance bytes");
        let bodies = proxy.bodies.lock().unwrap().clone();
        assert!(bodies.iter().any(|body| body.windows(fixture.base.len()).any(|window| window == fixture.base.as_bytes())));
        drop(prepared);
        source.recovery.as_mut().unwrap().expected_sha256 = Some("0".repeat(64));
        assert!(prepare_source_with_reservation(&source, &[], &budget, fixture.reservation()).await.is_err());
        staging_is_empty(&fixture.staging).await;
    }

    #[tokio::test]
    async fn host_preparation_missing_sha_refuses_and_cancelled_fetch_cleans_staging() {
        let fixture = SourceFixture::new().await;
        let proxy = GitHttpFixture::start(fixture.published.clone(), false).await;
        let (_sender, budget) = fixture_budget();
        let invalid = TrustedHandoffSource { commit: "main".into(), readonly_proxy_port: proxy.port, recovery: None };
        // Public entry validates before reserving any production-size disk.
        assert!(prepare_source(&invalid, &[], &budget).await.is_err());
        let missing = TrustedHandoffSource { commit: "f".repeat(40), readonly_proxy_port: proxy.port, recovery: None };
        assert!(prepare_source_with_reservation(&missing, &[], &budget, fixture.reservation()).await.is_err());
        staging_is_empty(&fixture.staging).await;
        let stalled = GitHttpFixture::start(fixture.published.clone(), true).await;
        let (cancel, budget) = fixture_budget();
        let source = TrustedHandoffSource { commit: fixture.commit.clone(), readonly_proxy_port: stalled.port, recovery: None };
        let reservation = fixture.reservation();
        let prepare = tokio::spawn(async move { prepare_source_with_reservation(&source, &[], &budget, reservation).await });
        tokio::time::timeout(Duration::from_secs(5), stalled.requested.notified()).await.unwrap();
        cancel.send(true).unwrap();
        assert!(prepare.await.unwrap().is_err());
        staging_is_empty(&fixture.staging).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_or_dropped_git_kills_descendants_before_staging_cleanup() {
        for abort_future in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = root.path().join("staging");
            std::fs::create_dir(&parent).unwrap();
            let directory = tempfile::tempdir_in(&parent).unwrap();
            let staging_path = directory.path().to_path_buf();
            let repository = GitRepository {
                path: staging_path.clone(),
                staging: Arc::new(HandoffStaging(Some(directory))),
            };
            let ready = root.path().join("ready");
            let release = root.path().join("release");
            let late_write = root.path().join("late-write");
            let mut command = tokio::process::Command::new("/bin/sh");
            // The descendant retains stdout, as fetch helpers can. If only
            // the shell leader is killed, it survives cancellation and writes
            // after release, even recreating the already-cleaned staging tree.
            command.arg("-c").arg(
                "( : > \"$1\"; n=0; while [ ! -f \"$2\" ]; do n=$((n+1)); [ \"$n\" -lt 100 ] || exit; sleep 0.05; done; printf late > \"$3\"; mkdir -p \"$4\"; printf late > \"$4/late\" ) & wait"
            ).arg("fixture").arg(&ready).arg(&release).arg(&late_write).arg(&staging_path)
                .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            let (cancel, budget) = fixture_budget();
            let work = tokio::spawn(async move { run_git_command(&repository, command, 4096, &budget).await });
            let ready_result = tokio::time::timeout(Duration::from_secs(5), async {
                while !tokio::fs::try_exists(&ready).await.unwrap() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await;
            if ready_result.is_err() {
                work.abort();
                let _ = work.await;
                panic!("descendant did not start");
            }
            if abort_future {
                work.abort();
                assert!(work.await.unwrap_err().is_cancelled());
            } else {
                cancel.send(true).unwrap();
                assert_eq!(work.await.unwrap().unwrap_err(), "managed_handoff_cancelled");
            }
            staging_is_empty(&parent).await;
            tokio::fs::write(&release, b"release").await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!tokio::fs::try_exists(&late_write).await.unwrap(), "descendant survived cancellation");
            assert!(!tokio::fs::try_exists(&staging_path).await.unwrap(), "descendant recreated staging");
        }
    }

    #[cfg(not(unix))]
    #[tokio::test]
    async fn handoff_git_refuses_hosts_without_process_tree_cleanup_before_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let repository = GitRepository {
            path: directory.path().to_path_buf(),
            staging: Arc::new(HandoffStaging(Some(directory))),
        };
        let (_sender, budget) = fixture_budget();
        let command = tokio::process::Command::new("must-not-be-spawned");
        assert_eq!(run_git_command(&repository, command, 4096, &budget).await.unwrap_err(),
            "managed_handoff_process_isolation_unavailable");
    }

    #[tokio::test]
    async fn blocking_work_keeps_staging_alive_until_completion_then_cleans_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_path_buf();
        let staging = Arc::new(HandoffStaging(Some(directory)));
        let worker_owner = staging.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _owner = worker_owner;
            started.send(()).unwrap();
            wait.recv().unwrap();
        });
        ready.await.unwrap();
        drop(staging);
        assert!(tokio::fs::try_exists(&path).await.unwrap());
        finish.send(()).unwrap();
        worker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while tokio::fs::try_exists(&path).await.unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    }

    #[test]
    fn launch_is_explicit_package_script_not_shell_or_install() {
        assert!(parse_launch(&[]).unwrap().is_none());
        assert_eq!(parse_launch(&["npm".into(), "run".into(), "test:gui".into()]).unwrap().unwrap().script, "test:gui");
        for args in [vec!["sh", "-c", "true"], vec!["npm", "install"], vec!["npm", "run", "a;curl"], vec!["npm", "run", "--prefix=/"], vec!["npm", "run", "dev", "--", "extra"]] {
            assert!(parse_launch(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).is_err());
        }
    }
    #[test]
    fn selection_refuses_credentials_traversal_and_duplicate_names() {
        for path in ["", "/tmp/a", "../a", "a/../b", "a//b", "a\\b", "a/.env", ".ssh/id_ed25519", "x/credentials", "x/.npmrc", "a.key", "cookies.sqlite"] {
            assert!(acceptance_path(path).is_err(), "{path}");
        }
        assert!(acceptance_path("acceptance/browser.json").is_ok());
        assert!(validate_acceptance_paths(&["a".into(), "a".into()]).is_err());
    }
    #[test]
    fn incremental_bundle_header_is_bounded_and_requires_complete_header() {
        let sha = "a".repeat(40);
        let header = format!("# v2 git bundle\n-{sha} base\n{} refs/heads/task\n\nPACK", "b".repeat(40));
        assert_eq!(bundle_prerequisites(header.as_bytes()).unwrap(), vec![sha]);
        for bad in ["garbage\n\n", "# v2 git bundle\n-../../x bad\n\n", "# v2 git bundle\n"] {
            assert!(bundle_prerequisites(bad.as_bytes()).is_err());
        }
    }
    #[tokio::test]
    async fn expired_and_cancelled_work_does_not_start() {
        let (sender, cancel) = watch::channel(false);
        let budget = HandoffBudget { deadline_at_ms: 0, cancel: cancel.clone() };
        assert!(budget.run(async { panic!("expired work ran"); #[allow(unreachable_code)] Ok::<(), String>(()) }).await.is_err());
        sender.send(true).unwrap();
        let budget = HandoffBudget { deadline_at_ms: i64::MAX, cancel };
        assert_eq!(budget.check().unwrap_err(), "managed_handoff_cancelled");
    }
    #[tokio::test]
    async fn recovery_copies_exact_bytes_and_refuses_hash_or_containment_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("a.bundle");
        tokio::fs::write(&file, b"bundle fixture").await.unwrap();
        let (_sender, cancel) = watch::channel(false);
        let budget = HandoffBudget { deadline_at_ms: chrono::Utc::now().timestamp_millis() + 10000, cancel };
        let mut source = RecoverySource { path: file.clone(), trusted_root: root.path().into(), expected_sha256: Some(hash(b"bundle fixture")) };
        let output = root.path().join("copy");
        assert_eq!(copy_recovery(&source, &output, &budget).await.unwrap(), hash(b"bundle fixture"));
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"bundle fixture");
        source.expected_sha256 = Some("0".repeat(64));
        assert!(copy_recovery(&source, &root.path().join("bad"), &budget).await.is_err());
        source.trusted_root = root.path().join("different");
        assert!(copy_recovery(&source, &root.path().join("escape"), &budget).await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_refuses_symlinks_and_special_files_before_open() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("real"), b"bundle").unwrap();
        std::os::unix::fs::symlink(root.path().join("real"), root.path().join("link")).unwrap();
        let (_sender, cancel) = watch::channel(false);
        let budget = HandoffBudget { deadline_at_ms: chrono::Utc::now().timestamp_millis() + 10000, cancel };
        let source = RecoverySource { path: root.path().join("link"), trusted_root: root.path().into(), expected_sha256: None };
        assert!(copy_recovery(&source, &root.path().join("out"), &budget).await.is_err());
    }
}
