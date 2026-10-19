//! A host's install home: versioned installs and the switch between them
//! (ADR-0224 A10).
//!
//! A native host runs from `<data dir>/install/current`, a symlink to one of
//! `<data dir>/install/versions/<version>`. The service definition names only
//! `current`, so an update is: stage the new version beside the running one,
//! write a pending-update marker, repoint `current` in one rename, and let the
//! service manager restart the process. The new process starts as a *trial*:
//! it commits once its server is ready and its brain accepted, or rolls
//! `current` back to the version it came from. A trial that never gets that
//! far (it crashes on every boot, or runs past its deadline) is rolled back at
//! the next boot, before the server starts.
//!
//! Everything a release is checked against comes from the signed catalog
//! (`cognia-update-catalog`): the archive's sha256, and the version, platform
//! and command contract its `host-manifest.json` must name. The manifest's own
//! per-file hashes are checked last, so a staged version is exactly the build
//! that was signed. The install home lives in the data dir, which the service
//! account owns, so a system service updates itself without root.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::server::HostLayout;

/// Directory of the install home inside a data dir.
pub const INSTALL_HOME_DIR: &str = "install";
/// The file every host install carries (`scripts/build/package-host-archive.mjs`).
pub const MANIFEST_FILE: &str = "host-manifest.json";
/// Boots a trial gets before it is judged failed: a version that cannot stay
/// up long enough to be judged must not keep the host down.
pub const MAX_TRIAL_BOOTS: u32 = 3;
/// Largest archive a host unpacks (the real one is about 150 MiB).
pub const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub const VERSIONS_DIR: &str = "versions";
/// The link the service runs through: `<home>/current/bin/cognia-server`.
pub const CURRENT_LINK: &str = "current";
const PENDING_FILE: &str = "pending-update.json";
const OUTCOME_FILE: &str = "last-update.json";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstallHomeError {
    #[error("{action}: {detail}")]
    Io { action: String, detail: String },
    #[error("{0}")]
    Invalid(String),
}

fn io_error(action: impl Into<String>) -> impl FnOnce(std::io::Error) -> InstallHomeError {
    let action = action.into();
    move |error| InstallHomeError::Io {
        action,
        detail: error.to_string(),
    }
}

fn invalid(message: impl Into<String>) -> InstallHomeError {
    InstallHomeError::Invalid(message.into())
}

/// `host-manifest.json`: what an install is and the sha256 of every file in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostManifest {
    pub format: u32,
    pub version: String,
    pub target: String,
    #[serde(default)]
    pub node_version: Option<String>,
    #[serde(default)]
    pub contract_version: Option<u32>,
    #[serde(default)]
    pub catalog_hash: Option<String>,
    pub files: BTreeMap<String, String>,
}

impl HostManifest {
    pub fn read(root: &Path) -> Result<Self, InstallHomeError> {
        let path = root.join(MANIFEST_FILE);
        let raw =
            std::fs::read_to_string(&path).map_err(io_error(format!("read {}", path.display())))?;
        serde_json::from_str(&raw).map_err(|error| {
            invalid(format!(
                "{} is not a host manifest: {error}",
                path.display()
            ))
        })
    }

    /// Every listed file exists under `root` with the listed sha256.
    pub fn verify_files(&self, root: &Path) -> Result<(), InstallHomeError> {
        for (relative, expected) in &self.files {
            let relative_path = Path::new(relative);
            if !relative_path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(invalid(format!("manifest lists an unsafe path {relative}")));
            }
            let actual = sha256_file(&root.join(relative_path))?;
            if &actual != expected {
                return Err(invalid(format!(
                    "{relative} does not match its manifest hash"
                )));
            }
        }
        Ok(())
    }
}

