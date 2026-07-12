//! `ocrs`-backed native OCR engine (cross-platform, pure Rust).
//!
//! This backend is gated on the `ocr-ocrs` Cargo feature. It pairs the
//! `ocrs` crate (detection + recognition pipeline) with the `rten` runtime,
//! both pure-Rust — no CMake, no onnxruntime DLLs. Models live in
//! `<app_data>/cognia/ocr/ocrs/` and are downloaded on first use via the
//! `ocr_download_model` Tauri command. Each backend instance caches a built
//! `OcrEngine` behind a `Mutex` so subsequent calls skip the model-load
//! roundtrip.
//!
//! The implementation is split into a thin trait impl and a set of free
//! functions (`resolve_model_dir`, `expected_model_paths`,
//! `missing_models`, `decode_image`) so the failure paths are unit-testable
//! without the real `OcrEngine` (which needs a few MB of model weights to
//! construct).

use std::path::{Path, PathBuf};

use crate::NativeOcrError;

#[cfg(feature = "ocr-ocrs")]
use crate::{
    NativeBackend, NativeBoundingBox, NativeOcrBlock, NativeOcrInvokePayload, NativeOcrResult,
};
#[cfg(feature = "ocr-ocrs")]
use ocrs::TextItem;

/// File names the auto-downloader writes inside `<model_dir>`. Kept as
/// constants so the downloader and the loader agree without duplicating
/// strings.
pub const DETECTION_MODEL_FILE: &str = "text-detection.rten";
pub const RECOGNITION_MODEL_FILE: &str = "text-recognition.rten";

/// Resolve the on-disk model directory. Honours `COGNIA_OCRS_MODEL_DIR` for
/// tests / power-users; falls back to the user's data dir.
pub fn resolve_model_dir() -> Result<PathBuf, NativeOcrError> {
    if let Ok(override_path) = std::env::var("COGNIA_OCRS_MODEL_DIR") {
        return Ok(PathBuf::from(override_path));
    }
    dirs::data_dir()
        .map(|d| d.join("cognia").join("ocr").join("ocrs"))
        .ok_or_else(|| {
            NativeOcrError::BackendFailure(
                "cannot resolve user data directory for ocrs models".to_string(),
            )
        })
}

/// Return the relative filenames of any models that are missing. Empty Vec
/// means the directory is fully populated. Marked `dead_code`-allowed
/// because the function is only reached from the feature-gated extract
/// path; tests still exercise it.
#[allow(dead_code)]
pub fn missing_models(model_dir: &Path) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if !model_dir.join(DETECTION_MODEL_FILE).is_file() {
        missing.push(DETECTION_MODEL_FILE);
    }
    if !model_dir.join(RECOGNITION_MODEL_FILE).is_file() {
        missing.push(RECOGNITION_MODEL_FILE);
    }
    missing
}

/// Decode the wire bytes into an RGB image and return the raw buffer plus
/// `(width, height)`. Pulled out as a free function so the error mapping is
/// unit-testable without spinning up `ocrs`.
#[cfg(feature = "ocr-ocrs")]
pub fn decode_image(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), NativeOcrError> {
    let decoded = image::load_from_memory(bytes).map_err(|e| {
        NativeOcrError::BackendFailure(format!("ocrs: failed to decode image bytes: {e}"))
    })?;
    let rgb = decoded.into_rgb8();
    let (width, height) = rgb.dimensions();
    Ok((rgb.into_raw(), width, height))
}

/// Backend instance. Holds the `OcrEngine` behind a lazy `OnceCell` so the
/// expensive model-load happens at most once per process.
#[cfg(feature = "ocr-ocrs")]
pub struct OcrsBackend {
    model_dir: PathBuf,
    engine: once_cell::sync::OnceCell<ocrs::OcrEngine>,
}

#[cfg(feature = "ocr-ocrs")]
impl OcrsBackend {
    /// Build a backend that resolves models from the standard location.
    pub fn new() -> Result<Self, NativeOcrError> {
        Ok(Self {
            model_dir: resolve_model_dir()?,
            engine: once_cell::sync::OnceCell::new(),
        })
    }

