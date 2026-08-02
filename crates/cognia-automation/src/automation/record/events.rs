//! The single `record:event` channel and the sink that carries it.
//!
//! Every payload here is derived from journal types, which is what makes the
//! privacy property checkable in one place: [`RecordedStep`] holds an
//! [`AssetId`] rather than bytes and a [`SafeElement`] rather than an
//! `ElementInfo`, so an event physically cannot carry a screenshot or a live
//! backend handle. `no_event_variant_leaks_bytes_or_paths` pins that.
//!
//! [`EventSink`] exists so the session does not have to be generic over
//! `tauri::Runtime`. Two things fall out of that, both load-bearing:
//!
//! - The drain loop becomes unit-testable — `EventSink::collecting()` swaps a
//!   `Vec` in for the real emitter, and the pause/stop/undo flush behaviour can
//!   finally be asserted rather than reasoned about.
//! - `RecorderState::interrupt_blocking` needs no `AppHandle`, which is what
//!   lets the shared kill-switch helper stay generic over `R` without infecting
//!   the session type.

use std::sync::Arc;

use serde::Serialize;

use super::assets::RecordingId;
use super::journal::{InterruptReason, RecordedStep};
use super::limits::{LimitUsage, RecordLimits};
use super::scope::CaptureScope;

pub const RECORD_EVENT: &str = "record:event";

/// Live recorder event. Mirrored on the TS side by
/// `lib/skills/recording/recorder-client.ts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecordEvent {
    Started {
        recording_id: RecordingId,
        started_at: i64,
        scope: CaptureScope,
        limits: RecordLimits,
    },
    Step {
        step: RecordedStep,
    },
    Paused {
        at: i64,
        step_count: u32,
    },
    Resumed {
        at: i64,
    },
    Undone {
        seq: u32,
        step_count: u32,
    },
    LimitWarning {
        usage: LimitUsage,
    },
    Stopped {
        recording_id: RecordingId,
        step_count: u32,
        ended_at: i64,
        total_bytes: u64,
    },
    /// The session ended without the user asking. `recoverable` is always true
    /// today — the journal is preserved on every interrupt path — but it is on
    /// the wire so the renderer never has to assume.
    Interrupted {
        recording_id: RecordingId,
        reason: InterruptReason,
        step_count: u32,
        recoverable: bool,
    },
    Error {
        message: String,
    },
}

/// Type-erased emitter. Built once at session start from the concrete
/// `AppHandle`.
#[derive(Clone)]
pub struct EventSink(Arc<dyn Fn(RecordEvent) + Send + Sync>);

impl EventSink {
    pub fn tauri<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Self {
        use tauri::Emitter;
        Self(Arc::new(move |event| {
            let _ = app.emit(RECORD_EVENT, &event);
        }))
    }

    /// A sink that drops everything. Used where a session is constructed for a
    /// path that has no renderer to talk to.
    pub fn noop() -> Self {
        Self(Arc::new(|_| {}))
    }

    #[cfg(test)]
    pub fn collecting() -> (Self, Arc<parking_lot::Mutex<Vec<RecordEvent>>>) {
        let log = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink_log = log.clone();
        (
            Self(Arc::new(move |event| sink_log.lock().push(event))),
            log,
        )
    }

    pub fn emit(&self, event: RecordEvent) {
        (self.0)(event)
    }
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventSink")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::record::assets::{AssetId, AssetMeta};
    use crate::automation::record::journal::{SafeElement, StepKind, TextCapture};
    use crate::automation::record::limits::LimitKind;
    use crate::automation::types::{ImageFormat, Point, Rect};

    fn maximal_step() -> RecordedStep {
        RecordedStep {
            seq: 1,
            ts_ms: 2,
            kind: StepKind::Click,
            point: Some(Point { x: 3, y: 4 }),
            element: Some(SafeElement {
                name: Some("Save".into()),
                control_type: Some("Button".into()),
                automation_id: Some("btnSave".into()),
                app_name: Some("Safari".into()),
                window_title: Some("Invoices".into()),
                bounds: Some(Rect {
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                }),
            }),
            asset_id: Some(AssetId::new()),
            asset_meta: Some(AssetMeta {
                width: 10,
                height: 10,
                byte_len: 1234,
                format: ImageFormat::Png,
                captured_at: 5,
            }),
            text: Some(TextCapture::Text {
                value: "hello".into(),
            }),
            scroll_dy: Some(-3),
            ocr_hint: Some("Submit order".into()),
        }
    }

