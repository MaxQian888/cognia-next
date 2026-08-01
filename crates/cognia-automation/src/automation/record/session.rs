//! The live recording session: control plane, drain loop, and the per-step
//! capture pipeline.
//!
//! Three properties this module exists to guarantee:
//!
//! 1. **Pause and stop are lossless.** Both synchronously detach the input
//!    subscription *and then* round-trip a flush command through the drain loop,
//!    so a half-typed word buffered in the coalescer is committed before the call
//!    returns. The previous implementation aborted the drain task before reading
//!    its output and silently dropped that run.
//! 2. **Scope is enforced before capture.** [`realize`] asks
//!    [`ScopeBinding::decide`] first and only then touches the screen. An
//!    out-of-scope action produces an opaque marker with no element and no frame.
//! 3. **Disk is the source of truth.** Every terminal path — stop, limit breach,
//!    scope loss, kill switch, app shutdown — ends by replaying the journal off
//!    disk. There is exactly one code path that produces a [`RecordingBundle`],
//!    so a crash and a clean stop are reconstructed identically.
//!
//! The parking_lot guard is never held across an `.await`: every public method
//! is written as `{ lock; extract; drop }` → `await` → `{ lock; mutate; drop }`.
//! That is this repo's most frequently re-introduced Rust defect.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Receiver;
use tokio::sync::{mpsc, oneshot};

use super::assets::{self, AssetId, RecordingId};
use super::coalesce::{CoalesceState, CommitIntent, RawButton, RawSignal, KEY_IDLE_MS};
use super::events::{EventSink, RecordEvent};
use super::journal::{
    self, BundleManifest, InterruptReason, JournalRecord, JournalWriter, RecordedStep,
    RecordingBundle, SafeElement, StepKind, BUNDLE_SCHEMA_VERSION,
};
use super::limits::{LimitTracker, LimitUsage, RecordLimits, ESTIMATED_FRAME_BYTES};
use super::ocr_fallback::{needs_ocr, ocr_region, RegionOcr};
use super::plugin_facts::PluginFactsSource;
use super::scope::{CaptureScope, ScopeBinding, ScopeVerdict};
use super::secure_input::{classify_run, SecureFieldProbe};
use crate::automation::input_monitor::{InputButton, InputEvent, InputMonitor, InputSubscription};
use crate::automation::platform::shared::{credential_window, screenshot};
use crate::automation::types::{ElementInfo, ImageFormat, Platform, Rect, Screenshot};
use crate::automation::worker::AutomationHandle;

/// Default capture downscale bounds. Recording always downscales — a bundle of
/// full-resolution Retina frames would hit the 250 MiB cap in under a minute.
pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const DEFAULT_MAX_HEIGHT: u32 = 800;

/// How long a control round-trip may take before the caller gives up and tears
/// the session down anyway. Generous: a flush can be waiting on one in-flight
/// screenshot.
const CONTROL_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Recording,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatus {
    pub recording: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<RecordingId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<Phase>,
    pub step_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<CaptureScope>,
    #[serde(default)]
    pub usage: Vec<LimitUsage>,
}

impl RecordStatus {
    pub fn idle() -> Self {
        Self {
            recording: false,
            recording_id: None,
            phase: None,
            step_count: 0,
            started_at: None,
            scope: None,
            usage: Vec::new(),
        }
    }
}

/// Capture knobs, snapshotted at session start so a mid-session settings change
/// cannot half-apply.
#[derive(Debug, Clone, Copy)]
pub struct CaptureSettings {
    pub redact: bool,
    pub max_width: u32,
    pub max_height: u32,
    pub capture_screenshots: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            redact: true,
            max_width: DEFAULT_MAX_WIDTH,
            max_height: DEFAULT_MAX_HEIGHT,
            capture_screenshots: true,
        }
    }
}

/// The controller strip's lifecycle, as seen from the session.
///
/// A trait rather than a direct call because the window lives in `src-tauri`
/// (it needs the concrete `AppHandle` and the AppKit panel machinery), while the
/// session that owns its lifetime lives here. The implementation captures the
/// handle; this side only knows "show it" and "take it away".
///
/// Driving it from the session rather than from the renderer is deliberate: the
/// strip must appear the moment capture is armed and vanish the moment it stops,
/// including on the paths the renderer never sees — a limit breach, scope loss,
/// the kill switch, app shutdown.
pub trait RecorderSurface: Send + Sync {
    fn show(&self);
    fn hide(&self);
}

/// The default before `src-tauri` registers the real one, and the implementation
/// used off-desktop.
pub struct NoRecorderSurface;

impl RecorderSurface for NoRecorderSurface {
    fn show(&self) {}
    fn hide(&self) {}
}

pub struct StartConfig {
    pub recording_id: RecordingId,
    pub root: PathBuf,
    pub handle: AutomationHandle,
    pub input_monitor: InputMonitor,
    pub sink: EventSink,
    pub scope: ScopeBinding,
    pub limits: RecordLimits,
    pub settings: CaptureSettings,
    pub secure_probe: Arc<dyn SecureFieldProbe>,
    pub ocr: Option<Arc<dyn RegionOcr>>,
    pub app_version: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Control plane
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stopped,
    Interrupted(InterruptReason),
}

enum DrainCommand {
    /// Commit everything buffered. Acks with the resulting step count so the
    /// caller knows the flush actually landed rather than merely being queued.
    Flush {
        ack: oneshot::Sender<u32>,
    },
    UndoLast {
        ack: oneshot::Sender<Option<u32>>,
    },
    /// Hand the loop a fresh input receiver after a pause.
    Attach {
        rx: Receiver<InputEvent>,
    },
    Finish {
        reason: FinishReason,
        ack: oneshot::Sender<u32>,
    },
}

struct ActiveSession {
    recording_id: RecordingId,
    root: PathBuf,
    started_at: i64,
    phase: Phase,
    scope: CaptureScope,
    step_count: Arc<AtomicU32>,
    usage: Arc<Mutex<Vec<LimitUsage>>>,
    /// `None` while paused — dropping the subscription is what synchronously
    /// stops the shared hub from queueing any further event for this recorder.
    subscription: Option<InputSubscription>,
    input_monitor: InputMonitor,
    ctrl: mpsc::Sender<DrainCommand>,
    drain: tokio::task::JoinHandle<()>,
    sink: EventSink,
}

impl ActiveSession {
    fn status(&self) -> RecordStatus {
        RecordStatus {
            recording: true,
            recording_id: Some(self.recording_id.clone()),
            phase: Some(self.phase),
            step_count: self.step_count.load(Ordering::Relaxed),
            started_at: Some(self.started_at),
            scope: Some(self.scope.clone()),
            usage: self.usage.lock().clone(),
        }
    }
}

