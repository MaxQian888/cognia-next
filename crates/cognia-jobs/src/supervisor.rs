//! The job supervisor: spawn, observe, and reap background commands.
//!
//! Two properties distinguish this from the sidecar registry it replaces:
//!
//! 1. **Process groups.** Children are spawned into their own session
//!    (`setsid`) so a kill signals the whole tree. The previous implementation
//!    called `child.kill()` on the wrapper shell, which left `sh -c "pnpm dev"`
//!    grandchildren alive holding their ports while reporting success.
//! 2. **Lifetime is owner-scoped, not session-scoped.** A job owned by a
//!    scheduled task outlives the chat turn that created it.
//!
//! Locking discipline: `parking_lot` mutexes are taken, cloned out of, and
//! released — never held across an `.await`. Live child handles live inside
//! their own waiter task rather than behind a shared lock, so kill and wait
//! never contend.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Notify};

use crate::limits::{MAX_JOBS_GLOBAL, MAX_JOBS_PER_SESSION, MAX_LOG_BYTES_GLOBAL};
use crate::output::JobOutput;
use crate::store::JobStore;
use crate::types::{
    now_ms, JobError, JobExit, JobOutputSlice, JobOwner, JobRecord, JobStatus, Result,
    SpawnJobRequest,
};

/// How long a killed process group gets to exit on SIGTERM before SIGKILL.
const KILL_ESCALATION: Duration = Duration::from_secs(3);

/// Live state for a running job. Terminal jobs drop theirs and are served
/// entirely from the store plus the on-disk log.
struct LiveJob {
    output: Arc<Mutex<JobOutput>>,
    /// Fires whenever output lands or the job settles — drives long-polling
    /// without a sleep loop.
    notify: Arc<Notify>,
    kill_tx: mpsc::Sender<()>,
    killed: Arc<AtomicBool>,
}

/// Listener invoked once per job when it reaches a terminal state.
///
/// The Tauri layer uses this to emit `job:exited` onto the scheduler event bus
/// and to wake any registered `Monitor`.
pub type ExitListener = Arc<dyn Fn(JobExit) + Send + Sync>;

pub struct JobSupervisor {
    store: Arc<JobStore>,
    log_dir: PathBuf,
    live: Mutex<HashMap<String, Arc<LiveJob>>>,
    exit_listeners: Mutex<Vec<ExitListener>>,
}

impl JobSupervisor {
    pub fn new(store: Arc<JobStore>, log_dir: PathBuf) -> Self {
        Self {
            store,
            log_dir,
            live: Mutex::new(HashMap::new()),
            exit_listeners: Mutex::new(Vec::new()),
        }
    }

    /// Boot reconcile. Any row still `running` belongs to a process from a
    /// previous app lifetime, so it is flipped to `interrupted`. Must run
    /// before the first `spawn`, otherwise the concurrency caps count ghosts.
    pub fn reconcile_on_boot(&self) -> Result<Vec<String>> {
        self.store.interrupt_orphans_on_boot(now_ms())
    }

    /// Register a terminal-transition listener. Called once per job, after the
    /// store has recorded the verdict, with the listener set frozen at spawn
    /// time so a late registration cannot retroactively observe an old job.
    pub fn on_exit(&self, listener: ExitListener) {
        self.exit_listeners.lock().push(listener);
    }

    /// Enforce the per-owner and global concurrency caps.
    fn check_capacity(&self, owner: &JobOwner) -> Result<()> {
        if self.store.count_running(None)? >= MAX_JOBS_GLOBAL {
            return Err(JobError::LimitReached(format!(
                "at most {MAX_JOBS_GLOBAL} background jobs may run at once on this host"
            )));
        }
        // Only session-owned work is capped per owner; scheduled tasks and
        // app-owned jobs are already gated by the scheduler and by approval.
        if matches!(owner, JobOwner::Session { .. })
            && self.store.count_running(Some(owner))? >= MAX_JOBS_PER_SESSION
        {
            return Err(JobError::LimitReached(format!(
                "at most {MAX_JOBS_PER_SESSION} background jobs may run at once in one session; \
                 stop one with kill_shell first"
            )));
        }
        Ok(())
    }

