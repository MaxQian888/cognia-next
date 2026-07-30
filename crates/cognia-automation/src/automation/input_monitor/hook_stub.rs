//! Non-Windows stub for the global input hook. macOS (CGEventTap) and Linux
//! (X11/AT-SPI) capture are future work; today recording is desktop-Windows
//! only and these platforms degrade gracefully — `install` returns an error
//! that the command maps to `UnsupportedPlatform` + a `record:event` error.

use tokio::sync::mpsc::UnboundedSender;

use super::InputEvent;

pub(crate) struct HookGuard;

impl HookGuard {
    pub(crate) fn install(_tx: UnboundedSender<InputEvent>) -> Result<HookGuard, String> {
        Err("input recording is not supported on this platform yet".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_returns_unsupported() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<InputEvent>();
        assert!(HookGuard::install(tx).is_err());
    }
}
