//! The on-disk recording bundle: an immutable manifest plus an append-only
//! journal.
//!
//! ```text
//! <data_dir>/cognia/recordings/<recordingId>/
//!     manifest.json     written once at start, never mutated
//!     journal.jsonl     one JSON object per line, fsynced per record
//!     assets/<assetId>.png
//! ```
//!
//! **Undo is a tombstone, never a truncation.** That single choice is what lets
//! the writer be strictly append-only, which in turn is what makes the file
//! crash-safe: a renderer crash, a force-quit or a kill switch can lose at most
//! the record currently in flight, and [`replay`] reconstructs the rest.
//!
//! [`replay`] is a pure fold over the lines, so the entire crash-recovery
//! contract — including a torn final line from a half-written record — is one
//! testable function with no filesystem in the way.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::assets::{AssetId, AssetMeta, RecordingId};
use super::limits::{LimitUsage, RecordLimits};
use super::scope::CaptureScope;
use crate::automation::types::{ElementInfo, MonitorInfo, Platform, Point, Rect};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const JOURNAL_FILE: &str = "journal.jsonl";
pub const BUNDLE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("journal io error: {message}")]
    Io { message: String },
    #[error("bundle manifest is missing or unreadable")]
    NoManifest,
}

fn io(e: std::io::Error) -> JournalError {
    JournalError::Io {
        message: e.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step model
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Click,
    Type,
    Scroll,
    /// The user acted outside the recording's scope. Carries no element, no
    /// text and no frame — only the fact that something was skipped, so the
    /// review timeline can show an honest gap instead of pretending the
    /// recording was continuous.
    OutOfScope,
}

/// What was typed, and whether we are allowed to say.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TextCapture {
    /// Layout-decoded printable text.
    Text { value: String },
    /// The key run touched a secure field, a credential window, or a focus state
    /// we could not classify. Nothing is retained — not the characters, not the
    /// length, not the shape. A length would be enough to narrow a password.
    Sensitive,
    /// A non-printable run, described structurally rather than reconstructed.
    Keys { chord: String },
}

/// The accessibility facts a step is allowed to carry.
///
/// Deliberately **not** [`ElementInfo`]: no `ElementRef` (a live handle into the
/// backend's tree), no `children` (an unbounded subtree), no `process_id`. Only
/// what an LLM needs in order to describe the step in prose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SafeElement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
}

impl SafeElement {
    pub fn from_element_info(info: &ElementInfo) -> Self {
        Self {
            name: info.name.clone(),
            control_type: info.control_type.clone(),
            automation_id: info.automation_id.clone(),
            app_name: info.process_name.clone(),
            window_title: info.window_title.clone(),
            bounds: info.bounding_rect,
        }
    }