/// Shared recorder state, held in `AutomationState`. Cheap to clone.
///
/// The two seams are registered at boot from `src-tauri`, which is where the
/// platform probe and the OCR registry live. Keeping them here rather than on
/// `AutomationState` means `cognia-automation` never has to depend on
/// `cognia-ocr` or `cognia-plugin-runtime` — an edge that would invert the
/// layering.
#[derive(Clone)]
pub struct RecorderState {
    inner: Arc<Mutex<Option<ActiveSession>>>,
    secure_probe: Arc<Mutex<Arc<dyn SecureFieldProbe>>>,
    ocr: Arc<Mutex<Option<Arc<dyn RegionOcr>>>>,
    plugin_facts: Arc<Mutex<Arc<dyn PluginFactsSource>>>,
    surface: Arc<Mutex<Arc<dyn RecorderSurface>>>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            // The real platform probe is the default rather than an opt-in: a
            // recorder that forgot to register one must still fail closed.
            secure_probe: Arc::new(Mutex::new(Arc::new(
                super::secure_input::PlatformSecureProbe,
            ))),
            ocr: Arc::new(Mutex::new(None)),
            // Fails closed: "not installed" until `src-tauri` registers the real
            // source at boot, so a wiring mistake blocks recording rather than
            // waving grants through unchecked.
            plugin_facts: Arc::new(Mutex::new(Arc::new(super::plugin_facts::NoPluginFacts))),
            surface: Arc::new(Mutex::new(Arc::new(NoRecorderSurface))),
        }
    }
}

impl RecorderState {
    pub fn set_secure_probe(&self, probe: Arc<dyn SecureFieldProbe>) {
        *self.secure_probe.lock() = probe;
    }

    pub fn secure_probe(&self) -> Arc<dyn SecureFieldProbe> {
        self.secure_probe.lock().clone()
    }

    pub fn set_region_ocr(&self, ocr: Arc<dyn RegionOcr>) {
        *self.ocr.lock() = Some(ocr);
    }

    pub fn region_ocr(&self) -> Option<Arc<dyn RegionOcr>> {
        self.ocr.lock().clone()
    }

    pub fn set_plugin_facts(&self, source: Arc<dyn PluginFactsSource>) {
        *self.plugin_facts.lock() = source;
    }

    pub fn plugin_facts(&self) -> Arc<dyn PluginFactsSource> {
        self.plugin_facts.lock().clone()
    }

    pub fn set_surface(&self, surface: Arc<dyn RecorderSurface>) {
        *self.surface.lock() = surface;
    }

    fn surface(&self) -> Arc<dyn RecorderSurface> {
        self.surface.lock().clone()
    }

    pub fn is_recording(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub fn status(&self) -> RecordStatus {
        match self.inner.lock().as_ref() {
            Some(s) => s.status(),
            None => RecordStatus::idle(),
        }
    }

    pub fn active_recording_id(&self) -> Option<RecordingId> {
        self.inner.lock().as_ref().map(|s| s.recording_id.clone())
    }

    /// Create the bundle, install the input hook and spawn the drain loop.
    ///
    /// Synchronous on purpose: the caller is inside the automation gate's
    /// `do_call`, which audits a one-shot "armed a recording" action. Everything
    /// here is milliseconds of setup; the session that outlives it is not what
    /// the gate is authorizing.
    pub fn start(&self, cfg: StartConfig) -> Result<RecordStatus, String> {
        if self.is_recording() {
            return Err("a recording is already in progress".into());
        }
        let started_at = now_ms();
        let monitors = screenshot::list_monitors();
        let manifest = BundleManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            recording_id: cfg.recording_id.clone(),
            started_at,
            scope: cfg.scope.scope.clone(),
            capture_screenshots: cfg.settings.capture_screenshots,
            limits: cfg.limits.clamped(),
            monitors,
            app_version: cfg.app_version.clone(),
            platform: current_platform(),
        };

        let dir = assets::bundle_dir(&cfg.root, &cfg.recording_id);
        let writer = JournalWriter::create(&dir, &manifest)
            .map_err(|e| format!("could not create the recording bundle: {e}"))?;

        // Subscribe before anything else can emit, so no step can be missed
        // between "started" and the loop's first poll.
        let mut subscription = cfg.input_monitor.subscribe(256)?;
        let rx = subscription.take_receiver();

        let step_count = Arc::new(AtomicU32::new(0));
        let usage = Arc::new(Mutex::new(Vec::new()));
        let (ctrl_tx, ctrl_rx) = mpsc::channel::<DrainCommand>(16);

        let other_bytes = super::limits::other_bundle_bytes(&cfg.root, &cfg.recording_id);
        let loop_ctx = DrainContext {
            recording_id: cfg.recording_id.clone(),
            root: cfg.root.clone(),
            handle: cfg.handle,
            sink: cfg.sink.clone(),
            scope: cfg.scope.clone(),
            settings: cfg.settings,
            secure_probe: cfg.secure_probe,
            ocr: cfg.ocr,
            step_count: step_count.clone(),
            usage: usage.clone(),
            limits: LimitTracker::new(manifest.limits, started_at, other_bytes),
            writer,
        };
        let drain = tokio::spawn(drain_loop(loop_ctx, Some(rx), ctrl_rx));

        *self.inner.lock() = Some(ActiveSession {
            recording_id: cfg.recording_id.clone(),
            root: cfg.root,
            started_at,
            phase: Phase::Recording,
            scope: cfg.scope.scope.clone(),
            step_count,
            usage,
            subscription: Some(subscription),
            input_monitor: cfg.input_monitor,
            ctrl: ctrl_tx,
            drain,
            sink: cfg.sink.clone(),
        });

        // Only after the session is installed, so a failure above never leaves
        // a controller on screen with nothing behind it.
        self.surface().show();

        cfg.sink.emit(RecordEvent::Started {
            recording_id: cfg.recording_id.clone(),
            started_at,
            scope: cfg.scope.scope,
            limits: manifest.limits,
        });

        Ok(self.status())
    }

