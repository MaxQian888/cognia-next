//! Wire and storage types for the background-job supervisor.
//!
//! Everything crossing a boundary (the `host_rpc` stdio frame to the sidecar,
//! the Tauri command surface, the Companion RPC to a remote client) serializes
//! camelCase so the TypeScript mirrors match without an adapter layer.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Who owns a job, and therefore what kills it.
///
/// This is the whole reason the supervisor exists: a scheduled task's chat
/// session is torn down the moment its turn settles, so a job bound to that
/// session would die before the work finished. `ScheduledTask` and `App`
/// ownership let work outlive the turn that started it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobOwner {
    /// Default. Killed after [`crate::limits::SESSION_CLOSE_GRACE`] once the
    /// chat session closes — the grace period survives a webview reload.
    #[serde(rename_all = "camelCase")]
    Session { session_id: String },
    /// Lives until the owning scheduled task fires again or is deleted.
    #[serde(rename_all = "camelCase")]
    ScheduledTask { task_id: String },
    /// Survives every session. Reaped at app exit or after
    /// [`crate::limits::DETACHED_JOB_TTL`], whichever comes first. Requires
    /// explicit `detach: true` plus approval — never the default.
    App,
}

impl JobOwner {
    /// Stable discriminant used for SQLite indexing and log lines.
    pub fn kind_str(&self) -> &'static str {
        match self {
            JobOwner::Session { .. } => "session",
            JobOwner::ScheduledTask { .. } => "scheduledTask",
            JobOwner::App => "app",
        }
    }

    /// The owning entity's id, if the variant has one.
    pub fn owner_id(&self) -> Option<&str> {
        match self {
            JobOwner::Session { session_id } => Some(session_id),
            JobOwner::ScheduledTask { task_id } => Some(task_id),
            JobOwner::App => None,
        }
    }
}

/// Lifecycle state of a job. Terminal states are everything except `Running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Running,
    /// Process ended on its own; `exit_code` carries the real code.
    Exited,
    /// Killed by us — user action, owner teardown, or TTL expiry.
    Killed,
    /// The supervisor lost track of it (app crash). Set by boot reconcile,
    /// never by the running supervisor.
    Interrupted,
    /// Spawn itself failed; the process never existed.
    Failed,
}

impl JobStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, JobStatus::Running)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Exited => "exited",
            JobStatus::Killed => "killed",
            JobStatus::Interrupted => "interrupted",
            JobStatus::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "running" => Some(JobStatus::Running),
            "exited" => Some(JobStatus::Exited),
            "killed" => Some(JobStatus::Killed),
            "interrupted" => Some(JobStatus::Interrupted),
            "failed" => Some(JobStatus::Failed),
            _ => None,
        }
    }
}

/// Request to start a background job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnJobRequest {
    /// The shell command line, verbatim as the model wrote it. Kept for display
    /// and for `list_shells`; the supervisor does not re-parse it.
    pub command: String,
    /// Program to exec (the resolved platform shell).
    pub program: String,
    /// Argv for `program`, already built by the caller's shell descriptor.
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Full environment for the child. The caller (sidecar) has already
    /// scrubbed shell-injection vectors and pinned non-interactive vars.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub owner: JobOwner,
    /// Windows-only: pass argv through without re-quoting.
    #[serde(default)]
    pub windows_verbatim_arguments: bool,
    /// Optional human label shown in the Job Center ahead of the raw command.
    #[serde(default)]
    pub label: Option<String>,
}

/// A job as stored and as returned over every RPC surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub owner: JobOwner,
    pub status: JobStatus,
    /// Real exit code. `None` while running, or when killed by signal.
    pub exit_code: Option<i32>,
    /// OS pid; `None` once the process is gone.
    pub pid: Option<u32>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    /// Total bytes ever written to the log, including bytes since rotated off
    /// the head. This is the high-water offset, not the file length.
    pub total_output_bytes: u64,
    /// Bytes discarded by the rate limiter. Non-zero means the log has gaps.
    pub dropped_output_bytes: u64,
    pub label: Option<String>,
}

