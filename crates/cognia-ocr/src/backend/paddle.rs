//! PaddleOCR-via-ONNX native backend powered by `oar-ocr` (cross-platform).
//!
//! Gated on the `ocr-paddle` Cargo feature. Loads PP-OCRv5 ONNX models from
//! `<app_data>/cognia/ocr/paddle/`. The default install ships only the
//! `det` / `rec` / `dict` triple required by `OAROCRBuilder::new(…)`; an
//! optional `cls.onnx` (text-line orientation classifier) is wired up when
//! present.
//!
//! The free helpers (`resolve_model_dir`, `missing_models`, `decode_image`,
//! `BackendConfig::from_dir`) live outside the feature gate so the failure
//! paths remain unit-testable without `ort` / `oar-ocr` on the build path.

use std::path::{Path, PathBuf};

use crate::NativeOcrError;

#[cfg(feature = "ocr-paddle")]
use crate::{
    NativeBackend, NativeBoundingBox, NativeOcrBlock, NativeOcrInvokePayload, NativeOcrResult,
};

/// File names the auto-downloader writes inside `<model_dir>`. Kept in
/// sync with `ocr_download_model`'s download-manifest entries.
pub const DETECTION_MODEL_FILE: &str = "det.onnx";
pub const RECOGNITION_MODEL_FILE: &str = "rec.onnx";
pub const DICTIONARY_FILE: &str = "dict.txt";
/// Optional text-line orientation classifier. Not part of the mandatory
/// triple, so the constant is only referenced by the feature-gated builder
/// (in production) and by tests; mark dead-code-allowed.
#[allow(dead_code)]
pub const CLASSIFICATION_MODEL_FILE: &str = "cls.onnx";

/// Resolve the on-disk model directory. Honours `COGNIA_PADDLE_MODEL_DIR`
/// for tests / power-users; falls back to the user's data dir.
pub fn resolve_model_dir() -> Result<PathBuf, NativeOcrError> {
    if let Ok(override_path) = std::env::var("COGNIA_PADDLE_MODEL_DIR") {
        return Ok(PathBuf::from(override_path));
    }
    dirs::data_dir()
        .map(|d| d.join("cognia").join("ocr").join("paddle"))
        .ok_or_else(|| {
            NativeOcrError::BackendFailure(
                "cannot resolve user data directory for paddle-ocr models".to_string(),
            )
        })
}

/// Resolved on-disk file locations. `cls` is optional — `None` means run
/// without the orientation classifier (recognition quality is still good
/// on upright text). Marked `dead_code`-allowed because the production
/// code path is feature-gated; tests still exercise this struct.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub det: PathBuf,
    pub rec: PathBuf,
    pub dict: PathBuf,
    pub cls: Option<PathBuf>,
}

#[allow(dead_code)]
impl BackendConfig {
    /// Compose a config from the standard directory layout. The cls model
    /// is treated as optional — its absence does not produce an error.
    pub fn from_dir(model_dir: &Path) -> Self {
        let cls_path = model_dir.join(CLASSIFICATION_MODEL_FILE);
        Self {
            det: model_dir.join(DETECTION_MODEL_FILE),
            rec: model_dir.join(RECOGNITION_MODEL_FILE),
            dict: model_dir.join(DICTIONARY_FILE),
            cls: if cls_path.is_file() {
                Some(cls_path)
            } else {
                None
            },
        }
    }

    /// Names of the mandatory files that don't exist on disk. Empty Vec
    /// means the backend can start.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if !self.det.is_file() {
            missing.push(DETECTION_MODEL_FILE);
        }
        if !self.rec.is_file() {
            missing.push(RECOGNITION_MODEL_FILE);
        }
        if !self.dict.is_file() {
            missing.push(DICTIONARY_FILE);
        }
        missing
    }
}

/// Names of any mandatory files that are missing under `model_dir`. Empty
/// Vec means the backend can start. See `BackendConfig` for the same
/// dead-code allowance rationale.
#[allow(dead_code)]
pub fn missing_models(model_dir: &Path) -> Vec<&'static str> {
    BackendConfig::from_dir(model_dir).missing()
}

#[cfg(feature = "ocr-paddle")]
pub fn decode_image(bytes: &[u8]) -> Result<image::RgbImage, NativeOcrError> {
    let decoded = image::load_from_memory(bytes).map_err(|e| {
        NativeOcrError::BackendFailure(format!("paddle-ocr: failed to decode image bytes: {e}"))
    })?;
    Ok(decoded.into_rgb8())
}

