//! Monitors: "wake me when X happens".
//!
//! One evaluator task per waiting monitor, bounded by
//! [`crate::limits::MAX_MONITORS_GLOBAL`]. Each task settles its monitor
//! exactly once and wakes anyone blocked on it.
//!
//! # Why both blocking and async
//!
//! Short waits ("the dev server is up in 3s") should not cost a full model
//! round-trip, and long waits ("this build takes 40 minutes") must not hold a
//! provider request open. So a monitor is created the same way either way, and
//! the CALLER chooses how long to block on it; past the threshold the sidecar
//! stops blocking and lets the durable watch deliver the result later.
//!
//! # Push vs pull
//!
//! Job and upstream conditions are push: the supervisor's own wakeups drive
//! them, so latency is near-zero and idle cost is nil. Only the shell predicate
//! polls, which is why it is the one variant with an interval, a floor, and
//! exponential backoff — an unbounded version is a spin loop on a core.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::limits::{clamp_poll_interval, next_poll_interval, MAX_MONITORS_GLOBAL};
use crate::store::JobStore;
use crate::supervisor::JobSupervisor;
use crate::types::{
    now_ms, JobError, JobOwner, MonitorCondition, MonitorRecord, MonitorStatus, Result,
};

/// Rolling window of job output kept while looking for a pattern. Bounded so a
/// chatty job cannot grow the evaluator's memory without limit.
const MATCH_WINDOW_BYTES: usize = 256 * 1024;

/// Idle ceiling for a job-condition evaluator's wait. Output and exit both wake
/// it sooner; this only bounds how long it sleeps when nothing happens.
const JOB_POLL_CEILING: Duration = Duration::from_secs(1);

/// How long a shell predicate may run before it is treated as a miss.
const PREDICATE_TIMEOUT: Duration = Duration::from_secs(30);

struct LiveMonitor {
    notify: Arc<Notify>,
    cancel: Arc<Notify>,
}

/// Fired-monitor listener, used by the Tauri layer to emit `monitor:fired` and
/// to wake the owning chat session.
pub type MonitorListener = Arc<dyn Fn(MonitorRecord) + Send + Sync>;

pub struct MonitorRegistry {
    store: Arc<JobStore>,
    supervisor: Arc<JobSupervisor>,
    live: Mutex<HashMap<String, LiveMonitor>>,
    listeners: Mutex<Vec<MonitorListener>>,
}