impl JobRecord {
    /// Wall-clock duration so far, or the final duration once terminal.
    pub fn duration_ms(&self, now_ms: i64) -> i64 {
        (self.ended_at_ms.unwrap_or(now_ms) - self.started_at_ms).max(0)
    }
}

/// A slice of a job's output, addressed by byte offset.
///
/// Byte offsets replace the old cursor-only model: the caller can page
/// backwards through history instead of being able to read each byte exactly
/// once, which is what made the previous "wait for a pattern" semantics
/// unrecoverable when the filter did not match.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputSlice {
    /// Offset this slice starts at.
    pub from_offset: u64,
    /// Offset the next read should start at.
    pub next_offset: u64,
    /// Decoded text. Lossy UTF-8; the log itself keeps the raw bytes.
    pub data: String,
    pub status: JobStatus,
    pub exit_code: Option<i32>,
    /// True when `data` was cut short by the caller's `max_bytes`.
    pub has_more: bool,
}

/// Why a job stopped, for the `job:exited` scheduler event and notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobExit {
    pub job_id: String,
    pub status: JobStatus,
    pub exit_code: Option<i32>,
    pub owner: JobOwner,
    pub ended_at_ms: i64,
}

// ---------------------------------------------------------------------------
// Monitors — "wake me when X happens"
// ---------------------------------------------------------------------------

/// What a monitor is waiting for.
///
/// The split between push conditions (job/upstream) and the one pull condition
/// (shell) is deliberate: polling is the general escape hatch, so it is the
/// only variant that carries an interval and needs rate governance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MonitorCondition {
    /// Fires when a background job reaches any terminal state.
    #[serde(rename_all = "camelCase")]
    JobExit { job_id: String },
    /// Fires when a job's output first matches `pattern`.
    ///
    /// Only expressible because reads are non-destructive: the previous
    /// consume-once cursor lost the bytes a non-matching read skipped.
    #[serde(rename_all = "camelCase")]
    JobOutput { job_id: String, pattern: String },
    /// Fires when a predicate command exits 0. The general case — port
    /// readiness, a passing test run, a file appearing.
    #[serde(rename_all = "camelCase")]
    ShellPredicate {
        /// Display form of the command line.
        command: String,
        program: String,
        args: Vec<String>,
        cwd: PathBuf,
        #[serde(default)]
        env: BTreeMap<String, String>,
        /// Requested poll interval; clamped into the permitted band and then
        /// backed off exponentially on each miss.
        #[serde(default)]
        interval_ms: Option<u64>,
    },
    /// Fires when the renderer/scheduler reports an upstream completion —
    /// a background subagent settling, or a scheduled task's run finishing.
    /// This is the linkage that lets an agent say "wait for tonight's backup".
    #[serde(rename_all = "camelCase")]
    Upstream { source: String, id: String },
}

