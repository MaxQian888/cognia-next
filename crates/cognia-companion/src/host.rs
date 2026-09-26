//! What the companion needs from the renderer it runs beside (ADR-0196 P5.1).
//!
//! The desktop hosts a WebView; the headless server hosts none. Companion code
//! that used to hold an `Option<tauri::AppHandle>` holds an
//! `Option<Arc<dyn RendererPort>>` instead: `None` in tests and on the headless
//! server, the app's `TauriRenderer` (`companion_api::host` in `src-tauri`) on
//! the desktop. Everything the companion does to the renderer is a method
//! here; the few desktop-only paths that still need the `AppHandle` itself
//! (managed state, the desktop dispatch arm) are app code and recover it with
//! that module's `tauri_app`, through [`RendererPort::as_any`].

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use super::bridge_transport::BridgeTransport;

/// The renderer a companion server runs beside.
pub trait RendererPort: Send + Sync + 'static {
    /// Emits `event` to the renderer, best effort: a failed emit is dropped,
    /// as every caller did with `AppHandle::emit`'s result.
    fn emit(&self, event: &str, payload: Value);

    /// The transport that carries bridge requests into the renderer's
    /// canonical store.
    fn bridge_transport(&self) -> Arc<dyn BridgeTransport>;

    /// The app's resource dir, where the terminal host it may start finds its
    /// shell-integration scripts.
    fn resource_dir(&self) -> Option<PathBuf>;

    /// Lets the desktop recover its own adapter (`tauri_app` in the app).
    fn as_any(&self) -> &dyn Any;
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

        fn resource_dir(&self) -> Option<PathBuf> {
            None
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
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
