use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{NativeBackend, NativeOcrError, NativeOcrInvokePayload, NativeOcrResult};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

pub struct TesseractBackend {
    executable: PathBuf,
}

impl Default for TesseractBackend {
    fn default() -> Self {
        Self {
            executable: PathBuf::from("tesseract"),
        }
    }
}

impl TesseractBackend {
    #[cfg(test)]
    pub fn with_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: path.into(),
        }
    }
}

impl NativeBackend for TesseractBackend {
    fn id(&self) -> &'static str {
        "tesseract"
    }

    fn extract(&self, payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError> {
        if payload.bytes.is_empty() {
            return Err(NativeOcrError::BackendFailure(
                "tesseract: empty image payload".to_string(),
            ));
        }
        if payload.bytes.len() > MAX_IMAGE_BYTES {
            return Err(NativeOcrError::BackendFailure(format!(
                "tesseract: image payload exceeds {} MiB limit",
                MAX_IMAGE_BYTES / 1024 / 1024
            )));
        }

        let extension = image_extension(&payload.mime_type)?;
        let languages = tesseract_language_arg(&payload.languages);
        let temp_dir = tempfile::tempdir()
            .map_err(|e| NativeOcrError::BackendFailure(format!("tesseract: temp dir: {e}")))?;
        let input_path = temp_dir.path().join(format!("input.{extension}"));
        let output_base = temp_dir.path().join("output");
        std::fs::write(&input_path, &payload.bytes).map_err(|e| {
            NativeOcrError::BackendFailure(format!(
                "tesseract: write input image {}: {e}",
                input_path.display()
            ))
        })?;

        let args = build_tesseract_args(&input_path, &output_base, &languages);
        log::info!(
            "tesseract OCR starting: bytes={} mime_type={} languages={}",
            payload.bytes.len(),
            payload.mime_type,
            languages
        );
        let output = Command::new(&self.executable)
            .args(&args)
            .output()
            .map_err(|e| {
                let message = if e.kind() == std::io::ErrorKind::NotFound {
                    "tesseract: executable not found; install Tesseract OCR or disable ocr-tesseract"
                        .to_string()
                } else {
                    format!("tesseract: spawn failed: {e}")
                };
                log::warn!("{message}");
                NativeOcrError::BackendFailure(message)
            })?;

        if !output.status.success() {
            let stderr = truncate_log_field(&String::from_utf8_lossy(&output.stderr));
            let status = output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated by signal".to_string());
            let message = format!("tesseract: process failed with status {status}: {stderr}");
            log::warn!("{message}");
            return Err(NativeOcrError::BackendFailure(message));
        }

        let output_path = output_base.with_extension("txt");
        let text = std::fs::read_to_string(&output_path).map_err(|e| {
            NativeOcrError::BackendFailure(format!(
                "tesseract: read output text {}: {e}",
                output_path.display()
            ))
        })?;

        Ok(NativeOcrResult {
            text: text.trim_end_matches(['\r', '\n']).to_string(),
            blocks: Vec::new(),
            width: None,
            height: None,
        })
    }
}

fn image_extension(mime_type: &str) -> Result<&'static str, NativeOcrError> {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Ok("png"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/bmp" | "image/x-ms-bmp" => Ok("bmp"),
        "image/tiff" | "image/tif" => Ok("tiff"),
        other => Err(NativeOcrError::BackendFailure(format!(
            "tesseract: unsupported image MIME type `{other}`"
        ))),
    }
}

fn tesseract_language_arg(languages: &[String]) -> String {
    let mut normalized = Vec::new();
    for language in languages {
        let Some(code) = normalize_language(language) else {
            continue;
        };
        if !normalized.iter().any(|existing| existing == &code) {
            normalized.push(code);
        }
    }
    if normalized.is_empty() {
        "eng".to_string()
    } else {
        normalized.join("+")
    }
}