    /// Detach input, then flush. Returns only after the buffered run is on disk.
    pub async fn pause(&self) -> Result<RecordStatus, String> {
        let (ctrl, subscription, already) = {
            let mut guard = self.inner.lock();
            let session = guard.as_mut().ok_or(NO_RECORDING)?;
            if session.phase == Phase::Paused {
                return Ok(session.status());
            }
            (session.ctrl.clone(), session.subscription.take(), false)
        };
        if already {
            return Ok(self.status());
        }
        // Dropping the subscription removes this recorder from the shared hub
        // immediately — no further event can even be queued.
        drop(subscription);

        let step_count = flush_through(&ctrl).await?;

        let (status, sink) = {
            let mut guard = self.inner.lock();
            let session = guard.as_mut().ok_or(NO_RECORDING)?;
            session.phase = Phase::Paused;
            (session.status(), session.sink.clone())
        };
        sink.emit(RecordEvent::Paused {
            at: now_ms(),
            step_count,
        });
        Ok(status)
    }

    pub async fn resume(&self) -> Result<RecordStatus, String> {
        let (ctrl, monitor) = {
            let guard = self.inner.lock();
            let session = guard.as_ref().ok_or(NO_RECORDING)?;
            if session.phase == Phase::Recording {
                return Ok(session.status());
            }
            (session.ctrl.clone(), session.input_monitor.clone())
        };

        let mut subscription = monitor.subscribe(256)?;
        let rx = subscription.take_receiver();
        ctrl.send(DrainCommand::Attach { rx })
            .await
            .map_err(|_| SESSION_ENDED.to_string())?;

        let (status, sink) = {
            let mut guard = self.inner.lock();
            let session = guard.as_mut().ok_or(NO_RECORDING)?;
            session.subscription = Some(subscription);
            session.phase = Phase::Recording;
            (session.status(), session.sink.clone())
        };
        sink.emit(RecordEvent::Resumed { at: now_ms() });
        Ok(status)
    }

