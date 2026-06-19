//! Non-Windows stub for the global input hook. macOS (CGEventTap) and Linux
//! (X11/AT-SPI) capture are future work; today recording is desktop-Windows
//! only and these platforms degrade gracefully — `install` returns an error
//! that the command maps to `UnsupportedPlatform` + a `record:event` error.

use tokio::sync::mpsc::Sender;

use super::session::RawSignal;

pub(crate) struct HookGuard;

impl HookGuard {
    pub(crate) fn install(_tx: Sender<RawSignal>) -> Result<HookGuard, String> {
        Err("input recording is not supported on this platform yet".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_returns_unsupported() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<RawSignal>(1);
        assert!(HookGuard::install(tx).is_err());
    }
}
