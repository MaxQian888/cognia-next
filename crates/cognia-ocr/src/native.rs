//! Native OCR backends for cognia-next (ADR-0024).
//!
//! The TypeScript-side `OcrProvider` for tesseract-native / windows-media-ocr
//! / apple-vision / ocrs / paddle-ocr delegates to the `ocr_extract_native`
//! Tauri command. That command picks a backend by tag and runs it. Each
//! backend is gated by the platforms it can run on:
//!
//! - `tesseract` — cross-platform; invokes the local `tesseract` CLI when
//!   the `ocr-tesseract` Cargo feature is enabled. Without the feature the
//!   backend reports `MissingBinding` and the TS layer falls back to the
//!   wasm provider.
//! - `windows-media-ocr` — Windows + MSIX only. Currently a placeholder; a
//!   future PR will wire the `winocr` crate behind the `ocr-windows` feature.
//! - `apple-vision` — macOS only. Runs Vision.framework's
//!   `VNRecognizeTextRequest` in-process via the `objc2-vision` bindings.
//! - `ocrs` — cross-platform pure-Rust pipeline (`ocrs` + RTen) behind the
//!   `ocr-ocrs` Cargo feature. Models live in `<app_data>/cognia/ocr/ocrs/`
//!   and are downloaded on first use via `ocr_download_model`.
//! - `paddle-ocr` — PaddleOCR PP-OCRv5 via `oar-ocr` + ONNX Runtime behind
//!   the `ocr-paddle` feature. Models live in `<app_data>/cognia/ocr/paddle/`.
//!
//! The `NativeBackend` trait + `MockBackend` exist so unit tests can exercise
//! the command without spinning up real native libraries.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum BackendKind {
    Tesseract,
    WindowsMediaOcr,
    AppleVision,
    Ocrs,
    PaddleOcr,
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
    let _perf = cognia_instrument::guard("ocr.extract");
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
    use crate::backend::install_platform_backends;
    install_platform_backends(registry).await
}

// ─── Model management (download + status) ────────────────────────────────
//
// Local backends (`ocrs`, `paddle-ocr`) ship without weights to keep the
// installer slim. Models are downloaded on first use into
// `<app_data>/cognia/ocr/<backend>/` via `ocr_download_model`. The
// settings UI uses `ocr_model_status` to render "Download" / "Ready"
// badges and to gate the auto-router's readiness probe.

/// One file in the registry — name on disk + remote source URL. SHA-256s
/// are recorded after a successful download for tamper detection.
#[derive(Debug, Clone)]
pub struct ModelFileSpec {
    pub file_name: &'static str,
    pub url: &'static str,
    /// Approximate download size in bytes — used by the UI for a progress
    /// bar before any byte has been read. Best-effort; the live byte count
    /// from the HTTP response takes precedence once available.
    pub expected_bytes: u64,
}

/// Static registry of model URLs per backend tag. Updated alongside the
/// upstream model releases. URLs verified 2026-07-13 (all return HTTP 200).
/// Sources:
/// - `ocrs`: the ocrs-models S3 bucket — the same location the upstream
///   `ocrs` CLI downloads from (github.com/robertknight/ocrs).
/// - `paddle-ocr`: PP-OCRv5 ONNX conversions + dictionary published on the
///   `oar-ocr` GitHub Releases page, as documented in that repo's
///   docs/models.md (the HF PaddlePaddle repos ship Paddle-format files
///   only, no ONNX).
/// Mirroring the file names used by `crate::backend::ocrs::*_MODEL_FILE` /
/// `crate::backend::paddle::*` so downloader and loader agree.
pub fn model_spec(backend: &str) -> Option<Vec<ModelFileSpec>> {
    match backend {
        "ocrs" => Some(vec![
            ModelFileSpec {
                file_name: crate::backend::ocrs::DETECTION_MODEL_FILE,
                url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten",
                expected_bytes: 2_640_000,
            },
            ModelFileSpec {
                file_name: crate::backend::ocrs::RECOGNITION_MODEL_FILE,
                url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten",
                expected_bytes: 10_190_000,
            },
        ]),
        "paddle-ocr" => Some(vec![
            ModelFileSpec {
                file_name: crate::backend::paddle::DETECTION_MODEL_FILE,
                url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_det.onnx",
                expected_bytes: 4_826_518,
            },
            ModelFileSpec {
                file_name: crate::backend::paddle::RECOGNITION_MODEL_FILE,
                url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_rec.onnx",
                expected_bytes: 16_562_373,
            },
            ModelFileSpec {
                file_name: crate::backend::paddle::DICTIONARY_FILE,
                url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/ppocrv5_dict.txt",
                expected_bytes: 74_012,
            },
        ]),
        _ => None,
    }
}

