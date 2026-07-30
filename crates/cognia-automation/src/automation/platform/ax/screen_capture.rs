use std::ffi::{c_char, CStr, CString};

use base64::Engine;

use crate::automation::backend::ApplicationScreenshot;
use crate::automation::types::{
    AutomationError, ElementInfo, ImageFormat, Rect, Result, Screenshot, ScreenshotOpts,
};

#[repr(C)]
struct NativeCaptureResult {
    bytes: *mut u8,
    length: usize,
    width: u32,
    height: u32,
    window_id: u32,
    display_id: u32,
    logical_x: f64,
    logical_y: f64,
    logical_width: f64,
    logical_height: f64,
    point_pixel_scale: f64,
    error: *mut c_char,
}

impl Default for NativeCaptureResult {
    fn default() -> Self {
        Self {
            bytes: std::ptr::null_mut(),
            length: 0,
            width: 0,
            height: 0,
            window_id: 0,
            display_id: 0,
            logical_x: 0.0,
            logical_y: 0.0,
            logical_width: 0.0,
            logical_height: 0.0,
            point_pixel_scale: 0.0,
            error: std::ptr::null_mut(),
        }
    }
}

unsafe extern "C" {
    fn cognia_sc_capture_window(
        process_id: i32,
        preferred_title: *const c_char,
        has_bounds: bool,
        logical_x: f64,
        logical_y: f64,
        logical_width: f64,
        logical_height: f64,
        result: *mut NativeCaptureResult,
    ) -> bool;
    fn cognia_sc_capture_display(
        requested_display_id: u32,
        has_region: bool,
        region_x: f64,
        region_y: f64,
        region_width: f64,
        region_height: f64,
        result: *mut NativeCaptureResult,
    ) -> bool;
    fn cognia_sc_capture_result_free(result: *mut NativeCaptureResult);
}

struct NativeResultGuard(NativeCaptureResult);

impl Drop for NativeResultGuard {
    fn drop(&mut self) {
        unsafe {
            cognia_sc_capture_result_free(&mut self.0);
        }
    }
}

pub fn capture_application_window(
    process_id: u32,
    window_hint: Option<&ElementInfo>,
    opts: &ScreenshotOpts,
) -> Result<ApplicationScreenshot> {
    if opts.region.is_some() || opts.monitor_id.is_some() {
        return Err(AutomationError::BackendError {
            message: "app-session screenshots capture the matched window and reject region/monitor overrides"
                .into(),
        });
    }
    if matches!(opts.format, Some(ImageFormat::Jpeg)) {
        return Err(AutomationError::BackendError {
            message: "app-session screenshots use lossless PNG evidence".into(),
        });
    }

    let title = window_hint
        .and_then(|hint| hint.window_title.as_deref().or(hint.name.as_deref()))
        .and_then(|title| CString::new(title).ok());
    let bounds = window_hint.and_then(|hint| hint.bounding_rect);
    let mut native = NativeResultGuard(NativeCaptureResult::default());
    let success = unsafe {
        cognia_sc_capture_window(
            i32::try_from(process_id).map_err(|_| AutomationError::BackendError {
                message: "application process id exceeds macOS pid range".into(),
            })?,
            title
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            bounds.is_some(),
            bounds.map_or(0.0, |rect| f64::from(rect.x)),
            bounds.map_or(0.0, |rect| f64::from(rect.y)),
            bounds.map_or(0.0, |rect| f64::from(rect.width)),
            bounds.map_or(0.0, |rect| f64::from(rect.height)),
            &mut native.0,
        )
    };
    if !success {
        return Err(native_error(&native.0));
    }
    finish_capture(&native.0, true)
}

