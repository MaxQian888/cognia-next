//! Windows `VddDriver` — composes `parsec_vdd` (device + IOCTLs), `topology`
//! (snapshot prior primary, promote the virtual display to primary, restore on
//! release), and a thread-affine `ES_SYSTEM_REQUIRED` system-sleep keepalive.
//!
//! Built by `super::build_driver()` **on the controller thread**, so it may
//! hold the `!Send` device handle and own the thread-local execution-state
//! assertion for the duration the display is up.

use std::collections::HashSet;
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

use super::parsec_vdd::VddDevice;
use super::{topology, AcquiredDisplay, ReleaseReason, VddDriver, VddError};

/// How long to wait for the freshly-added virtual monitor to enumerate.
const ENUMERATE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct WindowsVddDriver {
    device: Option<VddDevice>,
    index: Option<u32>,
    monitor: Option<String>,
    prev_primary: Option<String>,
    keepalive: bool,
}

impl WindowsVddDriver {
    pub fn new() -> Self {
        Self::default()
    }

    fn assert_keepalive(&mut self) {
        // ES_SYSTEM_REQUIRED keeps the machine awake; the virtual display is
        // the render surface, so ES_DISPLAY_REQUIRED is intentionally omitted.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        self.keepalive = true;
    }

    fn clear_keepalive(&mut self) {
        if self.keepalive {
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
            self.keepalive = false;
        }
    }

    /// Poll until a display name appears that wasn't present in `before`.
    fn wait_for_new_display(before: &HashSet<String>) -> Option<String> {
        let deadline = Instant::now() + ENUMERATE_TIMEOUT;
        while Instant::now() < deadline {
            for dev in topology::list_active_devices() {
                if !before.contains(&dev.name) {
                    return Some(dev.name);
                }
            }
            sleep(Duration::from_millis(100));
        }
        None
    }
}

impl VddDriver for WindowsVddDriver {
    fn acquire(&mut self) -> Result<AcquiredDisplay, VddError> {
        let before: HashSet<String> = topology::list_active_devices()
            .into_iter()
            .map(|d| d.name)
            .collect();

        let device = VddDevice::open()?;
        let index = device.add_display()?;

        let monitor = Self::wait_for_new_display(&before).ok_or_else(|| {
            // The display never enumerated — unplug so we don't leak it.
            let _ = device.remove_display(index);
            VddError::Driver("virtual display did not enumerate within timeout".into())
        })?;

        let prev_primary = topology::current_primary();
        topology::set_primary(&monitor).inspect_err(|_| {
            let _ = device.remove_display(index);
        })?;
        self.assert_keepalive();

        let (width, height) = topology::display_size(&monitor).unwrap_or((1920, 1080));

        self.device = Some(device);
        self.index = Some(index);
        self.monitor = Some(monitor.clone());
        self.prev_primary = prev_primary;

        Ok(AcquiredDisplay {
            label: monitor,
            width,
            height,
        })
    }

    fn ping(&mut self) -> Result<(), VddError> {
        match &self.device {
            Some(dev) => dev.ping(),
            None => Err(VddError::Driver("ping with no acquired device".into())),
        }
    }

    fn release(&mut self, _reason: ReleaseReason) {
        self.clear_keepalive();
        if let (Some(dev), Some(idx)) = (&self.device, self.index) {
            let _ = dev.remove_display(idx);
        }
        if let Some(prev) = self.prev_primary.take() {
            // Best-effort — if the physical display is still gone this is a
            // no-op until it returns, which is harmless.
            let _ = topology::set_primary(&prev);
        }
        self.device = None;
        self.index = None;
        self.monitor = None;
    }

    fn is_acquired(&self) -> bool {
        self.device.is_some()
    }
}

impl Drop for WindowsVddDriver {
    fn drop(&mut self) {
        if self.is_acquired() {
            self.release(ReleaseReason::Shutdown);
        } else {
            self.clear_keepalive();
        }
    }
}

#[cfg(test)]
mod tests {
    // The acquire/ping/release path drives real Win32 display + parsec-vdd
    // IOCTLs and cannot run in CI without the signed driver loaded + a display
    // present; it is validated on-hardware per the plan's verification section.
    // The cross-platform controller state machine is covered by
    // `controller.rs` tests against a mock driver.
    #[test]
    fn windows_driver_constructs() {
        let d = super::WindowsVddDriver::new();
        assert!(!super::VddDriver::is_acquired(&d));
    }
}
