//! Screen capture via `xcap`. Works cross-platform; used by every backend
//! (Windows UIA + macOS AX + Linux AT-SPI) so screenshot semantics stay
//! identical across platforms.
//!
//! Output is always PNG by default; `format` is honored as a hint and may
//! be lifted later (xcap emits raw RGBA frames; PNG / JPEG encoding goes
//! through the `image` crate).

use std::io::Cursor;

use base64::engine::general_purpose;
use base64::Engine as _;
use xcap::image::{self, RgbaImage};
use xcap::Monitor;

use crate::automation::types::*;

pub fn capture_primary(opts: &ScreenshotOpts) -> Result<Screenshot> {
    let monitors =
        Monitor::all().map_err(|e| AutomationError::BackendError {
            message: format!("xcap enumerate monitors failed: {e}"),
        })?;
    if monitors.is_empty() {
        return Err(AutomationError::BackendError {
            message: "no monitors detected".into(),
        });
    }
    // Explicit monitor pick first (`opts.monitor_id` from
    // `Capabilities.monitors`); unknown / absent ids fall back to the
    // primary. `xcap` returns monitors in OS order; the primary is the one
    // with `is_primary() == true`. Fall back to the first monitor if no
    // primary flag is set (rare; happens on some virtual displays).
    let mon = opts
        .monitor_id
        .as_deref()
        .and_then(|want| monitors.iter().find(|m| m.id().to_string() == want))
        .cloned()
        .unwrap_or_else(|| {
            monitors
                .iter()
                .find(|m| m.is_primary())
                .cloned()
                .unwrap_or_else(|| monitors[0].clone())
        });

    let image = mon.capture_image().map_err(|e| AutomationError::BackendError {
        message: format!("monitor capture_image failed: {e}"),
    })?;

    // Optional crop. If the region falls outside the monitor we clamp.
    let (full_w, full_h) = (image.width(), image.height());
    let format = opts.format.unwrap_or_default();

    let (final_w, final_h, bytes) = if let Some(region) = opts.region {
        let x = region.x.max(0) as u32;
        let y = region.y.max(0) as u32;
        let w = (region.width.max(0) as u32).min(full_w.saturating_sub(x));
        let h = (region.height.max(0) as u32).min(full_h.saturating_sub(y));
        let cropped = image::imageops::crop_imm(&image, x, y, w, h).to_image();
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        encode(&cropped, format, &mut out)?;
        (w, h, out)
    } else {
        let mut out = Vec::with_capacity((full_w * full_h * 4) as usize);
        encode(&image, format, &mut out)?;
        (full_w, full_h, out)
    };

    Ok(Screenshot {
        bytes: general_purpose::STANDARD.encode(&bytes),
        width: final_w,
        height: final_h,
        captured_at: chrono::Utc::now().timestamp_millis(),
        format,
        source_width: None,
        source_height: None,
    })
}

/// Enumerate monitors for `Capabilities.monitors`. Failure → empty vec —
/// capabilities is a probe and must never error the whole call.
pub fn list_monitors() -> Vec<MonitorInfo> {
    let Ok(monitors) = Monitor::all() else {
        return vec![];
    };
    monitors
        .iter()
        .map(|m| MonitorInfo {
            id: m.id().to_string(),
            name: m.name().to_string(),
            x: m.x(),
            y: m.y(),
            width: m.width(),
            height: m.height(),
            is_primary: m.is_primary(),
            scale_factor: m.scale_factor(),
        })
        .collect()
}

/// Downscale to fit within (max_w, max_h) preserving aspect ratio.
/// No-op when already within bounds.
pub(crate) fn resize_to_fit(image: RgbaImage, max_w: u32, max_h: u32) -> RgbaImage {
    let (w, h) = (image.width(), image.height());
    if w <= max_w && h <= max_h {
        return image;
    }
    let scale = f64::min(f64::from(max_w) / f64::from(w), f64::from(max_h) / f64::from(h));
    let nw = ((f64::from(w)) * scale).round().max(1.0) as u32;
    let nh = ((f64::from(h)) * scale).round().max(1.0) as u32;
    image::imageops::resize(&image, nw, nh, image::imageops::FilterType::Lanczos3)
}

/// Decode an already-encoded `Screenshot`, downscale to fit, re-encode.
/// `desktop_screenshot` applies this AFTER capture so local and remote
/// (cua) screenshots scale through one code path. No-op (returns the
/// input untouched, `source_*` stays `None`) when already within bounds.
pub fn downscale_encoded(shot: Screenshot, max_w: u32, max_h: u32) -> Result<Screenshot> {
    if shot.width <= max_w && shot.height <= max_h {
        return Ok(shot);
    }
    let raw = general_purpose::STANDARD.decode(&shot.bytes).map_err(|e| {
        AutomationError::BackendError {
            message: format!("downscale: b64 decode failed: {e}"),
        }
    })?;
    let img = image::load_from_memory(&raw)
        .map_err(|e| AutomationError::BackendError {
            message: format!("downscale: image decode failed: {e}"),
        })?
        .to_rgba8();
    let resized = resize_to_fit(img, max_w, max_h);
    let (nw, nh) = (resized.width(), resized.height());
    let mut out = Vec::with_capacity((nw * nh * 4) as usize);
    encode(&resized, shot.format, &mut out)?;
    Ok(Screenshot {
        bytes: general_purpose::STANDARD.encode(&out),
        width: nw,
        height: nh,
        captured_at: shot.captured_at,
        format: shot.format,
        source_width: Some(shot.width),
        source_height: Some(shot.height),
    })
}