/// sha256 of a file, lowercase hex.
pub fn sha256_file(path: &Path) -> Result<String, InstallHomeError> {
    let mut file =
        std::fs::File::open(path).map_err(io_error(format!("open {}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(io_error(format!("read {}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// What the signed catalog says a release is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedRelease {
    pub version: String,
    pub target: String,
    pub sha256: String,
    pub contract_version: u32,
    pub catalog_hash: String,
}

/// An update between switching `current` and the new version proving itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub attempt_id: String,
    pub from: String,
    pub to: String,
    pub started_at_ms: i64,
    /// The trial fails when it has not committed by then.
    pub deadline_ms: i64,
    /// Boots of `to` so far.
    #[serde(default)]
    pub boots: u32,
    /// Required runtime failures observed before replacing the old version.
    #[serde(default)]
    pub baseline_failed_required_runtimes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateResult {
    Installed,
    RolledBack,
}

/// How the last update ended, for the host panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub attempt_id: String,
    pub from: String,
    pub to: String,
    pub result: UpdateResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub at_ms: i64,
}

/// What a booting process must do about a pending update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootDecision {
    /// No update in progress.
    Steady,
    /// This process is the new version on trial: run, and commit once healthy
    /// or roll back by the deadline.
    Trial(PendingUpdate),
    /// The trial failed and `current` points back at the old version. Exit, so
    /// the service manager starts it.
    RolledBack(UpdateOutcome),
}

/// `<data dir>/install`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallHome {
    root: PathBuf,
}

