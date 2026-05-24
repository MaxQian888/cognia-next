//! Thin FFI over the bundled **parsec-vdd** driver (MIT, Microsoft-signed).
//!
//! Control surface is documented by the public `nomi-san/parsec-vdd`
//! reference: open the adapter device, then drive it with three IOCTLs —
//! `ADD` (plug a virtual monitor, returns its index), `REMOVE` (unplug an
//! index), `UPDATE` (keep-alive ping; the driver unplugs all added displays
//! ~1 s after the last ping). IOCTLs use overlapped I/O because `ADD` blocks
//! until the monitor arrives.
//!
//! The Win32 plumbing here is fully compiled & type-checked on Windows; the
//! exact ADD/REMOVE buffer conventions follow the public reference and must be
//! smoke-tested on hardware during bring-up (see the plan's verification
//! section — they cannot be exercised in CI without the signed driver loaded).
//! Non-Windows builds get a stub so the crate compiles everywhere.

use super::VddError;

/// parsec-vdd control IOCTLs (from the public reference header).
pub const VDD_IOCTL_ADD: u32 = 0x0022_e004;
pub const VDD_IOCTL_REMOVE: u32 = 0x0022_a008;
pub const VDD_IOCTL_UPDATE: u32 = 0x0022_a00c;

/// Device-interface path template for the Parsec display adapter. `%d` is the
/// instance index; we probe a small range so a non-zero enumeration still
/// resolves. (SetupAPI enumeration via the interface GUID is the more robust
/// alternative if a deployment ever surfaces a higher instance index.)
#[cfg(target_os = "windows")]
const DEVICE_PATH_TEMPLATE: &str =
    "\\\\?\\root#display#000{idx}#{{00b41627-04c4-429e-a26e-0265cf50c8fa}}";

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::ffi::c_void;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_IO_PENDING, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::IO::{DeviceIoControl, GetOverlappedResult, OVERLAPPED};

    /// `GENERIC_READ | GENERIC_WRITE` as the raw `u32` `CreateFileW` wants —
    /// avoids chasing the constant across windows-rs module moves.
    const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
    /// How long an IOCTL may block before we give up (ADD waits for the
    /// monitor to enumerate).
    const IO_TIMEOUT_MS: u32 = 5_000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Owned virtual-display device handle. `Drop` closes the OS handles, so an
    /// early `?` never leaks.
    pub struct VddDevice {
        device: HANDLE,
        event: HANDLE,
    }

    // The handle is owned exclusively by the controller thread; we never share
    // it across threads. Marking it explicitly keeps the type ergonomic to
    // hold inside the (thread-affine) driver without the compiler complaining
    // about the raw `HANDLE` pointer.
    unsafe impl Send for VddDevice {}

    impl VddDevice {
        /// Open the Parsec adapter device. Probes a small instance-index range.
        pub fn open() -> Result<Self, VddError> {
            let mut last = "no parsec-vdd device found".to_string();
            for idx in 0..5 {
                let path = DEVICE_PATH_TEMPLATE.replace("{idx}", &idx.to_string());
                match unsafe { Self::open_path(&path) } {
                    Ok(device) => {
                        let event = unsafe {
                            CreateEventW(None, true, false, PCWSTR::null())
                        }
                        .map_err(|e| {
                            // Don't leak the device if event creation fails.
                            let _ = unsafe { CloseHandle(device) };
                            VddError::Driver(format!("CreateEventW failed: {e}"))
                        })?;
                        return Ok(Self { device, event });
                    }
                    Err(e) => last = e,
                }
            }
            Err(VddError::Driver(last))
        }

        unsafe fn open_path(path: &str) -> Result<HANDLE, String> {
            let wpath = wide(path);
            let handle = CreateFileW(
                PCWSTR(wpath.as_ptr()),
                GENERIC_READ_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            )
            .map_err(|e| format!("CreateFileW({path}) failed: {e}"))?;
            if handle == INVALID_HANDLE_VALUE {
                return Err(format!("CreateFileW({path}) returned INVALID_HANDLE_VALUE"));
            }
            Ok(handle)
        }

        /// Run one overlapped IOCTL, blocking up to `IO_TIMEOUT_MS`.
        fn io_control(
            &self,
            code: u32,
            input: &[u8],
            output: &mut [u8],
        ) -> Result<u32, VddError> {
            unsafe {
                let mut overlapped: OVERLAPPED = std::mem::zeroed();
                overlapped.hEvent = self.event;
                let in_ptr = if input.is_empty() {
                    None
                } else {
                    Some(input.as_ptr() as *const c_void)
                };
                let out_ptr = if output.is_empty() {
                    None
                } else {
                    Some(output.as_mut_ptr() as *mut c_void)
                };
                let mut bytes_returned: u32 = 0;
                let res = DeviceIoControl(
                    self.device,
                    code,
                    in_ptr,
                    input.len() as u32,
                    out_ptr,
                    output.len() as u32,
                    Some(&mut bytes_returned),
                    Some(&mut overlapped),
                );
                if res.is_err() {
                    // ERROR_IO_PENDING is expected for overlapped I/O — wait.
                    if GetLastError() != ERROR_IO_PENDING {
                        return Err(VddError::Driver(format!(
                            "DeviceIoControl(0x{code:08x}) failed: {:?}",
                            res.err()
                        )));
                    }
                    if WaitForSingleObject(self.event, IO_TIMEOUT_MS) != WAIT_OBJECT_0 {
                        return Err(VddError::Driver(format!(
                            "DeviceIoControl(0x{code:08x}) timed out after {IO_TIMEOUT_MS}ms"
                        )));
                    }
                    GetOverlappedResult(self.device, &overlapped, &mut bytes_returned, false)
                        .map_err(|e| {
                            VddError::Driver(format!(
                                "GetOverlappedResult(0x{code:08x}) failed: {e}"
                            ))
                        })?;
                }
                Ok(bytes_returned)
            }
        }

        /// Plug a virtual monitor; returns the driver-assigned index. The
        /// driver writes the index back into the output buffer.
        pub fn add_display(&self) -> Result<u32, VddError> {
            let mut out = [0u8; 4];
            self.io_control(VDD_IOCTL_ADD, &[], &mut out)?;
            Ok(u32::from_le_bytes(out))
        }

        /// Unplug a previously added monitor by index. The reference encodes
        /// the index as a 16-bit big-endian value in the input buffer.
        pub fn remove_display(&self, index: u32) -> Result<(), VddError> {
            let be = (index as u16).to_be_bytes();
            self.io_control(VDD_IOCTL_REMOVE, &be, &mut [])?;
            Ok(())
        }

        /// Keep-alive ping — must be sent at least once per second.
        pub fn ping(&self) -> Result<(), VddError> {
            self.io_control(VDD_IOCTL_UPDATE, &[], &mut [])?;
            Ok(())
        }
    }

    impl Drop for VddDevice {
        fn drop(&mut self) {
            unsafe {
                if !self.event.is_invalid() {
                    let _ = CloseHandle(self.event);
                }
                if !self.device.is_invalid() && self.device != INVALID_HANDLE_VALUE {
                    let _ = CloseHandle(self.device);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use imp::VddDevice;

/// Non-Windows stub so the crate compiles everywhere. Every operation reports
/// the platform is unsupported.
#[cfg(not(target_os = "windows"))]
pub struct VddDevice;

#[cfg(not(target_os = "windows"))]
impl VddDevice {
    pub fn open() -> Result<Self, VddError> {
        Err(VddError::Unavailable("parsec-vdd is Windows-only".into()))
    }
    pub fn add_display(&self) -> Result<u32, VddError> {
        Err(VddError::Unavailable("parsec-vdd is Windows-only".into()))
    }
    pub fn remove_display(&self, _index: u32) -> Result<(), VddError> {
        Err(VddError::Unavailable("parsec-vdd is Windows-only".into()))
    }
    pub fn ping(&self) -> Result<(), VddError> {
        Err(VddError::Unavailable("parsec-vdd is Windows-only".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ioctl_codes_match_reference() {
        assert_eq!(VDD_IOCTL_ADD, 0x0022_e004);
        assert_eq!(VDD_IOCTL_REMOVE, 0x0022_a008);
        assert_eq!(VDD_IOCTL_UPDATE, 0x0022_a00c);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn stub_open_is_unavailable() {
        assert!(matches!(VddDevice::open(), Err(VddError::Unavailable(_))));
    }
}
