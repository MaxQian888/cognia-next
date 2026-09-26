//! Where the automation stack's renderer events go (ADR-0196).
//!
//! The worker, the dispatcher's audit rows, consent prompts, the kill switch,
//! the virtual display and the UIA watcher all tell the renderer something
//! happened. They used to call `tauri::Emitter::emit` on an `AppHandle`, which
//! linked Tauri into every build of this crate. They now emit through
//! [`AutomationEventSink`]; the desktop's `AppHandle` is one implementation.
//!
//! [`AppHandle`] keeps the `Option<AppHandle>` / `Option<&AppHandle>`
//! parameters the app passes compiling unchanged. With `tauri-host` it is
//! Tauri's handle. Without it, it is a type with no values, so those options
//! are always `None` and nothing is emitted, which is what a caller that
//! passes `None` gets today.

use serde::Serialize;

/// Receives one renderer event whose payload is already JSON.
pub trait AutomationEventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: String) -> Result<(), String>;
}

/// Serialize `payload` and hand it to `sink` as `event`.
///
/// The JSON is exactly what `tauri::Emitter::emit` would have produced:
/// `emit` runs `serde_json::to_string` on the payload and then takes the same
/// path as the `emit_str` the Tauri implementation calls.
pub fn emit<S: Serialize + ?Sized>(
    sink: &(impl AutomationEventSink + ?Sized),
    event: &str,
    payload: &S,
) -> Result<(), String> {
    let json = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    sink.emit_json(event, json)
}

/// A borrowed sink is a sink, so a caller holding `&AppHandle` can pass it
/// without cloning the handle.
impl<T: AutomationEventSink + ?Sized> AutomationEventSink for &T {
    fn emit_json(&self, event: &str, payload: String) -> Result<(), String> {
        (**self).emit_json(event, payload)
    }
}

#[cfg(feature = "tauri-host")]
pub type AppHandle = tauri::AppHandle;

/// Built without `tauri-host` there is no renderer to address, so this handle
/// has no values. See the module docs.
#[cfg(not(feature = "tauri-host"))]
#[derive(Debug, Clone, Copy)]
pub enum AppHandle {}

#[cfg(feature = "tauri-host")]
impl<R: tauri::Runtime> AutomationEventSink for tauri::AppHandle<R> {
    fn emit_json(&self, event: &str, payload: String) -> Result<(), String> {
        tauri::Emitter::emit_str(self, event, payload).map_err(|error| error.to_string())
    }
}

#[cfg(not(feature = "tauri-host"))]
impl AutomationEventSink for AppHandle {
    fn emit_json(&self, _event: &str, _payload: String) -> Result<(), String> {
        match *self {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[derive(Default)]
    struct Capture(Mutex<Vec<(String, String)>>);

    impl AutomationEventSink for Capture {
        fn emit_json(&self, event: &str, payload: String) -> Result<(), String> {
            self.0.lock().push((event.to_string(), payload));
            Ok(())
        }
    }

    struct Refuses;

    impl AutomationEventSink for Refuses {
        fn emit_json(&self, _event: &str, _payload: String) -> Result<(), String> {
            Err("renderer gone".into())
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        panic_message: &'static str,
        attempt: u32,
    }

    #[test]
    fn emits_the_payload_as_serde_json_would_serialize_it() {
        let sink = Capture::default();
        let payload = Payload {
            panic_message: "boom",
            attempt: 2,
        };
        emit(&sink, "automation:worker-restart", &payload).unwrap();
        let sent = sink.0.lock().clone();
        assert_eq!(
            sent,
            vec![(
                "automation:worker-restart".to_string(),
                serde_json::to_string(&payload).unwrap()
            )]
        );
        assert_eq!(sent[0].1, r#"{"panicMessage":"boom","attempt":2}"#);
    }

    #[test]
    fn works_through_a_trait_object() {
        let sink = Capture::default();
        let dynamic: &dyn AutomationEventSink = &sink;
        emit(
            dynamic,
            "automation:event",
            &serde_json::json!({ "id": "a" }),
        )
        .unwrap();
        assert_eq!(sink.0.lock()[0].1, r#"{"id":"a"}"#);
    }

    #[test]
    fn a_borrowed_sink_delivers_to_the_same_place() {
        let sink = Capture::default();
        emit(&&sink, "automation:event", &true).unwrap();
        assert_eq!(sink.0.lock()[0], ("automation:event".into(), "true".into()));
    }

    #[test]
    fn a_refusing_sink_surfaces_its_error() {
        assert_eq!(
            emit(&Refuses, "automation:event", &1).unwrap_err(),
            "renderer gone"
        );
    }
}
