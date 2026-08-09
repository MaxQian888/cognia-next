//! Apple Vision text-recognition backend (macOS).
//!
//! Runs `VNRecognizeTextRequest` in-process through the `objc2-vision`
//! bindings — no sidecar, no model downloads; Vision.framework ships with
//! the OS. Vision reports bounding boxes normalized to the image with a
//! bottom-left origin; we convert to the pixel-space / top-left convention
//! the other native backends (ocrs, paddle) use, which requires probing the
//! image dimensions from the encoded bytes first.

use crate::{
    NativeBackend, NativeBoundingBox, NativeOcrError, NativeOcrInvokePayload, NativeOcrResult,
};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

#[derive(Default)]
pub struct AppleVisionBackend;

impl NativeBackend for AppleVisionBackend {
    fn id(&self) -> &'static str {
        "apple-vision"
    }

    fn extract(&self, payload: &NativeOcrInvokePayload) -> Result<NativeOcrResult, NativeOcrError> {
        if payload.bytes.is_empty() {
            return Err(NativeOcrError::BackendFailure(
                "empty image payload".to_string(),
            ));
        }
        let dims = image_dimensions(&payload.bytes);

        // Vision rejects images with any dimension ≤ 2 px ("image is too
        // small"). Nothing legible fits there anyway — and the settings-UI
        // health probe sends a 1×1 PNG — so report an empty success.
        if let Some((w, h)) = dims {
            if w < 3 || h < 3 {
                return Ok(NativeOcrResult {
                    text: String::new(),
                    blocks: Vec::new(),
                    width: Some(w as f32),
                    height: Some(h as f32),
                });
            }
        }

        let data = NSData::with_bytes(&payload.bytes);
        let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            options.as_ref(),
        );

        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let languages = map_languages(&payload.languages);
        if !languages.is_empty() {
            let ns_langs: Vec<Retained<NSString>> =
                languages.iter().map(|l| NSString::from_str(l)).collect();
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&ns_langs));
        }

        let as_vn_request: Retained<VNRequest> =
            Retained::into_super(Retained::into_super(request.clone()));
        let requests = NSArray::from_retained_slice(&[as_vn_request]);
        handler.performRequests_error(&requests).map_err(|err| {
            NativeOcrError::BackendFailure(format!(
                "Vision text recognition failed: {}",
                err.localizedDescription()
            ))
        })?;

        let mut blocks: Vec<crate::NativeOcrBlock> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        if let Some(observations) = request.results() {
            for obs in observations.iter() {
                let candidates = obs.topCandidates(1);
                let Some(candidate) = candidates.iter().next() else {
                    continue;
                };
                let text = candidate.string().to_string();
                if text.is_empty() {
                    continue;
                }
                let confidence = candidate.confidence();
                let bbox = dims.map(|(w, h)| {
                    let rect = unsafe { obs.boundingBox() };
                    normalized_to_pixel_bbox(
                        rect.origin.x,
                        rect.origin.y,
                        rect.size.width,
                        rect.size.height,
                        w as f32,
                        h as f32,
                    )
                });
                lines.push(text.clone());
                blocks.push(crate::NativeOcrBlock {
                    text,
                    bbox,
                    confidence: Some(confidence),
                });
            }
        }

        Ok(NativeOcrResult {
            text: lines.join("\n"),
            blocks,
            width: dims.map(|(w, _)| w as f32),
            height: dims.map(|(_, h)| h as f32),
        })
    }
}

/// Header-only probe for the encoded image's pixel dimensions. Returns
/// `None` for formats the `image` crate can't identify — OCR still runs,
/// but bounding boxes are omitted (they'd be meaningless without a scale).
fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// Convert Vision's normalized bottom-left-origin rect to the pixel-space
/// top-left-origin convention shared by the other native backends.
fn normalized_to_pixel_bbox(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    img_width: f32,
    img_height: f32,
) -> NativeBoundingBox {
    NativeBoundingBox {
        x: (x as f32 * img_width).max(0.0),
        y: ((1.0 - y - h) as f32 * img_height).max(0.0),
        width: (w as f32 * img_width).max(0.0),
        height: (h as f32 * img_height).max(0.0),
    }
}