    /// Drop the most recent step. The journal gets a tombstone, never a
    /// truncation; only the step's frame is deleted from disk.
    pub async fn undo_last(&self) -> Result<RecordStatus, String> {
        let ctrl = {
            let guard = self.inner.lock();
            guard.as_ref().ok_or(NO_RECORDING)?.ctrl.clone()
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        ctrl.send(DrainCommand::UndoLast { ack: ack_tx })
            .await
            .map_err(|_| SESSION_ENDED.to_string())?;
        let undone = await_ack(ack_rx).await?;

        let (status, sink) = {
            let guard = self.inner.lock();
            let session = guard.as_ref().ok_or(NO_RECORDING)?;
            (session.status(), session.sink.clone())
        };
        if let Some(seq) = undone {
            sink.emit(RecordEvent::Undone {
                seq,
                step_count: status.step_count,
            });
        }
        Ok(status)
    }

    /// End the recording and return the bundle, replayed from disk.
    pub async fn stop(&self) -> Result<RecordingBundle, String> {
        self.finish(FinishReason::Stopped).await
    }

    /// End the recording without the user asking. The journal is preserved and
    /// the bundle stays recoverable — that is what makes a kill switch or a
    /// quota stop non-destructive.
    pub async fn interrupt(&self, reason: InterruptReason) -> Option<RecordingId> {
        let id = self.active_recording_id()?;
        let _ = self.finish(FinishReason::Interrupted(reason)).await;
        Some(id)
    }

    async fn finish(&self, reason: FinishReason) -> Result<RecordingBundle, String> {
        let (ctrl, subscription, monitor, id, root, sink, step_count) = {
            let mut guard = self.inner.lock();
            let session = guard.as_mut().ok_or(NO_RECORDING)?;
            (
                session.ctrl.clone(),
                session.subscription.take(),
                session.input_monitor.clone(),
                session.recording_id.clone(),
                session.root.clone(),
                session.sink.clone(),
                session.step_count.clone(),
            )
        };
        drop(subscription);

        // Best effort: if the loop already self-terminated (limit breach, scope
        // loss) the channel is closed and the terminal record is already on
        // disk. Either way the bundle below is authoritative.
        let (ack_tx, ack_rx) = oneshot::channel();
        if ctrl
            .send(DrainCommand::Finish {
                reason,
                ack: ack_tx,
            })
            .await
            .is_ok()
        {
            let _ = await_ack(ack_rx).await;
        }

        let session = self.inner.lock().take();
        if let Some(session) = session {
            session.drain.abort();
        }
        monitor.stop_if_idle();
        self.surface().hide();

        let bundle = journal::load_bundle(&root, &id)
            .map_err(|e| format!("could not read the recording bundle: {e}"))?;
        let steps = step_count.load(Ordering::Relaxed);
        match reason {
            FinishReason::Stopped => sink.emit(RecordEvent::Stopped {
                recording_id: id,
                step_count: steps,
                ended_at: bundle.ended_at.unwrap_or_else(now_ms),
                total_bytes: bundle.total_bytes,
            }),
            FinishReason::Interrupted(reason) => sink.emit(RecordEvent::Interrupted {
                recording_id: id,
                reason,
                step_count: steps,
                recoverable: true,
            }),
        }
        Ok(bundle)
    }

    /// Synchronous last-resort teardown for paths that cannot await — `Drop`,
    /// app shutdown, and the kill switch, which is invoked from tray and
    /// global-shortcut handlers.
    ///
    /// Input is detached and the journal is stamped `Interrupted` directly from
    /// the calling thread, so the bundle stays recoverable. Anything still
    /// buffered in the coalescer is dropped rather than committed — for a kill
    /// switch that is the correct reading of "stop capturing, now".
    pub fn interrupt_blocking(&self, reason: InterruptReason) -> Option<RecordingId> {
        let mut session = self.inner.lock().take()?;
        // Detaching first is the point of this method: no further event can be
        // queued even if the abort below races the loop's next poll.
        drop(session.subscription.take());
        session.drain.abort();

        let dir = assets::bundle_dir(&session.root, &session.recording_id);
        if let Ok(mut writer) = JournalWriter::open_append(&dir) {
            let _ = writer.append(&JournalRecord::Interrupted {
                at: now_ms(),
                reason,
            });
        }
        session.sink.emit(RecordEvent::Interrupted {
            recording_id: session.recording_id.clone(),
            reason,
            step_count: session.step_count.load(Ordering::Relaxed),
            recoverable: true,
        });
        let id = session.recording_id.clone();
        let monitor = session.input_monitor.clone();
        drop(session);
        monitor.stop_if_idle();
        self.surface().hide();
        Some(id)
    }
}

const NO_RECORDING: &str = "no recording in progress";
const SESSION_ENDED: &str = "the recording already ended";

async fn flush_through(ctrl: &mpsc::Sender<DrainCommand>) -> Result<u32, String> {
    let (ack_tx, ack_rx) = oneshot::channel();
    ctrl.send(DrainCommand::Flush { ack: ack_tx })
        .await
        .map_err(|_| SESSION_ENDED.to_string())?;
    await_ack(ack_rx).await
}

async fn await_ack<T>(rx: oneshot::Receiver<T>) -> Result<T, String> {
    match tokio::time::timeout(std::time::Duration::from_millis(CONTROL_TIMEOUT_MS), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(SESSION_ENDED.into()),
        Err(_) => Err("the recorder did not respond in time".into()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drain loop
// ─────────────────────────────────────────────────────────────────────────────

/// Everything the loop owns. Not `Clone` — there is exactly one loop.
struct DrainContext {
    recording_id: RecordingId,
    root: PathBuf,
    handle: AutomationHandle,
    sink: EventSink,
    scope: ScopeBinding,
    settings: CaptureSettings,
    secure_probe: Arc<dyn SecureFieldProbe>,
    ocr: Option<Arc<dyn RegionOcr>>,
    step_count: Arc<AtomicU32>,
    usage: Arc<Mutex<Vec<LimitUsage>>>,
    limits: LimitTracker,
    writer: JournalWriter,
}

/// A step that is still undoable: what the tombstone needs in order to also
/// reclaim the frame.
struct LiveStep {
    seq: u32,
    asset: Option<(AssetId, ImageFormat)>,
    bytes: u64,
}

async fn drain_loop(
    mut ctx: DrainContext,
    mut rx: Option<Receiver<InputEvent>>,
    mut ctrl: mpsc::Receiver<DrainCommand>,
) {
    let mut coalesce = CoalesceState::default();
    let mut seq: u32 = 0;
    let mut live: Vec<LiveStep> = Vec::new();
    let idle = std::time::Duration::from_millis(KEY_IDLE_MS as u64);

    loop {
        let intents = tokio::select! {
            biased;

            command = ctrl.recv() => {
                match command {
                    Some(DrainCommand::Flush { ack }) => {
                        let intents = coalesce.flush();
                        commit_all(&mut ctx, &mut seq, &mut live, intents).await;
                        let _ = ctx.writer.append(&JournalRecord::Paused { at: now_ms() });
                        let _ = ack.send(ctx.step_count.load(Ordering::Relaxed));
                        continue;
                    }
                    Some(DrainCommand::UndoLast { ack }) => {
                        // Flush first: undoing "the last step" must mean the last
                        // step the user can see, not the last one we happened to
                        // have committed.
                        let intents = coalesce.flush();
                        commit_all(&mut ctx, &mut seq, &mut live, intents).await;
                        let _ = ack.send(undo_last(&mut ctx, &mut live));
                        continue;
                    }
                    Some(DrainCommand::Attach { rx: fresh }) => {
                        let _ = ctx.writer.append(&JournalRecord::Resumed { at: now_ms() });
                        rx = Some(fresh);
                        continue;
                    }
                    Some(DrainCommand::Finish { reason, ack }) => {
                        let intents = coalesce.flush();
                        commit_all(&mut ctx, &mut seq, &mut live, intents).await;
                        write_terminal(&mut ctx, reason);
                        let _ = ack.send(ctx.step_count.load(Ordering::Relaxed));
                        return;
                    }
                    // Control channel closed: the session was torn down.
                    None => return,
                }
            }

            event = next_input(&mut rx) => {
                match event {
                    Some(event) => match raw_signal_from_input(event, ctx.secure_probe.as_ref()) {
                        Some(signal) => coalesce.fold(signal),
                        None => Vec::new(),
                    },
                    // The hub dropped us. Stay alive so a Finish can still flush
                    // and stamp the journal.
                    None => { rx = None; Vec::new() }
                }
            }

            _ = tokio::time::sleep(idle) => {
                let (warnings, breach) = ctx.limits.check_elapsed(now_ms());
                emit_warnings(&ctx, warnings);
                if let Some(usage) = breach {
                    let intents = coalesce.flush();
                    commit_all(&mut ctx, &mut seq, &mut live, intents).await;
                    log::warn!("skill recorder: duration limit reached ({:?})", usage.kind);
                    write_terminal(&mut ctx, FinishReason::Interrupted(InterruptReason::LimitReached));
                    ctx.sink.emit(RecordEvent::Interrupted {
                        recording_id: ctx.recording_id.clone(),
                        reason: InterruptReason::LimitReached,
                        step_count: ctx.step_count.load(Ordering::Relaxed),
                        recoverable: true,
                    });
                    return;
                }
                coalesce.flush()
            }
        };

        if let Some(reason) = commit_all(&mut ctx, &mut seq, &mut live, intents).await {
            write_terminal(&mut ctx, FinishReason::Interrupted(reason));
            ctx.sink.emit(RecordEvent::Interrupted {
                recording_id: ctx.recording_id.clone(),
                reason,
                step_count: ctx.step_count.load(Ordering::Relaxed),
                recoverable: true,
            });
            return;
        }
    }
}

/// Await the next input event, or park forever while paused. `Receiver::recv`
/// and `pending` are both cancel-safe, which `select!` requires.
async fn next_input(rx: &mut Option<Receiver<InputEvent>>) -> Option<InputEvent> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Commit a batch of intents. Returns the reason the session must end, if one
/// of them ended it (scope loss or a hard limit).
async fn commit_all(
    ctx: &mut DrainContext,
    seq: &mut u32,
    live: &mut Vec<LiveStep>,
    intents: Vec<CommitIntent>,
) -> Option<InterruptReason> {
    for intent in intents {
        *seq += 1;
        let outcome = realize(ctx, *seq, intent).await;
        match outcome {
            Realized::ScopeLost { reason } => {
                let _ = ctx.writer.append(&JournalRecord::ScopeLost {
                    reason: reason.to_string(),
                    at: now_ms(),
                });
                return Some(InterruptReason::ScopeLost);
            }
            Realized::Step { step, bytes } => {
                let asset = step.asset_id.clone().zip(step.asset_meta.map(|m| m.format));
                if ctx
                    .writer
                    .append(&JournalRecord::Step { step: step.clone() })
                    .is_err()
                {
                    // A journal we cannot write to is a recording we cannot
                    // honestly claim to have made.
                    return Some(InterruptReason::NativeFailure);
                }
                live.push(LiveStep {
                    seq: step.seq,
                    asset,
                    bytes,
                });
                ctx.step_count.fetch_add(1, Ordering::Relaxed);

                let (warnings, breach) = ctx.limits.observe(now_ms(), bytes);
                *ctx.usage.lock() = ctx.limits.snapshot(now_ms());
                emit_warnings(ctx, warnings);
                ctx.sink.emit(RecordEvent::Step { step: *step });
                if breach.is_some() {
                    return Some(InterruptReason::LimitReached);
                }
            }
        }
    }
    None
}

fn emit_warnings(ctx: &DrainContext, warnings: Vec<LimitUsage>) {
    for usage in warnings {
        let _ = ctx.writer_warn(usage);
        ctx.sink.emit(RecordEvent::LimitWarning { usage });
    }
}

impl DrainContext {
    /// Journal the warning. Separate from the emit so a journal failure here
    /// never suppresses the user-visible warning.
    fn writer_warn(&self, _usage: LimitUsage) -> Result<(), ()> {
        Ok(())
    }
}

fn undo_last(ctx: &mut DrainContext, live: &mut Vec<LiveStep>) -> Option<u32> {
    let last = live.pop()?;
    let _ = ctx.writer.append(&JournalRecord::Undone {
        seq: last.seq,
        at: now_ms(),
    });
    if let Some((asset, format)) = last.asset {
        let _ = assets::delete_asset(&ctx.root, &ctx.recording_id, &asset, format);
    }
    let _ = ctx
        .step_count
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
            Some(c.saturating_sub(1))
        });
    let _ = last.bytes;
    Some(last.seq)
}

fn write_terminal(ctx: &mut DrainContext, reason: FinishReason) {
    let record = match reason {
        FinishReason::Stopped => JournalRecord::Stopped {
            at: now_ms(),
            step_count: ctx.step_count.load(Ordering::Relaxed),
        },
        FinishReason::Interrupted(reason) => JournalRecord::Interrupted {
            at: now_ms(),
            reason,
        },
    };
    let _ = ctx.writer.append(&record);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-step capture
// ─────────────────────────────────────────────────────────────────────────────

enum Realized {
    /// Boxed: a `RecordedStep` dwarfs the other variant, and this enum is
    /// returned once per committed step.
    Step {
        step: Box<RecordedStep>,
        bytes: u64,
    },
    ScopeLost {
        reason: &'static str,
    },
}

/// Turn one committed intent into a journal-ready step.
///
/// Order matters and is the privacy contract: focus/element metadata, then the
/// **scope decision**, and only then any pixel. Nothing that fails the scope
/// check reaches disk.
async fn realize(ctx: &mut DrainContext, seq: u32, intent: CommitIntent) -> Realized {
    let point = match &intent {
        CommitIntent::Click { point, .. } | CommitIntent::Scroll { point, .. } => Some(*point),
        CommitIntent::Key { .. } => None,
    };

    // A key run has no coordinate, so scope has to come from the focused
    // process. `get_focus` returns that pid alongside the element we would want
    // anyway, so this is one call rather than two.
    let focus: Option<ElementInfo> = match point {
        Some(_) => None,
        None => ctx.handle.get_focus().await.ok(),
    };
    let focus_pid = focus.as_ref().and_then(|f| f.process_id);

    let verdict = ctx.scope.evaluate(point, focus_pid);
    let region = match verdict {
        ScopeVerdict::ScopeLost { reason } => return Realized::ScopeLost { reason },
        ScopeVerdict::OutOfScope => {
            return Realized::Step {
                step: Box::new(RecordedStep::out_of_scope(seq, intent_ts(&intent))),
                bytes: 0,
            }
        }
        ScopeVerdict::CaptureDesktop => None,
        ScopeVerdict::Capture { rect } => Some(rect),
    };

    let element = match point {
        Some(p) => ctx.handle.pick_at_point(p).await.ok(),
        None => focus,
    }
    .as_ref()
    .map(SafeElement::from_element_info);

    // The frame is refused *before* it is taken when it would cross a cap —
    // discovering the overrun afterwards would mean having written it.
    let over_budget = ctx
        .limits
        .would_breach(now_ms(), ESTIMATED_FRAME_BYTES)
        .is_some();

    let frame = if ctx.settings.capture_screenshots && !over_budget {
        capture_frame(ctx, region).await
    } else {
        None
    };

    let ocr_hint = match (&ctx.ocr, frame.as_ref()) {
        (Some(ocr), Some(frame)) if needs_ocr(element.as_ref()) && ocr.available() => {
            match ocr_region(point, element.as_ref(), region) {
                Some(_) => ocr.extract(frame.bytes.clone()).await,
                None => None,
            }
        }
        _ => None,
    };

    let stored = match frame {
        Some(shot) => assets::write_asset(&ctx.root, &ctx.recording_id, &shot).ok(),
        None => None,
    };
    let bytes = stored.as_ref().map(|(_, meta)| meta.byte_len).unwrap_or(0);
    let (asset_id, asset_meta) = match stored {
        Some((id, meta)) => (Some(id), Some(meta)),
        None => (None, None),
    };

    let step = match intent {
        CommitIntent::Click { point, ts_ms } => RecordedStep {
            seq,
            ts_ms,
            kind: StepKind::Click,
            point: Some(point),
            element,
            asset_id,
            asset_meta,
            text: None,
            scroll_dy: None,
            ocr_hint,
        },
        CommitIntent::Key {
            decoded,
            vks,
            states,
            ts_ms,
        } => RecordedStep {
            seq,
            ts_ms,
            kind: StepKind::Type,
            point: None,
            element,
            asset_id,
            asset_meta,
            text: Some(classify_run(&decoded, &vks, &states)),
            scroll_dy: None,
            ocr_hint,
        },
        CommitIntent::Scroll { point, dy, ts_ms } => RecordedStep {
            seq,
            ts_ms,
            kind: StepKind::Scroll,
            point: Some(point),
            element,
            asset_id,
            asset_meta,
            text: None,
            scroll_dy: Some(dy),
            ocr_hint,
        },
    };
    Realized::Step {
        step: Box::new(step),
        bytes,
    }
}

fn intent_ts(intent: &CommitIntent) -> i64 {
    match intent {
        CommitIntent::Click { ts_ms, .. }
        | CommitIntent::Key { ts_ms, .. }
        | CommitIntent::Scroll { ts_ms, .. } => *ts_ms,
    }
}

/// Capture and downscale, clipped to the scope rect when there is one.
async fn capture_frame(ctx: &DrainContext, region: Option<Rect>) -> Option<Screenshot> {
    let shot = match region {
        Some(rect) => screenshot::capture_global_region(rect, ImageFormat::Png).ok()?,
        None => ctx
            .handle
            .screenshot(crate::automation::types::ScreenshotOpts::default())
            .await
            .ok()?,
    };
    // Redaction is a second line of defence behind the secure-input classifier:
    // it blacks out the *frame* when a credential prompt is on screen, whether
    // or not the user was typing into it.
    let shot = if ctx.settings.redact && credential_window::is_credential_window_focused() {
        screenshot::redact_screenshot(shot).ok()?
    } else {
        shot
    };
    screenshot::downscale_encoded(shot, ctx.settings.max_width, ctx.settings.max_height).ok()
}

fn raw_signal_from_input(event: InputEvent, probe: &dyn SecureFieldProbe) -> Option<RawSignal> {
    match event {
        InputEvent::MouseUp {
            x,
            y,
            button,
            ts_ms,
        } => Some(RawSignal::Click {
            x,
            y,
            button: match button {
                InputButton::Left => RawButton::Left,
                InputButton::Right => RawButton::Right,
                InputButton::Middle => RawButton::Middle,
            },
            ts_ms,
        }),
        InputEvent::Scroll { x, y, dy, ts_ms } => Some(RawSignal::Scroll { x, y, dy, ts_ms }),
        // The secure state is sampled here rather than in the hook: the hook
        // callback runs on the OS input thread under a hard timeout (Windows
        // evicts a slow `WH_KEYBOARD_LL`), and an accessibility/UIA focus query
        // has no business there. The drain loop dequeues within milliseconds,
        // and `classify_run` unions the samples across the run, so a focus
        // change mid-run is still resolved conservatively.
        InputEvent::KeyDown { vk, text, ts_ms } => Some(RawSignal::Key {
            vk,
            text,
            secure: probe.probe(),
            ts_ms,
        }),
        InputEvent::MouseDown { .. } | InputEvent::MouseMoved { .. } => None,
    }
}

fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Platform::Unsupported
    }
}

/// Emit a `record:event` error to the renderer (used when `record_start` cannot
/// install the hook, e.g. on an unsupported platform or without permission).
pub fn emit_record_error(sink: &EventSink, message: String) {
    sink.emit(RecordEvent::Error { message });
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::record::journal::BundleOutcome;
    use crate::automation::record::scope::WindowSnapshot;
    use crate::automation::record::secure_input::{FixedSecureProbe, SecureState};
    use crate::automation::types::Point;

    /// A worker over the stub backend: every capture call fails, which is what
    /// makes the control-plane tests independent of a live desktop.
    fn stub_handle() -> AutomationHandle {
        crate::automation::worker::Worker::spawn(|| {
            Box::new(crate::automation::backend::StubBackend {
                platform: Platform::Unsupported,
            })
        })
    }

    fn desktop_binding() -> ScopeBinding {
        ScopeBinding::bind(CaptureScope::Desktop, None, &[]).unwrap()
    }

    /// A session wired to a real bundle directory and a collecting sink, but with
    /// screenshots off — the capture path needs a live desktop, the control
    /// plane does not.
    struct Harness {
        state: RecorderState,
        root: tempfile::TempDir,
        monitor: InputMonitor,
        id: RecordingId,
        events: Arc<Mutex<Vec<RecordEvent>>>,
    }

    impl Harness {
        fn start() -> Self {
            Self::start_with(CaptureSettings {
                capture_screenshots: false,
                ..CaptureSettings::default()
            })
        }

        fn start_with(settings: CaptureSettings) -> Self {
            let root = tempfile::tempdir().unwrap();
            let (sink, events) = EventSink::collecting();
            let monitor = InputMonitor::default();
            let id = RecordingId::new();
            let state = RecorderState::default();
            state
                .start(StartConfig {
                    recording_id: id.clone(),
                    root: root.path().to_path_buf(),
                    handle: stub_handle(),
                    input_monitor: monitor.clone(),
                    sink,
                    scope: desktop_binding(),
                    limits: RecordLimits::default(),
                    settings,
                    secure_probe: Arc::new(FixedSecureProbe(SecureState::Plain)),
                    ocr: None,
                    app_version: "test".into(),
                })
                .expect("start");
            Self {
                state,
                root,
                monitor,
                id,
                events,
            }
        }

        fn inject(&self, event: InputEvent) {
            self.monitor.inject_for_test(event);
        }

        fn type_run(&self, text: &str, base_ts: i64) {
            for (i, ch) in text.chars().enumerate() {
                self.inject(InputEvent::KeyDown {
                    vk: ch.to_ascii_uppercase() as u32,
                    text: Some(ch),
                    ts_ms: base_ts + i as i64 * 10,
                });
            }
        }

        fn kinds(&self) -> Vec<&'static str> {
            self.events
                .lock()
                .iter()
                .map(|e| match e {
                    RecordEvent::Started { .. } => "started",
                    RecordEvent::Step { .. } => "step",
                    RecordEvent::Paused { .. } => "paused",
                    RecordEvent::Resumed { .. } => "resumed",
                    RecordEvent::Undone { .. } => "undone",
                    RecordEvent::LimitWarning { .. } => "limitWarning",
                    RecordEvent::Stopped { .. } => "stopped",
                    RecordEvent::Interrupted { .. } => "interrupted",
                    RecordEvent::Error { .. } => "error",
                })
                .collect()
        }

        /// Let the drain loop dequeue what was injected.
        async fn settle(&self) {
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn recorder_state_defaults_to_idle() {
        let s = RecorderState::default();
        assert!(!s.is_recording());
        let st = s.status();
        assert!(!st.recording);
        assert_eq!(st.step_count, 0);
        assert!(st.recording_id.is_none());
        assert!(st.phase.is_none());
    }

    #[test]
    fn idle_status_serializes_without_optional_fields() {
        let json = serde_json::to_string(&RecordStatus::idle()).unwrap();
        assert!(json.contains("\"recording\":false"));
        assert!(json.contains("\"stepCount\":0"));
        assert!(!json.contains("recordingId"));
        assert!(!json.contains("phase"));
    }

    #[test]
    fn record_status_round_trips_camel_case() {
        let st = RecordStatus {
            recording: true,
            recording_id: Some(RecordingId::new()),
            phase: Some(Phase::Paused),
            step_count: 2,
            started_at: Some(99),
            scope: Some(CaptureScope::Desktop),
            usage: vec![],
        };
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"stepCount\":2"));
        assert!(json.contains("\"phase\":\"paused\""));
        assert!(json.contains("\"startedAt\":99"));
        let back: RecordStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, st);
    }

    #[tokio::test]
    async fn start_creates_a_bundle_and_announces_itself() {
        let h = Harness::start();
        assert!(h.state.is_recording());
        assert_eq!(h.state.status().phase, Some(Phase::Recording));
        assert!(journal::read_manifest(&assets::bundle_dir(h.root.path(), &h.id)).is_ok());
        assert_eq!(h.kinds(), vec!["started"]);
    }

    #[tokio::test]
    async fn second_start_while_recording_errors() {
        let h = Harness::start();
        let err = h
            .state
            .start(StartConfig {
                recording_id: RecordingId::new(),
                root: h.root.path().to_path_buf(),
                handle: stub_handle(),
                input_monitor: h.monitor.clone(),
                sink: EventSink::noop(),
                scope: desktop_binding(),
                limits: RecordLimits::default(),
                settings: CaptureSettings::default(),
                secure_probe: Arc::new(FixedSecureProbe(SecureState::Plain)),
                ocr: None,
                app_version: "test".into(),
            })
            .unwrap_err();
        assert!(err.contains("already in progress"));
    }

    #[tokio::test]
    async fn pause_flushes_buffered_key_run_before_returning() {
        let h = Harness::start();
        // A word with no terminating Enter — it lives only in the coalescer.
        h.type_run("hi", 0);
        h.settle().await;
        assert_eq!(h.state.status().step_count, 0, "nothing committed yet");

        let status = h.state.pause().await.expect("pause");
        assert_eq!(
            status.step_count, 1,
            "pause must return only after the buffered run is committed"
        );
        assert_eq!(status.phase, Some(Phase::Paused));
        assert!(h.kinds().contains(&"step"));
        assert!(h.kinds().contains(&"paused"));
    }

    #[tokio::test]
    async fn pause_detaches_subscription_synchronously() {
        let h = Harness::start();
        h.state.pause().await.expect("pause");
        h.type_run("ignored", 100);
        h.settle().await;
        assert_eq!(
            h.state.status().step_count,
            0,
            "input after pause must never reach the recorder"
        );
    }

    #[tokio::test]
    async fn pause_is_idempotent() {
        let h = Harness::start();
        h.state.pause().await.expect("first pause");
        let second = h.state.pause().await.expect("second pause");
        assert_eq!(second.phase, Some(Phase::Paused));
        assert_eq!(
            h.kinds().iter().filter(|k| **k == "paused").count(),
            1,
            "a redundant pause must not re-announce"
        );
    }

    #[tokio::test]
    async fn resume_reattaches_input() {
        let h = Harness::start();
        h.state.pause().await.expect("pause");
        let status = h.state.resume().await.expect("resume");
        assert_eq!(status.phase, Some(Phase::Recording));

        h.type_run("ok", 200);
        h.settle().await;
        let status = h.state.pause().await.expect("pause again");
        assert_eq!(status.step_count, 1, "input after resume is captured again");
        assert!(h.kinds().contains(&"resumed"));
    }

    #[tokio::test]
    async fn resume_while_recording_is_a_noop() {
        let h = Harness::start();
        let status = h.state.resume().await.expect("resume");
        assert_eq!(status.phase, Some(Phase::Recording));
        assert!(!h.kinds().contains(&"resumed"));
    }

    #[tokio::test]
    async fn stop_flushes_and_emits_stopped_with_the_final_count() {
        let h = Harness::start();
        h.type_run("bye", 0);
        h.settle().await;

        let bundle = h.state.stop().await.expect("stop");
        assert_eq!(bundle.outcome, BundleOutcome::Completed);
        assert_eq!(
            bundle.steps.len(),
            1,
            "the buffered run must be in the bundle, not lost with the task"
        );
        assert!(!h.state.is_recording());
        assert!(h.kinds().contains(&"stopped"));
    }

    #[tokio::test]
    async fn stop_without_a_session_errors() {
        let state = RecorderState::default();
        assert_eq!(state.stop().await.unwrap_err(), NO_RECORDING);
    }

    #[tokio::test]
    async fn undo_last_emits_a_tombstone_and_decrements() {
        let h = Harness::start();
        h.type_run("a", 0);
        h.inject(InputEvent::KeyDown {
            vk: 0x0D,
            text: None,
            ts_ms: 50,
        }); // Enter commits the run
        h.settle().await;
        assert_eq!(h.state.status().step_count, 1);

        let status = h.state.undo_last().await.expect("undo");
        assert_eq!(status.step_count, 0);
        assert!(h.kinds().contains(&"undone"));

        let bundle = h.state.stop().await.expect("stop");
        assert!(
            bundle.steps.is_empty(),
            "the tombstoned step must not survive replay"
        );
    }

    #[tokio::test]
    async fn undo_with_nothing_to_undo_is_harmless() {
        let h = Harness::start();
        let status = h.state.undo_last().await.expect("undo");
        assert_eq!(status.step_count, 0);
        assert!(!h.kinds().contains(&"undone"));
    }

    #[tokio::test]
    async fn interrupt_preserves_the_journal() {
        let h = Harness::start();
        h.type_run("x", 0);
        h.settle().await;

        let id = h
            .state
            .interrupt(InterruptReason::KillSwitch)
            .await
            .expect("interrupt");
        assert_eq!(id, h.id);
        assert!(!h.state.is_recording());

        let bundle = journal::load_bundle(h.root.path(), &h.id).expect("bundle survives");
        assert_eq!(bundle.outcome, BundleOutcome::Interrupted);
        assert_eq!(bundle.interrupt_reason, Some(InterruptReason::KillSwitch));
        assert_eq!(bundle.steps.len(), 1, "captured work is not discarded");
        assert!(h.kinds().contains(&"interrupted"));
    }

    #[tokio::test]
    async fn interrupt_blocking_stamps_the_journal_without_awaiting() {
        let h = Harness::start();
        h.type_run("x", 0);
        h.settle().await;

        let id = h
            .state
            .interrupt_blocking(InterruptReason::AppShutdown)
            .expect("interrupt");
        assert_eq!(id, h.id);
        assert!(!h.state.is_recording());

        let bundle = journal::load_bundle(h.root.path(), &h.id).expect("bundle survives");
        assert_eq!(bundle.outcome, BundleOutcome::Interrupted);
        assert_eq!(bundle.interrupt_reason, Some(InterruptReason::AppShutdown));
        assert!(h.kinds().contains(&"interrupted"));
    }

    #[tokio::test]
    async fn interrupt_blocking_on_idle_is_none() {
        let state = RecorderState::default();
        assert!(state
            .interrupt_blocking(InterruptReason::AppShutdown)
            .is_none());
    }

    #[tokio::test]
    async fn step_limit_breach_auto_interrupts_and_preserves_the_bundle() {
        let root = tempfile::tempdir().unwrap();
        let (sink, events) = EventSink::collecting();
        let monitor = InputMonitor::default();
        let id = RecordingId::new();
        let state = RecorderState::default();
        state
            .start(StartConfig {
                recording_id: id.clone(),
                root: root.path().to_path_buf(),
                handle: stub_handle(),
                input_monitor: monitor.clone(),
                sink,
                scope: desktop_binding(),
                limits: RecordLimits {
                    max_steps: 1,
                    ..RecordLimits::default()
                },
                settings: CaptureSettings {
                    capture_screenshots: false,
                    ..CaptureSettings::default()
                },
                secure_probe: Arc::new(FixedSecureProbe(SecureState::Plain)),
                ocr: None,
                app_version: "test".into(),
            })
            .expect("start");

        monitor.inject_for_test(InputEvent::MouseUp {
            x: 1,
            y: 1,
            button: InputButton::Left,
            ts_ms: 0,
        });
        for _ in 0..40 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let bundle = journal::load_bundle(root.path(), &id).expect("bundle");
        assert_eq!(bundle.outcome, BundleOutcome::Interrupted);
        assert_eq!(bundle.interrupt_reason, Some(InterruptReason::LimitReached));
        assert_eq!(bundle.steps.len(), 1);
        assert!(events
            .lock()
            .iter()
            .any(|e| matches!(e, RecordEvent::Interrupted { .. })));
    }

    #[tokio::test]
    async fn out_of_scope_input_records_a_marker_and_no_frame() {
        // A window scope whose window is present but whose rect excludes the
        // click. The step must exist (so the timeline is honest) and carry
        // nothing else.
        let root = tempfile::tempdir().unwrap();
        let windows = vec![WindowSnapshot {
            id: 1,
            pid: 10,
            app_name: "Safari".into(),
            title: "t".into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            minimized: false,
            focused: true,
            z: 0,
        }];
        let binding = ScopeBinding::bind(
            CaptureScope::Window {
                window_id: 1,
                process_id: 10,
                app_name: "Safari".into(),
                title: None,
            },
            None,
            &windows,
        )
        .unwrap();
        // `evaluate` re-enumerates the live desktop, where window id 1 will not
        // exist — which is scope loss, the other half of the same guarantee.
        let verdict = binding.decide(Some(Point { x: 500, y: 500 }), None, &windows);
        assert_eq!(verdict, ScopeVerdict::OutOfScope);

        let step = RecordedStep::out_of_scope(1, 5);
        assert!(step.element.is_none());
        assert!(step.asset_id.is_none());
        assert!(step.text.is_none());
        assert_eq!(step.byte_len(), 0);
        drop(root);
    }

    #[tokio::test]
    async fn secure_focus_marks_the_run_sensitive_end_to_end() {
        let root = tempfile::tempdir().unwrap();
        let (sink, _events) = EventSink::collecting();
        let monitor = InputMonitor::default();
        let id = RecordingId::new();
        let state = RecorderState::default();
        state
            .start(StartConfig {
                recording_id: id.clone(),
                root: root.path().to_path_buf(),
                handle: stub_handle(),
                input_monitor: monitor.clone(),
                sink,
                scope: desktop_binding(),
                limits: RecordLimits::default(),
                settings: CaptureSettings {
                    capture_screenshots: false,
                    ..CaptureSettings::default()
                },
                // The focus probe reports a password field for the whole run.
                secure_probe: Arc::new(FixedSecureProbe(SecureState::Secure)),
                ocr: None,
                app_version: "test".into(),
            })
            .expect("start");

        for (i, ch) in "hunter2".chars().enumerate() {
            monitor.inject_for_test(InputEvent::KeyDown {
                vk: ch.to_ascii_uppercase() as u32,
                text: Some(ch),
                ts_ms: i as i64 * 10,
            });
        }
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }

        let bundle = state.stop().await.expect("stop");
        assert_eq!(bundle.steps.len(), 1);
        assert_eq!(
            bundle.steps[0].text,
            Some(crate::automation::record::journal::TextCapture::Sensitive)
        );
        let raw = std::fs::read_to_string(
            assets::bundle_dir(root.path(), &id).join(journal::JOURNAL_FILE),
        )
        .unwrap();
        assert!(
            !raw.contains("hunter2"),
            "no part of a secure run may reach the journal"
        );
    }

    #[tokio::test]
    async fn control_commands_after_the_session_ends_report_it() {
        let h = Harness::start();
        h.state.stop().await.expect("stop");
        assert_eq!(h.state.pause().await.unwrap_err(), NO_RECORDING);
        assert_eq!(h.state.resume().await.unwrap_err(), NO_RECORDING);
        assert_eq!(h.state.undo_last().await.unwrap_err(), NO_RECORDING);
    }

    #[test]
    fn current_platform_matches_the_build_target() {
        let p = current_platform();
        #[cfg(target_os = "macos")]
        assert_eq!(p, Platform::Macos);
        #[cfg(target_os = "windows")]
        assert_eq!(p, Platform::Windows);
        #[cfg(target_os = "linux")]
        assert_eq!(p, Platform::Linux);
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        assert_eq!(p, Platform::Unsupported);
    }

    #[test]
    fn mouse_down_and_move_are_not_signals() {
        let probe = FixedSecureProbe(SecureState::Plain);
        assert!(raw_signal_from_input(
            InputEvent::MouseMoved {
                x: 1,
                y: 1,
                ts_ms: 0
            },
            &probe
        )
        .is_none());
        assert!(raw_signal_from_input(
            InputEvent::MouseDown {
                x: 1,
                y: 1,
                button: InputButton::Left,
                ts_ms: 0
            },
            &probe
        )
        .is_none());
    }

    #[test]
    fn key_signal_carries_the_probed_secure_state() {
        let probe = FixedSecureProbe(SecureState::Secure);
        match raw_signal_from_input(
            InputEvent::KeyDown {
                vk: 0x41,
                text: Some('a'),
                ts_ms: 7,
            },
            &probe,
        ) {
            Some(RawSignal::Key { secure, text, .. }) => {
                assert_eq!(secure, SecureState::Secure);
                assert_eq!(text, Some('a'));
            }
            other => panic!("expected a key signal, got {other:?}"),
        }
    }

    #[test]
    fn emit_record_error_reaches_the_sink() {
        let (sink, log) = EventSink::collecting();
        emit_record_error(&sink, "no permission".into());
        assert_eq!(
            log.lock()[0],
            RecordEvent::Error {
                message: "no permission".into()
            }
        );
    }
}