impl MonitorCondition {
    /// Short human-readable form, used in log lines and the fired-notice text.
    pub fn describe(&self) -> String {
        match self {
            MonitorCondition::JobExit { job_id } => format!("job {job_id} exits"),
            MonitorCondition::JobOutput { job_id, pattern } => {
                format!("job {job_id} output matches /{pattern}/")
            }
            MonitorCondition::ShellPredicate { command, .. } => {
                format!("`{command}` exits 0")
            }
            MonitorCondition::Upstream { source, id } => format!("{source} {id} completes"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MonitorStatus {
    Waiting,
    /// The condition held.
    Fired,
    /// The condition can never hold now (e.g. the watched job died first).
    Unsatisfiable,
    Cancelled,
    /// Deadline passed, or the app restarted while waiting.
    Expired,
}

impl MonitorStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, MonitorStatus::Waiting)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MonitorStatus::Waiting => "waiting",
            MonitorStatus::Fired => "fired",
            MonitorStatus::Unsatisfiable => "unsatisfiable",
            MonitorStatus::Cancelled => "cancelled",
            MonitorStatus::Expired => "expired",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "waiting" => Some(MonitorStatus::Waiting),
            "fired" => Some(MonitorStatus::Fired),
            "unsatisfiable" => Some(MonitorStatus::Unsatisfiable),
            "cancelled" => Some(MonitorStatus::Cancelled),
            "expired" => Some(MonitorStatus::Expired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRecord {
    pub id: String,
    pub condition: MonitorCondition,
    pub owner: JobOwner,
    pub status: MonitorStatus,
    pub created_at_ms: i64,
    pub settled_at_ms: Option<i64>,
    /// Absolute deadline for an async watch. `None` means "until cancelled".
    pub expires_at_ms: Option<i64>,
    /// Why it settled the way it did — the text handed to the model.
    pub detail: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error("no job with id {0}")]
    NotFound(String),
    #[error("job {0} is owned by another session")]
    Forbidden(String),
    #[error("job limit reached: {0}")]
    LimitReached(String),
    #[error("failed to spawn job: {0}")]
    Spawn(String),
    #[error("job store error: {0}")]
    Store(String),
    #[error("job io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, JobError>;

/// Epoch milliseconds. Centralised so tests can reason about one clock source.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_serializes_tagged_camel_case_for_the_ts_mirror() {
        let owner = JobOwner::Session {
            session_id: "sess-1".into(),
        };
        let json = serde_json::to_value(&owner).unwrap();
        assert_eq!(json["kind"], "session");
        assert_eq!(json["sessionId"], "sess-1");

        let task = JobOwner::ScheduledTask {
            task_id: "task-9".into(),
        };
        let json = serde_json::to_value(&task).unwrap();
        assert_eq!(json["kind"], "scheduledTask");
        assert_eq!(json["taskId"], "task-9");

        let app = serde_json::to_value(JobOwner::App).unwrap();
        assert_eq!(app["kind"], "app");
    }

    #[test]
    fn owner_round_trips_through_json() {
        for owner in [
            JobOwner::Session {
                session_id: "s".into(),
            },
            JobOwner::ScheduledTask {
                task_id: "t".into(),
            },
            JobOwner::App,
        ] {
            let json = serde_json::to_string(&owner).unwrap();
            let back: JobOwner = serde_json::from_str(&json).unwrap();
            assert_eq!(owner, back);
        }
    }

    #[test]
    fn owner_kind_and_id_accessors_agree_with_the_variant() {
        let s = JobOwner::Session {
            session_id: "abc".into(),
        };
        assert_eq!(s.kind_str(), "session");
        assert_eq!(s.owner_id(), Some("abc"));
        assert_eq!(JobOwner::App.owner_id(), None);
    }

    #[test]
    fn only_running_is_non_terminal() {
        assert!(!JobStatus::Running.is_terminal());
        for st in [
            JobStatus::Exited,
            JobStatus::Killed,
            JobStatus::Interrupted,
            JobStatus::Failed,
        ] {
            assert!(st.is_terminal(), "{st:?} should be terminal");
        }
    }

    #[test]
    fn status_string_round_trips() {
        for st in [
            JobStatus::Running,
            JobStatus::Exited,
            JobStatus::Killed,
            JobStatus::Interrupted,
            JobStatus::Failed,
        ] {
            assert_eq!(JobStatus::parse(st.as_str()), Some(st));
        }
        assert_eq!(JobStatus::parse("nonsense"), None);
    }

    #[test]
    fn duration_uses_now_while_running_and_end_once_finished() {
        let mut rec = JobRecord {
            id: "j".into(),
            command: "sleep 1".into(),
            cwd: "/tmp".into(),
            owner: JobOwner::App,
            status: JobStatus::Running,
            exit_code: None,
            pid: Some(1),
            started_at_ms: 1_000,
            ended_at_ms: None,
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: None,
        };
        assert_eq!(rec.duration_ms(3_000), 2_000);
        rec.ended_at_ms = Some(2_500);
        // Once ended, `now` is ignored.
        assert_eq!(rec.duration_ms(9_999), 1_500);
    }

    #[test]
    fn duration_never_goes_negative_on_clock_skew() {
        // A backwards system-clock jump must not produce a negative duration in
        // the UI; clamp at zero instead.
        let rec = JobRecord {
            id: "j".into(),
            command: "x".into(),
            cwd: "/tmp".into(),
            owner: JobOwner::App,
            status: JobStatus::Running,
            exit_code: None,
            pid: None,
            started_at_ms: 5_000,
            ended_at_ms: None,
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: None,
        };
        assert_eq!(rec.duration_ms(1_000), 0);
    }
}
