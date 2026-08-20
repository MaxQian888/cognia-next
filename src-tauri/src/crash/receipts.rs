//! What the desktop remembers about reports it has submitted.
//!
//! Before this existed, `/logs` reported every desktop incident as `detected`
//! forever and its receipt code was always blank: the lifecycle the UI renders
//! (`queued` → `uploading` → `processing` → `accepted`) had no local side to
//! read from. The mobile shell already had the equivalent through the
//! Capacitor plugin's `markReceipt`; this is the desktop half.
//!
//! Kept as a sidecar JSON file in the crash-reports directory rather than in
//! Dexie: the reports themselves live there, retention already prunes that
//! directory, and a submission record is worthless without the report it
//! describes. It is also the only place the one-time deletion credential can
//! live — the service hands it out once and stores only its hash, so losing it
//! costs the ability to delete a submission later.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Sidecar file name inside the crash-reports directory.
const RECEIPTS_FILE: &str = "submissions.json";

/// One submitted report, keyed in the store by its local report stem.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionRecord {
    pub incident_id: String,
    pub support_code: String,
    /// The service's `clientState` — what the `/logs` lifecycle renders.
    pub client_state: String,
    pub processing_state: String,
    /// Service this went to, so a record survives the user re-pointing the app.
    pub service_url: String,
    pub submitted_at: String,
    /// One-time credential, present only for the call that created the
    /// incident. A resumed submission keeps whatever was stored the first time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_credential: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_at: Option<String>,
    /// Whether the local artifacts were included, so the UI can say what left
    /// the machine without re-reading the package.
    #[serde(default)]
    pub included_minidump: bool,
    #[serde(default)]
    pub included_screenshot: bool,
}

fn receipts_path(dir: &Path) -> PathBuf {
    dir.join(RECEIPTS_FILE)
}

/// Read every stored record.
///
/// A store that will not parse is treated as empty rather than fatal: the
/// records are a convenience over data the service also holds, and refusing to
/// list crash reports because a sidecar got truncated would be a worse outcome
/// than losing the receipts.
pub fn load_all(dir: &Path) -> BTreeMap<String, SubmissionRecord> {
    let Ok(bytes) = std::fs::read(receipts_path(dir)) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn load(dir: &Path, stem: &str) -> Option<SubmissionRecord> {
    load_all(dir).remove(stem)
}

/// Insert or replace one record, atomically.
///
/// Written to a temporary file and renamed so a crash *during* the write of a
/// crash receipt cannot leave a half-written store — the one failure mode this
/// subsystem must not have.
pub fn save(dir: &Path, stem: &str, record: &SubmissionRecord) -> std::io::Result<()> {
    let mut all = load_all(dir);
    all.insert(stem.to_owned(), record.clone());
    write_all(dir, &all)
}

pub fn remove(dir: &Path, stem: &str) -> std::io::Result<()> {
    let mut all = load_all(dir);
    if all.remove(stem).is_none() {
        return Ok(());
    }
    write_all(dir, &all)
}

fn write_all(dir: &Path, all: &BTreeMap<String, SubmissionRecord>) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = receipts_path(dir);
    let temporary = path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(all)?;
    write_private(&temporary, &encoded)?;
    std::fs::rename(&temporary, &path)
}

/// Write owner-only where the platform can express it: the file carries
/// deletion credentials, which are bearer capabilities over uploaded data.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
        // `create(true).truncate(true)` rather than `create_new`: a retried
        // write must be able to replace the leftover temporary file.
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> SubmissionRecord {
        SubmissionRecord {
            incident_id: "inc-1".to_owned(),
            support_code: "ABC123".to_owned(),
            client_state: "processing".to_owned(),
            processing_state: "received".to_owned(),
            service_url: "https://diag.example.com".to_owned(),
            submitted_at: "2026-08-20T00:00:00Z".to_owned(),
            deletion_credential: Some("del_x".to_owned()),
            withdrawn_at: None,
            included_minidump: true,
            included_screenshot: false,
        }
    }

    #[test]
    fn round_trips_a_record_per_report_stem() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "crash-a", &record()).unwrap();
        assert_eq!(load(dir.path(), "crash-a"), Some(record()));
        assert_eq!(load(dir.path(), "crash-b"), None);
    }

    #[test]
    fn a_second_save_replaces_rather_than_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "crash-a", &record()).unwrap();
        let accepted = SubmissionRecord {
            client_state: "accepted".to_owned(),
            processing_state: "accepted".to_owned(),
            ..record()
        };
        save(dir.path(), "crash-a", &accepted).unwrap();
        let all = load_all(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all["crash-a"].client_state, "accepted");
        // The credential survives a state refresh — it is never re-issued.
        assert_eq!(all["crash-a"].deletion_credential.as_deref(), Some("del_x"));
    }

    #[test]
    fn a_corrupt_store_reads_as_empty_rather_than_blocking_the_report_list() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(RECEIPTS_FILE), b"{ truncated").unwrap();
        assert!(load_all(dir.path()).is_empty());
        // And it recovers on the next write.
        save(dir.path(), "crash-a", &record()).unwrap();
        assert_eq!(load_all(dir.path()).len(), 1);
    }

    #[test]
    fn removing_an_absent_stem_is_not_an_error_and_leaves_the_rest_alone() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "crash-a", &record()).unwrap();
        remove(dir.path(), "crash-missing").unwrap();
        remove(dir.path(), "crash-a").unwrap();
        assert!(load_all(dir.path()).is_empty());
    }

    #[test]
    fn no_temporary_file_survives_a_successful_write() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "crash-a", &record()).unwrap();
        assert!(!dir.path().join("submissions.json.tmp").exists());
        assert!(dir.path().join(RECEIPTS_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_owner_only_because_it_holds_deletion_credentials() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "crash-a", &record()).unwrap();
        let mode = std::fs::metadata(dir.path().join(RECEIPTS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_absent_credential_is_omitted_rather_than_serialized_as_null() {
        let dir = tempfile::tempdir().unwrap();
        let resumed = SubmissionRecord {
            deletion_credential: None,
            ..record()
        };
        save(dir.path(), "crash-a", &resumed).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(RECEIPTS_FILE)).unwrap();
        assert!(!raw.contains("deletionCredential"));
        assert!(raw.contains("supportCode"));
    }
}