/// Resolve the on-disk model directory for a given backend tag, reusing
/// the same path each loader looks at.
pub fn resolve_backend_model_dir(backend: &str) -> Result<PathBuf, String> {
    match backend {
        "ocrs" => crate::backend::ocrs::resolve_model_dir().map_err(|e| e.to_string()),
        "paddle-ocr" => crate::backend::paddle::resolve_model_dir().map_err(|e| e.to_string()),
        other => Err(format!(
            "model management not supported for backend `{other}`"
        )),
    }
}

/// Compose a status report for the frontend's "Manage local OCR models"
/// row. Reports per-file installation state, total bytes occupied, and the
/// directory path so the UI can offer a "Reveal in Explorer" affordance.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    pub backend: String,
    pub installed: bool,
    pub model_dir: String,
    /// File names declared by the model registry. Empty for backends that
    /// don't manage their own models (every native backend other than
    /// `ocrs` / `paddle-ocr` today).
    pub files: Vec<ModelFileStatus>,
    /// Total on-disk bytes across all *installed* files.
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelFileStatus {
    pub file_name: String,
    pub installed: bool,
    pub expected_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_bytes: Option<u64>,
}

/// Pure helper exposed for unit tests — builds a `ModelStatus` from a
/// known model directory + spec. Doesn't read any global state.
pub fn build_model_status(
    backend: &str,
    model_dir: PathBuf,
    spec: &[ModelFileSpec],
) -> ModelStatus {
    let mut files = Vec::with_capacity(spec.len());
    let mut total: u64 = 0;
    let mut all_installed = !spec.is_empty();
    for entry in spec {
        let path = model_dir.join(entry.file_name);
        let meta = std::fs::metadata(&path).ok();
        let installed = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
        let actual_bytes = meta.as_ref().map(|m| m.len());
        if installed {
            if let Some(bytes) = actual_bytes {
                total = total.saturating_add(bytes);
            }
        } else {
            all_installed = false;
        }
        files.push(ModelFileStatus {
            file_name: entry.file_name.to_string(),
            installed,
            expected_bytes: entry.expected_bytes,
            actual_bytes,
        });
    }
    ModelStatus {
        backend: backend.to_string(),
        installed: all_installed,
        model_dir: model_dir.to_string_lossy().into_owned(),
        files,
        total_bytes: total,
        reason: None,
    }
}