pub fn capture_display(opts: &ScreenshotOpts) -> Result<Screenshot> {
    if matches!(opts.format, Some(ImageFormat::Jpeg)) {
        return Err(AutomationError::BackendError {
            message: "macOS ScreenCaptureKit screenshots use lossless PNG evidence".into(),
        });
    }
    let display_id = opts
        .monitor_id
        .as_deref()
        .map(str::parse::<u32>)
        .transpose()
        .map_err(|_| AutomationError::BackendError {
            message: "macOS monitor id is not a Core Graphics display id".into(),
        })?
        .unwrap_or_default();
    let region = opts.region;
    let mut native = NativeResultGuard(NativeCaptureResult::default());
    let success = unsafe {
        cognia_sc_capture_display(
            display_id,
            region.is_some(),
            region.map_or(0.0, |rect| f64::from(rect.x)),
            region.map_or(0.0, |rect| f64::from(rect.y)),
            region.map_or(0.0, |rect| f64::from(rect.width)),
            region.map_or(0.0, |rect| f64::from(rect.height)),
            &mut native.0,
        )
    };
    if !success {
        return Err(native_error(&native.0));
    }
    Ok(finish_capture(&native.0, false)?.screenshot)
}

fn finish_capture(
    native: &NativeCaptureResult,
    require_window: bool,
) -> Result<ApplicationScreenshot> {
    if native.bytes.is_null()
        || native.length == 0
        || native.width == 0
        || native.height == 0
        || (require_window && native.window_id == 0)
        || !native.point_pixel_scale.is_finite()
        || native.point_pixel_scale <= 0.0
    {
        return Err(AutomationError::BackendError {
            message: "ScreenCaptureKit returned incomplete surface evidence".into(),
        });
    }

    let png = unsafe { std::slice::from_raw_parts(native.bytes, native.length) };
    Ok(ApplicationScreenshot {
        screenshot: Screenshot {
            bytes: base64::engine::general_purpose::STANDARD.encode(png),
            width: native.width,
            height: native.height,
            captured_at: unix_time_millis(),
            format: ImageFormat::Png,
            source_width: None,
            source_height: None,
        },
        window_id: (native.window_id != 0).then(|| u64::from(native.window_id)),
        display_id: (native.display_id != 0).then(|| native.display_id.to_string()),
        logical_bounds: Rect {
            x: round_to_i32(native.logical_x)?,
            y: round_to_i32(native.logical_y)?,
            width: round_to_i32(native.logical_width)?,
            height: round_to_i32(native.logical_height)?,
        },
        scale_factor: native.point_pixel_scale,
    })
}

fn native_error(native: &NativeCaptureResult) -> AutomationError {
    let message = if native.error.is_null() {
        "ScreenCaptureKit failed without an error".into()
    } else {
        unsafe { CStr::from_ptr(native.error) }
            .to_string_lossy()
            .into_owned()
    };
    AutomationError::BackendError { message }
}

fn round_to_i32(value: f64) -> Result<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(AutomationError::BackendError {
            message: "ScreenCaptureKit returned an invalid logical window rectangle".into(),
        });
    }
    Ok(value.round() as i32)
}

fn unix_time_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_finite_native_coordinates() {
        let error = round_to_i32(f64::NAN).unwrap_err();
        assert!(error
            .to_string()
            .contains("invalid logical window rectangle"));
    }

    #[test]
    fn rounds_screen_capture_kit_points() {
        assert_eq!(round_to_i32(-100.4).unwrap(), -100);
        assert_eq!(round_to_i32(501.6).unwrap(), 502);
    }

    #[test]
    #[ignore = "requires a signed macOS process with Screen Recording permission"]
    fn captures_a_live_application_window() {
        use crate::automation::backend::AutomationBackend;
        use crate::automation::session::ResolvedApplication;
        use crate::automation::types::TreeOpts;

        let process_id = std::env::var("COGNIA_SCK_TEST_PID")
            .expect("set COGNIA_SCK_TEST_PID to a one-window application")
            .parse()
            .expect("COGNIA_SCK_TEST_PID must be a u32");
        let backend = super::super::AxBackend::new().unwrap();
        let application = ResolvedApplication {
            bundle_id: None,
            path: None,
            display_name: "ScreenCaptureKit fixture".into(),
            process_id,
        };
        let roots = backend
            .read_application_tree(&application, TreeOpts::default())
            .unwrap();
        let capture =
            capture_application_window(process_id, roots.first(), &ScreenshotOpts::default())
                .unwrap();
        assert!(capture.window_id.is_some());
        assert!(capture.screenshot.width > 0);
        assert!(capture.screenshot.height > 0);
        assert!(!capture.screenshot.bytes.is_empty());
    }
}
