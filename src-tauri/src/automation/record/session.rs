//! Record-and-replay skill recorder — session manager + coalescing reducer.
//!
//! This module is platform-agnostic. The only platform-specific piece is the
//! global input hook (`hook_win` / `hook_mac` / `hook_stub`), which feeds a stream of coarse
//! `RawSignal`s into the async drain loop here. The drain loop coalesces rapid
//! signals (double-clicks, key runs, scroll bursts) into `Observation`s, and for
//! each surviving observation captures a screenshot + the accessibility element
//! under the cursor by reusing the existing automation worker
//! (`AutomationHandle::screenshot` / `::pick_at_point`).
//!
//! Recording is *observational* — it captures "what the user did" coarsely so an
//! LLM can synthesize a natural-language skill. It is NOT a high-fidelity event
//! recorder for deterministic replay; replay is agentic via the computer-use
//! tools.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::engine::general_purpose;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::Receiver;

use super::HookGuard;
use crate::automation::platform::shared::{credential_window, screenshot};
use crate::automation::types::{
    ElementInfo, ImageFormat, MonitorInfo, Point, Screenshot, ScreenshotOpts,
};
use crate::automation::worker::AutomationHandle;

/// Rapid clicks closer together than this (in ms) AND within
/// `CLICK_COALESCE_PX` are treated as one observation (double/triple-click).
const CLICK_COALESCE_MS: i64 = 400;
const CLICK_COALESCE_PX: i32 = 6;
/// A run of key presses with inter-key gaps under this many ms collapses into a
/// single "typed text" observation. The run also commits on a non-key signal,
/// an idle timeout, or an Enter/Tab key.
const KEY_IDLE_MS: i64 = 800;
/// Consecutive scroll signals within this many ms accumulate into one
/// observation whose `scroll_dy` is the summed delta.
const SCROLL_COALESCE_MS: i64 = 600;
/// Default capture downscale bounds — recording always downscales so the
/// inline base64 frames returned over IPC stay small.
pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const DEFAULT_MAX_HEIGHT: u32 = 800;