/// Backend instance — caches the constructed `OAROCR` pipeline behind a
/// `Mutex` so subsequent calls skip the (expensive) ONNX-graph load.
#[cfg(feature = "ocr-paddle")]
pub struct PaddleOcrBackend {
    model_dir: PathBuf,
    pipeline: std::sync::Mutex<Option<oar_ocr::prelude::OAROCR>>,
}

#[cfg(feature = "ocr-paddle")]
impl PaddleOcrBackend {
    pub fn new() -> Result<Self, NativeOcrError> {
        Ok(Self {
            model_dir: resolve_model_dir()?,
            pipeline: std::sync::Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn with_model_dir(model_dir: PathBuf) -> Self {
        Self {
            model_dir,
            pipeline: std::sync::Mutex::new(None),
        }
    }

    fn build_pipeline(&self) -> Result<oar_ocr::prelude::OAROCR, NativeOcrError> {
        let cfg = BackendConfig::from_dir(&self.model_dir);
        let missing = cfg.missing();
        if !missing.is_empty() {
            return Err(NativeOcrError::BackendFailure(format!(
                "paddle-ocr models missing — run ocr_download_model to fetch: {}",
                missing.join(", ")
            )));
        }
        let mut builder = oar_ocr::prelude::OAROCRBuilder::new(&cfg.det, &cfg.rec, &cfg.dict);
        if let Some(cls_path) = cfg.cls.as_deref() {
            builder = builder.with_text_line_orientation_classification(cls_path);
        }
        builder
            .build()
            .map_err(|e| NativeOcrError::BackendFailure(format!("paddle-ocr: builder: {e}")))
    }
}

#[cfg(feature = "ocr-paddle")]
impl NativeBackend for PaddleOcrBackend {
    fn id(&self) -> &'static str {
        "paddle-ocr"
    }

    fn extract(&self, payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError> {
        // Get or initialize the pipeline. We hold the lock for the whole
        // predict() call because `OAROCR` is expensive to clone and its
        // internal state isn't documented as thread-safe across concurrent
        // predict invocations. OCR throughput per backend is single-image
        // anyway (the connector batches at a higher level).
        let mut guard = self.pipeline.lock().map_err(|_| {
            NativeOcrError::BackendFailure("paddle-ocr: pipeline mutex poisoned".to_string())
        })?;
        if guard.is_none() {
            *guard = Some(self.build_pipeline()?);
        }
        let pipeline = guard.as_ref().expect("pipeline just initialized above");

        let image = decode_image(&payload.bytes)?;
        let (width, height) = image.dimensions();

        let predictions = pipeline
            .predict(vec![image])
            .map_err(|e| NativeOcrError::BackendFailure(format!("paddle-ocr: predict: {e}")))?;
        let first = predictions.into_iter().next().ok_or_else(|| {
            NativeOcrError::BackendFailure("paddle-ocr: empty prediction batch".to_string())
        })?;

        let mut text_segments: Vec<String> = Vec::new();
        let mut blocks: Vec<NativeOcrBlock> = Vec::new();
        for region in &first.text_regions {
            let Some(text) = region.text.as_deref() else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            let text = text.to_string();
            text_segments.push(text.clone());
            blocks.push(NativeOcrBlock {
                text,
                bbox: region_bbox(region),
                confidence: region.confidence,
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

/// Collapse an `oar-ocr` text-region polygon to an axis-aligned bbox.
#[cfg(feature = "ocr-paddle")]
fn region_bbox(region: &oar_ocr::prelude::TextRegion) -> Option<NativeBoundingBox> {
    bbox_from_coords(
        region
            .bounding_box
            .points
            .iter()
            .map(|point| (point.x, point.y)),
    )
}

#[cfg(feature = "ocr-paddle")]
fn bbox_from_coords(points: impl IntoIterator<Item = (f32, f32)>) -> Option<NativeBoundingBox> {
    let points = points.into_iter().collect::<Vec<_>>();
    if points.is_empty() {
        return None;
    }
    let xs = points.iter().map(|p| p.0);
    let ys = points.iter().map(|p| p.1);
    let x_min = xs.clone().fold(f32::INFINITY, f32::min);
    let x_max = xs.fold(f32::NEG_INFINITY, f32::max);
    let y_min = ys.clone().fold(f32::INFINITY, f32::min);
    let y_max = ys.fold(f32::NEG_INFINITY, f32::max);
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
    fn backend_config_from_dir_returns_expected_paths() {
        let dir = PathBuf::from("/tmp/paddle-models");
        let cfg = BackendConfig::from_dir(&dir);
        assert!(cfg.det.ends_with(DETECTION_MODEL_FILE));
        assert!(cfg.rec.ends_with(RECOGNITION_MODEL_FILE));
        assert!(cfg.dict.ends_with(DICTIONARY_FILE));
        assert!(cfg.cls.is_none(), "cls.onnx should be None when absent");
    }

    #[test]
    fn backend_config_picks_up_cls_when_present() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(CLASSIFICATION_MODEL_FILE), b"stub").unwrap();
        let cfg = BackendConfig::from_dir(tmp.path());
        assert!(cfg.cls.is_some());
        let cls_path = cfg.cls.unwrap();
        assert!(cls_path.ends_with(CLASSIFICATION_MODEL_FILE));
    }

    #[test]
    fn missing_models_reports_all_three_when_dir_empty() {
        let tmp = tempdir().unwrap();
        let missing = missing_models(tmp.path());
        assert_eq!(missing.len(), 3);
        assert!(missing.contains(&DETECTION_MODEL_FILE));
        assert!(missing.contains(&RECOGNITION_MODEL_FILE));
        assert!(missing.contains(&DICTIONARY_FILE));
    }

    #[test]
    fn missing_models_is_empty_when_mandatories_present() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(DETECTION_MODEL_FILE), b"stub").unwrap();
        std::fs::write(tmp.path().join(RECOGNITION_MODEL_FILE), b"stub").unwrap();
        std::fs::write(tmp.path().join(DICTIONARY_FILE), b"stub").unwrap();
        let missing = missing_models(tmp.path());
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_models_ignores_optional_cls() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(DETECTION_MODEL_FILE), b"stub").unwrap();
        std::fs::write(tmp.path().join(RECOGNITION_MODEL_FILE), b"stub").unwrap();
        std::fs::write(tmp.path().join(DICTIONARY_FILE), b"stub").unwrap();
        // No cls.onnx → still considered ready.
        let missing = missing_models(tmp.path());
        assert!(missing.is_empty());
    }

    #[test]
    fn resolve_model_dir_honours_env_override() {
        let prev = env::var("COGNIA_PADDLE_MODEL_DIR").ok();
        env::set_var("COGNIA_PADDLE_MODEL_DIR", "/tmp/explicit-paddle-models");
        let resolved = resolve_model_dir().unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/explicit-paddle-models"));
        if let Some(p) = prev {
            env::set_var("COGNIA_PADDLE_MODEL_DIR", p);
        } else {
            env::remove_var("COGNIA_PADDLE_MODEL_DIR");
        }
    }

    #[cfg(feature = "ocr-paddle")]
    #[test]
    fn decode_image_rejects_non_image_bytes() {
        let err = decode_image(b"not an image").unwrap_err();
        match err {
            NativeOcrError::BackendFailure(msg) => assert!(msg.contains("decode")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[cfg(feature = "ocr-paddle")]
    #[test]
    fn backend_with_missing_models_returns_helpful_error() {
        let tmp = tempdir().unwrap();
        let backend = PaddleOcrBackend::with_model_dir(tmp.path().to_path_buf());
        assert_eq!(backend.id(), "paddle-ocr");
        let err = backend
            .extract(&NativeOcrInvokePayload {
                backend: "paddle-ocr".to_string(),
                bytes: vec![],
                mime_type: "image/png".to_string(),
                languages: vec!["zh-cn".to_string()],
            })
            .unwrap_err();
        match err {
            NativeOcrError::BackendFailure(msg) => {
                assert!(msg.contains("paddle-ocr models missing"));
                assert!(msg.contains(DETECTION_MODEL_FILE));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[cfg(feature = "ocr-paddle")]
    #[test]
    fn bbox_from_coords_collapses_polygon_to_axis_aligned_box() {
        let bbox =
            bbox_from_coords([(4.0, 10.0), (9.5, 7.0), (11.0, 14.0), (3.0, 13.0)]).expect("bbox");

        assert_eq!(bbox.x, 3.0);
        assert_eq!(bbox.y, 7.0);
        assert_eq!(bbox.width, 8.0);
        assert_eq!(bbox.height, 7.0);
    }

    #[cfg(feature = "ocr-paddle")]
    #[test]
    fn bbox_from_coords_rejects_empty_and_non_finite_points() {
        assert!(bbox_from_coords(std::iter::empty()).is_none());
        assert!(bbox_from_coords([(0.0, f32::NAN)]).is_none());
    }
}