    /// Build a backend with an explicit model directory — used in tests.
    #[cfg(test)]
    pub fn with_model_dir(model_dir: PathBuf) -> Self {
        Self {
            model_dir,
            engine: once_cell::sync::OnceCell::new(),
        }
    }

    fn ensure_engine(&self) -> Result<&ocrs::OcrEngine, NativeOcrError> {
        // OnceCell::get_or_try_init lands on stable behind a feature in
        // once_cell — emulate with manual guard so we can return our error
        // type without the unstable API.
        if let Some(existing) = self.engine.get() {
            return Ok(existing);
        }
        let missing = missing_models(&self.model_dir);
        if !missing.is_empty() {
            return Err(NativeOcrError::BackendFailure(format!(
                "ocrs models missing — run ocr_download_model to fetch: {}",
                missing.join(", ")
            )));
        }
        let det_path = self.model_dir.join(DETECTION_MODEL_FILE);
        let rec_path = self.model_dir.join(RECOGNITION_MODEL_FILE);
        let detection_model = rten::Model::load_file(&det_path).map_err(|e| {
            NativeOcrError::BackendFailure(format!(
                "ocrs: failed to load detection model {}: {e}",
                det_path.display()
            ))
        })?;
        let recognition_model = rten::Model::load_file(&rec_path).map_err(|e| {
            NativeOcrError::BackendFailure(format!(
                "ocrs: failed to load recognition model {}: {e}",
                rec_path.display()
            ))
        })?;
        let engine = ocrs::OcrEngine::new(ocrs::OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
        .map_err(|e| NativeOcrError::BackendFailure(format!("ocrs: engine init failed: {e}")))?;
        let _ = self.engine.set(engine);
        // OnceCell::set fails when already-set; either way `.get()` is Some now.
        self.engine.get().ok_or_else(|| {
            NativeOcrError::BackendFailure("ocrs: engine cache failed to populate".to_string())
        })
    }
}

#[cfg(feature = "ocr-ocrs")]
impl NativeBackend for OcrsBackend {
    fn id(&self) -> &'static str {
        "ocrs"
    }

    fn extract(&self, payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError> {
        let engine = self.ensure_engine()?;
        let (rgb, width, height) = decode_image(&payload.bytes)?;
        let src = ocrs::ImageSource::from_bytes(&rgb, (width, height))
            .map_err(|e| NativeOcrError::BackendFailure(format!("ocrs: image source: {e}")))?;
        let input = engine
            .prepare_input(src)
            .map_err(|e| NativeOcrError::BackendFailure(format!("ocrs: prepare_input: {e}")))?;
        let words = engine
            .detect_words(&input)
            .map_err(|e| NativeOcrError::BackendFailure(format!("ocrs: detect_words: {e}")))?;
        let lines = engine.find_text_lines(&input, &words);
        let line_texts = engine
            .recognize_text(&input, &lines)
            .map_err(|e| NativeOcrError::BackendFailure(format!("ocrs: recognize_text: {e}")))?;

        let mut text_segments: Vec<String> = Vec::new();
        let mut blocks: Vec<NativeOcrBlock> = Vec::new();
        for maybe_line in line_texts.iter() {
            let Some(line) = maybe_line else { continue };
            let rendered = line.to_string();
            if rendered.is_empty() {
                continue;
            }
            text_segments.push(rendered.clone());
            blocks.push(NativeOcrBlock {
                text: rendered,
                bbox: line_bbox(line),
                // ocrs 0.12 doesn't expose per-line confidence; leave as None
                // rather than synthesizing a fake number.
                confidence: None,
            });
        }

        Ok(NativeOcrResult {
            text: text_segments.join("\n"),
            blocks,
            width: Some(width as f32),
            height: Some(height as f32),
        })
    }
}

/// Compute an axis-aligned bbox from an ocrs line's recognized characters.
#[cfg(feature = "ocr-ocrs")]
fn line_bbox(line: &ocrs::TextLine) -> Option<NativeBoundingBox> {
    let rect = line.bounding_rect();
    if rect.is_empty() {
        return None;
    }
    let x_min = rect.left() as f32;
    let x_max = rect.right() as f32;
    let y_min = rect.top() as f32;
    let y_max = rect.bottom() as f32;
    if !x_min.is_finite() || !x_max.is_finite() || !y_min.is_finite() || !y_max.is_finite() {
        return None;
    }
    Some(NativeBoundingBox {
        x: x_min,
        y: y_min,
        width: (x_max - x_min).max(0.0),
        height: (y_max - y_min).max(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::tempdir;

    #[test]
    fn missing_models_reports_both_when_dir_empty() {
        let tmp = tempdir().unwrap();
        let missing = missing_models(tmp.path());
        assert_eq!(missing.len(), 2);
        assert!(missing.contains(&DETECTION_MODEL_FILE));
        assert!(missing.contains(&RECOGNITION_MODEL_FILE));
    }

    #[test]
    fn missing_models_reports_only_absent_files() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(DETECTION_MODEL_FILE), b"stub").unwrap();
        let missing = missing_models(tmp.path());
        assert_eq!(missing, vec![RECOGNITION_MODEL_FILE]);
    }

    #[test]
    fn missing_models_reports_none_when_complete() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(DETECTION_MODEL_FILE), b"stub").unwrap();
        std::fs::write(tmp.path().join(RECOGNITION_MODEL_FILE), b"stub").unwrap();
        let missing = missing_models(tmp.path());
        assert!(missing.is_empty());
    }