/// Map the lowercase ISO-639-ish tags the TS layer sends to the BCP-47
/// identifiers Vision's recognizer expects. Unknown tags are dropped rather
/// than passed through — Vision fails the whole request on an unsupported
/// recognition language, and its default (English) is a better fallback.
fn map_languages(tags: &[String]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for tag in tags {
        let mapped = match tag.as_str() {
            "en" | "en-us" => Some("en-US"),
            "zh" | "zh-cn" | "zh-hans" | "chi_sim" => Some("zh-Hans"),
            "zh-tw" | "zh-hk" | "zh-hant" | "chi_tra" => Some("zh-Hant"),
            "ja" | "ja-jp" | "jpn" => Some("ja-JP"),
            "ko" | "ko-kr" | "kor" => Some("ko-KR"),
            "fr" | "fr-fr" | "fra" => Some("fr-FR"),
            "de" | "de-de" | "deu" => Some("de-DE"),
            "es" | "es-es" | "spa" => Some("es-ES"),
            "it" | "it-it" | "ita" => Some("it-IT"),
            "pt" | "pt-br" | "por" => Some("pt-BR"),
            "ru" | "ru-ru" | "rus" => Some("ru-RU"),
            "uk" | "uk-ua" | "ukr" => Some("uk-UA"),
            "th" | "th-th" | "tha" => Some("th-TH"),
            "vi" | "vi-vn" | "vie" => Some("vi-VT"),
            _ => None,
        };
        if let Some(lang) = mapped {
            if !out.contains(&lang) {
                out.push(lang);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([255, 255, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png)
            .expect("encode png");
        out.into_inner()
    }

    fn payload(bytes: Vec<u8>, languages: Vec<String>) -> NativeOcrInvokePayload {
        NativeOcrInvokePayload {
            backend: "apple-vision".to_string(),
            bytes,
            mime_type: "image/png".to_string(),
            languages,
            model_variant: None,
        }
    }

    #[test]
    fn id_round_trips() {
        assert_eq!(AppleVisionBackend.id(), "apple-vision");
    }

    #[test]
    fn extract_on_blank_image_returns_empty_text() {
        let result = AppleVisionBackend
            .extract(&payload(png_bytes(64, 64), vec!["en".to_string()]))
            .expect("vision extract on blank image");
        assert_eq!(result.text, "");
        assert!(result.blocks.is_empty());
        assert_eq!(result.width, Some(64.0));
        assert_eq!(result.height, Some(64.0));
    }

    #[test]
    fn extract_on_probe_sized_image_succeeds() {
        // The TS-side settings probe sends a 1×1 PNG — must not error.
        let result = AppleVisionBackend
            .extract(&payload(png_bytes(1, 1), vec!["en".to_string()]))
            .expect("vision extract on 1x1 probe image");
        assert_eq!(result.text, "");
    }

    #[test]
    fn extract_on_empty_payload_reports_backend_failure() {
        let err = AppleVisionBackend
            .extract(&payload(Vec::new(), vec![]))
            .unwrap_err();
        match err {
            NativeOcrError::BackendFailure(msg) => assert!(msg.contains("empty")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn normalized_bbox_converts_to_top_left_pixels() {
        // A rect covering the top-left quadrant in Vision coordinates:
        // origin (0, 0.5), size (0.5, 0.5) on a 200×100 image.
        let bbox = normalized_to_pixel_bbox(0.0, 0.5, 0.5, 0.5, 200.0, 100.0);
        assert_eq!(bbox.x, 0.0);
        assert_eq!(bbox.y, 0.0);
        assert_eq!(bbox.width, 100.0);
        assert_eq!(bbox.height, 50.0);
    }

    #[test]
    fn map_languages_translates_and_dedupes() {
        let tags = vec![
            "en".to_string(),
            "en-us".to_string(),
            "zh-cn".to_string(),
            "klingon".to_string(),
        ];
        assert_eq!(map_languages(&tags), vec!["en-US", "zh-Hans"]);
    }

    #[test]
    fn map_languages_drops_everything_unknown() {
        assert!(map_languages(&["xx".to_string()]).is_empty());
    }
}
