use std::ffi::c_void;

use uiautomation::patterns::{UITextPattern, UITextRange};
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
    SafeArrayUnaccessData,
};

use crate::automation::types::Rect;

const MAX_ANCESTORS: usize = 8;

pub fn selected_ranges(
    automation: &UIAutomation,
    focused: &UIElement,
) -> Option<(UIElement, Vec<UITextRange>)> {
    let walker = automation.get_control_view_walker().ok()?;
    let mut element = focused.clone();
    for _ in 0..=MAX_ANCESTORS {
        if element.is_password().unwrap_or(false) {
            return None;
        }
        if let Ok(pattern) = element.get_pattern::<UITextPattern>() {
            if let Ok(ranges) = pattern.get_selection() {
                if !ranges.is_empty() {
                    return Some((element, ranges));
                }
            }
        }
        element = walker.get_parent(&element).ok()?;
    }
    None
}

pub fn selected_text(ranges: &[UITextRange]) -> Option<String> {
    let mut parts = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Ok(text) = range.get_text(-1) {
            if !text.trim().is_empty() {
                parts.push(text);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub fn last_visible_bounds(ranges: &[UITextRange]) -> Option<Rect> {
    ranges
        .iter()
        .rev()
        .find_map(|range| bounding_rectangles(range).into_iter().last())
}

fn bounding_rectangles(range: &UITextRange) -> Vec<Rect> {
    let array = match unsafe { range.as_ref().GetBoundingRectangles() } {
        Ok(array) if !array.is_null() => array,
        _ => return Vec::new(),
    };
    let _array_guard = SafeArrayGuard(array);
    let lower = match unsafe { SafeArrayGetLBound(array, 1) } {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let upper = match unsafe { SafeArrayGetUBound(array, 1) } {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let len = (upper - lower + 1).max(0) as usize;
    if len < 4 {
        return Vec::new();
    }

    let mut data: *mut c_void = std::ptr::null_mut();
    if unsafe { SafeArrayAccessData(array, &mut data) }.is_err() || data.is_null() {
        return Vec::new();
    }
    let values = unsafe { std::slice::from_raw_parts(data.cast::<f64>(), len) };
    let rects = values
        .chunks_exact(4)
        .filter_map(|chunk| {
            let width = chunk[2].round() as i32;
            let height = chunk[3].round() as i32;
            (width > 0 && height > 0).then_some(Rect {
                x: chunk[0].round() as i32,
                y: chunk[1].round() as i32,
                width,
                height,
            })
        })
        .collect();
    let _ = unsafe { SafeArrayUnaccessData(array) };
    rects
}

struct SafeArrayGuard(*mut SAFEARRAY);

impl Drop for SafeArrayGuard {
    fn drop(&mut self) {
        let _ = unsafe { SafeArrayDestroy(self.0) };
    }
}