    #[test]
    fn resolve_model_dir_honours_env_override() {
        // SAFETY: env::set_var is unsafe on edition 2024 but stable here.
        // The test must not run in parallel with anything else that reads
        // COGNIA_OCRS_MODEL_DIR — Cargo runs unit tests in the same binary
        // sequentially within a module's `tests` thread when using a single
        // env var, but we restore the previous value to be safe.
        let prev = env::var("COGNIA_OCRS_MODEL_DIR").ok();
        env::set_var("COGNIA_OCRS_MODEL_DIR", "/tmp/explicit-ocrs-models");
        let resolved = resolve_model_dir().unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/explicit-ocrs-models"));
        if let Some(p) = prev {
            env::set_var("COGNIA_OCRS_MODEL_DIR", p);
        } else {
            env::remove_var("COGNIA_OCRS_MODEL_DIR");
        }
    }

    #[cfg(feature = "ocr-ocrs")]
    #[test]
    fn decode_image_rejects_non_image_bytes() {
        let err = decode_image(b"not an image").unwrap_err();
        match err {
            NativeOcrError::BackendFailure(msg) => assert!(msg.contains("decode")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[cfg(feature = "ocr-ocrs")]
    #[test]
    fn backend_with_missing_models_returns_helpful_error() {
        let tmp = tempdir().unwrap();
        let backend = OcrsBackend::with_model_dir(tmp.path().to_path_buf());
        assert_eq!(backend.id(), "ocrs");
        let err = backend
            .extract(&NativeOcrInvokePayload {
                backend: "ocrs".to_string(),
                bytes: vec![],
                mime_type: "image/png".to_string(),
                languages: vec!["en".to_string()],
            })
            .unwrap_err();
        match err {
            NativeOcrError::BackendFailure(msg) => {
                assert!(msg.contains("ocrs models missing"));
                assert!(msg.contains(DETECTION_MODEL_FILE));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[cfg(feature = "ocr-ocrs")]
    #[test]
    fn line_bbox_collapses_character_rects_to_axis_aligned_box() {
        let line = ocrs::TextLine::new(vec![
            ocrs::TextChar {
                char: 'A',
                rect: rten_imageproc::Rect::from_tlhw(10, 20, 5, 4),
            },
            ocrs::TextChar {
                char: 'B',
                rect: rten_imageproc::Rect::from_tlhw(12, 27, 6, 3),
            },
        ]);

        let bbox = line_bbox(&line).expect("line bbox");

        assert_eq!(bbox.x, 20.0);
        assert_eq!(bbox.y, 10.0);
        assert_eq!(bbox.width, 10.0);
        assert_eq!(bbox.height, 8.0);
    }
}
