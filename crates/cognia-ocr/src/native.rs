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
//! - `paddle-ocr` — PaddleOCR PP-OCRv6 via `oar-ocr` + ONNX Runtime behind
//!   the `ocr-paddle` feature. Models live in
//!   `<app_data>/cognia/ocr/paddle/<variant>/`.
//!
//! The `NativeBackend` trait + `MockBackend` exist so unit tests can exercise
//! the command without spinning up real native libraries.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
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
    #[serde(default)]
    pub model_variant: Option<String>,
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

    /// Whether this backend can actually do work.
    ///
    /// `list_ids()` cannot answer this: `install_platform_backends` registers a
    /// `PlaceholderBackend` under *every* id precisely so the dispatch table
    /// stays dense, which means the id set looks identical whether or not any
    /// real engine is linked. A caller deciding whether to offer an
    /// OCR-dependent feature at all needs to know the difference before it
    /// builds a request — not after it gets `MissingBinding` back.
    fn is_available(&self) -> bool {
        true
    }
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

    /// Ids that will actually produce text, placeholders excluded.
    ///
    /// Empty means this build has no working OCR engine — on a default
    /// Windows build that is the norm, since every `ocr-*` feature is opt-in
    /// and `ocr-windows` additionally needs MSIX package identity at runtime.
    pub async fn available_ids(&self) -> Vec<&'static str> {
        let guard = self.inner.lock().await;
        guard
            .backends
            .iter()
            .filter(|b| b.is_available())
            .map(|b| b.id())
            .collect()
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

/// Return only real, callable backends. Placeholder registrations are
/// intentionally excluded so the renderer never advertises them as ready.
#[tauri::command]
pub async fn ocr_list_available_backends(
    state: tauri::State<'_, NativeOcrRegistry>,
) -> Result<Vec<String>, String> {
    Ok(state
        .available_ids()
        .await
        .into_iter()
        .map(str::to_string)
        .collect())
}

// ─── Restricted local HTTP transport ────────────────────────────────────

const OCR_HTTP_MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct OcrHttpRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_ocr_http_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub allow_private_network: bool,
}

fn default_ocr_http_timeout_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrHttpResponse {
    pub status: u16,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OcrHttpTargetScope {
    Loopback,
    Private,
    Forbidden,
}

fn ipv6_is_unique_local(ip: &Ipv6Addr) -> bool {
    ip.octets()[0] & 0xfe == 0xfc
}

fn classify_ocr_http_ip(ip: IpAddr) -> OcrHttpTargetScope {
    if ip.is_loopback() {
        return OcrHttpTargetScope::Loopback;
    }
    match ip {
        IpAddr::V4(ip) if ip.is_private() => OcrHttpTargetScope::Private,
        IpAddr::V6(ip) if ipv6_is_unique_local(&ip) => OcrHttpTargetScope::Private,
        _ => OcrHttpTargetScope::Forbidden,
    }
}

async fn validate_and_resolve_ocr_http_target(
    raw_url: &str,
    allow_private_network: bool,
) -> Result<(reqwest::Url, Option<(String, Vec<SocketAddr>)>), String> {
    let url = reqwest::Url::parse(raw_url).map_err(|_| "invalid OCR endpoint URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("OCR endpoint must use HTTP or HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("OCR endpoint credentials must not be embedded in the URL".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "OCR endpoint is missing a host".to_string())?
        .trim_end_matches('.')
        .trim_matches(|character| character == '[' || character == ']')
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "OCR endpoint has no usable port".to_string())?;

    let addresses = if host.eq_ignore_ascii_case("localhost") {
        vec![
            SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ]
    } else if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| "OCR endpoint DNS resolution failed".to_string())?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err("OCR endpoint DNS resolution returned no addresses".into());
    }

    let scopes = addresses
        .iter()
        .map(|address| classify_ocr_http_ip(address.ip()))
        .collect::<Vec<_>>();
    if scopes.contains(&OcrHttpTargetScope::Forbidden) {
        return Err(
            "public, link-local, metadata, multicast, and unspecified OCR targets are rejected"
                .into(),
        );
    }
    if scopes.contains(&OcrHttpTargetScope::Private) && !allow_private_network {
        return Err("private/LAN OCR endpoint requires explicit confirmation".into());
    }

    let resolution_override = host.parse::<IpAddr>().is_err().then_some((host, addresses));
    Ok((url, resolution_override))
}