/// Query installation state for a managed backend's models. Returns a
/// `reason`-only status when the backend doesn't manage models (so the UI
/// can hide the model row gracefully) or when the data directory can't be
/// resolved.
#[tauri::command]
pub async fn ocr_model_status(backend: String) -> Result<ModelStatus, String> {
    let Some(spec) = model_spec(&backend) else {
        return Ok(ModelStatus {
            backend,
            installed: false,
            model_dir: String::new(),
            files: Vec::new(),
            total_bytes: 0,
            reason: Some("backend does not manage its own models".to_string()),
        });
    };
    let model_dir = resolve_backend_model_dir(&backend)?;
    Ok(build_model_status(&backend, model_dir, &spec))
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    pub backend: String,
    pub model_dir: String,
    pub files: Vec<DownloadedFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadedFile {
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub backend: String,
    pub file_name: String,
    /// Bytes written so far for this file.
    pub bytes_done: u64,
    /// Best-effort total — from `Content-Length` when available, else the
    /// `expected_bytes` from the spec.
    pub bytes_total: u64,
    /// 1-based index of the file currently downloading.
    pub file_index: usize,
    /// Total number of files this download covers.
    pub file_count: usize,
}

/// Download every file from the registry into `<model_dir>`, atomically
/// (write to a `.partial` file first, rename on completion). Emits
/// `ocr://download-progress` events for the UI. Writes `manifest.json` at
/// the end with each file's SHA-256 for tamper detection.
#[tauri::command]
pub async fn ocr_download_model(
    app: tauri::AppHandle,
    backend: String,
) -> Result<DownloadResult, String> {
    use sha2::{Digest, Sha256};
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    let Some(spec) = model_spec(&backend) else {
        return Err(format!(
            "backend `{backend}` does not manage its own models"
        ));
    };
    let model_dir = resolve_backend_model_dir(&backend)?;
    tokio::fs::create_dir_all(&model_dir)
        .await
        .map_err(|e| format!("create model dir: {e}"))?;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;
    let file_count = spec.len();
    let mut files = Vec::with_capacity(file_count);
    for (idx, entry) in spec.iter().enumerate() {
        let final_path = model_dir.join(entry.file_name);
        let partial_path = model_dir.join(format!("{}.partial", entry.file_name));
        let response = client
            .get(entry.url)
            .send()
            .await
            .map_err(|e| format!("GET {}: {e}", entry.url))?;
        if !response.status().is_success() {
            return Err(format!("GET {} returned {}", entry.url, response.status()));
        }
        let bytes_total = response.content_length().unwrap_or(entry.expected_bytes);

        let mut hasher = Sha256::new();
        let mut bytes_done: u64 = 0;
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&partial_path)
            .await
            .map_err(|e| format!("create {}: {e}", partial_path.display()))?;
        use futures_util::StreamExt as _;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read chunk: {e}"))?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {}: {e}", partial_path.display()))?;
            bytes_done = bytes_done.saturating_add(chunk.len() as u64);
            // Best-effort emit; ignore errors so the download completes
            // even if the listener has detached.
            let _ = app.emit(
                "ocr://download-progress",
                DownloadProgressEvent {
                    backend: backend.clone(),
                    file_name: entry.file_name.to_string(),
                    bytes_done,
                    bytes_total,
                    file_index: idx + 1,
                    file_count,
                },
            );
        }
        file.flush()
            .await
            .map_err(|e| format!("flush {}: {e}", partial_path.display()))?;
        drop(file);
        tokio::fs::rename(&partial_path, &final_path)
            .await
            .map_err(|e| {
                format!(
                    "rename {} -> {}: {e}",
                    partial_path.display(),
                    final_path.display()
                )
            })?;
        let digest = hex::encode(hasher.finalize());
        files.push(DownloadedFile {
            file_name: entry.file_name.to_string(),
            bytes: bytes_done,
            sha256: digest,
        });
    }

    // Manifest with the live SHA-256s for tamper detection on subsequent
    // boots. Written last so a half-finished download doesn't leave a stale
    // manifest claiming readiness.
    let manifest_path = model_dir.join("manifest.json");
    let manifest_body = serde_json::json!({
        "backend": &backend,
        "downloaded_at": chrono::Utc::now().to_rfc3339(),
        "files": files.iter().map(|f| serde_json::json!({
            "file_name": f.file_name,
            "bytes": f.bytes,
            "sha256": f.sha256,
        })).collect::<Vec<_>>(),
    });
    tokio::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest_body)
            .map_err(|e| format!("serialize manifest: {e}"))?,
    )
    .await
    .map_err(|e| format!("write manifest {}: {e}", manifest_path.display()))?;

    Ok(DownloadResult {
        backend,
        model_dir: model_dir.to_string_lossy().into_owned(),
        files,
    })
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
        fn extract(
            &self,
            _payload: &NativeOcrInvokePayload,
        ) -> Result<NativeOcrResult, NativeOcrError> {
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

    // ─── Model management ────────────────────────────────────────────────

    use tempfile::tempdir;

    #[test]
    fn model_spec_lists_two_files_for_ocrs() {
        let spec = model_spec("ocrs").expect("ocrs spec present");
        assert_eq!(spec.len(), 2);
        let names: Vec<&str> = spec.iter().map(|s| s.file_name).collect();
        assert!(names.contains(&crate::backend::ocrs::DETECTION_MODEL_FILE));
        assert!(names.contains(&crate::backend::ocrs::RECOGNITION_MODEL_FILE));
        // Every URL must be HTTPS so the renderer-side allowlist accepts it,
        // and must point at the ocrs-models S3 bucket (the upstream ocrs
        // CLI's own download location — the old HF mirror 404s).
        for entry in &spec {
            assert!(
                entry
                    .url
                    .starts_with("https://ocrs-models.s3-accelerate.amazonaws.com/"),
                "unexpected ocrs model host: {}",
                entry.url
            );
        }
    }

    #[test]
    fn model_spec_lists_three_files_for_paddle() {
        let spec = model_spec("paddle-ocr").expect("paddle-ocr spec present");
        assert_eq!(spec.len(), 3);
        let names: Vec<&str> = spec.iter().map(|s| s.file_name).collect();
        assert!(names.contains(&crate::backend::paddle::DETECTION_MODEL_FILE));
        assert!(names.contains(&crate::backend::paddle::RECOGNITION_MODEL_FILE));
        assert!(names.contains(&crate::backend::paddle::DICTIONARY_FILE));
        // PP-OCRv5 ONNX conversions + dict live on the oar-ocr GitHub
        // Releases page (docs/models.md); the HF PaddlePaddle repos only
        // ship Paddle-format files and 404 for ONNX/dict.
        for entry in &spec {
            assert!(
                entry
                    .url
                    .starts_with("https://github.com/GreatV/oar-ocr/releases/download/"),
                "unexpected paddle model host: {}",
                entry.url
            );
        }
    }

    #[test]
    fn model_spec_returns_none_for_unmanaged_backend() {
        assert!(model_spec("tesseract").is_none());
        assert!(model_spec("apple-vision").is_none());
        assert!(model_spec("unknown").is_none());
    }

    #[test]
    fn build_model_status_reports_empty_directory() {
        let tmp = tempdir().unwrap();
        let spec = model_spec("ocrs").unwrap();
        let status = build_model_status("ocrs", tmp.path().to_path_buf(), &spec);
        assert!(!status.installed);
        assert_eq!(status.total_bytes, 0);
        assert_eq!(status.files.len(), 2);
        for f in &status.files {
            assert!(!f.installed);
            assert!(f.actual_bytes.is_none());
        }
    }

    #[test]
    fn build_model_status_reports_fully_installed_directory() {
        let tmp = tempdir().unwrap();
        let spec = model_spec("ocrs").unwrap();
        for entry in &spec {
            std::fs::write(tmp.path().join(entry.file_name), vec![0u8; 42]).unwrap();
        }
        let status = build_model_status("ocrs", tmp.path().to_path_buf(), &spec);
        assert!(status.installed);
        assert_eq!(status.total_bytes, 42 * spec.len() as u64);
        for f in &status.files {
            assert!(f.installed);
            assert_eq!(f.actual_bytes, Some(42));
        }
    }

    #[test]
    fn build_model_status_handles_partial_install() {
        let tmp = tempdir().unwrap();
        let spec = model_spec("paddle-ocr").unwrap();
        std::fs::write(tmp.path().join(spec[0].file_name), vec![0u8; 10]).unwrap();
        let status = build_model_status("paddle-ocr", tmp.path().to_path_buf(), &spec);
        assert!(!status.installed);
        assert_eq!(status.total_bytes, 10);
        assert!(status.files[0].installed);
        assert!(!status.files[1].installed);
    }

    #[tokio::test]
    async fn ocr_model_status_for_unmanaged_backend_returns_reason() {
        let status = ocr_model_status("tesseract".to_string()).await.unwrap();
        assert!(!status.installed);
        assert!(status.reason.is_some());
        assert!(status.files.is_empty());
    }

    #[tokio::test]
    async fn ocr_model_status_for_ocrs_reports_files_list() {
        // The data dir may or may not contain models on the test runner —
        // we only assert structural invariants here so the test passes
        // regardless of dev environment state.
        let status = ocr_model_status("ocrs".to_string()).await.unwrap();
        assert_eq!(status.backend, "ocrs");
        assert_eq!(status.files.len(), 2);
        for f in &status.files {
            assert!(
                f.file_name == crate::backend::ocrs::DETECTION_MODEL_FILE
                    || f.file_name == crate::backend::ocrs::RECOGNITION_MODEL_FILE
            );
        }
    }

    #[test]
    fn download_progress_event_serializes_with_camel_friendly_fields() {
        // The renderer reads these fields verbatim — guard against
        // accidental rename via this round-trip check.
        let event = DownloadProgressEvent {
            backend: "ocrs".to_string(),
            file_name: "text-detection.rten".to_string(),
            bytes_done: 100,
            bytes_total: 2_640_000,
            file_index: 1,
            file_count: 2,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"backend\":\"ocrs\""));
        assert!(json.contains("\"file_name\":\"text-detection.rten\""));
        assert!(json.contains("\"bytes_done\":100"));
        assert!(json.contains("\"file_count\":2"));
    }
}