    /// Start a background job. Returns as soon as the child is spawned.
    pub async fn spawn(&self, req: SpawnJobRequest) -> Result<JobRecord> {
        self.check_capacity(&req.owner)?;
        self.enforce_log_budget();

        let id = uuid::Uuid::new_v4().to_string();
        let started_at_ms = now_ms();
        let output = JobOutput::open(&self.log_dir, &id, Instant::now())
            .map_err(|e| JobError::Spawn(format!("could not open job log: {e}")))?;

        let mut cmd = tokio::process::Command::new(&req.program);
        cmd.args(&req.args)
            .current_dir(&req.cwd)
            .env_clear()
            .envs(&req.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP — no console flash,
            // and the group is addressable for a tree kill.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            if req.windows_verbatim_arguments {
                cmd.raw_arg(req.args.join(" "));
            }
        }

        // Put the child in its OWN session so a kill reaches grandchildren.
        // Same idiom as `cognia-automation/src/sandbox/macos.rs`.
        // SAFETY: post-fork / pre-exec; no allocation and no locks taken.
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    // Already a group leader on the rare path — fall back.
                    libc::setpgid(0, 0);
                }
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| JobError::Spawn(format!("{}: {e}", req.program)))?;
        let pid = child.id();

        let record = JobRecord {
            id: id.clone(),
            command: req.command.clone(),
            cwd: req.cwd.to_string_lossy().into_owned(),
            owner: req.owner.clone(),
            status: JobStatus::Running,
            exit_code: None,
            pid,
            started_at_ms,
            ended_at_ms: None,
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: req.label.clone(),
        };
        self.store.insert(&record)?;

        let output = Arc::new(Mutex::new(output));
        let notify = Arc::new(Notify::new());
        let killed = Arc::new(AtomicBool::new(false));
        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

        self.live.lock().insert(
            id.clone(),
            Arc::new(LiveJob {
                output: Arc::clone(&output),
                notify: Arc::clone(&notify),
                kill_tx,
                killed: Arc::clone(&killed),
            }),
        );

        // Pump stdout and stderr into the same offset space. They are separate
        // pipes (unlike a PTY, which merges them) but interleave into one log
        // in arrival order, which is what a reader expects.
        for stream in [
            child.stdout.take().map(StreamKind::Stdout),
            child.stderr.take().map(StreamKind::Stderr),
        ]
        .into_iter()
        .flatten()
        {
            let output = Arc::clone(&output);
            let notify = Arc::clone(&notify);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                match stream {
                    StreamKind::Stdout(mut s) => {
                        pump(&mut s, &mut buf, &output, &notify).await;
                    }
                    StreamKind::Stderr(mut s) => {
                        pump(&mut s, &mut buf, &output, &notify).await;
                    }
                }
            });
        }

        // Waiter: owns the `Child`, so kill and wait never contend on a lock.
        let store = Arc::clone(&self.store);
        let waiter_id = id.clone();
        let waiter_output = Arc::clone(&output);
        let waiter_notify = Arc::clone(&notify);
        let waiter_owner = req.owner.clone();
        let waiter_killed = Arc::clone(&killed);
        let listeners = self.exit_listeners.lock().clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                res = child.wait() => res.ok(),
                _ = kill_rx.recv() => {
                    waiter_killed.store(true, Ordering::SeqCst);
                    kill_tree(pid).await;
                    // Give the group a moment on SIGTERM, then escalate.
                    match tokio::time::timeout(KILL_ESCALATION, child.wait()).await {
                        Ok(res) => res.ok(),
                        Err(_) => {
                            force_kill_tree(pid).await;
                            child.wait().await.ok()
                        }
                    }
                }
            };

            let ended_at_ms = now_ms();
            let was_killed = waiter_killed.load(Ordering::SeqCst);
            let final_status = if was_killed {
                JobStatus::Killed
            } else {
                JobStatus::Exited
            };
            // A killed process reports no meaningful code — keep it `None`
            // rather than surfacing a signal number as an exit status.
            let exit_code = if was_killed {
                None
            } else {
                status.and_then(|s| s.code())
            };

            {
                let mut out = waiter_output.lock();
                out.flush();
                let _ = store.update_output_counters(
                    &waiter_id,
                    out.total_bytes(),
                    out.dropped_bytes(),
                );
            }
            let _ = store.settle(&waiter_id, final_status, exit_code, ended_at_ms);
            waiter_notify.notify_waiters();

            let exit = JobExit {
                job_id: waiter_id,
                status: final_status,
                exit_code,
                owner: waiter_owner,
                ended_at_ms,
            };
            for listener in listeners {
                listener(exit.clone());
            }
        });

        Ok(record)
    }

    /// Read a slice of a job's output. Non-consuming.
    pub fn read(&self, job_id: &str, from_offset: u64, max_bytes: usize) -> Result<JobOutputSlice> {
        let record = self
            .store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        let live = self.live.lock().get(job_id).cloned();
        let mut slice = match live {
            Some(job) => job.output.lock().read(from_offset, max_bytes),
            // Terminal job whose live state was dropped: reopen the log.
            None => {
                let mut out = JobOutput::open(&self.log_dir, job_id, Instant::now())?;
                out.read(from_offset, max_bytes)
            }
        };
        slice.status = record.status;
        slice.exit_code = record.exit_code;
        Ok(slice)
    }

    /// Long-poll for new output at or past `from_offset`, or for the job to
    /// settle, whichever happens first.
    ///
    /// Unlike the registry this replaces, a `wait` that returns no *matching*
    /// bytes does not consume them: `from_offset` is only advanced by the
    /// caller, from `next_offset`.
    pub async fn wait_for_output(
        &self,
        job_id: &str,
        from_offset: u64,
        max_bytes: usize,
        wait: Duration,
    ) -> Result<JobOutputSlice> {
        let deadline = Instant::now() + wait;
        loop {
            let slice = self.read(job_id, from_offset, max_bytes)?;
            if !slice.data.is_empty() || slice.status.is_terminal() {
                return Ok(slice);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(slice);
            }
            let notify = match self.live.lock().get(job_id) {
                Some(job) => Arc::clone(&job.notify),
                // Settled between the read and here — one more read decides.
                None => continue,
            };
            // `notified()` is registered before the await, so a wake that lands
            // between the read above and here is not missed.
            let _ = tokio::time::timeout(remaining, notify.notified()).await;
        }
    }

    /// Terminate a job's whole process group. Idempotent.
    ///
    /// `requester` scopes the permission check: an agent may only kill jobs its
    /// own session owns. `None` means the UI, which may kill anything.
    pub async fn kill(&self, job_id: &str, requester: Option<&JobOwner>) -> Result<JobRecord> {
        let record = self
            .store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if let Some(req) = requester {
            if !owner_matches(req, &record.owner) {
                return Err(JobError::Forbidden(job_id.to_string()));
            }
        }
        if record.status.is_terminal() {
            return Ok(record);
        }
        let live = self.live.lock().get(job_id).cloned();
        if let Some(job) = live {
            job.killed.store(true, Ordering::SeqCst);
            // Bounded channel of 1: a second kill while one is in flight is a
            // no-op, which is exactly the idempotency we want.
            let _ = job.kill_tx.try_send(());
        } else {
            // No live state (e.g. after a reconcile) — settle the row so the
            // caller does not see a permanently "running" ghost.
            self.store
                .settle(job_id, JobStatus::Killed, None, now_ms())?;
        }
        self.store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))
    }

    /// Kill every job belonging to `owner`. Returns the ids killed.
    pub async fn kill_owned_by(&self, owner: &JobOwner) -> Result<Vec<String>> {
        let ids: Vec<String> = self
            .store
            .list_by_owner(owner)?
            .into_iter()
            .filter(|r| !r.status.is_terminal())
            .map(|r| r.id)
            .collect();
        for id in &ids {
            let _ = self.kill(id, None).await;
        }
        Ok(ids)
    }

    /// Kill everything. Called at app exit so no job becomes an orphan daemon.
    pub async fn shutdown(&self) -> Result<Vec<String>> {
        let ids: Vec<String> = self
            .store
            .list_running()?
            .into_iter()
            .map(|r| r.id)
            .collect();
        for id in &ids {
            let _ = self.kill(id, None).await;
        }
        Ok(ids)
    }

    pub fn get(&self, job_id: &str) -> Result<Option<JobRecord>> {
        self.store.get(job_id)
    }

    /// Find a RUNNING job by its OS pid.
    ///
    /// Exists for `terminate_process`, whose contract is pid-addressed. Only
    /// running jobs are considered: a terminal row's pid is cleared, and a
    /// recycled pid must never resolve to a finished job.
    pub fn find_running_by_pid(&self, pid: u32) -> Result<Option<JobRecord>> {
        Ok(self
            .store
            .list_running()?
            .into_iter()
            .find(|r| r.pid == Some(pid)))
    }

    /// Kill a running job addressed by pid. `Ok(None)` means no job owns that
    /// pid, leaving the caller free to fall back to a plain signal.
    pub async fn kill_by_pid(
        &self,
        pid: u32,
        requester: Option<&JobOwner>,
    ) -> Result<Option<JobRecord>> {
        let Some(found) = self.find_running_by_pid(pid)? else {
            return Ok(None);
        };
        self.kill(&found.id, requester).await.map(Some)
    }

    pub fn list(&self, owner: Option<&JobOwner>) -> Result<Vec<JobRecord>> {
        match owner {
            Some(o) => self.store.list_by_owner(o),
            None => self.store.list_all(),
        }
    }

    /// Evict oldest-finished jobs' logs until the global disk budget holds.
    fn enforce_log_budget(&self) {
        let Ok(terminal) = self.store.list_terminal_oldest_first() else {
            return;
        };
        let mut total: u64 = terminal.iter().map(|r| r.total_output_bytes).sum();
        for rec in terminal {
            if total <= MAX_LOG_BYTES_GLOBAL {
                break;
            }
            let mut out = match JobOutput::open(&self.log_dir, &rec.id, Instant::now()) {
                Ok(o) => o,
                Err(_) => continue,
            };
            out.remove_files();
            total = total.saturating_sub(rec.total_output_bytes);
            let _ = self.store.update_output_counters(&rec.id, 0, 0);
        }
    }
}