impl MonitorRegistry {
    pub fn new(store: Arc<JobStore>, supervisor: Arc<JobSupervisor>) -> Self {
        Self {
            store,
            supervisor,
            live: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// Recreate evaluator tasks for durable watches left waiting by the
    /// previous process. Deadlines that elapsed while the host was offline are
    /// settled immediately; every other watch resumes in place with the same
    /// stable id and owner.
    pub fn reconcile_on_boot(self: &Arc<Self>) -> Result<Vec<String>> {
        let waiting: Vec<MonitorRecord> = self
            .store
            .list_monitors(None)?
            .into_iter()
            .filter(|record| record.status == MonitorStatus::Waiting)
            .collect();
        let mut resumed = Vec::with_capacity(waiting.len());
        for record in waiting {
            if record
                .expires_at_ms
                .is_some_and(|deadline| deadline <= now_ms())
            {
                self.settle(
                    &record.id,
                    MonitorStatus::Expired,
                    "deadline passed while the host was offline",
                );
                continue;
            }
            resumed.push(record.id.clone());
            self.start_evaluator(record);
        }
        Ok(resumed)
    }

    pub fn on_fired(&self, listener: MonitorListener) {
        self.listeners.lock().push(listener);
    }

    /// Register a monitor and start its evaluator.
    pub fn register(
        self: &Arc<Self>,
        condition: MonitorCondition,
        owner: JobOwner,
        expires_at_ms: Option<i64>,
        label: Option<String>,
    ) -> Result<MonitorRecord> {
        if self.store.count_waiting_monitors()? >= MAX_MONITORS_GLOBAL {
            return Err(JobError::LimitReached(format!(
                "at most {MAX_MONITORS_GLOBAL} monitors may wait at once; \
                 cancel one before starting another"
            )));
        }
        let record = MonitorRecord {
            id: uuid::Uuid::new_v4().to_string(),
            condition,
            owner,
            status: MonitorStatus::Waiting,
            created_at_ms: now_ms(),
            settled_at_ms: None,
            expires_at_ms,
            detail: None,
            label,
        };
        self.store.insert_monitor(&record)?;
        self.start_evaluator(record.clone());
        Ok(record)
    }

    fn start_evaluator(self: &Arc<Self>, record: MonitorRecord) {
        let notify = Arc::new(Notify::new());
        let cancel = Arc::new(Notify::new());
        self.live.lock().insert(
            record.id.clone(),
            LiveMonitor {
                notify: Arc::clone(&notify),
                cancel: Arc::clone(&cancel),
            },
        );

        let this = Arc::clone(self);
        let spawned = record.clone();
        tokio::spawn(async move {
            this.run_evaluator(spawned, cancel).await;
        });
    }

    /// Block until the monitor settles or `wait` elapses. Returns the current
    /// record either way — a still-`waiting` record means the caller should
    /// stop blocking and let the async watch deliver later.
    pub async fn wait(&self, monitor_id: &str, wait: Duration) -> Result<MonitorRecord> {
        let deadline = Instant::now() + wait;
        loop {
            let record = self
                .store
                .get_monitor(monitor_id)?
                .ok_or_else(|| JobError::NotFound(monitor_id.to_string()))?;
            if record.status.is_terminal() {
                return Ok(record);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(record);
            }
            let notify = match self.live.lock().get(monitor_id) {
                Some(m) => Arc::clone(&m.notify),
                None => continue,
            };
            let _ = tokio::time::timeout(remaining, notify.notified()).await;
        }
    }

    /// Cancel a waiting monitor. Idempotent; scoped like job kills.
    pub fn cancel(&self, monitor_id: &str, requester: Option<&JobOwner>) -> Result<MonitorRecord> {
        let record = self
            .store
            .get_monitor(monitor_id)?
            .ok_or_else(|| JobError::NotFound(monitor_id.to_string()))?;
        if let Some(req) = requester {
            if req != &record.owner {
                return Err(JobError::Forbidden(monitor_id.to_string()));
            }
        }
        self.settle(monitor_id, MonitorStatus::Cancelled, "cancelled by request");
        self.store
            .get_monitor(monitor_id)?
            .ok_or_else(|| JobError::NotFound(monitor_id.to_string()))
    }

    pub fn get(&self, monitor_id: &str) -> Result<Option<MonitorRecord>> {
        self.store.get_monitor(monitor_id)
    }

    pub fn list(&self, owner: Option<&JobOwner>) -> Result<Vec<MonitorRecord>> {
        self.store.list_monitors(owner)
    }

    /// Report an upstream completion. Fires every waiting monitor watching
    /// `(source, id)`; returns how many fired.
    ///
    /// This is the scheduler-linkage entry point: the renderer calls it when a
    /// background subagent settles or a scheduled task's run finishes.
    pub fn signal_upstream(&self, source: &str, id: &str) -> Result<usize> {
        let waiting: Vec<MonitorRecord> = self
            .store
            .list_monitors(None)?
            .into_iter()
            .filter(|m| m.status == MonitorStatus::Waiting)
            .filter(|m| {
                matches!(
                    &m.condition,
                    MonitorCondition::Upstream { source: s, id: i } if s == source && i == id
                )
            })
            .collect();
        let mut fired = 0;
        for m in waiting {
            if self.settle(
                &m.id,
                MonitorStatus::Fired,
                &format!("{source} {id} completed"),
            ) {
                fired += 1;
            }
        }
        Ok(fired)
    }

    /// Write the terminal verdict, wake waiters, stop the evaluator, and
    /// notify listeners. Returns whether THIS call was the one that settled it.
    fn settle(&self, monitor_id: &str, status: MonitorStatus, detail: &str) -> bool {
        let won = self
            .store
            .settle_monitor(monitor_id, status, Some(detail), now_ms())
            .unwrap_or(false);
        // Wake blocked callers even when we lost the race, so nobody is left
        // hanging on an already-settled monitor. Signalling `cancel` is what
        // actually STOPS the evaluator task: without it a cancelled shell
        // predicate would keep spawning its command every few seconds forever,
        // and an `Upstream` evaluator (which awaits `pending()`) would never
        // be reclaimed at all.
        if let Some(m) = self.live.lock().remove(monitor_id) {
            m.notify.notify_waiters();
            // `notify_one`, not `notify_waiters`: a cancel that lands before
            // the evaluator has parked on its `select!` must still stop it.
            // `notify_waiters` only wakes ALREADY-registered waiters, so the
            // signal would be dropped and the task would run forever.
            m.cancel.notify_one();
        }
        if won {
            if let Ok(Some(record)) = self.store.get_monitor(monitor_id) {
                let listeners = self.listeners.lock().clone();
                for listener in listeners {
                    listener(record.clone());
                }
            }
        }
        won
    }

    async fn run_evaluator(self: Arc<Self>, record: MonitorRecord, cancel: Arc<Notify>) {
        let id = record.id.clone();
        let deadline = record
            .expires_at_ms
            .map(|ms| Duration::from_millis((ms - now_ms()).max(0) as u64));

        let evaluate = async {
            match &record.condition {
                MonitorCondition::JobExit { job_id } => self.watch_job_exit(job_id).await,
                MonitorCondition::JobOutput { job_id, pattern } => {
                    self.watch_job_output(job_id, pattern).await
                }
                MonitorCondition::ShellPredicate {
                    program,
                    args,
                    cwd,
                    env,
                    interval_ms,
                    ..
                } => {
                    self.watch_shell_predicate(program, args, cwd, env, *interval_ms)
                        .await
                }
                // Fired externally by `signal_upstream`; nothing to poll.
                MonitorCondition::Upstream { .. } => std::future::pending().await,
            }
        };

        let outcome = match deadline {
            Some(d) => tokio::select! {
                out = evaluate => Some(out),
                _ = cancel.notified() => None,
                _ = tokio::time::sleep(d) => Some((
                    MonitorStatus::Expired,
                    "deadline passed before the condition held".to_string(),
                )),
            },
            None => tokio::select! {
                out = evaluate => Some(out),
                _ = cancel.notified() => None,
            },
        };

        if let Some((status, detail)) = outcome {
            self.settle(&id, status, &detail);
        }
    }

    async fn watch_job_exit(&self, job_id: &str) -> (MonitorStatus, String) {
        loop {
            match self.supervisor.get(job_id) {
                Ok(Some(rec)) if rec.status.is_terminal() => {
                    let code = rec
                        .exit_code
                        .map(|c| format!(" with exit code {c}"))
                        .unwrap_or_default();
                    return (
                        MonitorStatus::Fired,
                        format!("job {job_id} {}{code}", rec.status.as_str()),
                    );
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    return (
                        MonitorStatus::Unsatisfiable,
                        format!("job {job_id} no longer exists"),
                    )
                }
                Err(e) => return (MonitorStatus::Unsatisfiable, e.to_string()),
            }
            // Returns as soon as the job settles; the ceiling only bounds idle.
            let _ = self
                .supervisor
                .wait_for_output(job_id, u64::MAX, 1, JOB_POLL_CEILING)
                .await;
        }
    }

    async fn watch_job_output(&self, job_id: &str, pattern: &str) -> (MonitorStatus, String) {
        let re = match regex::Regex::new(pattern) {
            Ok(re) => re,
            Err(e) => {
                return (
                    MonitorStatus::Unsatisfiable,
                    format!("invalid pattern /{pattern}/: {e}"),
                )
            }
        };
        let mut offset = 0u64;
        let mut window = String::new();
        loop {
            let slice = match self.supervisor.read(job_id, offset, MATCH_WINDOW_BYTES) {
                Ok(s) => s,
                Err(e) => return (MonitorStatus::Unsatisfiable, e.to_string()),
            };
            offset = slice.next_offset;
            if !slice.data.is_empty() {
                window.push_str(&slice.data);
                if window.len() > MATCH_WINDOW_BYTES {
                    // Keep the tail. A pattern spanning the discarded boundary
                    // is the acceptable cost of a bounded window.
                    let cut = window.len() - MATCH_WINDOW_BYTES;
                    window = window
                        .char_indices()
                        .find(|(i, _)| *i >= cut)
                        .map(|(i, _)| window[i..].to_string())
                        .unwrap_or_default();
                }
                if re.is_match(&window) {
                    return (
                        MonitorStatus::Fired,
                        format!("job {job_id} output matched /{pattern}/"),
                    );
                }
            }
            // The job ended without ever matching — say so plainly rather than
            // waiting forever for output that can no longer arrive.
            if slice.status.is_terminal() && !slice.has_more {
                return (
                    MonitorStatus::Unsatisfiable,
                    format!("job {job_id} ended without matching /{pattern}/"),
                );
            }
            let _ = self
                .supervisor
                .wait_for_output(job_id, offset, 1, JOB_POLL_CEILING)
                .await;
        }
    }

    async fn watch_shell_predicate(
        &self,
        program: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &std::collections::BTreeMap<String, String>,
        interval_ms: Option<u64>,
    ) -> (MonitorStatus, String) {
        let mut interval = clamp_poll_interval(
            interval_ms
                .map(Duration::from_millis)
                .unwrap_or(crate::limits::MIN_POLL_INTERVAL),
        );
        let mut attempts: u32 = 0;
        loop {
            attempts += 1;
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args)
                .current_dir(cwd)
                .env_clear()
                // Same proxy env the supervisor gives the job itself: a
                // readiness predicate that probes an HTTP endpoint has to take
                // the same route as the thing it is checking.
                .envs(cognia_net::proxy_config::child_network_env())
                .envs(env)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let status = match tokio::time::timeout(PREDICATE_TIMEOUT, cmd.status()).await {
                Ok(Ok(s)) => Some(s),
                // A predicate that cannot even spawn will never succeed —
                // failing fast beats retrying a typo every 2s forever.
                Ok(Err(e)) => {
                    return (
                        MonitorStatus::Unsatisfiable,
                        format!("could not run the predicate `{program}`: {e}"),
                    )
                }
                Err(_) => None, // timed out — treat as a miss and back off
            };
            if status.map(|s| s.success()).unwrap_or(false) {
                return (
                    MonitorStatus::Fired,
                    format!("predicate succeeded after {attempts} attempt(s)"),
                );
            }
            tokio::time::sleep(interval).await;
            interval = next_poll_interval(interval);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn setup(dir: &TempDir) -> (Arc<JobSupervisor>, Arc<MonitorRegistry>) {
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        let sup = Arc::new(JobSupervisor::new(
            Arc::clone(&store),
            dir.path().join("logs"),
        ));
        let reg = Arc::new(MonitorRegistry::new(store, Arc::clone(&sup)));
        (sup, reg)
    }

    fn session(id: &str) -> JobOwner {
        JobOwner::Session {
            session_id: id.into(),
        }
    }

    #[cfg(unix)]
    fn sh(command: &str, owner: JobOwner) -> crate::types::SpawnJobRequest {
        let mut env = BTreeMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        crate::types::SpawnJobRequest {
            command: command.to_string(),
            program: "/bin/sh".to_string(),
            args: vec!["-c".into(), command.into()],
            cwd: std::env::temp_dir(),
            env,
            owner,
            windows_verbatim_arguments: false,
            label: None,
        }
    }

    #[cfg(unix)]
    fn predicate(command: &str) -> MonitorCondition {
        let mut env = BTreeMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        MonitorCondition::ShellPredicate {
            command: command.to_string(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), command.into()],
            cwd: std::env::temp_dir(),
            env,
            interval_ms: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn job_exit_condition_fires_when_the_job_ends() {
        let dir = TempDir::new().unwrap();
        let (sup, reg) = setup(&dir);
        let job = sup
            .spawn(sh("sleep 0.2; exit 5", session("s1")))
            .await
            .unwrap();

        let mon = reg
            .register(
                MonitorCondition::JobExit {
                    job_id: job.id.clone(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        let settled = reg.wait(&mon.id, Duration::from_secs(10)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Fired);
        assert!(
            settled
                .detail
                .as_deref()
                .unwrap_or("")
                .contains("exit code 5"),
            "detail should carry the real exit code, got {:?}",
            settled.detail
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn job_exit_condition_fires_immediately_for_an_already_finished_job() {
        // Registering after the fact must not hang forever waiting for an
        // event that already happened.
        let dir = TempDir::new().unwrap();
        let (sup, reg) = setup(&dir);
        let job = sup.spawn(sh("exit 0", session("s1"))).await.unwrap();
        for _ in 0..200 {
            if sup.get(&job.id).unwrap().unwrap().status.is_terminal() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let mon = reg
            .register(
                MonitorCondition::JobExit { job_id: job.id },
                session("s1"),
                None,
                None,
            )
            .unwrap();
        let settled = reg.wait(&mon.id, Duration::from_secs(5)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Fired);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn job_output_condition_fires_on_a_readiness_line() {
        let dir = TempDir::new().unwrap();
        let (sup, reg) = setup(&dir);
        let job = sup
            .spawn(sh(
                "echo booting; sleep 0.2; echo server ready on 3000; sleep 5",
                session("s1"),
            ))
            .await
            .unwrap();

        let mon = reg
            .register(
                MonitorCondition::JobOutput {
                    job_id: job.id.clone(),
                    pattern: "ready on".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        let settled = reg.wait(&mon.id, Duration::from_secs(10)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Fired);
        let _ = sup.kill(&job.id, None).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn job_output_condition_reports_unsatisfiable_when_the_job_ends_unmatched() {
        // Waiting forever for output that can never arrive is the failure mode
        // a naive implementation has; say so instead.
        let dir = TempDir::new().unwrap();
        let (sup, reg) = setup(&dir);
        let job = sup
            .spawn(sh("echo nope; exit 1", session("s1")))
            .await
            .unwrap();

        let mon = reg
            .register(
                MonitorCondition::JobOutput {
                    job_id: job.id,
                    pattern: "ready".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        let settled = reg.wait(&mon.id, Duration::from_secs(10)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Unsatisfiable);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_invalid_pattern_is_rejected_rather_than_silently_never_matching() {
        let dir = TempDir::new().unwrap();
        let (sup, reg) = setup(&dir);
        let job = sup.spawn(sh("sleep 5", session("s1"))).await.unwrap();

        let mon = reg
            .register(
                MonitorCondition::JobOutput {
                    job_id: job.id.clone(),
                    pattern: "([unclosed".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();
        let settled = reg.wait(&mon.id, Duration::from_secs(5)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Unsatisfiable);
        assert!(settled
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("invalid pattern"));
        let _ = sup.kill(&job.id, None).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_predicate_fires_once_the_command_succeeds() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let marker = dir.path().join("ready");
        let cond = predicate(&format!("test -f {}", marker.to_string_lossy()));

        let mon = reg.register(cond, session("s1"), None, None).unwrap();
        // Create the file after the first poll has already missed.
        tokio::time::sleep(Duration::from_millis(150)).await;
        std::fs::write(&marker, b"x").unwrap();

        let settled = reg.wait(&mon.id, Duration::from_secs(15)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Fired);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_stops_the_predicate_from_polling() {
        // Without a cancel signal reaching the evaluator, a cancelled shell
        // predicate keeps spawning its command every few seconds forever.
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let tally = dir.path().join("polls");
        // Never succeeds, so it polls until stopped; each run appends a byte.
        let cond = predicate(&format!("printf x >> {} ; false", tally.to_string_lossy()));

        let mon = reg.register(cond, session("s1"), None, None).unwrap();
        // Let it poll at least once.
        for _ in 0..80 {
            if std::fs::metadata(&tally).map(|m| m.len()).unwrap_or(0) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        reg.cancel(&mon.id, None).unwrap();

        // Let any in-flight poll finish, then take a baseline.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let baseline = std::fs::metadata(&tally).map(|m| m.len()).unwrap_or(0);
        // Longer than the 2s poll floor — a live evaluator would tick again.
        tokio::time::sleep(Duration::from_millis(3_000)).await;
        let after = std::fs::metadata(&tally).map(|m| m.len()).unwrap_or(0);

        assert_eq!(
            after, baseline,
            "evaluator kept polling after cancel ({baseline} → {after})"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_predicate_that_cannot_spawn_fails_fast_instead_of_retrying_forever() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let cond = MonitorCondition::ShellPredicate {
            command: "nope".into(),
            program: "/definitely/not/a/binary".into(),
            args: vec![],
            cwd: PathBuf::from("/tmp"),
            env: BTreeMap::new(),
            interval_ms: None,
        };
        let mon = reg.register(cond, session("s1"), None, None).unwrap();
        let settled = reg.wait(&mon.id, Duration::from_secs(5)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Unsatisfiable);
    }

    #[tokio::test]
    async fn upstream_signal_fires_only_the_matching_monitors() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let target = reg
            .register(
                MonitorCondition::Upstream {
                    source: "scheduledTask".into(),
                    id: "nightly".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();
        let other = reg
            .register(
                MonitorCondition::Upstream {
                    source: "scheduledTask".into(),
                    id: "weekly".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        assert_eq!(reg.signal_upstream("scheduledTask", "nightly").unwrap(), 1);
        assert_eq!(
            reg.get(&target.id).unwrap().unwrap().status,
            MonitorStatus::Fired
        );
        assert_eq!(
            reg.get(&other.id).unwrap().unwrap().status,
            MonitorStatus::Waiting
        );
    }

    #[tokio::test]
    async fn a_second_upstream_signal_fires_nothing() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        reg.register(
            MonitorCondition::Upstream {
                source: "subagent".into(),
                id: "run-1".into(),
            },
            session("s1"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(reg.signal_upstream("subagent", "run-1").unwrap(), 1);
        assert_eq!(reg.signal_upstream("subagent", "run-1").unwrap(), 0);
    }

    #[tokio::test]
    async fn wait_returns_a_still_waiting_record_when_the_budget_runs_out() {
        // This is the blocking→async degradation signal: the caller stops
        // blocking and lets the durable watch deliver later.
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let mon = reg
            .register(
                MonitorCondition::Upstream {
                    source: "never".into(),
                    id: "x".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        let record = reg.wait(&mon.id, Duration::from_millis(120)).await.unwrap();
        assert_eq!(record.status, MonitorStatus::Waiting);
    }

    #[tokio::test]
    async fn cancel_settles_a_waiting_monitor_and_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let mon = reg
            .register(
                MonitorCondition::Upstream {
                    source: "never".into(),
                    id: "x".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            reg.cancel(&mon.id, None).unwrap().status,
            MonitorStatus::Cancelled
        );
        // A second cancel does not error and does not rewrite the verdict.
        assert_eq!(
            reg.cancel(&mon.id, None).unwrap().status,
            MonitorStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn an_agent_cannot_cancel_another_sessions_monitor() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let mon = reg
            .register(
                MonitorCondition::Upstream {
                    source: "never".into(),
                    id: "x".into(),
                },
                session("owner"),
                None,
                None,
            )
            .unwrap();

        assert!(matches!(
            reg.cancel(&mon.id, Some(&session("intruder"))),
            Err(JobError::Forbidden(_))
        ));
        assert_eq!(
            reg.get(&mon.id).unwrap().unwrap().status,
            MonitorStatus::Waiting
        );
    }

    #[tokio::test]
    async fn an_expired_monitor_settles_at_its_deadline() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let mon = reg
            .register(
                MonitorCondition::Upstream {
                    source: "never".into(),
                    id: "x".into(),
                },
                session("s1"),
                Some(now_ms() + 150),
                None,
            )
            .unwrap();

        let settled = reg.wait(&mon.id, Duration::from_secs(5)).await.unwrap();
        assert_eq!(settled.status, MonitorStatus::Expired);
    }

    #[tokio::test]
    async fn fired_listeners_run_once_per_monitor() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        reg.on_fired(Arc::new(move |m: MonitorRecord| sink.lock().push(m.id)));

        let mon = reg
            .register(
                MonitorCondition::Upstream {
                    source: "s".into(),
                    id: "1".into(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();
        reg.signal_upstream("s", "1").unwrap();
        reg.signal_upstream("s", "1").unwrap();

        assert_eq!(seen.lock().as_slice(), &[mon.id]);
    }

    #[tokio::test]
    async fn the_global_monitor_cap_is_enforced() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        for i in 0..MAX_MONITORS_GLOBAL {
            reg.register(
                MonitorCondition::Upstream {
                    source: "s".into(),
                    id: i.to_string(),
                },
                session("s1"),
                None,
                None,
            )
            .unwrap();
        }
        assert!(matches!(
            reg.register(
                MonitorCondition::Upstream {
                    source: "s".into(),
                    id: "overflow".into()
                },
                session("s1"),
                None,
                None,
            ),
            Err(JobError::LimitReached(_))
        ));
    }

    #[tokio::test]
    async fn cancelling_frees_a_slot_against_the_cap() {
        let dir = TempDir::new().unwrap();
        let (_sup, reg) = setup(&dir);
        let mut ids = Vec::new();
        for i in 0..MAX_MONITORS_GLOBAL {
            ids.push(
                reg.register(
                    MonitorCondition::Upstream {
                        source: "s".into(),
                        id: i.to_string(),
                    },
                    session("s1"),
                    None,
                    None,
                )
                .unwrap()
                .id,
            );
        }
        reg.cancel(&ids[0], None).unwrap();
        reg.register(
            MonitorCondition::Upstream {
                source: "s".into(),
                id: "fits-now".into(),
            },
            session("s1"),
            None,
            None,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn boot_reconcile_resumes_a_durable_upstream_watch() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        store
            .insert_monitor(&MonitorRecord {
                id: "ghost".into(),
                condition: MonitorCondition::Upstream {
                    source: "s".into(),
                    id: "1".into(),
                },
                owner: session("old"),
                status: MonitorStatus::Waiting,
                created_at_ms: 1,
                settled_at_ms: None,
                expires_at_ms: None,
                detail: None,
                label: None,
            })
            .unwrap();

        let sup = Arc::new(JobSupervisor::new(
            Arc::clone(&store),
            dir.path().join("logs"),
        ));
        let reg = Arc::new(MonitorRegistry::new(Arc::clone(&store), sup));
        assert_eq!(reg.reconcile_on_boot().unwrap(), vec!["ghost".to_string()]);

        assert_eq!(reg.signal_upstream("s", "1").unwrap(), 1);
        let row = reg.wait("ghost", Duration::from_secs(1)).await.unwrap();
        assert_eq!(row.status, MonitorStatus::Fired);
        assert!(row.detail.as_deref().unwrap_or("").contains("completed"));
    }

    #[test]
    fn condition_descriptions_name_what_is_being_awaited() {
        assert_eq!(
            MonitorCondition::JobExit { job_id: "j".into() }.describe(),
            "job j exits"
        );
        assert_eq!(
            MonitorCondition::Upstream {
                source: "scheduledTask".into(),
                id: "nightly".into()
            }
            .describe(),
            "scheduledTask nightly completes"
        );
    }
}
