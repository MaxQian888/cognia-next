//! What the companion needs from the renderer it runs beside (ADR-0196 P5.1).
//!
//! The desktop hosts a WebView; the headless server hosts none. Companion code
//! that used to hold an `Option<tauri::AppHandle>` holds an
//! `Option<Arc<dyn RendererPort>>` instead: `None` in tests and on the headless
//! server, [`TauriRenderer`] on the desktop. Everything the companion does to
//! the renderer is a method here; the few desktop-only paths that still need
//! the `AppHandle` itself (managed state, the terminal host's resource dir,
//! the desktop dispatch arm) reach it through [`tauri_app`].

use std::any::Any;
use std::sync::Arc;

use serde_json::Value;

use super::bridge_transport::{BridgeTransport, WebViewBridgeTransport};

/// The renderer a companion server runs beside.
pub trait RendererPort: Send + Sync + 'static {
    /// Emits `event` to the renderer, best effort: a failed emit is dropped,
    /// as every caller did with `AppHandle::emit`'s result.
    fn emit(&self, event: &str, payload: Value);

    /// The transport that carries bridge requests into the renderer's
    /// canonical store.
    fn bridge_transport(&self) -> Arc<dyn BridgeTransport>;

    /// Lets [`tauri_app`] recover the desktop adapter.
    fn as_any(&self) -> &dyn Any;
}

/// The desktop renderer: the Tauri app and its WebView.
pub struct TauriRenderer(pub tauri::AppHandle);

impl RendererPort for TauriRenderer {
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter as _;
        let _ = self.0.emit(event, payload);
    }

    fn bridge_transport(&self) -> Arc<dyn BridgeTransport> {
        Arc::new(WebViewBridgeTransport(self.0.clone()))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The desktop's `AppHandle` behind `renderer`, when there is one.
pub fn tauri_app(renderer: &Option<Arc<dyn RendererPort>>) -> Option<&tauri::AppHandle> {
    renderer
        .as_deref()
        .and_then(|renderer| renderer.as_any().downcast_ref::<TauriRenderer>())
        .map(|tauri| &tauri.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    /// Records what the companion emitted, standing in for a WebView.
    #[derive(Default)]
    struct RecordingRenderer {
        emitted: Mutex<Vec<(String, Value)>>,
    }

    impl RendererPort for RecordingRenderer {
        fn emit(&self, event: &str, payload: Value) {
            self.emitted.lock().push((event.to_string(), payload));
        }

        fn bridge_transport(&self) -> Arc<dyn BridgeTransport> {
            unreachable!("RecordingRenderer carries no bridge")
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[test]
    fn no_renderer_has_no_tauri_app() {
        assert!(tauri_app(&None).is_none());
    }

    #[test]
    fn a_renderer_that_is_not_tauri_has_no_tauri_app() {
        let renderer: Arc<dyn RendererPort> = Arc::new(RecordingRenderer::default());
        assert!(tauri_app(&Some(renderer)).is_none());
    }

    #[test]
    fn emit_reaches_the_renderer() {
        let recording = Arc::new(RecordingRenderer::default());
        let renderer: Arc<dyn RendererPort> = recording.clone();
        renderer.emit("companion://device-paired", serde_json::json!({ "id": 1 }));
        assert_eq!(
            recording.emitted.lock().as_slice(),
            &[(
                "companion://device-paired".to_string(),
                serde_json::json!({ "id": 1 })
            )]
        );
    }
}