impl InstallHome {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(data_dir.join(INSTALL_HOME_DIR))
    }

    /// The install home a server binary runs from, when it runs from one
    /// (`<home>/current/bin/cognia-server` or `<home>/versions/<v>/bin/…`).
    pub fn of_server_binary(binary: &Path) -> Option<Self> {
        let layout = HostLayout::from_server_binary(binary)?;
        let parent = layout.root.parent()?;
        if layout.root.file_name()? == CURRENT_LINK {
            return Some(Self::new(parent));
        }
        if parent.file_name()? == VERSIONS_DIR {
            return Some(Self::new(parent.parent()?));
        }
        None
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join(VERSIONS_DIR)
    }

    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.versions_dir().join(version)
    }

    pub fn current_link(&self) -> PathBuf {
        self.root.join(CURRENT_LINK)
    }

    /// The layout the service runs: everything through `current`.
    pub fn current_layout(&self) -> HostLayout {
        HostLayout::new(self.current_link())
    }

    /// The version `current` points at.
    pub fn current_version(&self) -> Option<String> {
        let target = std::fs::read_link(self.current_link()).ok()?;
        target.file_name()?.to_str().map(str::to_owned)
    }

    /// Installed versions, oldest name first.
    pub fn installed_versions(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.versions_dir()) else {
            return Vec::new();
        };
        let mut versions: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.'))
            .collect();
        versions.sort();
        versions
    }

    fn check_version_name(version: &str) -> Result<(), InstallHomeError> {
        let ok = !version.is_empty()
            && !version.starts_with('.')
            && version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-+_".contains(&byte));
        ok.then_some(())
            .ok_or_else(|| invalid(format!("{version:?} is not a version")))
    }

    /// Point `current` at an installed version in one rename, so the service
    /// manager never sees it missing.
    pub fn point_current_at(&self, version: &str) -> Result<(), InstallHomeError> {
        Self::check_version_name(version)?;
        if !self.version_dir(version).is_dir() {
            return Err(invalid(format!("version {version} is not installed")));
        }
        let staging = self
            .root
            .join(format!(".current-{}", rand::random::<u64>()));
        symlink(&Path::new(VERSIONS_DIR).join(version), &staging)?;
        std::fs::rename(&staging, self.current_link()).map_err(|error| {
            let _ = std::fs::remove_file(&staging);
            InstallHomeError::Io {
                action: format!("switch {} to {version}", self.current_link().display()),
                detail: error.to_string(),
            }
        })
    }

    /// Take a host install directory (an unpacked archive) into the home and
    /// point `current` at it. An install already in the home is only pointed
    /// at. Returns its version.
    pub fn adopt(&self, source_root: &Path) -> Result<String, InstallHomeError> {
        let manifest = HostManifest::read(source_root)?;
        Self::check_version_name(&manifest.version)?;
        let missing = HostLayout::new(source_root).missing(|path| path.exists());
        if !missing.is_empty() {
            return Err(invalid(format!(
                "{} is not a complete host install",
                source_root.display()
            )));
        }
        let destination = self.version_dir(&manifest.version);
        let same = |a: &Path, b: &Path| {
            std::fs::canonicalize(a)
                .ok()
                .is_some_and(|a| Some(a) == std::fs::canonicalize(b).ok())
        };
        if !same(source_root, &destination) {
            if destination.exists() {
                std::fs::remove_dir_all(&destination)
                    .map_err(io_error(format!("replace {}", destination.display())))?;
            }
            let staging = self.versions_dir().join(format!(
                ".adopt-{}-{}",
                manifest.version,
                rand::random::<u64>()
            ));
            std::fs::create_dir_all(&staging)
                .map_err(io_error(format!("create {}", staging.display())))?;
            copy_tree(source_root, &staging)?;
            std::fs::rename(&staging, &destination)
                .map_err(io_error(format!("install {}", destination.display())))?;
        }
        self.point_current_at(&manifest.version)?;
        Ok(manifest.version)
    }

    /// Verify a downloaded archive against the catalog and unpack it as an
    /// installed version beside the running one. Returns its directory.
    pub fn stage_archive(
        &self,
        archive: &Path,
        expected: &ExpectedRelease,
    ) -> Result<PathBuf, InstallHomeError> {
        Self::check_version_name(&expected.version)?;
        if sha256_file(archive)? != expected.sha256 {
            return Err(invalid("the archive does not match the catalog's sha256"));
        }
        if self.current_version().as_deref() == Some(expected.version.as_str()) {
            return Err(invalid(format!("{} is already running", expected.version)));
        }
        let staging = self.versions_dir().join(format!(
            ".stage-{}-{}",
            expected.version,
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&staging)
            .map_err(io_error(format!("create {}", staging.display())))?;
        let result = (|| {
            let top = format!("cognia-host-{}-{}", expected.version, expected.target);
            unpack_archive(archive, &staging, &top)?;
            let root = staging.join(&top);
            let manifest = HostManifest::read(&root)?;
            if manifest.version != expected.version || manifest.target != expected.target {
                return Err(invalid(format!(
                    "the archive is {} {}, the catalog says {} {}",
                    manifest.version, manifest.target, expected.version, expected.target
                )));
            }
            if manifest.contract_version != Some(expected.contract_version)
                || manifest.catalog_hash.as_deref() != Some(expected.catalog_hash.as_str())
            {
                return Err(invalid(
                    "the archive's command contract is not the one the catalog names",
                ));
            }
            manifest.verify_files(&root)?;
            let missing = HostLayout::new(&root).missing(|path| path.exists());
            if !missing.is_empty() {
                return Err(invalid("the archive is not a complete host install"));
            }
            let destination = self.version_dir(&expected.version);
            if destination.exists() {
                std::fs::remove_dir_all(&destination)
                    .map_err(io_error(format!("replace {}", destination.display())))?;
            }
            std::fs::rename(&root, &destination)
                .map_err(io_error(format!("install {}", destination.display())))?;
            Ok(destination)
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    pub fn pending(&self) -> Option<PendingUpdate> {
        read_json(&self.root.join(PENDING_FILE))
    }

    pub fn last_outcome(&self) -> Option<UpdateOutcome> {
        read_json(&self.root.join(OUTCOME_FILE))
    }

    fn record(&self, outcome: &UpdateOutcome) -> Result<(), InstallHomeError> {
        write_json(&self.root.join(OUTCOME_FILE), outcome)
    }

    /// Switch to a staged version: mark the update pending, then repoint
    /// `current`. The caller exits next so the service manager restarts on it.
    pub fn begin_switch(
        &self,
        to: &str,
        now_ms: i64,
        trial_ms: i64,
        baseline_failed_required_runtimes: Vec<String>,
    ) -> Result<PendingUpdate, InstallHomeError> {
        let from = self
            .current_version()
            .ok_or_else(|| invalid("no current version to update from"))?;
        if from == to {
            return Err(invalid(format!("{to} is already current")));
        }
        if !self.version_dir(to).is_dir() {
            return Err(invalid(format!("version {to} is not staged")));
        }
        let pending = PendingUpdate {
            attempt_id: format!("upd-{now_ms}-{:08x}", rand::random::<u32>()),
            from,
            to: to.to_owned(),
            started_at_ms: now_ms,
            deadline_ms: now_ms + trial_ms,
            boots: 0,
            baseline_failed_required_runtimes,
        };
        write_json(&self.root.join(PENDING_FILE), &pending)?;
        if let Err(error) = self.point_current_at(to) {
            let _ = std::fs::remove_file(self.root.join(PENDING_FILE));
            return Err(error);
        }
        Ok(pending)
    }

    /// Decide, at boot, what a pending update means for this process.
    pub fn boot(
        &self,
        running_version: &str,
        now_ms: i64,
    ) -> Result<BootDecision, InstallHomeError> {
        let Some(mut pending) = self.pending() else {
            return Ok(BootDecision::Steady);
        };
        if self.current_version().as_deref() != Some(pending.to.as_str())
            || running_version != pending.to
        {
            // The switch never took (or was undone): the old version is what
            // runs, and the marker only describes a failed attempt.
            let outcome = self.finish(
                &pending,
                UpdateResult::RolledBack,
                Some(format!("{} did not start", pending.to)),
                now_ms,
            )?;
            if self.current_version().as_deref() != Some(pending.from.as_str()) {
                self.point_current_at(&pending.from)?;
            }
            let _ = outcome;
            return Ok(BootDecision::Steady);
        }
        pending.boots += 1;
        if pending.boots > MAX_TRIAL_BOOTS || now_ms > pending.deadline_ms {
            let reason = if now_ms > pending.deadline_ms {
                "it did not become healthy in time"
            } else {
                "it kept exiting before it became healthy"
            };
            return self
                .roll_back(reason, now_ms)
                .map(|outcome| BootDecision::RolledBack(outcome.expect("pending")));
        }
        write_json(&self.root.join(PENDING_FILE), &pending)?;
        Ok(BootDecision::Trial(pending))
    }

    /// The trial is healthy: keep it, and keep its predecessor for a later
    /// rollback; anything older is removed.
    pub fn commit(&self, now_ms: i64) -> Result<Option<UpdateOutcome>, InstallHomeError> {
        let Some(pending) = self.pending() else {
            return Ok(None);
        };
        let outcome = self.finish(&pending, UpdateResult::Installed, None, now_ms)?;
        self.prune(&[pending.to.as_str(), pending.from.as_str()]);
        Ok(Some(outcome))
    }

    /// The trial failed: point `current` back at the version it came from.
    pub fn roll_back(
        &self,
        reason: &str,
        now_ms: i64,
    ) -> Result<Option<UpdateOutcome>, InstallHomeError> {
        let Some(pending) = self.pending() else {
            return Ok(None);
        };
        self.point_current_at(&pending.from)?;
        self.finish(
            &pending,
            UpdateResult::RolledBack,
            Some(reason.to_owned()),
            now_ms,
        )
        .map(Some)
    }

    fn finish(
        &self,
        pending: &PendingUpdate,
        result: UpdateResult,
        reason: Option<String>,
        now_ms: i64,
    ) -> Result<UpdateOutcome, InstallHomeError> {
        let outcome = UpdateOutcome {
            attempt_id: pending.attempt_id.clone(),
            from: pending.from.clone(),
            to: pending.to.clone(),
            result,
            reason,
            at_ms: now_ms,
        };
        self.record(&outcome)?;
        let path = self.root.join(PENDING_FILE);
        std::fs::remove_file(&path).map_err(io_error(format!("remove {}", path.display())))?;
        Ok(outcome)
    }

    /// Remove every installed version not in `keep`, and leftover staging.
    pub fn prune(&self, keep: &[&str]) {
        let current = self.current_version();
        let Ok(entries) = std::fs::read_dir(self.versions_dir()) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let kept = keep.contains(&name.as_str()) || current.as_deref() == Some(name.as_str());
            if !kept {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Write through a temp file and a rename, so a crash leaves the old file or
/// the new one, never half of either.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), InstallHomeError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid(format!("{} has no parent", path.display())))?;
    std::fs::create_dir_all(parent).map_err(io_error(format!("create {}", parent.display())))?;
    let temp = parent.join(format!(".{}.tmp", rand::random::<u64>()));
    let body = serde_json::to_vec_pretty(value).map_err(|error| invalid(error.to_string()))?;
    std::fs::write(&temp, body).map_err(io_error(format!("write {}", temp.display())))?;
    std::fs::rename(&temp, path).map_err(io_error(format!("write {}", path.display())))
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> Result<(), InstallHomeError> {
    std::os::unix::fs::symlink(target, link).map_err(io_error(format!("link {}", link.display())))
}

#[cfg(not(unix))]
fn symlink(_target: &Path, link: &Path) -> Result<(), InstallHomeError> {
    Err(invalid(format!(
        "{}: versioned installs need symlinks",
        link.display()
    )))
}

/// Copy a directory tree, keeping file modes and symlinks.
fn copy_tree(from: &Path, to: &Path) -> Result<(), InstallHomeError> {
    let entries = std::fs::read_dir(from).map_err(io_error(format!("read {}", from.display())))?;
    for entry in entries {
        let entry = entry.map_err(io_error(format!("read {}", from.display())))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(io_error(format!("stat {}", source.display())))?;
        if kind.is_symlink() {
            let link = std::fs::read_link(&source)
                .map_err(io_error(format!("read {}", source.display())))?;
            symlink(&link, &target)?;
        } else if kind.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(io_error(format!("create {}", target.display())))?;
            copy_tree(&source, &target)?;
        } else {
            // `fs::copy` keeps the permission bits.
            std::fs::copy(&source, &target)
                .map_err(io_error(format!("copy {}", source.display())))?;
        }
    }
    Ok(())
}

/// Unpack a `.tar.gz` whose entries all sit under `top`, refusing anything
/// but plain files and directories, any path that climbs out, and more than
/// [`MAX_UNPACKED_BYTES`].
fn unpack_archive(archive: &Path, into: &Path, top: &str) -> Result<(), InstallHomeError> {
    let file =
        std::fs::File::open(archive).map_err(io_error(format!("open {}", archive.display())))?;
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(file));
    reader.set_preserve_permissions(true);
    reader.set_overwrite(false);
    let mut total: u64 = 0;
    let entries = reader
        .entries()
        .map_err(io_error(format!("read {}", archive.display())))?;
    for entry in entries {
        let mut entry = entry.map_err(io_error(format!("read {}", archive.display())))?;
        let path = entry
            .path()
            .map_err(io_error("read an archive path"))?
            .into_owned();
        let mut parts = path.components();
        let first_ok = matches!(parts.next(), Some(Component::Normal(name)) if name == top);
        if !first_ok || !parts.all(|part| matches!(part, Component::Normal(_))) {
            return Err(invalid(format!(
                "the archive holds {} outside {top}/",
                path.display()
            )));
        }
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory => {}
            other => {
                return Err(invalid(format!(
                    "the archive holds a {other:?} entry at {}",
                    path.display()
                )))
            }
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED_BYTES {
            return Err(invalid(
                "the archive unpacks to more than a host install can be",
            ));
        }
        let destination = into.join(&path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(io_error(format!("create {}", parent.display())))?;
        }
        entry
            .unpack(&destination)
            .map_err(io_error(format!("unpack {}", path.display())))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::{write_install as write_install_for, TEST_CATALOG_HASH as HASH};

    const VERSION_A: &str = "1.4.0";
    const VERSION_B: &str = "1.5.0";
    const TARGET: &str = "darwin-arm64";

    fn write_install(root: &Path, version: &str) {
        write_install_for(root, version, TARGET);
    }

    fn write_archive(dir: &Path, version: &str, edit: impl FnOnce(&Path)) -> (PathBuf, String) {
        crate::test_support::write_archive(dir, version, TARGET, edit)
    }

    fn expected(version: &str, sha256: String) -> ExpectedRelease {
        ExpectedRelease {
            version: version.to_owned(),
            target: TARGET.to_owned(),
            sha256,
            contract_version: 3,
            catalog_hash: HASH.into(),
        }
    }

    fn adopted() -> (tempfile::TempDir, InstallHome) {
        let tmp = tempfile::tempdir().unwrap();
        let unpacked = tmp.path().join("unpacked");
        write_install(&unpacked, VERSION_A);
        let home = InstallHome::in_data_dir(&tmp.path().join("data"));
        assert_eq!(home.adopt(&unpacked).unwrap(), VERSION_A);
        (tmp, home)
    }

    #[test]
    fn an_unpacked_archive_is_adopted_and_runs_through_current() {
        let (_tmp, home) = adopted();
        assert_eq!(home.current_version().as_deref(), Some(VERSION_A));
        let layout = home.current_layout();
        assert!(layout.root.ends_with("install/current"));
        assert!(layout.missing(|path| path.exists()).is_empty());
        assert_eq!(
            std::fs::read_to_string(layout.brain_entry()).unwrap(),
            format!("brain {VERSION_A}")
        );
        // Adopting what is already there only points at it.
        assert_eq!(home.adopt(&home.version_dir(VERSION_A)).unwrap(), VERSION_A);
        assert_eq!(home.installed_versions(), vec![VERSION_A]);
    }

    #[test]
    fn a_binary_finds_its_install_home_through_current_or_its_version() {
        let home =
            InstallHome::of_server_binary(Path::new("/data/install/current/bin/cognia-server"))
                .unwrap();
        assert_eq!(home.root(), Path::new("/data/install"));
        let home = InstallHome::of_server_binary(Path::new(
            "/data/install/versions/1.4.0/bin/cognia-server",
        ))
        .unwrap();
        assert_eq!(home.root(), Path::new("/data/install"));
        assert!(
            InstallHome::of_server_binary(Path::new("/opt/cognia/bin/cognia-server")).is_none()
        );
    }

    #[test]
    fn a_signed_archive_is_staged_beside_the_running_version() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        let staged = home
            .stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap();
        assert_eq!(staged, home.version_dir(VERSION_B));
        // Staging does not switch.
        assert_eq!(home.current_version().as_deref(), Some(VERSION_A));
        assert_eq!(home.installed_versions(), vec![VERSION_A, VERSION_B]);
    }

    #[test]
    fn an_archive_that_is_not_the_signed_build_is_refused() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        let wrong_sha = "0".repeat(64);
        assert!(home
            .stage_archive(&archive, &expected(VERSION_B, wrong_sha))
            .unwrap_err()
            .to_string()
            .contains("sha256"));
        let mut other_contract = expected(VERSION_B, sha.clone());
        other_contract.contract_version = 4;
        assert!(home
            .stage_archive(&archive, &other_contract)
            .unwrap_err()
            .to_string()
            .contains("contract"));
        let mut other_version = expected(VERSION_B, sha);
        other_version.version = "1.6.0".into();
        assert!(home.stage_archive(&archive, &other_version).is_err());

        // A file changed after the manifest was written.
        let tampered_dir = tmp.path().join("tampered");
        std::fs::create_dir_all(&tampered_dir).unwrap();
        let (tampered, sha) = write_archive(&tampered_dir, VERSION_B, |root| {
            std::fs::write(root.join("brain/cli.mjs"), "something else").unwrap();
        });
        assert!(home
            .stage_archive(&tampered, &expected(VERSION_B, sha))
            .unwrap_err()
            .to_string()
            .contains("manifest hash"));
        // Nothing half-staged is left behind.
        assert_eq!(home.installed_versions(), vec![VERSION_A]);
    }

    #[test]
    fn an_archive_entry_outside_its_directory_is_refused() {
        let (tmp, home) = adopted();
        let archive = tmp.path().join("evil.tar.gz");
        let file = std::fs::File::create(&archive).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "other-dir/x", &b"evil"[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        let sha = sha256_file(&archive).unwrap();
        assert!(home
            .stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap_err()
            .to_string()
            .contains("outside"));
    }

    #[test]
    fn a_healthy_trial_commits_and_keeps_one_version_to_roll_back_to() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        home.stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap();
        std::fs::create_dir_all(home.version_dir("1.3.0")).unwrap();

        let pending = home
            .begin_switch(VERSION_B, 1_000, 60_000, vec!["connector-runtime".into()])
            .unwrap();
        assert_eq!(
            (pending.from.as_str(), pending.to.as_str()),
            (VERSION_A, VERSION_B)
        );
        assert_eq!(home.current_version().as_deref(), Some(VERSION_B));

        // The new binary boots on trial.
        let BootDecision::Trial(trial) = home.boot(VERSION_B, 2_000).unwrap() else {
            panic!("expected a trial");
        };
        assert_eq!(trial.boots, 1);
        assert_eq!(
            trial.baseline_failed_required_runtimes,
            vec!["connector-runtime"]
        );
        assert_eq!(
            home.pending().unwrap().baseline_failed_required_runtimes,
            trial.baseline_failed_required_runtimes
        );
        let outcome = home.commit(3_000).unwrap().unwrap();
        assert_eq!(outcome.result, UpdateResult::Installed);
        assert_eq!(home.pending(), None);
        assert_eq!(home.last_outcome(), Some(outcome));
        assert_eq!(home.installed_versions(), vec![VERSION_A, VERSION_B]);
        assert_eq!(home.boot(VERSION_B, 4_000).unwrap(), BootDecision::Steady);
    }

    #[test]
    fn old_pending_updates_default_to_no_known_runtime_failures() {
        let pending: PendingUpdate = serde_json::from_value(serde_json::json!({
            "attemptId": "old", "from": VERSION_A, "to": VERSION_B,
            "startedAtMs": 1, "deadlineMs": 2, "boots": 0
        }))
        .unwrap();
        assert!(pending.baseline_failed_required_runtimes.is_empty());
    }

    #[test]
    fn a_failed_trial_rolls_current_back() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        home.stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap();
        home.begin_switch(VERSION_B, 1_000, 60_000, Vec::new())
            .unwrap();
        let outcome = home
            .roll_back("the brain was refused", 2_000)
            .unwrap()
            .unwrap();
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert_eq!(outcome.reason.as_deref(), Some("the brain was refused"));
        assert_eq!(home.current_version().as_deref(), Some(VERSION_A));
        assert_eq!(home.pending(), None);
        // The failed version stays staged until the next update replaces it.
        assert!(home.version_dir(VERSION_B).is_dir());
    }

    #[test]
    fn a_trial_that_keeps_crashing_or_overruns_is_rolled_back_at_boot() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        home.stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap();

        home.begin_switch(VERSION_B, 1_000, 60_000, Vec::new())
            .unwrap();
        for boot in 1..=MAX_TRIAL_BOOTS {
            assert!(
                matches!(home.boot(VERSION_B, 2_000).unwrap(), BootDecision::Trial(p) if p.boots == boot)
            );
        }
        let BootDecision::RolledBack(outcome) = home.boot(VERSION_B, 2_000).unwrap() else {
            panic!("expected a rollback");
        };
        assert!(outcome.reason.unwrap().contains("kept exiting"));
        assert_eq!(home.current_version().as_deref(), Some(VERSION_A));

        home.begin_switch(VERSION_B, 10_000, 60_000, Vec::new())
            .unwrap();
        let BootDecision::RolledBack(outcome) = home.boot(VERSION_B, 80_000).unwrap() else {
            panic!("expected a rollback");
        };
        assert!(outcome.reason.unwrap().contains("in time"));
    }

    #[test]
    fn the_old_version_booting_with_a_marker_reports_the_attempt_and_stays() {
        let (tmp, home) = adopted();
        let (archive, sha) = write_archive(tmp.path(), VERSION_B, |_| {});
        home.stage_archive(&archive, &expected(VERSION_B, sha))
            .unwrap();
        home.begin_switch(VERSION_B, 1_000, 60_000, Vec::new())
            .unwrap();
        // The old binary came up instead of the new one.
        assert_eq!(home.boot(VERSION_A, 2_000).unwrap(), BootDecision::Steady);
        assert_eq!(home.current_version().as_deref(), Some(VERSION_A));
        assert_eq!(
            home.last_outcome().unwrap().result,
            UpdateResult::RolledBack
        );
        assert_eq!(home.pending(), None);
    }

    #[test]
    fn a_switch_needs_a_staged_version_and_a_different_one() {
        let (_tmp, home) = adopted();
        assert!(home.begin_switch(VERSION_A, 0, 1, Vec::new()).is_err());
        assert!(home.begin_switch(VERSION_B, 0, 1, Vec::new()).is_err());
        assert!(home.point_current_at("../escape").is_err());
        assert_eq!(home.pending(), None);
    }
}
