//! Display-topology helpers — enumerate monitors, find/snapshot the current
//! primary, and promote a target monitor to primary (`ChangeDisplaySettingsEx`
//! + `CDS_SET_PRIMARY`, repositioning the others, then a final null apply).
//!
//! Making the virtual display primary is what keeps capture (`capture_primary`
//! picks `is_primary()`) and input (`MOUSEEVENTF_ABSOLUTE` normalizes to the
//! primary monitor) coordinate-consistent without touching those modules. On
//! release the driver restores the snapshotted primary.
//!
//! Windows-only; non-Windows builds get stubs so the crate compiles.

use super::VddError;

/// One active display device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    /// GDI device name, e.g. `\\.\DISPLAY1`.
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::ffi::c_void;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::POINTL;
    use windows::Win32::Graphics::Gdi::{
        ChangeDisplaySettingsExW, EnumDisplayDevicesW, EnumDisplaySettingsW, CDS_NORESET,
        CDS_SET_PRIMARY, CDS_TYPE, CDS_UPDATEREGISTRY, DEVMODEW, DISPLAY_DEVICEW,
        DISPLAY_DEVICE_ACTIVE, DISPLAY_DEVICE_PRIMARY_DEVICE, DISP_CHANGE_SUCCESSFUL, DM_POSITION,
        ENUM_CURRENT_SETTINGS,
    };

    fn wide_name(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn devmode_for(name_w: &[u16]) -> Option<DEVMODEW> {
        unsafe {
            let mut dm: DEVMODEW = std::mem::zeroed();
            dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            let ok = EnumDisplaySettingsW(PCWSTR(name_w.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm);
            if ok.as_bool() {
                Some(dm)
            } else {
                None
            }
        }
    }

    /// Enumerate active display adapters and their current geometry.
    pub fn list_active_devices() -> Vec<DisplayInfo> {
        let mut out = Vec::new();
        unsafe {
            let mut i = 0u32;
            loop {
                let mut dev: DISPLAY_DEVICEW = std::mem::zeroed();
                dev.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
                if !EnumDisplayDevicesW(PCWSTR::null(), i, &mut dev, 0).as_bool() {
                    break;
                }
                i += 1;
                if dev.StateFlags.0 & DISPLAY_DEVICE_ACTIVE.0 == 0 {
                    continue;
                }
                let name = wide_name(&dev.DeviceName);
                let primary = dev.StateFlags.0 & DISPLAY_DEVICE_PRIMARY_DEVICE.0 != 0;
                if let Some(dm) = devmode_for(&dev.DeviceName) {
                    let pos = dm.Anonymous1.Anonymous2.dmPosition;
                    out.push(DisplayInfo {
                        name,
                        x: pos.x,
                        y: pos.y,
                        width: dm.dmPelsWidth,
                        height: dm.dmPelsHeight,
                        primary,
                    });
                }
            }
        }
        out
    }

    /// Name of the current primary display, if any.
    pub fn current_primary() -> Option<String> {
        list_active_devices()
            .into_iter()
            .find(|d| d.primary)
            .map(|d| d.name)
    }

    /// Promote `target` to primary, repositioning every active display so the
    /// new primary sits at (0,0) and the others keep their relative geometry.
    pub fn set_primary(target: &str) -> Result<(), VddError> {
        let devices = list_active_devices();
        let anchor = devices
            .iter()
            .find(|d| d.name == target)
            .ok_or_else(|| VddError::Topology(format!("display {target} not found")))?;
        let (ox, oy) = (anchor.x, anchor.y);

        unsafe {
            for dev in &devices {
                let name_w: Vec<u16> = dev.name.encode_utf16().chain(std::iter::once(0)).collect();
                let Some(mut dm) = devmode_for(&name_w) else {
                    continue;
                };
                dm.Anonymous1.Anonymous2.dmPosition = POINTL {
                    x: dev.x - ox,
                    y: dev.y - oy,
                };
                dm.dmFields |= DM_POSITION;
                let mut flags = CDS_UPDATEREGISTRY | CDS_NORESET;
                if dev.name == target {
                    flags |= CDS_SET_PRIMARY;
                }
                let rc =
                    ChangeDisplaySettingsExW(PCWSTR(name_w.as_ptr()), Some(&dm), None, flags, None);
                if rc != DISP_CHANGE_SUCCESSFUL {
                    return Err(VddError::Topology(format!(
                        "ChangeDisplaySettingsExW({}) returned {}",
                        dev.name, rc.0
                    )));
                }
            }
            // Apply the batched registry changes.
            let rc = ChangeDisplaySettingsExW(
                PCWSTR::null(),
                None,
                None,
                CDS_TYPE(0),
                None::<*const c_void>,
            );
            if rc != DISP_CHANGE_SUCCESSFUL {
                return Err(VddError::Topology(format!(
                    "ChangeDisplaySettingsExW(apply) returned {}",
                    rc.0
                )));
            }
        }
        Ok(())
    }

    /// Geometry of a named display, if active.
    pub fn display_size(name: &str) -> Option<(u32, u32)> {
        list_active_devices()
            .into_iter()
            .find(|d| d.name == name)
            .map(|d| (d.width, d.height))
    }
}

#[cfg(target_os = "windows")]
pub use imp::{current_primary, display_size, list_active_devices, set_primary};

// ── Non-Windows stubs ──────────────────────────────────────────────────────
#[cfg(not(target_os = "windows"))]
pub fn list_active_devices() -> Vec<DisplayInfo> {
    Vec::new()
}
#[cfg(not(target_os = "windows"))]
pub fn current_primary() -> Option<String> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn set_primary(_target: &str) -> Result<(), VddError> {
    Err(VddError::Topology(
        "display topology is Windows-only".into(),
    ))
}
#[cfg(not(target_os = "windows"))]
pub fn display_size(_name: &str) -> Option<(u32, u32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_info_equality() {
        let a = DisplayInfo {
            name: "\\\\.\\DISPLAY1".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            primary: true,
        };
        assert_eq!(a.clone(), a);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn stubs_report_no_displays_off_windows() {
        assert!(list_active_devices().is_empty());
        assert!(current_primary().is_none());
        assert!(set_primary("x").is_err());
        assert!(display_size("x").is_none());
    }
}
