//! `VirtualDisplayController` — owns the virtual-display lifecycle on one
//! dedicated OS thread.
//!
//! Why a dedicated thread (mirrors `worker.rs`): the parsec-vdd device
//! `HANDLE` and the `SetThreadExecutionState` keepalive are thread-affine, and
//! the driver must be pinged on a steady ~100 ms cadence. A single
//! `recv_timeout` loop owns the driver, services `Arm`/`Release`/`Shutdown`
//! messages, pings while acquired, and auto-releases after an idle window — no
//! separate timer thread, so no stale-release race (the keepalive-generation
//! debounce from the design is subsumed by doing the idle check inline).
//!
//! The [`VddDriver`] is injectable, so this whole state machine is unit-tested
//! cross-platform against a mock; the real Windows driver is built by
//! [`super::build_driver`] on this thread.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::{ArmOutcome, ReleaseReason, VddDriver};
use crate::automation::audit::{AuditEntry, AuditRing, Decision};
use crate::automation::permission::Surface;

/// Default idle window before an unused virtual display is torn down. Long
/// enough to span slow model round-trips and human-away gaps without churning
/// the driver (each create/destroy reshuffles windows).
pub const DEFAULT_IDLE: Duration = Duration::from_secs(300);
/// parsec-vdd unplugs added displays ~1 s after the last ping; 100 ms keeps a
/// comfortable margin.
pub const PING_INTERVAL: Duration = Duration::from_millis(100);
/// How long `arm()` waits for the controller thread to acquire (or fail).
const ARM_TIMEOUT: Duration = Duration::from_secs(10);

enum Msg {
    Arm { reply: mpsc::Sender<ArmOutcome> },
    Release { reason: ReleaseReason },
}

/// Cheap, lock-protected view of the controller used by health/status reads
/// from other threads (the device itself stays owned by the controller thread).
#[derive(Debug, Default, Clone)]
pub struct Status {
    pub active: bool,
    pub active_monitor: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct VirtualDisplayController {
    tx: mpsc::Sender<Msg>,
    status: Arc<Mutex<Status>>,
    _thread: Arc<ThreadJoiner>,
}

struct ThreadJoiner(Option<JoinHandle<()>>);

impl Drop for ThreadJoiner {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            let _ = h.join();
        }
    }
}

impl VirtualDisplayController {
    /// Spawn with production defaults. `builder` runs on the controller thread
    /// (so the driver may be `!Send`); `audit`/`app` enable `automation:event`
    /// emission (pass `None` in tests).
    pub fn spawn<F>(builder: F, audit: Option<AuditRing>, app: Option<AppHandle>) -> Self
    where
        F: Fn() -> Box<dyn VddDriver> + Send + 'static,
    {
        Self::spawn_with_config(builder, DEFAULT_IDLE, PING_INTERVAL, audit, app)
    }

    /// Test/explicit constructor — lets unit tests inject a short idle window
    /// and fast ping cadence.
    pub fn spawn_with_config<F>(
        builder: F,
        idle_after: Duration,
        ping_interval: Duration,
        audit: Option<AuditRing>,
        app: Option<AppHandle>,
    ) -> Self
    where
        F: Fn() -> Box<dyn VddDriver> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Msg>();
        let status = Arc::new(Mutex::new(Status::default()));
        let status_thread = status.clone();
        let thread = thread::Builder::new()
            .name("virtual-display".into())
            .spawn(move || {
                let driver = builder();
                run(rx, status_thread, driver, idle_after, ping_interval, audit, app);
            })
            .expect("spawn virtual-display thread");
        Self {
            tx,
            status,
            _thread: Arc::new(ThreadJoiner(Some(thread))),
        }
    }

    /// Ensure a virtual display is active for the current screen-off turn. If
    /// one already exists, re-arms the idle timer; otherwise acquires one. On a
    /// missing/unsupported driver returns [`ArmOutcome::Unavailable`] so the
    /// caller can fail strictly instead of capturing a black screen.
    ///
    /// Blocks briefly on the controller thread's reply — call from a blocking
    /// context (Tauri commands use `spawn_blocking`).
    pub fn arm(&self) -> ArmOutcome {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(Msg::Arm { reply: reply_tx }).is_err() {
            return ArmOutcome::Unavailable("virtual display controller stopped".into());
        }
        match reply_rx.recv_timeout(ARM_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => ArmOutcome::Unavailable("virtual display controller timed out".into()),
        }
    }

    /// Tear down the virtual display now (kill switch / session close / app
    /// teardown). Best-effort and non-blocking.
    pub fn force_release(&self, reason: ReleaseReason) {
        let _ = self.tx.send(Msg::Release { reason });
    }

    /// Current status (active flag, monitor label, last error) for the health
    /// probe / settings card.
    pub fn status(&self) -> Status {
        self.status.lock().clone()
    }

    pub fn is_active(&self) -> bool {
        self.status.lock().active
    }
}

