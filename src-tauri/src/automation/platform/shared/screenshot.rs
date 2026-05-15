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