fn normalize_language(language: &str) -> Option<String> {
    let value = language.trim().replace('_', "-").to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }

    let mapped = match value.as_str() {
        "en" | "en-us" | "en-gb" | "eng" => "eng",
        "zh" | "zh-cn" | "zh-hans" | "zh-sg" | "cmn" | "chi-sim" | "chi_sim" => "chi_sim",
        "zh-tw" | "zh-hant" | "zh-hk" | "chi-tra" | "chi_tra" => "chi_tra",
        "ja" | "ja-jp" | "jpn" => "jpn",
        "ko" | "ko-kr" | "kor" => "kor",
        "fr" | "fr-fr" | "fra" | "fre" => "fra",
        "de" | "de-de" | "deu" | "ger" => "deu",
        "es" | "es-es" | "spa" => "spa",
        "pt" | "pt-br" | "por" => "por",
        "ru" | "ru-ru" | "rus" => "rus",
        "it" | "it-it" | "ita" => "ita",
        "ar" | "ar-sa" | "ara" => "ara",
        _ => {
            if is_safe_tesseract_code(&value) {
                return Some(value);
            }
            let primary = value.split('-').next().unwrap_or_default();
            if primary == value {
                return None;
            }
            return normalize_language(primary);
        }
    };
    Some(mapped.to_string())
}

fn is_safe_tesseract_code(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn build_tesseract_args(input: &Path, output_base: &Path, languages: &str) -> Vec<String> {
    vec![
        input.to_string_lossy().into_owned(),
        output_base.to_string_lossy().into_owned(),
        "-l".to_string(),
        languages.to_string(),
        "--psm".to_string(),
        "3".to_string(),
    ]
}

fn truncate_log_field(value: &str) -> String {
    const MAX_LOG_FIELD: usize = 512;
    let trimmed = value.trim();
    if trimmed.len() <= MAX_LOG_FIELD {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..MAX_LOG_FIELD])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeOcrError, NativeOcrInvokePayload};

    fn payload(bytes: Vec<u8>, mime_type: &str, languages: Vec<&str>) -> NativeOcrInvokePayload {
        NativeOcrInvokePayload {
            backend: "tesseract".to_string(),
            bytes,
            mime_type: mime_type.to_string(),
            languages: languages.into_iter().map(str::to_string).collect(),
            model_variant: None,
        }
    }

    #[test]
    fn normalizes_bcp47_languages_to_tesseract_codes() {
        assert_eq!(
            tesseract_language_arg(&["en".into(), "zh-cn".into(), "eng".into()]),
            "eng+chi_sim"
        );
        assert_eq!(
            tesseract_language_arg(&["zh-tw".into(), "ja".into(), "ko".into()]),
            "chi_tra+jpn+kor"
        );
        assert_eq!(tesseract_language_arg(&[]), "eng");
    }

    #[test]
    fn maps_supported_image_mime_types_to_safe_extensions() {
        assert_eq!(image_extension("image/png").unwrap(), "png");
        assert_eq!(image_extension("image/jpeg").unwrap(), "jpg");
        assert_eq!(image_extension("image/webp").unwrap(), "webp");
        assert_eq!(image_extension("image/bmp").unwrap(), "bmp");
        assert_eq!(image_extension("image/tiff").unwrap(), "tiff");

        let err = image_extension("application/pdf").unwrap_err();
        assert!(err.to_string().contains("unsupported image MIME type"));
    }

    #[test]
    fn builds_shell_free_tesseract_arguments() {
        let args = build_tesseract_args(Path::new("input.png"), Path::new("output"), "eng+chi_sim");

        assert_eq!(
            args,
            vec![
                "input.png".to_string(),
                "output".to_string(),
                "-l".to_string(),
                "eng+chi_sim".to_string(),
                "--psm".to_string(),
                "3".to_string()
            ]
        );
    }

    #[test]
    fn backend_id_matches_dispatch_slot() {
        let backend = TesseractBackend::default();
        assert_eq!(backend.id(), "tesseract");
    }

    #[test]
    fn rejects_empty_payload_before_spawning_process() {
        let backend = TesseractBackend::with_executable("definitely-missing-tesseract");
        let err = backend
            .extract(&payload(Vec::new(), "image/png", vec!["en"]))
            .unwrap_err();

        match err {
            NativeOcrError::BackendFailure(message) => {
                assert!(message.contains("empty image payload"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
