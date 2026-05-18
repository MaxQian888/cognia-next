//! Native OCR backends for cognia-next (ADR-0024).
//!
//! The TypeScript-side `OcrProvider` for tesseract-native / windows-media-ocr
//! / apple-vision delegates to the `ocr_extract_native` Tauri command. That
//! command picks a backend by tag and runs it. Each backend is gated by the
//! platforms it can run on:
//!
//! - `tesseract` — cross-platform; uses the `tesseract-rs` crate when the
//!   `ocr-tesseract` Cargo feature is enabled. Without the feature the
//!   backend reports `MissingBinding` and the TS layer falls back to the
//!   wasm provider.
//! - `windows-media-ocr` — Windows + MSIX only. Currently a placeholder; a
//!   future PR will wire the `winocr` crate behind the `ocr-windows` feature.
//! - `apple-vision` — macOS only. Calls the Swift sidecar at
//!   `src-tauri/sidecars/apple-vision-ocr/` via `tauri-plugin-shell`.
//!
//! The `NativeBackend` trait + `MockBackend` exist so unit tests can exercise
//! the command without spinning up real native libraries.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

pub mod backend;
pub mod msix;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum BackendKind {
    Tesseract,
    WindowsMediaOcr,
    AppleVision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeOcrBlock {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<NativeBoundingBox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeBoundingBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeOcrInvokePayload {
    pub backend: String,
    /// Raw image bytes — serialized over IPC as a number array.
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub languages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NativeOcrResult {
    pub text: String,
    #[serde(default)]
    pub blocks: Vec<NativeOcrBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
}

/// What every native backend implements. Mockable in tests so the command
/// dispatch surface is unit-testable.
pub trait NativeBackend: Send + Sync {
    fn id(&self) -> &'static str;
    fn extract(&self, payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError>;
}

#[derive(Debug, thiserror::Error)]
pub enum NativeOcrError {
    #[error("OCR backend `{0}` is not bound on this platform")]
    MissingBinding(&'static str),
    #[error("Unsupported backend tag: {0}")]
    UnknownBackend(String),
    #[error("Backend failure: {0}")]
    BackendFailure(String),
}

impl From<NativeOcrError> for String {
    fn from(err: NativeOcrError) -> String {
        err.to_string()
    }
}

/// In-process registry of native backends. Boot code (in `lib.rs`) populates
/// this with the cfg-gated real backends; tests can swap in a `MockBackend`.
#[derive(Clone, Default)]
pub struct NativeOcrRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Default)]
struct RegistryInner {
    backends: Vec<Box<dyn NativeBackend>>,
}

impl NativeOcrRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, backend: Box<dyn NativeBackend>) {
        let mut guard = self.inner.lock().await;
        guard.backends.push(backend);
    }

    pub async fn list_ids(&self) -> Vec<&'static str> {
        let guard = self.inner.lock().await;
        guard.backends.iter().map(|b| b.id()).collect()
    }

    pub async fn dispatch(
        &self,
        payload: &NativeOcrInvokePayload,
    ) -> Result<NativeOcrResult, NativeOcrError> {
        let guard = self.inner.lock().await;
        for backend in guard.backends.iter() {
            if backend.id() == payload.backend {
                return backend.extract(payload);
            }
        }
        Err(NativeOcrError::UnknownBackend(payload.backend.clone()))
    }
}

#[tauri::command]
pub async fn ocr_extract_native(
    state: tauri::State<'_, NativeOcrRegistry>,
    payload: NativeOcrInvokePayload,
) -> Result<NativeOcrResult, String> {
    state.dispatch(&payload).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ocr_list_native_backends(
    state: tauri::State<'_, NativeOcrRegistry>,
) -> Result<Vec<String>, String> {
    Ok(state
        .list_ids()
        .await
        .into_iter()
        .map(|s| s.to_string())
        .collect())
}

/// Build the registry that will be populated at app boot. Splits the
/// registration site from the command handlers so unit tests can construct
/// a registry full of mocks.
pub async fn install_default_backends(registry: &NativeOcrRegistry) {
    use backend::install_platform_backends;
    install_platform_backends(registry).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockBackend {
        id: &'static str,
        canned: NativeOcrResult,
    }

    impl NativeBackend for MockBackend {
        fn id(&self) -> &'static str {
            self.id
        }
        fn extract(&self, _payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError> {
            Ok(self.canned.clone())
        }
    }

    fn payload(backend: &str) -> NativeOcrInvokePayload {
        NativeOcrInvokePayload {
            backend: backend.to_string(),
            bytes: vec![1, 2, 3],
            mime_type: "image/png".to_string(),
            languages: vec!["en".to_string()],
        }
    }

    #[tokio::test]
    async fn dispatch_routes_by_id() {
        let registry = NativeOcrRegistry::new();
        registry
            .register(Box::new(MockBackend {
                id: "tesseract",
                canned: NativeOcrResult {
                    text: "hello".to_string(),
                    ..Default::default()
                },
            }))
            .await;
        let out = registry.dispatch(&payload("tesseract")).await.unwrap();
        assert_eq!(out.text, "hello");
    }

    #[tokio::test]
    async fn dispatch_errors_on_unknown_backend() {
        let registry = NativeOcrRegistry::new();
        let err = registry.dispatch(&payload("missing")).await.unwrap_err();
        match err {
            NativeOcrError::UnknownBackend(id) => assert_eq!(id, "missing"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_ids_returns_registered_backends() {
        let registry = NativeOcrRegistry::new();
        registry
            .register(Box::new(MockBackend {
                id: "tesseract",
                canned: NativeOcrResult::default(),
            }))
            .await;
        registry
            .register(Box::new(MockBackend {
                id: "windows-media-ocr",
                canned: NativeOcrResult::default(),
            }))
            .await;
        let ids = registry.list_ids().await;
        assert!(ids.contains(&"tesseract"));
        assert!(ids.contains(&"windows-media-ocr"));
    }

    #[tokio::test]
    async fn missing_binding_error_renders_helpfully() {
        let err = NativeOcrError::MissingBinding("tesseract");
        assert!(err.to_string().contains("tesseract"));
    }

    #[test]
    fn payload_round_trips_through_serde() {
        let value = NativeOcrInvokePayload {
            backend: "tesseract".to_string(),
            bytes: vec![1, 2],
            mime_type: "image/png".to_string(),
            languages: vec!["en".to_string()],
        };
        let json = serde_json::to_string(&value).unwrap();
        let parsed: NativeOcrInvokePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.backend, "tesseract");
        assert_eq!(parsed.bytes, vec![1, 2]);
    }
}