/// Does `requester` own `owner`'s jobs? Exact match — a session may not touch
/// another session's, a scheduled task's, or an app-owned job.
fn owner_matches(requester: &JobOwner, owner: &JobOwner) -> bool {
    requester == owner
}

enum StreamKind {
    Stdout(tokio::process::ChildStdout),
    Stderr(tokio::process::ChildStderr),
}

/// Drain one pipe into the job's output store, waking pollers per chunk.
async fn pump<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
    output: &Arc<Mutex<JobOutput>>,
    notify: &Arc<Notify>,
) {
    loop {
        match reader.read(buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Lock is taken and released inside the loop body — never held
                // across the `.await` above.
                output.lock().append(&buf[..n], Instant::now());
                notify.notify_waiters();
            }
        }
    }
}

/// SIGTERM the whole process group (negated pid).
async fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        // No process-group signal on Windows; `taskkill /T` walks the tree.
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

/// SIGKILL the whole process group after the escalation window.
async fn force_kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    kill_tree(Some(pid)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn supervisor(dir: &TempDir) -> JobSupervisor {
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        JobSupervisor::new(store, dir.path().join("logs"))
    }

    fn session(id: &str) -> JobOwner {
        JobOwner::Session {
            session_id: id.into(),
        }
    }

    #[cfg(unix)]
    fn sh(command: &str, owner: JobOwner) -> SpawnJobRequest {
        let mut env = BTreeMap::new();
        // Keep PATH so the child can find real binaries under `env_clear()`.
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        SpawnJobRequest {
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

    /// Poll the store until the job settles or the budget runs out.
    async fn await_settled(sup: &JobSupervisor, id: &str) -> JobRecord {
        for _ in 0..200 {
            let rec = sup.get(id).unwrap().unwrap();
            if rec.status.is_terminal() {
                return rec;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("job {id} did not settle in time");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_captures_output_and_records_the_real_exit_code() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo hello; exit 3", session("s1")))
            .await
            .unwrap();
        assert_eq!(rec.status, JobStatus::Running);

        let settled = await_settled(&sup, &rec.id).await;
        assert_eq!(settled.status, JobStatus::Exited);
        assert_eq!(
            settled.exit_code,
            Some(3),
            "real exit code, not a PTY guess"
        );

        let slice = sup.read(&rec.id, 0, 4096).unwrap();
        assert!(slice.data.contains("hello"), "got {:?}", slice.data);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_is_captured_alongside_stdout() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo out; echo err 1>&2", session("s1")))
            .await
            .unwrap();
        await_settled(&sup, &rec.id).await;
        let data = sup.read(&rec.id, 0, 4096).unwrap().data;
        assert!(data.contains("out"), "got {data:?}");
        assert!(data.contains("err"), "got {data:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_reaps_the_whole_process_group_not_just_the_wrapper_shell() {
        // THE regression test for the orphan-grandchild defect. The wrapper
        // `sh` spawns a grandchild `sleep` and exits its own foreground; a
        // plain `child.kill()` would leave the `sleep` running. Killing the
        // process group must reap it.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let marker = dir.path().join("grandchild.pid");
        let cmd = format!(
            "sh -c 'echo $$ > {} ; sleep 60' & wait",
            marker.to_string_lossy()
        );
        let rec = sup.spawn(sh(&cmd, session("s1"))).await.unwrap();

        // Wait for the grandchild to announce its pid.
        let mut grandchild_pid = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    grandchild_pid = Some(pid);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let grandchild_pid = grandchild_pid.expect("grandchild should have written its pid");
        // Sanity: it is alive right now.
        assert_eq!(unsafe { libc::kill(grandchild_pid, 0) }, 0);

        sup.kill(&rec.id, None).await.unwrap();
        await_settled(&sup, &rec.id).await;

        // Give the group kill a beat to land, then assert the grandchild is gone.
        let mut reaped = false;
        for _ in 0..80 {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            reaped,
            "grandchild {grandchild_pid} survived the kill — process group was not reaped"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_marks_the_job_killed_and_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();

        sup.kill(&rec.id, None).await.unwrap();
        let settled = await_settled(&sup, &rec.id).await;
        assert_eq!(settled.status, JobStatus::Killed);

        // Second kill on an already-terminal job is a no-op, not an error.
        let again = sup.kill(&rec.id, None).await.unwrap();
        assert_eq!(again.status, JobStatus::Killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_agent_cannot_kill_another_sessions_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("owner"))).await.unwrap();

        let err = sup.kill(&rec.id, Some(&session("intruder"))).await;
        assert!(matches!(err, Err(JobError::Forbidden(_))));
        // Still running — the rejection did not partially act.
        assert_eq!(
            sup.get(&rec.id).unwrap().unwrap().status,
            JobStatus::Running
        );

        // The owner may, and so may the UI (requester = None).
        sup.kill(&rec.id, Some(&session("owner"))).await.unwrap();
        await_settled(&sup, &rec.id).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_on_an_unknown_id_is_not_found() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        assert!(matches!(
            sup.kill("nope", None).await,
            Err(JobError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn per_session_cap_rejects_the_ninth_concurrent_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let owner = session("s1");
        let mut ids = Vec::new();
        for _ in 0..MAX_JOBS_PER_SESSION {
            ids.push(sup.spawn(sh("sleep 30", owner.clone())).await.unwrap().id);
        }
        let err = sup.spawn(sh("sleep 30", owner.clone())).await;
        assert!(
            matches!(err, Err(JobError::LimitReached(_))),
            "expected the per-session cap to reject, got {err:?}"
        );

        // Another session is unaffected — the cap is per owner, not global-only.
        sup.spawn(sh("sleep 30", session("s2"))).await.unwrap();

        for id in ids {
            let _ = sup.kill(&id, None).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_returns_as_soon_as_bytes_land() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("sleep 0.2; echo late-arrival", session("s1")))
            .await
            .unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            slice.data.contains("late-arrival"),
            "long-poll should have woken on the write, got {:?}",
            slice.data
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_returns_on_exit_even_with_no_output() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("sleep 0.1; exit 0", session("s1")))
            .await
            .unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(slice.status.is_terminal());
        assert_eq!(slice.data, "");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_times_out_without_consuming_anything() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_millis(150))
            .await
            .unwrap();
        assert_eq!(slice.data, "");
        assert_eq!(
            slice.next_offset, 0,
            "a timeout must not advance the offset"
        );
        let _ = sup.kill(&rec.id, None).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_survives_the_live_state_being_dropped() {
        // After settle, reads fall back to the on-disk log. This is what makes
        // "what did last night's build print?" answerable across a restart.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo durable-line", session("s1")))
            .await
            .unwrap();
        await_settled(&sup, &rec.id).await;

        sup.live.lock().remove(&rec.id);
        let slice = sup.read(&rec.id, 0, 4096).unwrap();
        assert!(slice.data.contains("durable-line"), "got {:?}", slice.data);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_listeners_fire_once_with_the_terminal_verdict() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen: Arc<Mutex<Vec<JobExit>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        sup.on_exit(Arc::new(move |exit| sink.lock().push(exit)));

        let rec = sup.spawn(sh("exit 7", session("s1"))).await.unwrap();
        await_settled(&sup, &rec.id).await;
        // The listener runs after settle; give the task a beat to land.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let events = seen.lock().clone();
        assert_eq!(events.len(), 1, "exactly one exit event per job");
        assert_eq!(events[0].job_id, rec.id);
        assert_eq!(events[0].exit_code, Some(7));
        assert_eq!(events[0].status, JobStatus::Exited);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_owned_by_reaps_one_session_and_leaves_others_alone() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let doomed = sup.spawn(sh("sleep 30", session("doomed"))).await.unwrap();
        let spared = sup.spawn(sh("sleep 30", session("spared"))).await.unwrap();

        let killed = sup.kill_owned_by(&session("doomed")).await.unwrap();
        assert_eq!(killed, vec![doomed.id.clone()]);
        await_settled(&sup, &doomed.id).await;
        assert_eq!(
            sup.get(&spared.id).unwrap().unwrap().status,
            JobStatus::Running
        );
        let _ = sup.kill(&spared.id, None).await;
    }

    #[tokio::test]
    async fn reconcile_on_boot_clears_ghost_rows_before_the_caps_count_them() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        // Simulate a previous lifetime that died with a job still running.
        store
            .insert(&JobRecord {
                id: "ghost".into(),
                command: "sleep 999".into(),
                cwd: "/tmp".into(),
                owner: session("old"),
                status: JobStatus::Running,
                exit_code: None,
                pid: Some(999_999),
                started_at_ms: 1,
                ended_at_ms: None,
                total_output_bytes: 0,
                dropped_output_bytes: 0,
                label: None,
            })
            .unwrap();

        let sup = JobSupervisor::new(Arc::clone(&store), dir.path().join("logs"));
        let ids = sup.reconcile_on_boot().unwrap();
        assert_eq!(ids, vec!["ghost".to_string()]);
        assert_eq!(
            store.get("ghost").unwrap().unwrap().status,
            JobStatus::Interrupted
        );
        assert_eq!(store.count_running(None).unwrap(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_reaps_the_owning_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();
        let pid = rec.pid.expect("spawned job has a pid");

        let killed = sup.kill_by_pid(pid, None).await.unwrap();
        assert_eq!(killed.map(|r| r.id), Some(rec.id.clone()));
        assert_eq!(await_settled(&sup, &rec.id).await.status, JobStatus::Killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_returns_none_for_a_pid_we_do_not_own() {
        // The caller must be able to tell "not ours" from "failed", so it can
        // fall back to a plain signal instead of refusing to act.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        assert!(sup.kill_by_pid(999_999, None).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_does_not_resolve_a_recycled_pid_to_a_finished_job() {
        // Terminal rows clear their pid; if they did not, an unrelated process
        // that later reused the number could be matched to a dead job.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("exit 0", session("s1"))).await.unwrap();
        let pid = rec.pid.expect("spawned job has a pid");
        await_settled(&sup, &rec.id).await;

        assert!(sup.kill_by_pid(pid, None).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_still_honours_owner_scoping() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("owner"))).await.unwrap();
        let pid = rec.pid.unwrap();

        assert!(matches!(
            sup.kill_by_pid(pid, Some(&session("intruder"))).await,
            Err(JobError::Forbidden(_))
        ));
        let _ = sup.kill(&rec.id, None).await;
    }

    #[test]
    fn owner_matching_is_exact_across_kinds_and_ids() {
        assert!(owner_matches(&session("a"), &session("a")));
        assert!(!owner_matches(&session("a"), &session("b")));
        assert!(!owner_matches(&session("a"), &JobOwner::App));
        assert!(!owner_matches(
            &JobOwner::ScheduledTask {
                task_id: "t".into()
            },
            &session("t")
        ));
        assert!(owner_matches(&JobOwner::App, &JobOwner::App));
    }
}