    /// True when the element carries nothing an LLM could describe. Drives the
    /// OCR fallback and the "needs a manual intent" review blocker.
    pub fn is_semantically_empty(&self) -> bool {
        let blank = |s: &Option<String>| s.as_deref().map(str::trim).unwrap_or("").is_empty();
        blank(&self.name) && blank(&self.automation_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedStep {
    pub seq: u32,
    pub ts_ms: i64,
    pub kind: StepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<SafeElement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_meta: Option<AssetMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextCapture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_dy: Option<i32>,
    /// Local-OCR text read from a bounded region around the interaction, used
    /// only when accessibility gave nothing. Kept separate from `text` so it can
    /// never be mistaken for something the user typed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_hint: Option<String>,
}

impl RecordedStep {
    pub fn out_of_scope(seq: u32, ts_ms: i64) -> Self {
        Self {
            seq,
            ts_ms,
            kind: StepKind::OutOfScope,
            point: None,
            element: None,
            asset_id: None,
            asset_meta: None,
            text: None,
            scroll_dy: None,
            ocr_hint: None,
        }
    }

    pub fn byte_len(&self) -> u64 {
        self.asset_meta.map(|m| m.byte_len).unwrap_or(0)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest + journal records
// ─────────────────────────────────────────────────────────────────────────────

/// Immutable bundle header. Its presence is what marks a directory as a claimed
/// bundle — [`scan_recoverable`] ignores anything without one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub schema_version: u32,
    pub recording_id: RecordingId,
    pub started_at: i64,
    pub scope: CaptureScope,
    pub capture_screenshots: bool,
    pub limits: RecordLimits,
    pub monitors: Vec<MonitorInfo>,
    pub app_version: String,
    pub platform: Platform,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InterruptReason {
    KillSwitch,
    LimitReached,
    ScopeLost,
    PermissionLost,
    UserInterrupt,
    AppShutdown,
    NativeFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JournalRecord {
    /// Boxed so the eight-variant enum is not sized by its one large payload —
    /// every journal append allocates a `JournalRecord`.
    Step {
        step: Box<RecordedStep>,
    },
    /// Undo tombstone. The step's line stays on disk; replay drops it.
    Undone {
        seq: u32,
        at: i64,
    },
    Paused {
        at: i64,
    },
    Resumed {
        at: i64,
    },
    LimitWarning {
        usage: LimitUsage,
        at: i64,
    },
    ScopeLost {
        reason: String,
        at: i64,
    },
    Stopped {
        at: i64,
        step_count: u32,
    },
    Interrupted {
        at: i64,
        reason: InterruptReason,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BundleOutcome {
    /// `Stopped` was written — the recording finished cleanly.
    Completed,
    /// `Interrupted` was written — the journal is intact and resumable for review.
    Interrupted,
    /// Neither terminal record is present: the process died before it could
    /// write one. Also resumable; the steps up to the crash are all there.
    Open,
}

/// Fully materialized bundle handed to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingBundle {
    pub manifest: BundleManifest,
    /// Tombstoned steps are already removed.
    pub steps: Vec<RecordedStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub outcome: BundleOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt_reason: Option<InterruptReason>,
    /// Steps the user performed outside scope. Reported as a count only.
    pub ignored_count: u32,
    pub total_bytes: u64,
}

/// Pure fold of a journal into a bundle.
///
/// A torn final line — the classic result of a crash mid-`write_all` — is
/// dropped silently. That is the correct reading: the record was never
/// completed, so it never happened.
pub fn replay(manifest: BundleManifest, lines: &[&str], total_bytes: u64) -> RecordingBundle {
    let mut steps: Vec<RecordedStep> = Vec::new();
    let mut tombstoned: Vec<u32> = Vec::new();
    let mut ended_at = None;
    let mut outcome = BundleOutcome::Open;
    let mut interrupt_reason = None;

    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<JournalRecord>(line) else {
            // Unparseable: either a torn tail or a record from a newer schema.
            // Either way the honest move is to skip it, not to fail the whole
            // recovery and strand every step before it.
            continue;
        };
        match record {
            JournalRecord::Step { step } => steps.push(*step),
            JournalRecord::Undone { seq, .. } => {
                if !tombstoned.contains(&seq) {
                    tombstoned.push(seq);
                }
            }
            JournalRecord::Stopped { at, .. } => {
                ended_at = Some(at);
                outcome = BundleOutcome::Completed;
            }
            JournalRecord::Interrupted { at, reason } => {
                ended_at = Some(at);
                outcome = BundleOutcome::Interrupted;
                interrupt_reason = Some(reason);
            }
            JournalRecord::Paused { .. }
            | JournalRecord::Resumed { .. }
            | JournalRecord::LimitWarning { .. }
            | JournalRecord::ScopeLost { .. } => {}
        }
    }

    steps.retain(|s| !tombstoned.contains(&s.seq));
    let ignored_count = steps
        .iter()
        .filter(|s| s.kind == StepKind::OutOfScope)
        .count() as u32;

    RecordingBundle {
        manifest,
        steps,
        ended_at,
        outcome,
        interrupt_reason,
        ignored_count,
        total_bytes,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer
// ─────────────────────────────────────────────────────────────────────────────

/// Append-only journal writer. Every [`Self::append`] is a serialize +
/// `write_all` + `flush` + `sync_data`.
///
/// The per-record fsync is deliberate and is the reason a force-quit costs at
/// most one step. Recording commits at human speed — a few records a second at
/// the very most — so the cost is irrelevant next to the guarantee.
pub struct JournalWriter {
    file: std::fs::File,
    path: PathBuf,
    bytes: u64,
}

impl JournalWriter {
    /// Create the bundle directory, write the manifest, open the journal.
    pub fn create(dir: &Path, manifest: &BundleManifest) -> Result<Self, JournalError> {
        std::fs::create_dir_all(dir.join("assets")).map_err(io)?;
        let manifest_json = serde_json::to_vec_pretty(manifest).map_err(|e| JournalError::Io {
            message: e.to_string(),
        })?;
        std::fs::write(dir.join(MANIFEST_FILE), &manifest_json).map_err(io)?;
        Self::open_append(dir)
    }

    /// Reopen an existing bundle's journal for appending — the shutdown and
    /// kill-switch paths use this to stamp a terminal record without needing the
    /// live session's writer.
    pub fn open_append(dir: &Path) -> Result<Self, JournalError> {
        let path = dir.join(JOURNAL_FILE);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(io)?;
        let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self { file, path, bytes })
    }

    pub fn append(&mut self, record: &JournalRecord) -> Result<(), JournalError> {
        let mut line = serde_json::to_vec(record).map_err(|e| JournalError::Io {
            message: e.to_string(),
        })?;
        line.push(b'\n');
        self.file.write_all(&line).map_err(io)?;
        self.file.flush().map_err(io)?;
        self.file.sync_data().map_err(io)?;
        self.bytes = self.bytes.saturating_add(line.len() as u64);
        Ok(())
    }

    pub fn byte_len(&self) -> u64 {
        self.bytes
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading bundles back
// ─────────────────────────────────────────────────────────────────────────────

pub fn read_manifest(dir: &Path) -> Result<BundleManifest, JournalError> {
    let raw = std::fs::read(dir.join(MANIFEST_FILE)).map_err(|_| JournalError::NoManifest)?;
    serde_json::from_slice(&raw).map_err(|_| JournalError::NoManifest)
}

pub fn read_journal_lines(dir: &Path) -> Vec<String> {
    let Ok(file) = std::fs::File::open(dir.join(JOURNAL_FILE)) else {
        return Vec::new();
    };
    BufReader::new(file).lines().map_while(Result::ok).collect()
}

/// Load and replay one bundle off disk.
pub fn load_bundle(root: &Path, id: &RecordingId) -> Result<RecordingBundle, JournalError> {
    let dir = super::assets::bundle_dir(root, id);
    let manifest = read_manifest(&dir)?;
    let lines = read_journal_lines(&dir);
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    Ok(replay(manifest, &refs, super::assets::dir_bytes(&dir)))
}

/// One row in the "resume an unfinished recording" list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableBundle {
    pub recording_id: RecordingId,
    pub started_at: i64,
    pub step_count: u32,
    pub total_bytes: u64,
    pub outcome: BundleOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt_reason: Option<InterruptReason>,
    /// Human-facing scope description for the recovery prompt.
    pub scope_summary: String,
    pub scope_kind: String,
}

/// Every bundle on disk that still has content, newest first. Nothing is ever
/// auto-deleted here — a recording the user has not seen is not ours to discard.
pub fn scan_recoverable(root: &Path) -> Vec<RecoverableBundle> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<RecoverableBundle> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            if !dir.is_dir() {
                return None;
            }
            let id = RecordingId::parse(entry.file_name().to_string_lossy().as_ref()).ok()?;
            let manifest = read_manifest(&dir).ok()?;
            let lines = read_journal_lines(&dir);
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            let bundle = replay(manifest, &refs, super::assets::dir_bytes(&dir));
            Some(RecoverableBundle {
                recording_id: id,
                started_at: bundle.manifest.started_at,
                step_count: bundle.steps.len() as u32,
                total_bytes: bundle.total_bytes,
                outcome: bundle.outcome,
                interrupt_reason: bundle.interrupt_reason,
                scope_summary: bundle.manifest.scope.summary(),
                scope_kind: bundle.manifest.scope.kind_label().to_string(),
            })
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.started_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::types::{ElementRef, ImageFormat};

    fn manifest() -> BundleManifest {
        BundleManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            recording_id: RecordingId::new(),
            started_at: 1_000,
            scope: CaptureScope::Desktop,
            capture_screenshots: true,
            limits: RecordLimits::default(),
            monitors: vec![],
            app_version: "0.1.0".into(),
            platform: Platform::Macos,
        }
    }

    fn step(seq: u32) -> RecordedStep {
        RecordedStep {
            seq,
            ts_ms: 1_000 + seq as i64,
            kind: StepKind::Click,
            point: Some(Point { x: 1, y: 2 }),
            element: Some(SafeElement {
                name: Some("Save".into()),
                ..SafeElement::default()
            }),
            asset_id: Some(AssetId::new()),
            asset_meta: Some(AssetMeta {
                width: 10,
                height: 10,
                byte_len: 100,
                format: ImageFormat::Png,
                captured_at: 1,
            }),
            text: None,
            scroll_dy: None,
            ocr_hint: None,
        }
    }

    fn line(record: &JournalRecord) -> String {
        serde_json::to_string(record).unwrap()
    }

    #[test]
    fn replay_keeps_steps_in_order() {
        let lines: Vec<String> = (1..=3)
            .map(|s| {
                line(&JournalRecord::Step {
                    step: Box::new(step(s)),
                })
            })
            .collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bundle = replay(manifest(), &refs, 300);
        assert_eq!(
            bundle.steps.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(bundle.outcome, BundleOutcome::Open);
        assert_eq!(bundle.total_bytes, 300);
    }

    #[test]
    fn replay_drops_tombstoned_steps() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Step {
                step: Box::new(step(2)),
            }),
            line(&JournalRecord::Undone { seq: 2, at: 9 }),
            line(&JournalRecord::Step {
                step: Box::new(step(3)),
            }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bundle = replay(manifest(), &refs, 0);
        assert_eq!(
            bundle.steps.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 3],
            "the undone step is gone but its neighbours survive"
        );
    }

    #[test]
    fn replay_of_torn_final_line_keeps_prior_steps() {
        // Exactly what a crash mid-write_all leaves behind.
        let good = line(&JournalRecord::Step {
            step: Box::new(step(1)),
        });
        let torn = {
            let full = line(&JournalRecord::Step {
                step: Box::new(step(2)),
            });
            full[..full.len() / 2].to_string()
        };
        let refs = [good.as_str(), torn.as_str()];
        let bundle = replay(manifest(), &refs, 0);
        assert_eq!(bundle.steps.len(), 1);
        assert_eq!(bundle.steps[0].seq, 1);
        assert_eq!(bundle.outcome, BundleOutcome::Open);
    }

    #[test]
    fn replay_skips_blank_lines_and_unknown_records() {
        let refs = [
            "",
            "   ",
            "{\"type\":\"somethingFromTheFuture\",\"at\":1}",
            "not json at all",
        ];
        let bundle = replay(manifest(), &refs, 0);
        assert!(bundle.steps.is_empty());
        assert_eq!(bundle.outcome, BundleOutcome::Open);
    }

    #[test]
    fn replay_marks_open_bundle_when_no_terminal_record() {
        let lines = [line(&JournalRecord::Step {
            step: Box::new(step(1)),
        })];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert_eq!(replay(manifest(), &refs, 0).outcome, BundleOutcome::Open);
    }

    #[test]
    fn replay_marks_completed_and_records_end_time() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Stopped {
                at: 5_000,
                step_count: 1,
            }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bundle = replay(manifest(), &refs, 0);
        assert_eq!(bundle.outcome, BundleOutcome::Completed);
        assert_eq!(bundle.ended_at, Some(5_000));
        assert!(bundle.interrupt_reason.is_none());
    }

    #[test]
    fn replay_marks_interrupted_with_its_reason() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Interrupted {
                at: 6_000,
                reason: InterruptReason::KillSwitch,
            }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bundle = replay(manifest(), &refs, 0);
        assert_eq!(bundle.outcome, BundleOutcome::Interrupted);
        assert_eq!(bundle.interrupt_reason, Some(InterruptReason::KillSwitch));
        assert_eq!(
            bundle.steps.len(),
            1,
            "an interrupted recording keeps every step it captured"
        );
    }

    #[test]
    fn undo_of_already_undone_seq_is_idempotent() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Undone { seq: 1, at: 2 }),
            line(&JournalRecord::Undone { seq: 1, at: 3 }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert!(replay(manifest(), &refs, 0).steps.is_empty());
    }

    #[test]
    fn undo_of_an_unknown_seq_is_harmless() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Undone { seq: 99, at: 2 }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert_eq!(replay(manifest(), &refs, 0).steps.len(), 1);
    }

    #[test]
    fn replay_counts_out_of_scope_steps() {
        let lines = [
            line(&JournalRecord::Step {
                step: Box::new(step(1)),
            }),
            line(&JournalRecord::Step {
                step: Box::new(RecordedStep::out_of_scope(2, 10)),
            }),
            line(&JournalRecord::Step {
                step: Box::new(RecordedStep::out_of_scope(3, 11)),
            }),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert_eq!(replay(manifest(), &refs, 0).ignored_count, 2);
    }

    #[test]
    fn writer_appends_and_never_rewrites() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bundle");
        let m = manifest();
        let mut w = JournalWriter::create(&dir, &m).unwrap();

        w.append(&JournalRecord::Step {
            step: Box::new(step(1)),
        })
        .unwrap();
        let after_one = std::fs::read(w.path()).unwrap();
        let len_one = w.byte_len();

        w.append(&JournalRecord::Step {
            step: Box::new(step(2)),
        })
        .unwrap();
        let after_two = std::fs::read(w.path()).unwrap();

        assert!(w.byte_len() > len_one, "byte_len is monotonic");
        assert_eq!(
            &after_two[..after_one.len()],
            &after_one[..],
            "the existing prefix must be byte-identical after a later append"
        );
        assert_eq!(after_two.iter().filter(|b| **b == b'\n').count(), 2);
    }

    #[test]
    fn create_writes_the_manifest_and_assets_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bundle");
        let m = manifest();
        JournalWriter::create(&dir, &m).unwrap();
        assert!(dir.join(MANIFEST_FILE).exists());
        assert!(dir.join("assets").is_dir());
        assert_eq!(read_manifest(&dir).unwrap(), m);
    }