    fn every_variant() -> Vec<RecordEvent> {
        let id = RecordingId::new();
        vec![
            RecordEvent::Started {
                recording_id: id.clone(),
                started_at: 1,
                scope: CaptureScope::Desktop,
                limits: RecordLimits::default(),
            },
            RecordEvent::Step {
                step: maximal_step(),
            },
            RecordEvent::Paused {
                at: 2,
                step_count: 1,
            },
            RecordEvent::Resumed { at: 3 },
            RecordEvent::Undone {
                seq: 1,
                step_count: 0,
            },
            RecordEvent::LimitWarning {
                usage: LimitUsage {
                    kind: LimitKind::BundleBytes,
                    used: 8,
                    limit: 10,
                },
            },
            RecordEvent::Stopped {
                recording_id: id.clone(),
                step_count: 1,
                ended_at: 9,
                total_bytes: 4096,
            },
            RecordEvent::Interrupted {
                recording_id: id,
                reason: InterruptReason::KillSwitch,
                step_count: 1,
                recoverable: true,
            },
            RecordEvent::Error {
                message: "hook install failed".into(),
            },
        ]
    }

    #[test]
    fn record_event_serializes_camel_case_tagged() {
        let tags: Vec<String> = every_variant()
            .iter()
            .map(|e| {
                let value: serde_json::Value = serde_json::to_value(e).unwrap();
                value["type"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(
            tags,
            vec![
                "started",
                "step",
                "paused",
                "resumed",
                "undone",
                "limitWarning",
                "stopped",
                "interrupted",
                "error",
            ]
        );
    }

    #[test]
    fn record_event_fields_are_camel_case() {
        let json = serde_json::to_string(&RecordEvent::Stopped {
            recording_id: RecordingId::new(),
            step_count: 2,
            ended_at: 3,
            total_bytes: 4,
        })
        .unwrap();
        assert!(json.contains("\"recordingId\""));
        assert!(json.contains("\"stepCount\":2"));
        assert!(json.contains("\"endedAt\":3"));
        assert!(json.contains("\"totalBytes\":4"));
    }

    #[test]
    fn no_event_variant_leaks_bytes_or_paths() {
        for event in every_variant() {
            let json = serde_json::to_string(&event).unwrap();
            assert!(
                !json.contains("\"bytes\""),
                "no event may carry image bytes: {json}"
            );
            assert!(
                !json.contains("\"path\""),
                "no event may carry a filesystem path: {json}"
            );
            assert!(
                !json.contains("elementRef"),
                "no event may carry a live backend handle: {json}"
            );
            assert!(!json.contains("/Users"), "{json}");
            assert!(!json.contains("C:\\"), "{json}");
            assert!(
                !json.contains(".png") && !json.contains(".jpg"),
                "assets travel as opaque ids, not filenames: {json}"
            );
        }
    }

    #[test]
    fn step_event_carries_an_asset_id_not_a_frame() {
        let json = serde_json::to_value(&RecordEvent::Step {
            step: maximal_step(),
        })
        .unwrap();
        let asset = json["step"]["assetId"].as_str().expect("assetId present");
        assert_eq!(asset.len(), 36, "an asset id is a bare uuid");
        assert!(json["step"]["assetMeta"]["byteLen"].as_u64() == Some(1234));
    }

    #[test]
    fn event_sink_collecting_captures_in_order() {
        let (sink, log) = EventSink::collecting();
        sink.emit(RecordEvent::Resumed { at: 1 });
        sink.emit(RecordEvent::Resumed { at: 2 });
        let seen = log.lock();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], RecordEvent::Resumed { at: 1 });
        assert_eq!(seen[1], RecordEvent::Resumed { at: 2 });
    }

    #[test]
    fn cloned_sinks_share_one_log() {
        let (sink, log) = EventSink::collecting();
        let clone = sink.clone();
        clone.emit(RecordEvent::Resumed { at: 7 });
        assert_eq!(log.lock().len(), 1);
    }

    #[test]
    fn noop_sink_swallows_events() {
        EventSink::noop().emit(RecordEvent::Error {
            message: "ignored".into(),
        });
    }

    #[test]
    fn event_sink_is_debug_without_leaking_state() {
        assert_eq!(format!("{:?}", EventSink::noop()), "EventSink");
    }

    #[test]
    fn record_event_channel_name_is_stable() {
        // The TS listener keys on this exact string.
        assert_eq!(RECORD_EVENT, "record:event");
    }
}