fn set_active(status: &Arc<Mutex<Status>>, monitor: Option<String>) {
    let mut g = status.lock();
    g.active = true;
    g.active_monitor = monitor;
    g.last_error = None;
}

fn set_inactive(status: &Arc<Mutex<Status>>, error: Option<String>) {
    let mut g = status.lock();
    g.active = false;
    g.active_monitor = None;
    if error.is_some() {
        g.last_error = error;
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    rx: mpsc::Receiver<Msg>,
    status: Arc<Mutex<Status>>,
    mut driver: Box<dyn VddDriver>,
    idle_after: Duration,
    ping_interval: Duration,
    audit: Option<AuditRing>,
    app: Option<AppHandle>,
) {
    let mut idle_deadline: Option<Instant> = None;
    loop {
        // Block indefinitely when idle; ping-cadence poll while a display is up.
        let wait = if driver.is_acquired() {
            ping_interval
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::Arm { reply }) => {
                if driver.is_acquired() {
                    idle_deadline = Some(Instant::now() + idle_after);
                    let _ = reply.send(ArmOutcome::AlreadyActive);
                    continue;
                }
                let started = Instant::now();
                match driver.acquire() {
                    Ok(acq) => {
                        idle_deadline = Some(Instant::now() + idle_after);
                        set_active(&status, Some(acq.label.clone()));
                        emit(
                            &audit,
                            &app,
                            "vdd_enter",
                            Decision::Allow,
                            Some(format!("virtual display {} active", acq.label)),
                            None,
                            started.elapsed(),
                        );
                        let _ = reply.send(ArmOutcome::Acquired { monitor: acq.label });
                    }
                    Err(err) => {
                        let msg = err.to_string();
                        set_inactive(&status, Some(msg.clone()));
                        emit(
                            &audit,
                            &app,
                            "vdd_enter",
                            Decision::Deny,
                            Some("vdd_unavailable".into()),
                            Some(msg.clone()),
                            started.elapsed(),
                        );
                        let _ = reply.send(ArmOutcome::Unavailable(msg));
                    }
                }
            }
            Ok(Msg::Release { reason }) => {
                if driver.is_acquired() {
                    driver.release(reason);
                    idle_deadline = None;
                    set_inactive(&status, None);
                    emit(
                        &audit,
                        &app,
                        "vdd_release",
                        Decision::Allow,
                        Some(reason.as_reason().to_string()),
                        None,
                        Duration::ZERO,
                    );
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !driver.is_acquired() {
                    continue;
                }
                if let Err(err) = driver.ping() {
                    // Ping failed — the display is gone or the device closed.
                    // Tear down cleanly and surface the error.
                    let msg = err.to_string();
                    driver.release(ReleaseReason::Manual);
                    idle_deadline = None;
                    set_inactive(&status, Some(msg.clone()));
                    emit(
                        &audit,
                        &app,
                        "vdd_release",
                        Decision::Deny,
                        Some("ping failed".into()),
                        Some(msg),
                        Duration::ZERO,
                    );
                    continue;
                }
                if let Some(dl) = idle_deadline {
                    if Instant::now() >= dl {
                        driver.release(ReleaseReason::Idle);
                        idle_deadline = None;
                        set_inactive(&status, None);
                        emit(
                            &audit,
                            &app,
                            "vdd_release",
                            Decision::Allow,
                            Some(ReleaseReason::Idle.as_reason().to_string()),
                            None,
                            Duration::ZERO,
                        );
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if driver.is_acquired() {
                    driver.release(ReleaseReason::Shutdown);
                }
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(
    audit: &Option<AuditRing>,
    app: &Option<AppHandle>,
    command: &str,
    decision: Decision,
    reason: Option<String>,
    error: Option<String>,
    duration: Duration,
) {
    let Some(ring) = audit else {
        return;
    };
    let entry = ring.record(AuditEntry {
        id: String::new(),
        ts: chrono::Utc::now().timestamp_millis(),
        surface: Surface::ComputerUse,
        plugin_id: Some("cognia-computer-use".into()),
        command: command.into(),
        process_name: None,
        window_title: None,
        decision,
        reason,
        duration_ms: duration.as_millis() as u64,
        error,
    });
    if let Some(handle) = app {
        let _ = handle.emit("automation:event", &entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::virtual_display::{AcquiredDisplay, VddError};

    #[derive(Default)]
    struct MockState {
        acquire_calls: u32,
        ping_calls: u32,
        release_calls: u32,
        acquired: bool,
        fail_acquire: bool,
        fail_ping_after: Option<u32>,
        last_release_reason: Option<ReleaseReason>,
    }

    #[derive(Clone)]
    struct MockHandle(Arc<Mutex<MockState>>);

    impl MockHandle {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(MockState::default())))
        }
        fn with_fail_acquire() -> Self {
            let h = Self::new();
            h.0.lock().fail_acquire = true;
            h
        }
        fn driver(&self) -> Box<dyn VddDriver> {
            Box::new(MockDriver(self.0.clone()))
        }
    }

    struct MockDriver(Arc<Mutex<MockState>>);

    impl VddDriver for MockDriver {
        fn acquire(&mut self) -> Result<AcquiredDisplay, VddError> {
            let mut s = self.0.lock();
            s.acquire_calls += 1;
            if s.fail_acquire {
                return Err(VddError::Unavailable("mock unavailable".into()));
            }
            s.acquired = true;
            Ok(AcquiredDisplay {
                label: "\\\\.\\DISPLAY9".into(),
                width: 1920,
                height: 1080,
            })
        }
        fn ping(&mut self) -> Result<(), VddError> {
            let mut s = self.0.lock();
            s.ping_calls += 1;
            if let Some(after) = s.fail_ping_after {
                if s.ping_calls > after {
                    s.acquired = false;
                    return Err(VddError::Driver("mock ping lost".into()));
                }
            }
            Ok(())
        }
        fn release(&mut self, reason: ReleaseReason) {
            let mut s = self.0.lock();
            s.release_calls += 1;
            s.acquired = false;
            s.last_release_reason = Some(reason);
        }
        fn is_acquired(&self) -> bool {
            self.0.lock().acquired
        }
    }

    fn wait_until(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if pred() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        pred()
    }

    #[test]
    fn arm_acquires_then_reports_already_active() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );

        let first = ctrl.arm();
        assert!(matches!(first, ArmOutcome::Acquired { .. }));
        assert!(ctrl.is_active());

        let second = ctrl.arm();
        assert!(matches!(second, ArmOutcome::AlreadyActive));
        // Only one acquire despite two arms.
        assert_eq!(mock.0.lock().acquire_calls, 1);

        ctrl.force_release(ReleaseReason::SessionClosed);
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert_eq!(mock.0.lock().last_release_reason, Some(ReleaseReason::SessionClosed));
    }

    #[test]
    fn arm_reports_unavailable_when_driver_fails() {
        let mock = MockHandle::with_fail_acquire();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        let out = ctrl.arm();
        assert!(matches!(out, ArmOutcome::Unavailable(_)));
        assert!(!ctrl.is_active());
        assert!(ctrl.status().last_error.is_some());
    }

    #[test]
    fn pings_while_acquired() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(wait_until(
            || mock.0.lock().ping_calls >= 3,
            Duration::from_secs(1)
        ));
        ctrl.force_release(ReleaseReason::Manual);
    }

    #[test]
    fn auto_releases_after_idle_window() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_millis(40), // short idle window
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(ctrl.is_active());
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        let s = mock.0.lock();
        assert!(s.release_calls >= 1);
        assert_eq!(s.last_release_reason, Some(ReleaseReason::Idle));
    }

    #[test]
    fn ping_failure_tears_down() {
        let mock = MockHandle::new();
        mock.0.lock().fail_ping_after = Some(2);
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert!(ctrl.status().last_error.is_some());
    }

    #[test]
    fn audit_ring_records_enter_and_release() {
        let mock = MockHandle::new();
        let ring = AuditRing::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            Some(ring.clone()),
            None,
        );
        ctrl.arm();
        ctrl.force_release(ReleaseReason::KillSwitch);
        assert!(wait_until(
            || {
                let snap = ring.snapshot();
                snap.iter().any(|e| e.command == "vdd_enter")
                    && snap.iter().any(|e| e.command == "vdd_release")
            },
            Duration::from_secs(1)
        ));
    }
}