    #[test]
    fn open_append_preserves_earlier_records() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bundle");
        let m = manifest();
        {
            let mut w = JournalWriter::create(&dir, &m).unwrap();
            w.append(&JournalRecord::Step {
                step: Box::new(step(1)),
            })
            .unwrap();
        }
        // The shutdown path reopens without the live session's writer.
        let mut w2 = JournalWriter::open_append(&dir).unwrap();
        w2.append(&JournalRecord::Interrupted {
            at: 7,
            reason: InterruptReason::AppShutdown,
        })
        .unwrap();

        let lines = read_journal_lines(&dir);
        assert_eq!(lines.len(), 2);
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bundle = replay(m, &refs, 0);
        assert_eq!(bundle.steps.len(), 1);
        assert_eq!(bundle.outcome, BundleOutcome::Interrupted);
    }

    #[test]
    fn load_bundle_round_trips_from_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let m = manifest();
        let id = m.recording_id.clone();
        let dir = super::super::assets::bundle_dir(tmp.path(), &id);
        let mut w = JournalWriter::create(&dir, &m).unwrap();
        w.append(&JournalRecord::Step {
            step: Box::new(step(1)),
        })
        .unwrap();
        w.append(&JournalRecord::Stopped {
            at: 9,
            step_count: 1,
        })
        .unwrap();

        let bundle = load_bundle(tmp.path(), &id).unwrap();
        assert_eq!(bundle.steps.len(), 1);
        assert_eq!(bundle.outcome, BundleOutcome::Completed);
        assert!(bundle.total_bytes > 0);
    }

    #[test]
    fn load_bundle_without_a_manifest_errors() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            load_bundle(tmp.path(), &RecordingId::new()),
            Err(JournalError::NoManifest)
        ));
    }

    #[test]
    fn scan_recoverable_ignores_dirs_without_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        // A stray directory whose name is not even a valid id.
        std::fs::create_dir_all(tmp.path().join("scratch")).unwrap();
        // A valid id but no manifest — a half-created bundle.
        let orphan = RecordingId::new();
        std::fs::create_dir_all(tmp.path().join(orphan.as_str())).unwrap();

        let real = manifest();
        JournalWriter::create(
            &super::super::assets::bundle_dir(tmp.path(), &real.recording_id),
            &real,
        )
        .unwrap();

        let found = scan_recoverable(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].recording_id, real.recording_id);
        assert_eq!(found[0].scope_kind, "desktop");
    }

    #[test]
    fn scan_recoverable_sorts_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        for started in [100i64, 300, 200] {
            let mut m = manifest();
            m.started_at = started;
            JournalWriter::create(
                &super::super::assets::bundle_dir(tmp.path(), &m.recording_id),
                &m,
            )
            .unwrap();
        }
        let found = scan_recoverable(tmp.path());
        assert_eq!(
            found.iter().map(|b| b.started_at).collect::<Vec<_>>(),
            vec![300, 200, 100]
        );
    }

    #[test]
    fn scan_recoverable_of_missing_root_is_empty() {
        assert!(scan_recoverable(Path::new("/nope/not/here")).is_empty());
    }

    #[test]
    fn safe_element_drops_element_ref_and_children() {
        let info = ElementInfo {
            element_ref: ElementRef("live-backend-handle".into()),
            name: Some("Save".into()),
            automation_id: Some("btnSave".into()),
            control_type: Some("Button".into()),
            class_name: Some("NSButton".into()),
            bounding_rect: Some(Rect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }),
            is_enabled: true,
            is_focused: true,
            process_id: Some(4242),
            process_name: Some("Safari".into()),
            window_title: Some("Invoices".into()),
            children: Some(vec![]),
        };
        let safe = SafeElement::from_element_info(&info);
        let json = serde_json::to_string(&safe).unwrap();

        assert!(json.contains("\"name\":\"Save\""));
        assert!(json.contains("\"automationId\":\"btnSave\""));
        assert!(
            !json.contains("live-backend-handle"),
            "a live element ref must never reach the journal: {json}"
        );
        assert!(!json.contains("elementRef"), "{json}");
        assert!(!json.contains("children"), "{json}");
        assert!(
            !json.contains("4242"),
            "the pid must not be carried: {json}"
        );
    }

    #[test]
    fn safe_element_detects_semantic_emptiness() {
        assert!(SafeElement::default().is_semantically_empty());
        assert!(SafeElement {
            name: Some("   ".into()),
            automation_id: Some("".into()),
            ..SafeElement::default()
        }
        .is_semantically_empty());
        assert!(!SafeElement {
            name: Some("Submit".into()),
            ..SafeElement::default()
        }
        .is_semantically_empty());
        assert!(
            !SafeElement {
                automation_id: Some("btnOk".into()),
                ..SafeElement::default()
            }
            .is_semantically_empty(),
            "an automation id alone is still describable"
        );
    }

    #[test]
    fn sensitive_text_serializes_without_a_value_field() {
        let json = serde_json::to_string(&TextCapture::Sensitive).unwrap();
        assert_eq!(json, "{\"kind\":\"sensitive\"}");
        assert!(!json.contains("value"));
        assert!(!json.contains("len"));
    }

    #[test]
    fn text_capture_variants_round_trip() {
        for value in [
            TextCapture::Text {
                value: "hello".into(),
            },
            TextCapture::Sensitive,
            TextCapture::Keys {
                chord: "cmd+c".into(),
            },
        ] {
            let json = serde_json::to_string(&value).unwrap();
            let back: TextCapture = serde_json::from_str(&json).unwrap();
            assert_eq!(back, value);
        }
    }

    #[test]
    fn recorded_step_serializes_camel_case_and_skips_empties() {
        let json = serde_json::to_string(&RecordedStep::out_of_scope(4, 77)).unwrap();
        assert!(json.contains("\"tsMs\":77"));
        assert!(json.contains("\"kind\":\"outOfScope\""));
        assert!(!json.contains("assetId"));
        assert!(!json.contains("ocrHint"));
        assert!(!json.contains("element"));
    }

    #[test]
    fn recorded_step_json_has_no_absolute_path() {
        let json = serde_json::to_string(&step(1)).unwrap();
        assert!(!json.contains("/Users"), "{json}");
        assert!(!json.contains("C:\\"), "{json}");
        assert!(
            !json.contains(".png"),
            "assets are ids, not filenames: {json}"
        );
    }

    #[test]
    fn journal_record_serializes_camel_case_tagged() {
        assert!(line(&JournalRecord::Paused { at: 1 }).contains("\"type\":\"paused\""));
        assert!(line(&JournalRecord::Resumed { at: 1 }).contains("\"type\":\"resumed\""));
        assert!(line(&JournalRecord::Undone { seq: 1, at: 2 }).contains("\"type\":\"undone\""));
        let stopped = line(&JournalRecord::Stopped {
            at: 1,
            step_count: 3,
        });
        assert!(stopped.contains("\"stepCount\":3"));
        let interrupted = line(&JournalRecord::Interrupted {
            at: 1,
            reason: InterruptReason::LimitReached,
        });
        assert!(interrupted.contains("\"reason\":\"limitReached\""));
        let scope_lost = line(&JournalRecord::ScopeLost {
            reason: "window-closed".into(),
            at: 1,
        });
        assert!(scope_lost.contains("\"type\":\"scopeLost\""));
    }

    #[test]
    fn manifest_round_trips() {
        let m = manifest();
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"captureScreenshots\":true"));
        let back: BundleManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn recording_bundle_round_trips() {
        let bundle = replay(manifest(), &[], 0);
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(json.contains("\"outcome\":\"open\""));
        assert!(json.contains("\"ignoredCount\":0"));
        let back: RecordingBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(back, bundle);
    }

    #[test]
    fn step_byte_len_reads_from_asset_meta() {
        assert_eq!(step(1).byte_len(), 100);
        assert_eq!(RecordedStep::out_of_scope(1, 0).byte_len(), 0);
    }
}