// ─────────────────────────────────────────────────────────────────────────────
// Raw signal — what the platform hook emits. Kept minimal so the hook callback
// does near-zero work (it must return well under the LowLevelHooksTimeout).
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawSignal {
    Click {
        x: i32,
        y: i32,
        button: RawButton,
        ts_ms: i64,
    },
    Scroll {
        x: i32,
        y: i32,
        dy: i32,
        ts_ms: i64,
    },
    Key {
        vk: u32,
        ts_ms: i64,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation — the coalesced, screenshot-enriched step the trace is made of.
// serde camelCase to match the TS mirror in `lib/skills/recording/types.ts`.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationKind {
    Click,
    Key,
    Scroll,
}

/// Where a screenshot lives. `Inline` carries base64 bytes (default — the TS
/// side needs them to attach screenshots as skill resources). `File` references
/// a temp file written to disk (opt-in via `record_start` for self-contained /
/// headless traces, avoiding a multi-MB IPC reply).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScreenshotRef {
    Inline {
        shot: Screenshot,
    },
    File {
        path: String,
        width: u32,
        height: u32,
        captured_at: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub seq: u32,
    pub ts_ms: i64,
    pub kind: ObservationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ElementInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ScreenshotRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_dy: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTrace {
    pub session_id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub observations: Vec<Observation>,
    pub monitors: Vec<MonitorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatus {
    pub recording: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub step_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Coalescing reducer — pure, fully unit-tested. Drives the async drain loop.
// ─────────────────────────────────────────────────────────────────────────────

/// What the reducer decides to commit as a single observation.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CommitIntent {
    Click {
        point: Point,
        ts_ms: i64,
    },
    Key {
        text_hint: Option<String>,
        ts_ms: i64,
    },
    Scroll {
        point: Point,
        dy: i32,
        ts_ms: i64,
    },
}

#[derive(Default)]
pub(crate) struct CoalesceState {
    keys: Vec<u32>,
    keys_first_ts: i64,
    keys_last_ts: i64,
    last_click: Option<(i32, i32, RawButton, i64)>,
    scroll: Option<(i32, i32, i32, i64)>, // x, y, accumulated dy, last ts
}

impl CoalesceState {
    /// Fold one raw signal into the running state, returning any observations
    /// that became final as a result. Usually 0 or 1; occasionally 2 (e.g. a
    /// click that flushes a pending key run first).
    pub(crate) fn fold(&mut self, sig: RawSignal) -> Vec<CommitIntent> {
        let mut out = Vec::new();
        match sig {
            RawSignal::Click {
                x,
                y,
                button,
                ts_ms,
            } => {
                self.flush_keys(&mut out);
                self.flush_scroll(&mut out);
                if let Some((lx, ly, lb, lts)) = self.last_click {
                    let close = (ts_ms - lts) <= CLICK_COALESCE_MS
                        && (x - lx).abs() <= CLICK_COALESCE_PX
                        && (y - ly).abs() <= CLICK_COALESCE_PX
                        && lb == button;
                    if close {
                        // Absorb the repeat into the existing click observation.
                        self.last_click = Some((x, y, button, ts_ms));
                        return out;
                    }
                }
                self.last_click = Some((x, y, button, ts_ms));
                out.push(CommitIntent::Click {
                    point: Point { x, y },
                    ts_ms,
                });
            }
            RawSignal::Key { vk, ts_ms } => {
                self.flush_scroll(&mut out);
                if self.keys.is_empty() {
                    self.keys_first_ts = ts_ms;
                }
                self.keys.push(vk);
                self.keys_last_ts = ts_ms;
                if is_commit_key(vk) {
                    self.flush_keys(&mut out);
                }
            }
            RawSignal::Scroll { x, y, dy, ts_ms } => {
                self.flush_keys(&mut out);
                match self.scroll.take() {
                    Some((_sx, _sy, sdy, sts)) if (ts_ms - sts) <= SCROLL_COALESCE_MS => {
                        self.scroll = Some((x, y, sdy + dy, ts_ms));
                    }
                    Some((sx, sy, sdy, sts)) => {
                        out.push(CommitIntent::Scroll {
                            point: Point { x: sx, y: sy },
                            dy: sdy,
                            ts_ms: sts,
                        });
                        self.scroll = Some((x, y, dy, ts_ms));
                    }
                    None => {
                        self.scroll = Some((x, y, dy, ts_ms));
                    }
                }
            }
        }
        out
    }

    /// Commit anything still buffered (key run / scroll burst). Called on idle
    /// timeout and at session stop.
    pub(crate) fn flush(&mut self) -> Vec<CommitIntent> {
        let mut out = Vec::new();
        self.flush_keys(&mut out);
        self.flush_scroll(&mut out);
        out
    }

    fn flush_keys(&mut self, out: &mut Vec<CommitIntent>) {
        if self.keys.is_empty() {
            return;
        }
        let text_hint = keys_to_hint(&self.keys);
        let ts_ms = self.keys_first_ts;
        self.keys.clear();
        out.push(CommitIntent::Key { text_hint, ts_ms });
    }

    fn flush_scroll(&mut self, out: &mut Vec<CommitIntent>) {
        if let Some((x, y, dy, ts_ms)) = self.scroll.take() {
            out.push(CommitIntent::Scroll {
                point: Point { x, y },
                dy,
                ts_ms,
            });
        }
    }
}

/// Enter / Tab commit a key run immediately (they usually mean "submit" /
/// "next field" — a natural boundary in a workflow).
fn is_commit_key(vk: u32) -> bool {
    const VK_TAB: u32 = 0x09;
    const VK_RETURN: u32 = 0x0D;
    vk == VK_TAB || vk == VK_RETURN
}

/// Lossy reconstruction of a printable string from virtual-key codes. No shift
/// state is tracked, so letters come back uppercase — this is a *hint* for the
/// LLM, explicitly labeled as such, not an exact transcript. Non-printable keys
/// are dropped.
fn keys_to_hint(vks: &[u32]) -> Option<String> {
    let mut s = String::new();
    for &vk in vks {
        if let Some(c) = vk_to_char(vk) {
            s.push(c);
        }
    }
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn vk_to_char(vk: u32) -> Option<char> {
    match vk {
        0x30..=0x39 => char::from_u32(vk), // '0'-'9'
        0x41..=0x5A => char::from_u32(vk), // 'A'-'Z'
        0x20 => Some(' '),                 // VK_SPACE
        _ => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot persistence.
// ─────────────────────────────────────────────────────────────────────────────

/// File name for a per-step screenshot. Pure (no I/O) so it is unit-testable.
pub(crate) fn screenshot_file_name(seq: u32, format: ImageFormat) -> String {
    let ext = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
    };
    format!("{seq:03}.{ext}")
}

/// Turn a captured screenshot into a `ScreenshotRef`. With `inline` (or no temp
/// dir) it stays as base64 in memory; otherwise it's written to the session temp
/// dir and referenced by path. A write failure falls back to inline so a step is
/// never silently lost.
pub(crate) fn persist_screenshot(
    shot: Screenshot,
    inline: bool,
    dir: Option<&Path>,
    seq: u32,
) -> ScreenshotRef {
    let dir = match (inline, dir) {
        (true, _) | (false, None) => return ScreenshotRef::Inline { shot },
        (false, Some(d)) => d,
    };
    match general_purpose::STANDARD.decode(shot.bytes.as_bytes()) {
        Ok(raw) => {
            let path = dir.join(screenshot_file_name(seq, shot.format));
            if std::fs::write(&path, &raw).is_ok() {
                ScreenshotRef::File {
                    path: path.to_string_lossy().into_owned(),
                    width: shot.width,
                    height: shot.height,
                    captured_at: shot.captured_at,
                }
            } else {
                ScreenshotRef::Inline { shot }
            }
        }
        Err(_) => ScreenshotRef::Inline { shot },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture settings snapshot — taken at session start so mid-session settings
// changes don't half-apply.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) struct CaptureSettings {
    pub redact: bool,
    pub max_width: u32,
    pub max_height: u32,
    pub inline: bool,
}

async fn capture_screenshot(
    handle: &AutomationHandle,
    settings: &CaptureSettings,
) -> Option<Screenshot> {
    let shot = handle.screenshot(ScreenshotOpts::default()).await.ok()?;
    let shot = if settings.redact && credential_window::is_credential_window_focused() {
        screenshot::redact_screenshot(shot).ok()?
    } else {
        shot
    };
    screenshot::downscale_encoded(shot, settings.max_width, settings.max_height).ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state.
// ─────────────────────────────────────────────────────────────────────────────

struct ActiveSession {
    session_id: String,
    started_at: i64,
    observations: Arc<Mutex<Vec<Observation>>>,
    monitors: Vec<MonitorInfo>,
    temp_dir: Option<PathBuf>,
    /// Owns the native input-hook thread; dropping it ends the message pump and
    /// unhooks. Kept even though never read directly (drop-on-take is the point).
    _hook: HookGuard,
    drain: tokio::task::JoinHandle<()>,
}

/// Shared recorder state, held in `AutomationState`. Cheap to clone.
#[derive(Clone, Default)]
pub struct RecorderState {
    inner: Arc<Mutex<Option<ActiveSession>>>,
}

impl RecorderState {
    pub fn is_recording(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub fn status(&self) -> RecordStatus {
        match self.inner.lock().as_ref() {
            Some(s) => RecordStatus {
                recording: true,
                session_id: Some(s.session_id.clone()),
                step_count: s.observations.lock().len() as u32,
                started_at: Some(s.started_at),
            },
            None => RecordStatus {
                recording: false,
                session_id: None,
                step_count: 0,
                started_at: None,
            },
        }
    }

    /// Install the input hook + spawn the drain loop. Returns an error string if
    /// already recording or the hook can't be installed (unsupported platform).
    pub(crate) fn start(
        &self,
        app: AppHandle,
        handle: AutomationHandle,
        settings: CaptureSettings,
        session_id: String,
        temp_dir: Option<PathBuf>,
    ) -> Result<RecordStatus, String> {
        if self.is_recording() {
            return Err("a recording is already in progress".into());
        }
        let monitors = screenshot::list_monitors();
        let observations: Arc<Mutex<Vec<Observation>>> = Arc::new(Mutex::new(Vec::new()));
        let started_at = now_ms();

        // Bounded channel: the hook only `try_send`s, so a backed-up consumer
        // drops the oldest noise rather than blocking the input chain.
        let (tx, rx) = tokio::sync::mpsc::channel::<RawSignal>(256);
        let hook = HookGuard::install(tx)?;

        if let Some(dir) = temp_dir.as_ref() {
            let _ = std::fs::create_dir_all(dir);
        }

        let drain = tokio::spawn(drain_loop(
            app.clone(),
            handle,
            rx,
            observations.clone(),
            settings,
            temp_dir.clone(),
        ));

        *self.inner.lock() = Some(ActiveSession {
            session_id: session_id.clone(),
            started_at,
            observations,
            monitors,
            temp_dir,
            _hook: hook,
            drain,
        });

        let _ = app.emit(
            "record:event",
            &RecordEvent::Started {
                session_id: session_id.clone(),
                started_at,
            },
        );

        Ok(RecordStatus {
            recording: true,
            session_id: Some(session_id),
            step_count: 0,
            started_at: Some(started_at),
        })
    }

    /// Stop recording and return the captured trace. Returns `None` when no
    /// session is active.
    pub fn stop(&self, app: &AppHandle) -> Option<RecordingTrace> {
        let session = self.inner.lock().take()?;
        session.drain.abort();
        // Dropping the hook ends the pump + joins the hook thread.
        let observations = session.observations.lock().clone();
        let ended_at = now_ms();
        let step_count = observations.len() as u32;
        let trace = RecordingTrace {
            session_id: session.session_id.clone(),
            started_at: session.started_at,
            ended_at,
            observations,
            monitors: session.monitors.clone(),
        };
        let _ = app.emit("record:event", &RecordEvent::Stopped { step_count });
        Some(trace)
    }

    /// Cancel recording, discarding the trace and any temp screenshots.
    pub fn cancel(&self, app: &AppHandle) {
        if let Some(session) = self.inner.lock().take() {
            session.drain.abort();
            if let Some(dir) = session.temp_dir.as_ref() {
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = app.emit("record:event", &RecordEvent::Cancelled);
        }
    }
}

/// Drain raw signals → coalesced observations, enriching each with a screenshot
/// and the element under the cursor. Runs until the channel closes (hook
/// dropped) or the task is aborted (stop / cancel).
async fn drain_loop(
    app: AppHandle,
    handle: AutomationHandle,
    mut rx: Receiver<RawSignal>,
    observations: Arc<Mutex<Vec<Observation>>>,
    settings: CaptureSettings,
    temp_dir: Option<PathBuf>,
) {
    let mut coalesce = CoalesceState::default();
    let mut seq: u32 = 0;
    let idle = std::time::Duration::from_millis(KEY_IDLE_MS as u64);
    loop {
        let intents = match tokio::time::timeout(idle, rx.recv()).await {
            Ok(Some(sig)) => coalesce.fold(sig),
            Ok(None) => break,          // channel closed — hook dropped
            Err(_) => coalesce.flush(), // idle timeout — commit buffered run
        };
        for intent in intents {
            seq += 1;
            let obs = realize(&handle, &settings, temp_dir.as_deref(), seq, intent).await;
            observations.lock().push(obs.clone());
            let _ = app.emit("record:event", &RecordEvent::Step { observation: obs });
        }
    }
    // Final flush for anything buffered when the channel closed.
    for intent in coalesce.flush() {
        seq += 1;
        let obs = realize(&handle, &settings, temp_dir.as_deref(), seq, intent).await;
        observations.lock().push(obs.clone());
        let _ = app.emit("record:event", &RecordEvent::Step { observation: obs });
    }
}

/// Enrich a commit intent into a full observation (screenshot + element).
async fn realize(
    handle: &AutomationHandle,
    settings: &CaptureSettings,
    temp_dir: Option<&Path>,
    seq: u32,
    intent: CommitIntent,
) -> Observation {
    let point = match &intent {
        CommitIntent::Click { point, .. } | CommitIntent::Scroll { point, .. } => Some(*point),
        CommitIntent::Key { .. } => None,
    };
    let element = match point {
        Some(p) => handle.pick_at_point(p).await.ok(),
        None => handle.get_focus().await.ok(),
    };
    let screenshot = capture_screenshot(handle, settings)
        .await
        .map(|shot| persist_screenshot(shot, settings.inline, temp_dir, seq));

    match intent {
        CommitIntent::Click { point, ts_ms } => Observation {
            seq,
            ts_ms,
            kind: ObservationKind::Click,
            point: Some(point),
            element,
            screenshot,
            text_hint: None,
            scroll_dy: None,
        },
        CommitIntent::Key { text_hint, ts_ms } => Observation {
            seq,
            ts_ms,
            kind: ObservationKind::Key,
            point: None,
            element,
            screenshot,
            text_hint,
            scroll_dy: None,
        },
        CommitIntent::Scroll { point, dy, ts_ms } => Observation {
            seq,
            ts_ms,
            kind: ObservationKind::Scroll,
            point: Some(point),
            element,
            screenshot,
            text_hint: None,
            scroll_dy: Some(dy),
        },
    }
}

/// Emit a `record:event` error to the renderer (used when `record_start` can't
/// install the hook, e.g. on an unsupported platform).
pub fn emit_record_error(app: &AppHandle, message: String) {
    let _ = app.emit("record:event", &RecordEvent::Error { message });
}

/// Live progress event. Mirrored on the TS side by `record:event` listeners.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum RecordEvent {
    Started { session_id: String, started_at: i64 },
    Step { observation: Observation },
    Stopped { step_count: u32 },
    Cancelled,
    Error { message: String },
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(x: i32, y: i32, ts: i64) -> RawSignal {
        RawSignal::Click {
            x,
            y,
            button: RawButton::Left,
            ts_ms: ts,
        }
    }
    fn key(vk: u32, ts: i64) -> RawSignal {
        RawSignal::Key { vk, ts_ms: ts }
    }
    fn scroll(dy: i32, ts: i64) -> RawSignal {
        RawSignal::Scroll {
            x: 10,
            y: 10,
            dy,
            ts_ms: ts,
        }
    }

    #[test]
    fn double_click_coalesces_to_one() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(102, 101, 50)));
        let clicks = out
            .iter()
            .filter(|i| matches!(i, CommitIntent::Click { .. }))
            .count();
        assert_eq!(clicks, 1, "rapid clicks within window+px must collapse");
    }

    #[test]
    fn separated_clicks_are_two() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(100, 100, 600)));
        let clicks = out
            .iter()
            .filter(|i| matches!(i, CommitIntent::Click { .. }))
            .count();
        assert_eq!(clicks, 2, "clicks beyond the window are distinct");
    }

    #[test]
    fn far_apart_clicks_are_two() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(400, 400, 50)));
        let clicks = out
            .iter()
            .filter(|i| matches!(i, CommitIntent::Click { .. }))
            .count();
        assert_eq!(clicks, 2, "clicks far apart in space are distinct");
    }

    #[test]
    fn key_run_collapses_to_single_hint() {
        let mut c = CoalesceState::default();
        // H E L L O within the idle window.
        for (i, vk) in [0x48u32, 0x45, 0x4C, 0x4C, 0x4F].iter().enumerate() {
            let out = c.fold(key(*vk, i as i64 * 100));
            assert!(out.is_empty(), "key run must not commit mid-stream");
        }
        let out = c.flush();
        assert_eq!(out.len(), 1);
        match &out[0] {
            CommitIntent::Key { text_hint, .. } => {
                assert_eq!(text_hint.as_deref(), Some("HELLO"));
            }
            other => panic!("expected key commit, got {other:?}"),
        }
    }

    #[test]
    fn enter_commits_key_run_immediately() {
        let mut c = CoalesceState::default();
        c.fold(key(0x48, 0)); // H
        let out = c.fold(key(0x0D, 50)); // Enter
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], CommitIntent::Key { .. }));
    }

    #[test]
    fn click_flushes_pending_key_run_first() {
        let mut c = CoalesceState::default();
        c.fold(key(0x41, 0)); // A
        let out = c.fold(click(50, 50, 100));
        assert_eq!(out.len(), 2, "key run commits, then the click");
        assert!(matches!(out[0], CommitIntent::Key { .. }));
        assert!(matches!(out[1], CommitIntent::Click { .. }));
    }

    #[test]
    fn scroll_burst_sums_dy() {
        let mut c = CoalesceState::default();
        assert!(c.fold(scroll(120, 0)).is_empty());
        assert!(c.fold(scroll(120, 100)).is_empty());
        assert!(c.fold(scroll(-60, 200)).is_empty());
        let out = c.flush();
        assert_eq!(out.len(), 1);
        match &out[0] {
            CommitIntent::Scroll { dy, .. } => assert_eq!(*dy, 180),
            other => panic!("expected scroll commit, got {other:?}"),
        }
    }

    #[test]
    fn vk_to_char_maps_printables_only() {
        assert_eq!(vk_to_char(0x41), Some('A'));
        assert_eq!(vk_to_char(0x39), Some('9'));
        assert_eq!(vk_to_char(0x20), Some(' '));
        assert_eq!(vk_to_char(0x0D), None); // Enter is not printable
    }

    #[test]
    fn keys_to_hint_drops_non_printables() {
        // Shift (0x10) + H + I → "HI".
        assert_eq!(keys_to_hint(&[0x10, 0x48, 0x49]).as_deref(), Some("HI"));
        assert_eq!(keys_to_hint(&[0x10, 0x11]), None);
    }

    #[test]
    fn screenshot_file_name_uses_format_extension() {
        assert_eq!(screenshot_file_name(1, ImageFormat::Png), "001.png");
        assert_eq!(screenshot_file_name(42, ImageFormat::Jpeg), "042.jpg");
    }

    #[test]
    fn persist_screenshot_inline_skips_io() {
        let shot = Screenshot {
            bytes: "abc".into(),
            width: 4,
            height: 4,
            captured_at: 1,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        };
        let r = persist_screenshot(shot, true, None, 1);
        assert!(matches!(r, ScreenshotRef::Inline { .. }));
    }

    #[test]
    fn persist_screenshot_no_dir_falls_back_inline() {
        let shot = Screenshot {
            bytes: "abc".into(),
            width: 4,
            height: 4,
            captured_at: 1,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        };
        let r = persist_screenshot(shot, false, None, 1);
        assert!(matches!(r, ScreenshotRef::Inline { .. }));
    }

    #[test]
    fn recorder_state_defaults_to_idle() {
        let s = RecorderState::default();
        assert!(!s.is_recording());
        let st = s.status();
        assert!(!st.recording);
        assert_eq!(st.step_count, 0);
        assert!(st.session_id.is_none());
    }

    #[test]
    fn stop_and_cancel_on_idle_are_noops() {
        // We can't construct an AppHandle in a unit test; assert the idle
        // guard short-circuits before any emit by checking `take()` returns
        // None via `is_recording`/`status`. Calling stop/cancel would need an
        // AppHandle, so we only assert the state-side invariant here.
        let s = RecorderState::default();
        assert!(!s.is_recording());
        // A second clone observes the same (empty) inner.
        let s2 = s.clone();
        assert!(!s2.is_recording());
    }

    #[test]
    fn observation_serializes_camel_case() {
        let obs = Observation {
            seq: 3,
            ts_ms: 123,
            kind: ObservationKind::Click,
            point: Some(Point { x: 5, y: 6 }),
            element: None,
            screenshot: None,
            text_hint: None,
            scroll_dy: None,
        };
        let json = serde_json::to_string(&obs).unwrap();
        assert!(json.contains("\"tsMs\":123"));
        assert!(json.contains("\"kind\":\"click\""));
        // None fields are skipped.
        assert!(!json.contains("textHint"));
    }

    #[test]
    fn record_status_round_trips_camel_case() {
        let st = RecordStatus {
            recording: true,
            session_id: Some("s1".into()),
            step_count: 2,
            started_at: Some(99),
        };
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"stepCount\":2"));
        assert!(json.contains("\"sessionId\":\"s1\""));
        let back: RecordStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, st);
    }

    #[test]
    fn screenshot_ref_variants_serialize_tagged() {
        let inline = ScreenshotRef::Inline {
            shot: Screenshot {
                bytes: "x".into(),
                width: 1,
                height: 1,
                captured_at: 0,
                format: ImageFormat::Png,
                source_width: None,
                source_height: None,
            },
        };
        let file = ScreenshotRef::File {
            path: "c:/tmp/1.png".into(),
            width: 2,
            height: 2,
            captured_at: 0,
        };
        assert!(serde_json::to_string(&inline)
            .unwrap()
            .contains("\"kind\":\"inline\""));
        let file_json = serde_json::to_string(&file).unwrap();
        assert!(file_json.contains("\"kind\":\"file\""));
        assert!(file_json.contains("capturedAt"));
    }

    #[test]
    fn recording_trace_round_trips() {
        let trace = RecordingTrace {
            session_id: "s".into(),
            started_at: 1,
            ended_at: 2,
            observations: vec![],
            monitors: vec![],
        };
        let json = serde_json::to_string(&trace).unwrap();
        assert!(json.contains("\"startedAt\":1"));
        let back: RecordingTrace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.session_id, "s");
        assert_eq!(back.ended_at, 2);
    }
}
