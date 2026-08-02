//! Bounded, restart-safe NDJSON spool for native V1 producers (ADR-0102 §3).
//!
//! Mirrors the renderer spool in `packages/logging/src/spool.ts`: one
//! monotonically increasing sequence per runtime, a flush watermark, hard
//! event/byte bounds, and `warn+` protection — a full spool evicts chatter
//! before it drops anything a crash report would need.
//!
//! Restart safety is the part a memory store cannot give you. State is written
//! through a temp file + rename, and recovery re-derives the in-memory index
//! from the NDJSON file, so a process killed mid-append resumes with a
//! consistent sequence instead of replaying or skipping records.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::event::{ObservabilityEventKind, ObservabilityEventV1, ObservabilitySeverity};

const EVENTS_FILE: &str = "events.ndjson";
const STATE_FILE: &str = "state.json";
const STATE_TEMP_FILE: &str = "state.json.tmp";
const EVENTS_TEMP_FILE: &str = "events.ndjson.tmp";

/// Hard bounds. A spool never grows past these; the only question is what it
/// gives up to stay inside them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolLimits {
    pub max_events: usize,
    pub max_bytes: u64,
}

impl Default for SpoolLimits {
    /// Seven days of local logs at 250 MB is the ADR default for the *store*;
    /// a single process spool is far smaller because it is a staging buffer,
    /// not the archive.
    fn default() -> Self {
        Self {
            max_events: 50_000,
            max_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolStats {
    pub event_count: usize,
    pub total_bytes: u64,
    pub last_sequence: u64,
    pub flush_watermark: u64,
    pub dropped_low_severity_events: u64,
    /// Protected (`warn+`) events the spool could not store. Non-zero here is
    /// a reportable defect, not routine back-pressure: an incident assembled
    /// from this spool is incomplete and must say so.
    pub rejected_protected_events: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpoolCapacityReason {
    EventTooLarge,
    ProtectedSeverityCapacity,
    LowSeverityCapacity,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpoolRecord {
    pub sequence: u64,
    pub bytes: u64,
    pub event: ObservabilityEventV1,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SpoolEnqueueResult {
    Stored {
        record: Box<SpoolRecord>,
        evicted: Vec<u64>,
        stats: SpoolStats,
    },
    CapacityExhausted {
        reason: SpoolCapacityReason,
        evicted: Vec<u64>,
        stats: SpoolStats,
    },
}

impl SpoolEnqueueResult {
    pub fn stats(&self) -> SpoolStats {
        match self {
            Self::Stored { stats, .. } | Self::CapacityExhausted { stats, .. } => *stats,
        }
    }

    pub fn is_stored(&self) -> bool {
        matches!(self, Self::Stored { .. })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    #[error("spool i/o failed at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("event rejected by the V1 contract: {0}")]
    Contract(#[from] crate::event::EventError),
}

fn io_error(path: &Path, source: std::io::Error) -> SpoolError {
    SpoolError::Io {
        path: path.display().to_string(),
        source,
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    last_sequence: u64,
    flush_watermark: u64,
    #[serde(default)]
    dropped_low_severity_events: u64,
    #[serde(default)]
    rejected_protected_events: u64,
}

#[derive(Debug, Clone)]
struct IndexEntry {
    sequence: u64,
    bytes: u64,
    protected: bool,
    line: String,
}

/// Durability tier requested for one write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityTier {
    /// Buffered — the OS decides when this reaches the disk.
    Batched,
    /// Flushed to the OS immediately, but not fsynced.
    Prompt,
    /// fsynced before the call returns. Used where the next instruction might
    /// be the one that terminates the process.
    Synchronous,
}

/// Which tier an event earns, per ADR-0102 §3. Crashes and terminal lifecycle
/// events are the cases where "we'll flush later" means "we never flushed".
pub fn durability_for(event: &ObservabilityEventV1) -> DurabilityTier {
    if event.kind == ObservabilityEventKind::Crash || event.severity >= ObservabilitySeverity::Error
    {
        return DurabilityTier::Synchronous;
    }
    if event.kind == ObservabilityEventKind::Lifecycle
        && event.severity >= ObservabilitySeverity::Warn
    {
        return DurabilityTier::Synchronous;
    }
    if event.severity >= ObservabilitySeverity::Warn {
        return DurabilityTier::Prompt;
    }
    DurabilityTier::Batched
}

/// A restart-safe, bounded NDJSON spool rooted at one directory.
#[derive(Debug)]
pub struct FileSpool {
    dir: PathBuf,
    limits: SpoolLimits,
    index: Vec<IndexEntry>,
    stats: SpoolStats,
    writer: Option<File>,
}

impl FileSpool {
    /// Open (creating if needed) and recover the spool at `dir`.
    ///
    /// Recovery is the interesting path: a line that does not parse — the
    /// classic torn tail of a process killed mid-append — is dropped rather
    /// than poisoning the whole spool, and anything at or below the persisted
    /// watermark is discarded because the sink already has it.
    pub fn open(dir: impl AsRef<Path>, limits: SpoolLimits) -> Result<Self, SpoolError> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(|error| io_error(&dir, error))?;

        let persisted = Self::read_state(&dir)?;
        let mut index = Vec::new();
        let events_path = dir.join(EVENTS_FILE);
        let mut torn_lines = 0usize;

        if events_path.exists() {
            let file = File::open(&events_path).map_err(|error| io_error(&events_path, error))?;
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else {
                    torn_lines += 1;
                    continue;
                };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<ObservabilityEventV1>(&line) else {
                    torn_lines += 1;
                    continue;
                };
                if event.delivery.spool_sequence <= persisted.flush_watermark {
                    continue;
                }
                index.push(IndexEntry {
                    sequence: event.delivery.spool_sequence,
                    bytes: line.len() as u64,
                    protected: event.severity.is_protected(),
                    line,
                });
            }
        }

        index.sort_by_key(|entry| entry.sequence);
        index.dedup_by_key(|entry| entry.sequence);

        let last_sequence = persisted
            .last_sequence
            .max(index.last().map(|entry| entry.sequence).unwrap_or(0));
        let mut spool = Self {
            dir,
            limits,
            stats: SpoolStats {
                event_count: index.len(),
                total_bytes: index.iter().map(|entry| entry.bytes).sum(),
                last_sequence,
                flush_watermark: persisted.flush_watermark,
                dropped_low_severity_events: persisted.dropped_low_severity_events,
                rejected_protected_events: persisted.rejected_protected_events,
            },
            index,
            writer: None,
        };

        // Only rewrite when recovery actually changed the file — an untouched
        // spool must not be rewritten on every launch.
        if torn_lines > 0 || persisted.flush_watermark > 0 {
            spool.rewrite()?;
        }
        spool.persist_state()?;
        Ok(spool)
    }

    fn read_state(dir: &Path) -> Result<PersistedState, SpoolError> {
        let path = dir.join(STATE_FILE);
        if !path.exists() {
            return Ok(PersistedState::default());
        }
        let raw = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
        // A corrupt state file must not brick the spool; recovery then leans on
        // the NDJSON file alone, which is the conservative direction (replay
        // rather than lose).
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    fn persist_state(&self) -> Result<(), SpoolError> {
        let state = PersistedState {
            last_sequence: self.stats.last_sequence,
            flush_watermark: self.stats.flush_watermark,
            dropped_low_severity_events: self.stats.dropped_low_severity_events,
            rejected_protected_events: self.stats.rejected_protected_events,
        };
        let temp = self.dir.join(STATE_TEMP_FILE);
        let final_path = self.dir.join(STATE_FILE);
        let encoded = serde_json::to_string(&state).unwrap_or_default();
        fs::write(&temp, encoded).map_err(|error| io_error(&temp, error))?;
        fs::rename(&temp, &final_path).map_err(|error| io_error(&final_path, error))?;
        Ok(())
    }

    /// Rewrite `events.ndjson` from the in-memory index, atomically. Called
    /// after eviction or acknowledgement, never on the hot append path.
    fn rewrite(&mut self) -> Result<(), SpoolError> {
        self.writer = None;
        let temp = self.dir.join(EVENTS_TEMP_FILE);
        let final_path = self.dir.join(EVENTS_FILE);
        let mut buffer = String::new();
        for entry in &self.index {
            buffer.push_str(&entry.line);
            buffer.push('\n');
        }
        fs::write(&temp, buffer).map_err(|error| io_error(&temp, error))?;
        fs::rename(&temp, &final_path).map_err(|error| io_error(&final_path, error))?;
        Ok(())
    }

    fn writer(&mut self) -> Result<&mut File, SpoolError> {
        if self.writer.is_none() {
            let path = self.dir.join(EVENTS_FILE);
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|error| io_error(&path, error))?;
            self.writer = Some(file);
        }
        Ok(self.writer.as_mut().expect("writer was just opened"))
    }

    pub fn stats(&self) -> SpoolStats {
        self.stats
    }

    pub fn limits(&self) -> SpoolLimits {
        self.limits
    }

    /// Append one event. The event is stamped with its sequence and the current
    /// watermark, validated, and only then written — an invalid event never
    /// reaches the file.
    pub fn enqueue(
        &mut self,
        event: &ObservabilityEventV1,
    ) -> Result<SpoolEnqueueResult, SpoolError> {
        let sequence = self.stats.last_sequence + 1;
        let stamped = event
            .clone()
            .with_delivery(sequence, self.stats.flush_watermark);
        let line = stamped.to_ndjson_line()?;
        let bytes = line.len() as u64;
        let protected = stamped.severity.is_protected();
        let mut evicted = Vec::new();

        if bytes > self.limits.max_bytes || self.limits.max_events == 0 {
            if protected {
                self.stats.rejected_protected_events += 1;
            } else {
                self.stats.dropped_low_severity_events += 1;
            }
            self.persist_state()?;
            return Ok(SpoolEnqueueResult::CapacityExhausted {
                reason: SpoolCapacityReason::EventTooLarge,
                evicted,
                stats: self.stats,
            });
        }

        while self.stats.event_count + 1 > self.limits.max_events
            || self.stats.total_bytes + bytes > self.limits.max_bytes
        {
            let Some(position) = self.index.iter().position(|entry| !entry.protected) else {
                break;
            };
            let removed = self.index.remove(position);
            self.stats.event_count -= 1;
            self.stats.total_bytes -= removed.bytes;
            self.stats.dropped_low_severity_events += 1;
            evicted.push(removed.sequence);
        }

        if self.stats.event_count + 1 > self.limits.max_events
            || self.stats.total_bytes + bytes > self.limits.max_bytes
        {
            if protected {
                self.stats.rejected_protected_events += 1;
            } else {
                self.stats.dropped_low_severity_events += 1;
            }
            if !evicted.is_empty() {
                self.rewrite()?;
            }
            self.persist_state()?;
            return Ok(SpoolEnqueueResult::CapacityExhausted {
                reason: if protected {
                    SpoolCapacityReason::ProtectedSeverityCapacity
                } else {
                    SpoolCapacityReason::LowSeverityCapacity
                },
                evicted,
                stats: self.stats,
            });
        }

        if evicted.is_empty() {
            let tier = durability_for(&stamped);
            let events_path = self.dir.join(EVENTS_FILE);
            let writer = self.writer()?;
            let written = writer
                .write_all(line.as_bytes())
                .and_then(|()| writer.write_all(b"\n"))
                .and_then(|()| match tier {
                    DurabilityTier::Batched => Ok(()),
                    DurabilityTier::Prompt => writer.flush(),
                    DurabilityTier::Synchronous => writer.flush().and_then(|()| writer.sync_all()),
                });
            written.map_err(|error| io_error(&events_path, error))?;
            self.index.push(IndexEntry {
                sequence,
                bytes,
                protected,
                line,
            });
        } else {
            self.index.push(IndexEntry {
                sequence,
                bytes,
                protected,
                line,
            });
            self.rewrite()?;
        }

        self.stats.event_count += 1;
        self.stats.total_bytes += bytes;
        self.stats.last_sequence = sequence;
        self.persist_state()?;

        Ok(SpoolEnqueueResult::Stored {
            record: Box::new(SpoolRecord {
                sequence,
                bytes,
                event: stamped,
            }),
            evicted,
            stats: self.stats,
        })
    }

    /// Read up to `limit` records with a sequence greater than `after_sequence`.
    pub fn list(&self, after_sequence: u64, limit: usize) -> Vec<SpoolRecord> {
        self.index
            .iter()
            .filter(|entry| entry.sequence > after_sequence)
            .take(limit)
            .filter_map(|entry| {
                serde_json::from_str::<ObservabilityEventV1>(&entry.line)
                    .ok()
                    .map(|event| SpoolRecord {
                        sequence: entry.sequence,
                        bytes: entry.bytes,
                        event,
                    })
            })
            .collect()
    }

    /// Acknowledge everything through `sequence`. The watermark only moves
    /// forward, so a late or duplicated ack cannot rewind delivery.
    pub fn ack_through(&mut self, sequence: u64) -> Result<SpoolStats, SpoolError> {
        let before = self.index.len();
        let acknowledged_bytes: u64 = self
            .index
            .iter()
            .filter(|entry| entry.sequence <= sequence)
            .map(|entry| entry.bytes)
            .sum();
        self.index.retain(|entry| entry.sequence > sequence);
        let removed = before - self.index.len();
        self.stats.event_count -= removed;
        self.stats.total_bytes -= acknowledged_bytes;
        self.stats.flush_watermark = self.stats.flush_watermark.max(sequence);
        if removed > 0 {
            self.rewrite()?;
        }
        self.persist_state()?;
        Ok(self.stats)
    }

    /// Drop everything, including the on-disk files.
    pub fn clear(&mut self) -> Result<(), SpoolError> {
        self.index.clear();
        self.stats.event_count = 0;
        self.stats.total_bytes = 0;
        self.rewrite()?;
        self.persist_state()
    }

    /// Time-bounded drain. Returns what was acknowledged and what was left, so
    /// a shutdown path can record the unfinished count instead of blocking on
    /// a sink that is not answering.
    pub fn drain<F>(
        &mut self,
        mut sink: F,
        batch_size: usize,
        budget: std::time::Duration,
        now: &dyn Fn() -> std::time::Instant,
    ) -> Result<DrainResult, SpoolError>
    where
        F: FnMut(&[SpoolRecord]) -> u64,
    {
        let started = now();
        let mut acknowledged = 0usize;

        while now().duration_since(started) < budget {
            let records = self.list(0, batch_size.max(1));
            if records.is_empty() {
                break;
            }
            let acknowledged_through = sink(&records);
            let count = records
                .iter()
                .filter(|record| record.sequence <= acknowledged_through)
                .count();
            if count == 0 {
                break;
            }
            self.ack_through(acknowledged_through)?;
            acknowledged += count;
        }

        let timed_out = self.stats.event_count > 0 && now().duration_since(started) >= budget;
        Ok(DrainResult {
            acknowledged,
            unfinished: self.stats.event_count,
            timed_out,
        })
    }

    /// Flush and fsync whatever is buffered. Call on graceful shutdown.
    pub fn close(&mut self) -> Result<(), SpoolError> {
        if let Some(writer) = self.writer.as_mut() {
            writer
                .flush()
                .and_then(|()| writer.sync_all())
                .map_err(|error| io_error(&self.dir.join(EVENTS_FILE), error))?;
        }
        self.writer = None;
        self.persist_state()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResult {
    pub acknowledged: usize,
    pub unfinished: usize,
    pub timed_out: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{
        ObservabilityCorrelation, ObservabilityPayload, ObservabilityPrivacy, ObservabilityRuntime,
        ObservabilityScope,
    };
    use tempfile::TempDir;

    fn scope() -> ObservabilityScope {
        ObservabilityScope {
            tenant_id: "tenant-local".into(),
            installation_id: "install-1".into(),
            runtime: ObservabilityRuntime::Tauri,
            process_id: "main-1".into(),
            module: "spool".into(),
            plugin_id: None,
            build_id: "build-1".into(),
            app_version: "0.1.0".into(),
            origin: None,
        }
    }

    fn event(severity: ObservabilitySeverity, message: &str) -> ObservabilityEventV1 {
        ObservabilityEventV1::new(
            format!("event-{message}"),
            "2026-08-01T09:15:00Z",
            ObservabilityEventKind::Log,
            severity,
            message,
            "log.spool",
            scope(),
            ObservabilityPrivacy::metadata_only("privacy-v1-2026-08-01"),
            ObservabilityPayload::message(message),
        )
        .with_correlation(ObservabilityCorrelation::default())
    }

    fn open(dir: &TempDir, limits: SpoolLimits) -> FileSpool {
        FileSpool::open(dir.path(), limits).expect("spool opens")
    }

    fn generous() -> SpoolLimits {
        SpoolLimits {
            max_events: 100,
            max_bytes: 1024 * 1024,
        }
    }

    #[test]
    fn sequences_start_at_one_and_increase_monotonically() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        for index in 1..=5 {
            let result = spool
                .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                .expect("enqueue");
            match result {
                SpoolEnqueueResult::Stored { record, .. } => {
                    assert_eq!(record.sequence, index);
                    assert_eq!(record.event.delivery.spool_sequence, index);
                }
                other => panic!("expected stored, got {other:?}"),
            }
        }
        assert_eq!(spool.stats().last_sequence, 5);
        assert_eq!(spool.stats().event_count, 5);
    }

    #[test]
    fn events_survive_a_restart_with_their_sequences() {
        let dir = TempDir::new().expect("tempdir");
        {
            let mut spool = open(&dir, generous());
            spool
                .enqueue(&event(ObservabilitySeverity::Error, "boom"))
                .expect("enqueue");
            spool
                .enqueue(&event(ObservabilitySeverity::Info, "hello"))
                .expect("enqueue");
            spool.close().expect("close");
        }
        let spool = open(&dir, generous());
        assert_eq!(spool.stats().event_count, 2);
        assert_eq!(spool.stats().last_sequence, 2);
        let records = spool.list(0, 10);
        assert_eq!(records[0].event.payload.message, "boom");
        assert_eq!(records[1].sequence, 2);
    }

    #[test]
    fn a_new_sequence_never_reuses_an_acknowledged_one() {
        let dir = TempDir::new().expect("tempdir");
        {
            let mut spool = open(&dir, generous());
            for index in 0..3 {
                spool
                    .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                    .expect("enqueue");
            }
            spool.ack_through(3).expect("ack");
            spool.close().expect("close");
        }
        let mut spool = open(&dir, generous());
        assert_eq!(spool.stats().event_count, 0);
        assert_eq!(spool.stats().flush_watermark, 3);
        let result = spool
            .enqueue(&event(ObservabilitySeverity::Info, "after"))
            .expect("enqueue");
        match result {
            SpoolEnqueueResult::Stored { record, .. } => {
                assert_eq!(record.sequence, 4, "sequence must not restart");
                assert_eq!(record.event.delivery.flush_watermark, 3);
            }
            other => panic!("expected stored, got {other:?}"),
        }
    }

    #[test]
    fn a_torn_tail_line_is_dropped_without_losing_earlier_records() {
        let dir = TempDir::new().expect("tempdir");
        {
            let mut spool = open(&dir, generous());
            spool
                .enqueue(&event(ObservabilitySeverity::Warn, "kept"))
                .expect("enqueue");
            spool.close().expect("close");
        }
        // Simulate a process killed mid-append: a partial JSON line at the end.
        let path = dir.path().join(EVENTS_FILE);
        let mut file = OpenOptions::new().append(true).open(&path).expect("open");
        file.write_all(b"{\"schemaVersion\":1,\"eventId\":\"tor")
            .expect("write");
        drop(file);

        let spool = open(&dir, generous());
        assert_eq!(spool.stats().event_count, 1);
        assert_eq!(spool.list(0, 10)[0].event.payload.message, "kept");
    }

    #[test]
    fn a_corrupt_state_file_does_not_brick_the_spool() {
        let dir = TempDir::new().expect("tempdir");
        {
            let mut spool = open(&dir, generous());
            spool
                .enqueue(&event(ObservabilitySeverity::Info, "kept"))
                .expect("enqueue");
            spool.close().expect("close");
        }
        fs::write(dir.path().join(STATE_FILE), "{ not json").expect("write");
        let spool = open(&dir, generous());
        // Watermark is lost, so the record replays — the conservative direction.
        assert_eq!(spool.stats().event_count, 1);
        assert_eq!(spool.stats().last_sequence, 1);
    }

    #[test]
    fn low_severity_events_are_evicted_before_protected_ones() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(
            &dir,
            SpoolLimits {
                max_events: 3,
                max_bytes: 1024 * 1024,
            },
        );
        spool
            .enqueue(&event(ObservabilitySeverity::Info, "chatter-1"))
            .expect("enqueue");
        spool
            .enqueue(&event(ObservabilitySeverity::Error, "important"))
            .expect("enqueue");
        spool
            .enqueue(&event(ObservabilitySeverity::Info, "chatter-2"))
            .expect("enqueue");
        let result = spool
            .enqueue(&event(ObservabilitySeverity::Info, "chatter-3"))
            .expect("enqueue");

        assert!(result.is_stored());
        let messages: Vec<String> = spool
            .list(0, 10)
            .into_iter()
            .map(|record| record.event.payload.message)
            .collect();
        assert!(messages.contains(&"important".to_string()));
        assert!(!messages.contains(&"chatter-1".to_string()));
        assert_eq!(spool.stats().dropped_low_severity_events, 1);
        assert_eq!(spool.stats().rejected_protected_events, 0);
    }

    #[test]
    fn a_protected_event_is_reported_rejected_rather_than_silently_dropped() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(
            &dir,
            SpoolLimits {
                max_events: 2,
                max_bytes: 1024 * 1024,
            },
        );
        spool
            .enqueue(&event(ObservabilitySeverity::Error, "e1"))
            .expect("enqueue");
        spool
            .enqueue(&event(ObservabilitySeverity::Fatal, "e2"))
            .expect("enqueue");
        let result = spool
            .enqueue(&event(ObservabilitySeverity::Error, "e3"))
            .expect("enqueue");

        match result {
            SpoolEnqueueResult::CapacityExhausted { reason, stats, .. } => {
                assert_eq!(reason, SpoolCapacityReason::ProtectedSeverityCapacity);
                assert_eq!(stats.rejected_protected_events, 1);
            }
            other => panic!("expected capacity exhaustion, got {other:?}"),
        }
        // The two earlier protected events are untouched.
        assert_eq!(spool.stats().event_count, 2);
    }

    #[test]
    fn an_oversized_event_is_rejected_without_evicting_anything() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(
            &dir,
            SpoolLimits {
                max_events: 10,
                max_bytes: 64,
            },
        );
        let result = spool
            .enqueue(&event(
                ObservabilitySeverity::Error,
                "far too large for 64 bytes",
            ))
            .expect("enqueue");
        match result {
            SpoolEnqueueResult::CapacityExhausted {
                reason, evicted, ..
            } => {
                assert_eq!(reason, SpoolCapacityReason::EventTooLarge);
                assert!(evicted.is_empty());
            }
            other => panic!("expected capacity exhaustion, got {other:?}"),
        }
        assert_eq!(spool.stats().event_count, 0);
    }

    #[test]
    fn zero_capacity_rejects_everything() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(
            &dir,
            SpoolLimits {
                max_events: 0,
                max_bytes: 1024,
            },
        );
        let result = spool
            .enqueue(&event(ObservabilitySeverity::Info, "m"))
            .expect("enqueue");
        assert!(!result.is_stored());
    }

    #[test]
    fn byte_bounds_are_enforced_as_well_as_event_bounds() {
        let dir = TempDir::new().expect("tempdir");
        let single = {
            let probe_dir = TempDir::new().expect("tempdir");
            let mut probe = open(&probe_dir, generous());
            match probe
                .enqueue(&event(ObservabilitySeverity::Info, "sized"))
                .expect("enqueue")
            {
                SpoolEnqueueResult::Stored { record, .. } => record.bytes,
                other => panic!("expected stored, got {other:?}"),
            }
        };
        let mut spool = open(
            &dir,
            SpoolLimits {
                max_events: 100,
                max_bytes: single * 2 + 2,
            },
        );
        for index in 0..4 {
            spool
                .enqueue(&event(ObservabilitySeverity::Info, "sized"))
                .expect("enqueue");
            let _ = index;
        }
        assert!(spool.stats().total_bytes <= spool.limits().max_bytes);
        assert!(spool.stats().dropped_low_severity_events > 0);
    }

    #[test]
    fn ack_through_moves_the_watermark_forward_only() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        for index in 0..3 {
            spool
                .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                .expect("enqueue");
        }
        spool.ack_through(2).expect("ack");
        assert_eq!(spool.stats().flush_watermark, 2);
        assert_eq!(spool.stats().event_count, 1);
        spool.ack_through(1).expect("late ack");
        assert_eq!(
            spool.stats().flush_watermark,
            2,
            "a late ack must not rewind the watermark"
        );
        assert_eq!(spool.stats().event_count, 1);
    }

    #[test]
    fn list_respects_after_sequence_and_limit() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        for index in 0..5 {
            spool
                .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                .expect("enqueue");
        }
        let page = spool.list(2, 2);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].sequence, 3);
        assert_eq!(page[1].sequence, 4);
    }

    #[test]
    fn drain_acknowledges_everything_a_healthy_sink_accepts() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        for index in 0..5 {
            spool
                .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                .expect("enqueue");
        }
        let now = std::time::Instant::now;
        let result = spool
            .drain(
                |records| records.last().map(|record| record.sequence).unwrap_or(0),
                2,
                std::time::Duration::from_secs(5),
                &now,
            )
            .expect("drain");
        assert_eq!(result.acknowledged, 5);
        assert_eq!(result.unfinished, 0);
        assert!(!result.timed_out);
    }

    #[test]
    fn drain_reports_unfinished_work_when_the_budget_expires() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        for index in 0..5 {
            spool
                .enqueue(&event(ObservabilitySeverity::Info, &format!("m{index}")))
                .expect("enqueue");
        }
        // A clock that jumps past the budget after the first look.
        let start = std::time::Instant::now();
        let calls = std::cell::Cell::new(0u32);
        let clock = move || {
            let seen = calls.get();
            calls.set(seen + 1);
            if seen == 0 {
                start
            } else {
                start + std::time::Duration::from_secs(60)
            }
        };
        let result = spool
            .drain(
                |records| records.last().map(|record| record.sequence).unwrap_or(0),
                1,
                std::time::Duration::from_secs(1),
                &clock,
            )
            .expect("drain");
        assert_eq!(result.acknowledged, 0);
        assert_eq!(result.unfinished, 5);
        assert!(result.timed_out);
    }

    #[test]
    fn drain_stops_when_the_sink_refuses_everything() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        spool
            .enqueue(&event(ObservabilitySeverity::Info, "m"))
            .expect("enqueue");
        let now = std::time::Instant::now;
        let result = spool
            .drain(|_| 0, 10, std::time::Duration::from_secs(5), &now)
            .expect("drain");
        assert_eq!(result.acknowledged, 0);
        assert_eq!(result.unfinished, 1);
        assert!(!result.timed_out, "a refusing sink is not a timeout");
    }

    #[test]
    fn clear_empties_the_spool_and_the_file() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        spool
            .enqueue(&event(ObservabilitySeverity::Info, "m"))
            .expect("enqueue");
        spool.clear().expect("clear");
        assert_eq!(spool.stats().event_count, 0);
        let contents = fs::read_to_string(dir.path().join(EVENTS_FILE)).expect("read");
        assert!(contents.is_empty());
    }

    #[test]
    fn an_invalid_event_is_rejected_before_it_reaches_the_file() {
        let dir = TempDir::new().expect("tempdir");
        let mut spool = open(&dir, generous());
        let mut invalid = event(ObservabilitySeverity::Info, "m");
        invalid.name.clear();
        assert!(spool.enqueue(&invalid).is_err());
        assert_eq!(spool.stats().event_count, 0);
        assert_eq!(spool.stats().last_sequence, 0);
    }

    #[test]
    fn durability_tier_escalates_for_crashes_and_errors() {
        assert_eq!(
            durability_for(&event(ObservabilitySeverity::Trace, "m")),
            DurabilityTier::Batched
        );
        assert_eq!(
            durability_for(&event(ObservabilitySeverity::Warn, "m")),
            DurabilityTier::Prompt
        );
        assert_eq!(
            durability_for(&event(ObservabilitySeverity::Error, "m")),
            DurabilityTier::Synchronous
        );

        let mut crash = event(ObservabilitySeverity::Info, "m");
        crash.kind = ObservabilityEventKind::Crash;
        assert_eq!(durability_for(&crash), DurabilityTier::Synchronous);

        let mut terminal = event(ObservabilitySeverity::Warn, "m");
        terminal.kind = ObservabilityEventKind::Lifecycle;
        assert_eq!(durability_for(&terminal), DurabilityTier::Synchronous);
    }

    #[test]
    fn stats_survive_a_restart() {
        let dir = TempDir::new().expect("tempdir");
        {
            let mut spool = open(
                &dir,
                SpoolLimits {
                    max_events: 1,
                    max_bytes: 1024 * 1024,
                },
            );
            spool
                .enqueue(&event(ObservabilitySeverity::Info, "a"))
                .expect("enqueue");
            spool
                .enqueue(&event(ObservabilitySeverity::Info, "b"))
                .expect("enqueue");
            spool.close().expect("close");
        }
        let spool = open(
            &dir,
            SpoolLimits {
                max_events: 1,
                max_bytes: 1024 * 1024,
            },
        );
        assert_eq!(spool.stats().dropped_low_severity_events, 1);
        assert_eq!(spool.stats().last_sequence, 2);
    }

    #[test]
    fn default_limits_are_bounded() {
        let limits = SpoolLimits::default();
        assert!(limits.max_events > 0);
        assert!(limits.max_bytes > 0);
    }

    #[test]
    fn opening_a_fresh_directory_creates_it() {
        let dir = TempDir::new().expect("tempdir");
        let nested = dir.path().join("a").join("b");
        let spool = FileSpool::open(&nested, generous()).expect("opens");
        assert!(nested.exists());
        assert_eq!(spool.stats().event_count, 0);
    }
}
