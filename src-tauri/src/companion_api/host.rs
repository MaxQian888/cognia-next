//! The desktop's renderer adapter for the companion (ADR-0196 P7).
//!
//! The renderer port lives in `cognia_companion::host` and is glob-re-exported
//! here, so `companion_api::host::…` paths are unchanged. The WebView adapter
//! stays in the app: it is the one piece that holds an `AppHandle`, and the
//! only code that recovers one from a state ([`tauri_app`]) is the app's own
//! dispatch host and command shells.

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

pub use cognia_companion::host::*;

use super::bridge_transport::{BridgeTransport, WebViewBridgeTransport};

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

    fn resource_dir(&self) -> Option<PathBuf> {
        use tauri::Manager as _;
        self.0.path().resource_dir().ok()
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

    /// A renderer that is not the desktop's WebView.
    struct HeadlessRenderer;

    impl RendererPort for HeadlessRenderer {
        fn emit(&self, _event: &str, _payload: Value) {}

        fn bridge_transport(&self) -> Arc<dyn BridgeTransport> {
            unreachable!("HeadlessRenderer carries no bridge")
        }

        fn resource_dir(&self) -> Option<PathBuf> {
            None
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
        let renderer: Arc<dyn RendererPort> = Arc::new(HeadlessRenderer);
        assert!(tauri_app(&Some(renderer)).is_none());
    }
}