fn ocr_http_cancellations() -> &'static cognia_net::request_cancellation::RequestCancellationRegistry
{
    static CANCELLATIONS: OnceLock<cognia_net::request_cancellation::RequestCancellationRegistry> =
        OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

#[tauri::command]
pub fn ocr_http_cancel(request_id: String) -> bool {
    ocr_http_cancellations().cancel(&request_id)
}

async fn execute_ocr_http_request(request: OcrHttpRequest) -> Result<OcrHttpResponse, String> {
    use futures_util::StreamExt as _;
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    let (url, resolution_override) =
        validate_and_resolve_ocr_http_target(&request.url, request.allow_private_network).await?;
    let mut builder = reqwest::Client::builder()
        .user_agent("cognia-next-ocr/1.0")
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if let Some((host, addresses)) = &resolution_override {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, url.as_str())
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|_| "failed to build OCR HTTP client".to_string())?;

    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("unsupported OCR HTTP method '{other}'")),
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "content-length"
        ) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "invalid OCR HTTP header name".to_string())?;
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| "invalid OCR HTTP header value".to_string())?;
        if matches!(name.as_str(), "authorization" | "api-key" | "x-api-key") {
            value.set_sensitive(true);
        }
        headers.insert(name, value);
    }

    let mut pending = client
        .request(method, url)
        .headers(headers)
        .timeout(Duration::from_millis(
            request.timeout_ms.clamp(1_000, 600_000),
        ));
    if let Some(body) = request.body {
        pending = pending.body(body);
    }
    let response = pending.send().await.map_err(|error| {
        if error.is_timeout() {
            "OCR HTTP request timed out".to_string()
        } else {
            "OCR HTTP request failed".to_string()
        }
    })?;
    if response.status().is_redirection() {
        return Err("OCR HTTP redirects are disabled".into());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if response
        .content_length()
        .is_some_and(|length| length as usize > OCR_HTTP_MAX_BODY_BYTES)
    {
        return Err("OCR HTTP response exceeds the 25 MiB limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "failed to read OCR HTTP response".to_string())?;
        if bytes.len() + chunk.len() > OCR_HTTP_MAX_BODY_BYTES {
            return Err("OCR HTTP response exceeds the 25 MiB limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body =
        String::from_utf8(bytes).map_err(|_| "OCR HTTP response is not valid UTF-8".to_string())?;
    Ok(OcrHttpResponse {
        status,
        body,
        content_type,
    })
}

#[tauri::command]
pub async fn ocr_http_fetch(request: OcrHttpRequest) -> Result<OcrHttpResponse, String> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("OCR HTTP request id is required".into());
    }
    let (generation, mut cancel_rx) = ocr_http_cancellations().register(&request_id);
    let result = tokio::select! {
        result = execute_ocr_http_request(request) => result,
        _ = &mut cancel_rx => Err("OCR HTTP request cancelled".into()),
    };
    ocr_http_cancellations().finish(&request_id, generation);
    result
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
/// are pinned from the upstream release registry for integrity verification.
#[derive(Debug, Clone)]
pub struct ModelFileSpec {
    pub file_name: &'static str,
    pub url: &'static str,
    /// Approximate download size in bytes — used by the UI for a progress
    /// bar before any byte has been read. Best-effort; the live byte count
    /// from the HTTP response takes precedence once available.
    pub expected_bytes: u64,
    /// Pinned digest from the upstream release registry.
    pub sha256: &'static str,
}

/// Static registry of model URLs per backend tag. Updated alongside the
/// upstream model releases. URLs verified 2026-07-13 (all return HTTP 200).
/// Sources:
/// - `ocrs`: the ocrs-models S3 bucket — the same location the upstream
///   `ocrs` CLI downloads from (github.com/robertknight/ocrs).
/// - `paddle-ocr`: PP-OCRv6 ONNX conversions + dictionaries published on the
///   `oar-ocr` v0.7.0 GitHub release, as documented by oar-ocr 0.9.x in
///   docs/models.md (the HF PaddlePaddle repos ship Paddle-format files
///   only, no ONNX).
///
/// Mirroring the file names used by `crate::backend::ocrs::*_MODEL_FILE` /
/// `crate::backend::paddle::*` so downloader and loader agree.
pub fn model_spec(backend: &str, variant: Option<&str>) -> Option<Vec<ModelFileSpec>> {
    match backend {
        "ocrs" => Some(vec![
            ModelFileSpec {
                file_name: crate::backend::ocrs::DETECTION_MODEL_FILE,
                url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten",
                expected_bytes: 2_640_000,
                sha256: "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca",
            },
            ModelFileSpec {
                file_name: crate::backend::ocrs::RECOGNITION_MODEL_FILE,
                url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten",
                expected_bytes: 10_190_000,
                sha256: "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e",
            },
        ]),
        "paddle-ocr" => match variant.unwrap_or("v6-small") {
            "v6-tiny" => Some(vec![
                ModelFileSpec {
                    file_name: crate::backend::paddle::DETECTION_MODEL_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_tiny_det.onnx",
                    expected_bytes: 1_780_590,
                    sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8",
                },
                ModelFileSpec {
                    file_name: crate::backend::paddle::RECOGNITION_MODEL_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_tiny_rec.onnx",
                    expected_bytes: 4_462_639,
                    sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6",
                },
                ModelFileSpec {
                    file_name: crate::backend::paddle::DICTIONARY_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/ppocrv6_tiny_dict.txt",
                    expected_bytes: 27_156,
                    sha256: "c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd",
                },
            ]),
            "v6-small" => Some(vec![
                ModelFileSpec {
                    file_name: crate::backend::paddle::DETECTION_MODEL_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_small_det.onnx",
                    expected_bytes: 9_880_512,
                    sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
                },
                ModelFileSpec {
                    file_name: crate::backend::paddle::RECOGNITION_MODEL_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/pp-ocrv6_small_rec.onnx",
                    expected_bytes: 21_159_378,
                    sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
                },
                ModelFileSpec {
                    file_name: crate::backend::paddle::DICTIONARY_FILE,
                    url: "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/ppocrv6_dict.txt",
                    expected_bytes: 74_947,
                    sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
                },
            ]),
            _ => None,
        },
        _ => None,
    }
}

/// Resolve the on-disk model directory for a given backend tag, reusing
/// the same path each loader looks at.
pub fn resolve_backend_model_dir(backend: &str, variant: Option<&str>) -> Result<PathBuf, String> {
    match backend {
        "ocrs" => crate::backend::ocrs::resolve_model_dir().map_err(|e| e.to_string()),
        "paddle-ocr" => crate::backend::paddle::resolve_model_dir()
            .map(|dir| dir.join(variant.unwrap_or("v6-small")))
            .map_err(|e| e.to_string()),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub integrity: ModelIntegrity,
    pub installed: bool,
    pub model_dir: String,
    /// File names declared by the model registry. Empty for backends that
    /// don't manage their own models (every native backend other than
    /// `ocrs` / `paddle-ocr` today).
    pub files: Vec<ModelFileStatus>,
    /// Total on-disk bytes across all *installed* files.
    pub total_bytes: u64,
    /// Pre-v6 files found in the unversioned Paddle directory. They are never
    /// loaded by the v6 backend and are reported only for user cleanup.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub legacy_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_model_dir: Option<String>,
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
    pub integrity: ModelIntegrity,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelIntegrity {
    Verified,
    Missing,
    Corrupt,
    Unknown,
}

/// Pure helper exposed for unit tests — builds a `ModelStatus` from a
/// known model directory + spec. Doesn't read any global state.
pub fn build_model_status(
    backend: &str,
    variant: Option<&str>,
    model_dir: PathBuf,
    spec: &[ModelFileSpec],
) -> ModelStatus {
    let mut files = Vec::with_capacity(spec.len());
    let mut total: u64 = 0;
    let mut all_installed = !spec.is_empty();
    for entry in spec {
        let path = model_dir.join(entry.file_name);
        let meta = std::fs::metadata(&path).ok();
        let exists = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
        let actual_bytes = meta.as_ref().map(|m| m.len());
        let digest = if exists {
            sha256_path(&path).ok()
        } else {
            None
        };
        let integrity = if !exists {
            ModelIntegrity::Missing
        } else if digest.as_deref() == Some(entry.sha256) {
            ModelIntegrity::Verified
        } else {
            ModelIntegrity::Corrupt
        };
        let installed = integrity == ModelIntegrity::Verified;
        if !installed {
            all_installed = false;
        }
        if exists {
            if let Some(bytes) = actual_bytes {
                total = total.saturating_add(bytes);
            }
        }
        files.push(ModelFileStatus {
            file_name: entry.file_name.to_string(),
            installed,
            expected_bytes: entry.expected_bytes,
            actual_bytes,
            integrity,
        });
    }
    let (legacy_files, legacy_model_dir) = if backend == "paddle-ocr" && variant.is_some() {
        let legacy_dir = model_dir.parent().map(std::path::Path::to_path_buf);
        let legacy_files = legacy_dir
            .as_deref()
            .map(|dir| {
                [
                    crate::backend::paddle::DETECTION_MODEL_FILE,
                    crate::backend::paddle::RECOGNITION_MODEL_FILE,
                    crate::backend::paddle::DICTIONARY_FILE,
                    crate::backend::paddle::CLASSIFICATION_MODEL_FILE,
                ]
                .into_iter()
                .filter(|name| dir.join(name).is_file())
                .map(str::to_string)
                .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let legacy_model_dir =
            (!legacy_files.is_empty()).then(|| legacy_dir.unwrap().to_string_lossy().into_owned());
        (legacy_files, legacy_model_dir)
    } else {
        (Vec::new(), None)
    };
    let has_legacy = !legacy_files.is_empty();
    ModelStatus {
        backend: backend.to_string(),
        variant: variant.map(str::to_string),
        version: (backend == "paddle-ocr").then(|| "PP-OCRv6".to_string()),
        integrity: if all_installed {
            ModelIntegrity::Verified
        } else if files
            .iter()
            .any(|file| file.integrity == ModelIntegrity::Corrupt)
        {
            ModelIntegrity::Corrupt
        } else {
            ModelIntegrity::Missing
        },
        installed: all_installed,
        model_dir: model_dir.to_string_lossy().into_owned(),
        files,
        total_bytes: total,
        legacy_files,
        legacy_model_dir,
        reason: has_legacy.then(|| {
            "legacy PP-OCRv5 files detected; they are preserved but not active for PP-OCRv6"
                .to_string()
        }),
    }
}

fn sha256_path(path: &std::path::Path) -> Result<String, std::io::Error> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

/// Query installation state for a managed backend's models. Returns a
/// `reason`-only status when the backend doesn't manage models (so the UI
/// can hide the model row gracefully) or when the data directory can't be
/// resolved.
#[tauri::command]
pub async fn ocr_model_status(
    backend: String,
    variant: Option<String>,
) -> Result<ModelStatus, String> {
    let Some(spec) = model_spec(&backend, variant.as_deref()) else {
        return Ok(ModelStatus {
            backend,
            variant,
            version: None,
            integrity: ModelIntegrity::Unknown,
            installed: false,
            model_dir: String::new(),
            files: Vec::new(),
            total_bytes: 0,
            legacy_files: Vec::new(),
            legacy_model_dir: None,
            reason: Some("backend does not manage its own models".to_string()),
        });
    };
    let model_dir = resolve_backend_model_dir(&backend, variant.as_deref())?;
    Ok(build_model_status(
        &backend,
        variant.as_deref(),
        model_dir,
        &spec,
    ))
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
async fn download_model_inner(
    progress: Arc<dyn Fn(DownloadProgressEvent) + Send + Sync>,
    backend: String,
    variant: Option<String>,
) -> Result<DownloadResult, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let Some(spec) = model_spec(&backend, variant.as_deref()) else {
        return Err(format!(
            "backend `{backend}` does not manage its own models"
        ));
    };
    let model_dir = resolve_backend_model_dir(&backend, variant.as_deref())?;
    tokio::fs::create_dir_all(&model_dir)
        .await
        .map_err(|e| format!("create model dir: {e}"))?;

    let builder = reqwest::Client::builder();
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, spec[0].url)
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;
    let file_count = spec.len();
    let mut files = Vec::with_capacity(file_count);
    for (idx, entry) in spec.iter().enumerate() {
        let final_path = model_dir.join(entry.file_name);
        if sha256_path(&final_path).ok().as_deref() == Some(entry.sha256) {
            let bytes = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            files.push(DownloadedFile {
                file_name: entry.file_name.to_string(),
                bytes,
                sha256: entry.sha256.to_string(),
            });
            continue;
        }
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
        let temporary = tempfile::Builder::new()
            .prefix(&format!(".{}.", entry.file_name))
            .suffix(".partial")
            .tempfile_in(&model_dir)
            .map_err(|e| {
                format!(
                    "create temporary model file in {}: {e}",
                    model_dir.display()
                )
            })?;
        let (temporary_file, temporary_path) = temporary.into_parts();
        let partial_path = temporary_path.to_path_buf();
        let mut file = tokio::fs::File::from_std(temporary_file);
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
            progress(DownloadProgressEvent {
                backend: backend.clone(),
                file_name: entry.file_name.to_string(),
                bytes_done,
                bytes_total,
                file_index: idx + 1,
                file_count,
            });
        }
        file.flush()
            .await
            .map_err(|e| format!("flush {}: {e}", partial_path.display()))?;
        file.sync_all()
            .await
            .map_err(|e| format!("sync {}: {e}", partial_path.display()))?;
        drop(file);
        let digest = hex::encode(hasher.finalize());
        if digest != entry.sha256 {
            return Err(format!(
                "SHA-256 mismatch for {}: expected {}, got {}",
                entry.file_name, entry.sha256, digest
            ));
        }
        persist_download(temporary_path, &final_path)?;
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
        "variant": &variant,
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

fn persist_download(
    temporary_path: tempfile::TempPath,
    final_path: &std::path::Path,
) -> Result<(), String> {
    let source = temporary_path.to_path_buf();
    temporary_path.persist(final_path).map_err(|error| {
        format!(
            "replace {} -> {}: {}",
            source.display(),
            final_path.display(),
            error.error
        )
    })
}

fn model_download_cancellations(
) -> &'static cognia_net::request_cancellation::RequestCancellationRegistry {
    static CANCELLATIONS: OnceLock<cognia_net::request_cancellation::RequestCancellationRegistry> =
        OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

fn model_download_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn model_download_lock(backend: &str, variant: Option<&str>) -> Arc<Mutex<()>> {
    let key = format!("{backend}:{}", variant.unwrap_or("default"));
    let Ok(mut locks) = model_download_locks().lock() else {
        return Arc::new(Mutex::new(()));
    };
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[tauri::command]
pub fn ocr_cancel_model_download(request_id: String) -> bool {
    model_download_cancellations().cancel(&request_id)
}

/// Download a model variant with request cancellation and per-variant
/// serialization. Concurrent callers share the verified files: only the
/// first performs network I/O; waiters reuse the pinned-hash result.
#[tauri::command]
pub async fn ocr_download_model(
    app: tauri::AppHandle,
    backend: String,
    variant: Option<String>,
    request_id: Option<String>,
) -> Result<DownloadResult, String> {
    use tauri::Emitter as _;
    let progress = Arc::new(move |event: DownloadProgressEvent| {
        let _ = app.emit("ocr://download-progress", event);
    });
    ocr_download_model_with_emitter(backend, variant, request_id, progress).await
}

/// Host-neutral model download used by cognia-server. Progress delivery is
/// injected so the desktop can emit a Tauri event while headless publishes
/// the same payload through the authenticated companion EventBus.
pub async fn ocr_download_model_with_emitter(
    backend: String,
    variant: Option<String>,
    request_id: Option<String>,
    progress: Arc<dyn Fn(DownloadProgressEvent) + Send + Sync>,
) -> Result<DownloadResult, String> {
    let lock = model_download_lock(&backend, variant.as_deref());
    let run = async {
        let _guard = lock.lock().await;
        download_model_inner(progress, backend, variant).await
    };
    let Some(request_id) = request_id.filter(|id| !id.trim().is_empty()) else {
        return run.await;
    };
    let (generation, mut cancel_rx) = model_download_cancellations().register(&request_id);
    let result = tokio::select! {
        result = run => result,
        _ = &mut cancel_rx => Err("OCR model download cancelled".into()),
    };
    model_download_cancellations().finish(&request_id, generation);
    result
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
            model_variant: None,
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
    async fn available_ids_excludes_unavailable_backends() {
        struct Unavailable;
        impl NativeBackend for Unavailable {
            fn id(&self) -> &'static str {
                "placeholder"
            }
            fn extract(
                &self,
                _payload: &NativeOcrInvokePayload,
            ) -> Result<NativeOcrResult, NativeOcrError> {
                Err(NativeOcrError::MissingBinding("placeholder"))
            }
            fn is_available(&self) -> bool {
                false
            }
        }
        let registry = NativeOcrRegistry::new();
        registry.register(Box::new(Unavailable)).await;
        assert!(registry.available_ids().await.is_empty());
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
            model_variant: None,
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
        let spec = model_spec("ocrs", None).expect("ocrs spec present");
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
        let spec = model_spec("paddle-ocr", Some("v6-small")).expect("paddle-ocr spec present");
        assert_eq!(spec.len(), 3);
        let names: Vec<&str> = spec.iter().map(|s| s.file_name).collect();
        assert!(names.contains(&crate::backend::paddle::DETECTION_MODEL_FILE));
        assert!(names.contains(&crate::backend::paddle::RECOGNITION_MODEL_FILE));
        assert!(names.contains(&crate::backend::paddle::DICTIONARY_FILE));
        // PP-OCRv6 ONNX conversions + dict live on the oar-ocr v0.7 release.
        for entry in &spec {
            assert!(
                entry
                    .url
                    .starts_with("https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/"),
                "unexpected paddle model host: {}",
                entry.url
            );
        }
    }

    #[test]
    fn model_spec_returns_none_for_unmanaged_backend() {
        assert!(model_spec("tesseract", None).is_none());
        assert!(model_spec("apple-vision", None).is_none());
        assert!(model_spec("unknown", None).is_none());
        assert!(model_spec("paddle-ocr", Some("v6-medium")).is_none());
    }

    #[test]
    fn build_model_status_reports_empty_directory() {
        let tmp = tempdir().unwrap();
        let spec = model_spec("ocrs", None).unwrap();
        let status = build_model_status("ocrs", None, tmp.path().to_path_buf(), &spec);
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
        let spec = vec![ModelFileSpec {
            file_name: "model.bin",
            url: "https://example.invalid/model.bin",
            expected_bytes: 4,
            sha256: "725c546b990dd1b41f3d5791b37c3c0edcb1f08cf150bdae32a73dfd166e02d7",
        }];
        std::fs::write(tmp.path().join("model.bin"), b"stub").unwrap();
        let status = build_model_status("ocrs", None, tmp.path().to_path_buf(), &spec);
        assert!(status.installed);
        assert_eq!(status.integrity, ModelIntegrity::Verified);
        assert_eq!(status.total_bytes, 4);
        for f in &status.files {
            assert!(f.installed);
            assert_eq!(f.actual_bytes, Some(4));
        }
    }

    #[test]
    fn build_model_status_rejects_a_present_but_corrupt_complete_install() {
        let tmp = tempdir().unwrap();
        let spec = vec![ModelFileSpec {
            file_name: "model.bin",
            url: "https://example.invalid/model.bin",
            expected_bytes: 4,
            sha256: "725c546b990dd1b41f3d5791b37c3c0edcb1f08cf150bdae32a73dfd166e02d7",
        }];
        std::fs::write(tmp.path().join("model.bin"), b"bad!").unwrap();

        let status = build_model_status("ocrs", None, tmp.path().to_path_buf(), &spec);

        assert!(!status.installed);
        assert_eq!(status.integrity, ModelIntegrity::Corrupt);
        assert_eq!(status.files[0].integrity, ModelIntegrity::Corrupt);
    }

    #[test]
    fn build_model_status_handles_partial_install() {
        let tmp = tempdir().unwrap();
        let spec = model_spec("paddle-ocr", Some("v6-small")).unwrap();
        std::fs::write(tmp.path().join(spec[0].file_name), vec![0u8; 10]).unwrap();
        let status = build_model_status(
            "paddle-ocr",
            Some("v6-small"),
            tmp.path().to_path_buf(),
            &spec,
        );
        assert!(!status.installed);
        assert_eq!(status.total_bytes, 10);
        assert!(!status.files[0].installed);
        assert_eq!(status.files[0].integrity, ModelIntegrity::Corrupt);
        assert!(!status.files[1].installed);
    }

    #[test]
    fn build_model_status_reports_legacy_paddle_files_as_non_active() {
        let tmp = tempdir().unwrap();
        let active_dir = tmp.path().join("v6-small");
        std::fs::create_dir_all(&active_dir).unwrap();
        for name in [
            crate::backend::paddle::DETECTION_MODEL_FILE,
            crate::backend::paddle::RECOGNITION_MODEL_FILE,
            crate::backend::paddle::DICTIONARY_FILE,
        ] {
            std::fs::write(tmp.path().join(name), b"legacy-v5").unwrap();
        }

        let spec = model_spec("paddle-ocr", Some("v6-small")).unwrap();
        let status = build_model_status("paddle-ocr", Some("v6-small"), active_dir, &spec);

        assert!(!status.installed);
        assert_eq!(
            status.legacy_model_dir.as_deref(),
            Some(tmp.path().to_string_lossy().as_ref())
        );
        assert_eq!(status.legacy_files.len(), 3);
        assert!(status.reason.unwrap().contains("legacy PP-OCRv5"));
    }

    #[test]
    fn persist_download_atomically_replaces_a_corrupt_existing_file() {
        use std::io::Write as _;

        let tmp = tempdir().unwrap();
        let final_path = tmp.path().join("model.bin");
        std::fs::write(&final_path, b"corrupt").unwrap();
        let mut temporary = tempfile::NamedTempFile::new_in(tmp.path()).unwrap();
        temporary.write_all(b"verified").unwrap();

        persist_download(temporary.into_temp_path(), &final_path).unwrap();

        assert_eq!(std::fs::read(final_path).unwrap(), b"verified");
    }

    #[tokio::test]
    async fn ocr_model_status_for_unmanaged_backend_returns_reason() {
        let status = ocr_model_status("tesseract".to_string(), None)
            .await
            .unwrap();
        assert!(!status.installed);
        assert!(status.reason.is_some());
        assert!(status.files.is_empty());
    }

    #[tokio::test]
    async fn ocr_model_status_for_ocrs_reports_files_list() {
        // The data dir may or may not contain models on the test runner —
        // we only assert structural invariants here so the test passes
        // regardless of dev environment state.
        let status = ocr_model_status("ocrs".to_string(), None).await.unwrap();
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

    #[tokio::test]
    async fn ocr_http_policy_allows_loopback_without_confirmation() {
        assert!(
            validate_and_resolve_ocr_http_target("http://127.0.0.1:1224/api/ocr", false)
                .await
                .is_ok()
        );
        assert!(
            validate_and_resolve_ocr_http_target("http://[::1]:1224/api/ocr", false)
                .await
                .is_ok()
        );
        assert!(
            validate_and_resolve_ocr_http_target("http://localhost:1224/api/ocr", false)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn ocr_http_policy_requires_confirmation_for_private_lan() {
        let endpoint = "http://192.168.1.20:1224/api/ocr";
        assert!(validate_and_resolve_ocr_http_target(endpoint, false)
            .await
            .unwrap_err()
            .contains("explicit confirmation"));
        assert!(validate_and_resolve_ocr_http_target(endpoint, true)
            .await
            .is_ok());
        assert!(
            validate_and_resolve_ocr_http_target("http://[fd00::20]:1224/api/ocr", true)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn ocr_http_policy_rejects_public_link_local_and_metadata_targets() {
        for endpoint in [
            "https://8.8.8.8/ocr",
            "http://169.254.169.254/latest/meta-data",
            "http://[fe80::1]/ocr",
            "ftp://127.0.0.1/ocr",
        ] {
            assert!(
                validate_and_resolve_ocr_http_target(endpoint, true)
                    .await
                    .is_err(),
                "endpoint should be rejected: {endpoint}"
            );
        }
    }

    #[test]
    fn ocr_http_response_uses_renderer_contract_field_names() {
        let value = serde_json::to_value(OcrHttpResponse {
            status: 200,
            body: "{}".into(),
            content_type: Some("application/json".into()),
        })
        .unwrap();
        assert_eq!(value["contentType"], "application/json");
        assert!(value.get("content_type").is_none());
    }

    #[test]
    fn concurrent_model_downloads_share_a_variant_lock() {
        let first = model_download_lock("paddle-ocr", Some("v6-small"));
        let second = model_download_lock("paddle-ocr", Some("v6-small"));
        let other = model_download_lock("paddle-ocr", Some("v6-tiny"));
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn model_download_cancel_terminates_the_registered_request() {
        let (_generation, receiver) = model_download_cancellations().register("download-1");
        assert!(ocr_cancel_model_download("download-1".into()));
        assert!(receiver.blocking_recv().is_ok());
        assert!(!ocr_cancel_model_download("download-1".into()));
    }
}
