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
    let monitors = Monitor::all().map_err(|e| AutomationError::BackendError {
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
        .and_then(|want| {
            monitors
                .iter()
                .find(|m| m.id().is_ok_and(|id| id.to_string() == want))
        })
        .cloned()
        .unwrap_or_else(|| {
            monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .cloned()
                .unwrap_or_else(|| monitors[0].clone())
        });

    let image = mon
        .capture_image()
        .map_err(|e| AutomationError::BackendError {
            message: format!("monitor capture_image failed: {e}"),
        })?;

    // Optional crop. If the region falls outside the monitor we clamp.
    let (full_w, full_h) = (image.width(), image.height());
    let format = opts.format.unwrap_or_default();

    let (final_w, final_h, bytes) = if let Some(region) = opts.region {
        let (x, y, w, h) = clamp_crop_region(region, full_w, full_h);
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

/// Capture a region given in GLOBAL LOGICAL coordinates.
///
/// `capture_primary`'s `ScreenshotOpts.region` is monitor-local *physical*
/// pixels, which is the right contract for Computer Use (the model is looking
/// at a captured image and points at it). Callers that start from desktop
/// coordinates — a mouse drag, an AX element rect — have neither of those
/// properties, and passing such a rect straight through silently crops the
/// wrong area: doubly wrong on a Retina display, and wrong in origin as well
/// on any monitor that is not at the desktop origin.
///
/// So this is a separate entry point rather than a change to
/// `ScreenshotOpts`, which would have broken the Computer Use contract.
pub fn capture_global_region(region: Rect, format: ImageFormat) -> Result<Screenshot> {
    let monitors = Monitor::all().map_err(|e| AutomationError::BackendError {
        message: format!("xcap enumerate monitors failed: {e}"),
    })?;
    let infos = list_monitors();
    let (index, info) = infos
        .iter()
        .enumerate()
        .find(|(_, info)| monitor_contains_center(info, region))
        .ok_or_else(|| AutomationError::BackendError {
            message: "capture region falls outside every monitor".into(),
        })?;
    let local = global_rect_to_monitor_pixels(region, info).ok_or_else(|| {
        AutomationError::BackendError {
            message: "capture region does not intersect its monitor".into(),
        }
    })?;
    let monitor = monitors
        .get(index)
        .ok_or_else(|| AutomationError::BackendError {
            message: "monitor list changed during capture".into(),
        })?;

    let image = monitor
        .capture_image()
        .map_err(|e| AutomationError::BackendError {
            message: format!("monitor capture_image failed: {e}"),
        })?;
    let (x, y, w, h) = clamp_crop_region(local, image.width(), image.height());
    if w == 0 || h == 0 {
        return Err(AutomationError::BackendError {
            message: "capture region is empty after clamping".into(),
        });
    }
    let cropped = image::imageops::crop_imm(&image, x, y, w, h).to_image();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    encode(&cropped, format, &mut out)?;

    Ok(Screenshot {
        bytes: general_purpose::STANDARD.encode(&out),
        width: w,
        height: h,
        captured_at: chrono::Utc::now().timestamp_millis(),
        format,
        source_width: None,
        source_height: None,
    })
}

/// Whether the region's centre lies on this monitor. Centre rather than origin
/// so a selection that overhangs a screen edge still resolves to the monitor
/// the user is actually looking at.
fn monitor_contains_center(info: &MonitorInfo, region: Rect) -> bool {
    let cx = region.x + region.width / 2;
    let cy = region.y + region.height / 2;
    cx >= info.x
        && cy >= info.y
        && cx < info.x.saturating_add(info.width as i32)
        && cy < info.y.saturating_add(info.height as i32)
}

/// Global logical points → monitor-local physical pixels.
///
/// `xcap` reports monitor bounds in logical points (`CGDisplayBounds`) but
/// captures at `scale_factor` — so this both re-origins to the monitor and
/// scales to pixels. Pure, because it is the single place the whole OCR
/// fallback can silently read the wrong part of the screen.
pub(crate) fn global_rect_to_monitor_pixels(region: Rect, info: &MonitorInfo) -> Option<Rect> {
    let scale = if info.scale_factor.is_finite() && info.scale_factor > 0.0 {
        f64::from(info.scale_factor)
    } else {
        1.0
    };
    let local_x = f64::from(region.x - info.x) * scale;
    let local_y = f64::from(region.y - info.y) * scale;
    let width = f64::from(region.width) * scale;
    let height = f64::from(region.height) * scale;
    if width < 1.0 || height < 1.0 {
        return None;
    }
    Some(Rect {
        x: local_x.round() as i32,
        y: local_y.round() as i32,
        width: width.round() as i32,
        height: height.round() as i32,
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
        .filter_map(|m| {
            Some(MonitorInfo {
                id: m.id().ok()?.to_string(),
                name: m.name().ok()?,
                x: m.x().ok()?,
                y: m.y().ok()?,
                width: m.width().ok()?,
                height: m.height().ok()?,
                is_primary: m.is_primary().ok()?,
                scale_factor: m.scale_factor().ok()?,
            })
        })
        .collect()
}

pub(crate) fn clamp_crop_region(region: Rect, full_w: u32, full_h: u32) -> (u32, u32, u32, u32) {
    let x = i64::from(region.x).clamp(0, i64::from(full_w)) as u32;
    let y = i64::from(region.y).clamp(0, i64::from(full_h)) as u32;
    let w = i64::from(region.width)
        .max(0)
        .min(i64::from(full_w.saturating_sub(x))) as u32;
    let h = i64::from(region.height)
        .max(0)
        .min(i64::from(full_h.saturating_sub(y))) as u32;
    (x, y, w, h)
}

/// Downscale to fit within (max_w, max_h) preserving aspect ratio.
/// No-op when already within bounds.
pub(crate) fn resize_to_fit(image: RgbaImage, max_w: u32, max_h: u32) -> RgbaImage {
    let (w, h) = (image.width(), image.height());
    if w <= max_w && h <= max_h {
        return image;
    }
    let scale = f64::min(
        f64::from(max_w) / f64::from(w),
        f64::from(max_h) / f64::from(h),
    );
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

/// Crop an already-encoded `Screenshot` to `region`, expressed in the shot's
/// OWN pixel space (top-left origin), then re-encode.
///
/// This is the `zoom` primitive. Grounding accuracy on high-resolution screens
/// collapses when a whole desktop is squeezed into a model's vision budget —
/// small controls end up a few pixels across. Handing back just the region of
/// interest, at the resolution it was captured, is the cheapest known fix:
/// published crop-and-reground results roughly double single-step grounding
/// accuracy on professional-application screenshots.
///
/// The region is clamped to the image rather than rejected, because the model
/// is estimating a box off a picture — asking it to be pixel-exact about the
/// edges would fail calls for no benefit. An empty intersection IS an error,
/// though: that means the model is looking somewhere the frame does not cover,
/// and silently returning the whole screen would hide that.
pub fn crop_encoded(shot: Screenshot, region: Rect) -> Result<Screenshot> {
    let raw = general_purpose::STANDARD.decode(&shot.bytes).map_err(|e| {
        AutomationError::BackendError {
            message: format!("zoom: b64 decode failed: {e}"),
        }
    })?;
    let img = image::load_from_memory(&raw)
        .map_err(|e| AutomationError::BackendError {
            message: format!("zoom: image decode failed: {e}"),
        })?
        .to_rgba8();

    let (x, y, w, h) = clamp_crop_region(region, img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(AutomationError::BackendError {
            message: format!(
                "zoom: region {}x{} at ({},{}) does not intersect the {}x{} frame",
                region.width,
                region.height,
                region.x,
                region.y,
                img.width(),
                img.height()
            ),
        });
    }

    let cropped = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    encode(&cropped, shot.format, &mut out)?;
    Ok(Screenshot {
        bytes: general_purpose::STANDARD.encode(&out),
        width: w,
        height: h,
        captured_at: shot.captured_at,
        format: shot.format,
        // The crop is a window onto the frame the model already measured
        // against, so report that frame as the source. A caller mapping a
        // point back out of a zoom needs the offset too — which is why the
        // session layer returns the clamped region alongside this image.
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
    fn crop_encoded_returns_just_the_region() {
        let out = crop_encoded(
            encoded_shot(1600, 1200),
            Rect {
                x: 100,
                y: 200,
                width: 320,
                height: 240,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (320, 240));
        // The source dims describe the frame the crop came out of, so a caller
        // can still reason about where the region sits.
        assert_eq!(out.source_width, Some(1600));
        assert_eq!(out.source_height, Some(1200));
    }

    #[test]
    fn crop_encoded_clamps_an_overhanging_region() {
        // The model is estimating a box off a picture; demanding pixel-exact
        // edges would fail calls for no benefit.
        let out = crop_encoded(
            encoded_shot(100, 100),
            Rect {
                x: 80,
                y: 80,
                width: 400,
                height: 400,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (20, 20));
    }

    #[test]
    fn crop_encoded_rejects_a_region_outside_the_frame() {
        // An empty intersection means the model is looking somewhere the frame
        // does not cover. Silently returning the whole screen would hide that.
        let err = crop_encoded(
            encoded_shot(100, 100),
            Rect {
                x: 500,
                y: 500,
                width: 10,
                height: 10,
            },
        );
        assert!(err.is_err());
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
    fn clamp_crop_region_handles_origin_outside_image() {
        let region = Rect {
            x: 50,
            y: 30,
            width: 20,
            height: 20,
        };

        assert_eq!(clamp_crop_region(region, 10, 10), (10, 10, 0, 0));
    }

    #[test]
    fn clamp_crop_region_handles_negative_origin_and_oversized_region() {
        let region = Rect {
            x: -5,
            y: -7,
            width: 20,
            height: 30,
        };

        assert_eq!(clamp_crop_region(region, 12, 8), (0, 0, 12, 8));
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

    fn monitor(x: i32, y: i32, w: u32, h: u32, scale: f32) -> MonitorInfo {
        MonitorInfo {
            id: "1".into(),
            name: "Display".into(),
            x,
            y,
            width: w,
            height: h,
            is_primary: x == 0 && y == 0,
            scale_factor: scale,
        }
    }

    /// The single highest-value test here: without this conversion the OCR
    /// fallback crops the wrong rectangle on every Retina display, and the
    /// wrong origin on every non-primary monitor — and because it still
    /// returns *an* image, the failure is silent.
    #[test]
    fn a_global_region_maps_onto_a_retina_secondary_monitor() {
        // Secondary display starting at logical x=1512, captured at 2×.
        let info = monitor(1512, 0, 1512, 982, 2.0);
        let region = Rect {
            x: 1612,
            y: 100,
            width: 200,
            height: 40,
        };
        assert_eq!(
            global_rect_to_monitor_pixels(region, &info),
            Some(Rect {
                x: 200,
                y: 200,
                width: 400,
                height: 80
            })
        );
    }

    #[test]
    fn a_non_retina_primary_monitor_is_a_pure_reorigin() {
        let info = monitor(0, 0, 1920, 1080, 1.0);
        let region = Rect {
            x: 40,
            y: 60,
            width: 100,
            height: 20,
        };
        assert_eq!(global_rect_to_monitor_pixels(region, &info), Some(region));
    }

    #[test]
    fn a_degenerate_or_bogus_scale_never_produces_a_zero_sized_crop() {
        let info = monitor(0, 0, 1920, 1080, 2.0);
        // Zero-area selection: nothing to OCR.
        assert_eq!(
            global_rect_to_monitor_pixels(
                Rect {
                    x: 10,
                    y: 10,
                    width: 0,
                    height: 5
                },
                &info
            ),
            None
        );
        // A monitor reporting a nonsense scale must fall back to 1×, not
        // multiply the region by zero.
        let broken = monitor(0, 0, 1920, 1080, 0.0);
        assert_eq!(
            global_rect_to_monitor_pixels(
                Rect {
                    x: 10,
                    y: 10,
                    width: 30,
                    height: 8
                },
                &broken
            ),
            Some(Rect {
                x: 10,
                y: 10,
                width: 30,
                height: 8
            })
        );
    }

    #[test]
    fn a_region_is_assigned_to_the_monitor_under_its_centre() {
        let left = monitor(0, 0, 1512, 982, 2.0);
        let right = monitor(1512, 0, 1920, 1080, 1.0);
        // Straddles the seam but mostly on the right-hand display.
        let region = Rect {
            x: 1480,
            y: 20,
            width: 200,
            height: 30,
        };
        assert!(!monitor_contains_center(&left, region));
        assert!(monitor_contains_center(&right, region));
    }

    #[test]
    fn a_region_off_every_monitor_belongs_to_none() {
        let only = monitor(0, 0, 1920, 1080, 1.0);
        let region = Rect {
            x: 5000,
            y: 5000,
            width: 10,
            height: 10,
        };
        assert!(!monitor_contains_center(&only, region));
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
