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
    // `xcap` returns monitors in OS order; the primary is the one with
    // `is_primary() == true`. Fall back to the first monitor if no primary
    // flag is set (rare; happens on some virtual displays).
    let mon = monitors
        .iter()
        .find(|m| m.is_primary())
        .cloned()
        .unwrap_or_else(|| monitors[0].clone());

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
        }
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