fn encode(img: &RgbaImage, format: ImageFormat, out: &mut Vec<u8>) -> Result<()> {
    let mut cursor = Cursor::new(out);
    let fmt = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
    };
    img.write_to(&mut cursor, fmt)
        .map_err(|e| AutomationError::BackendError {
            message: format!("png encode failed: {e}"),
        })
}

/// Return a new `Screenshot` with identical dimensions / format /
/// timestamp metadata but whose pixel bytes are a uniform black image.
/// The dispatcher calls this when `AutomationSettings.redact_screenshots`
/// is on AND the foreground window is a credential prompt — the model
/// still sees a tool_result of the expected shape, but no sensitive
/// pixels leak.
pub fn redact_screenshot(original: Screenshot) -> Result<Screenshot> {
    let blank = RgbaImage::new(original.width, original.height);
    let mut out: Vec<u8> = Vec::with_capacity((original.width * original.height * 4) as usize);
    encode(&blank, original.format, &mut out)?;
    Ok(Screenshot {
        bytes: general_purpose::STANDARD.encode(&out),
        width: original.width,
        height: original.height,
        captured_at: original.captured_at,
        format: original.format,
        source_width: original.source_width,
        source_height: original.source_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(w: u32, h: u32) -> Screenshot {
        Screenshot {
            bytes: "anything".into(),
            width: w,
            height: h,
            captured_at: 1_700_000_000,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        }
    }

    /// Build a real encoded PNG screenshot of the given dimensions.
    fn encoded_shot(w: u32, h: u32) -> Screenshot {
        let img = RgbaImage::new(w, h);
        let mut bytes = Vec::new();
        encode(&img, ImageFormat::Png, &mut bytes).unwrap();
        Screenshot {
            bytes: general_purpose::STANDARD.encode(&bytes),
            width: w,
            height: h,
            captured_at: 1,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        }
    }

    #[test]
    fn resize_to_fit_no_op_when_within_bounds() {
        let img = RgbaImage::new(800, 600);
        let out = resize_to_fit(img, 1280, 800);
        assert_eq!((out.width(), out.height()), (800, 600));
    }

    #[test]
    fn resize_to_fit_preserves_aspect_ratio() {
        let img = RgbaImage::new(2560, 1440);
        let out = resize_to_fit(img, 1280, 800);
        // Limited by width: 2560→1280 (×0.5) → 1440→720.
        assert_eq!((out.width(), out.height()), (1280, 720));
    }

    #[test]
    fn resize_to_fit_never_collapses_to_zero() {
        let img = RgbaImage::new(4000, 2);
        let out = resize_to_fit(img, 100, 100);
        assert!(out.width() >= 1 && out.height() >= 1);
    }

    #[test]
    fn downscale_encoded_sets_source_dims() {
        let out = downscale_encoded(encoded_shot(64, 32), 32, 32).unwrap();
        assert_eq!((out.width, out.height), (32, 16));
        assert_eq!(out.source_width, Some(64));
        assert_eq!(out.source_height, Some(32));
        // Payload must still be a decodable PNG of the new size.
        let raw = general_purpose::STANDARD.decode(&out.bytes).unwrap();
        let img = image::load_from_memory(&raw).unwrap();
        assert_eq!((img.width(), img.height()), (32, 16));
    }

    #[test]
    fn downscale_encoded_no_op_within_bounds() {
        let original = encoded_shot(16, 16);
        let original_b64 = original.bytes.clone();
        let out = downscale_encoded(original, 1280, 800).unwrap();
        assert_eq!(out.bytes, original_b64);
        assert_eq!(out.source_width, None);
        assert_eq!(out.source_height, None);
    }

    #[test]
    fn downscale_encoded_rejects_garbage_payload() {
        let bad = Screenshot {
            bytes: "!!!not-base64!!!".into(),
            width: 4000,
            height: 4000,
            captured_at: 1,
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        };
        assert!(downscale_encoded(bad, 100, 100).is_err());
    }

    #[test]
    fn redact_preserves_dimensions_and_timestamp() {
        let r = redact_screenshot(shot(640, 480)).unwrap();
        assert_eq!(r.width, 640);
        assert_eq!(r.height, 480);
        assert_eq!(r.captured_at, 1_700_000_000);
        assert_eq!(r.format, ImageFormat::Png);
    }

    #[test]
    fn redact_replaces_payload_bytes() {
        let original = shot(8, 8);
        let original_bytes = original.bytes.clone();
        let r = redact_screenshot(original).unwrap();
        // Same nominal shape, but the encoded payload swaps out (a black
        // 8×8 PNG decodes to base64 differently than the placeholder string).
        assert_ne!(r.bytes, original_bytes);
        // Base64-decoded PNG must begin with the PNG magic bytes.
        let raw = general_purpose::STANDARD.decode(&r.bytes).unwrap();
        assert_eq!(&raw[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }
}
