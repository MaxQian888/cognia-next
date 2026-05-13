//! The cross-platform `AutomationBackend` trait. Each platform module
//! (`platform::uia` / `platform::ax` / `platform::atspi`) implements this;
//! the worker thread owns one implementation behind a trait object.
//!
//! Methods are intentionally synchronous and blocking — the worker thread
//! takes care of marshalling requests onto a stable OS thread (which, on
//! Windows, owns the COM apartment).

use super::types::*;

pub trait AutomationBackend {
    fn capabilities(&self) -> Capabilities;
    fn get_focus(&self) -> Result<ElementInfo>;
    fn read_tree(&self, root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>>;
    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>>;
    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot>;
    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()>;
    fn type_text(&self, text: &str, opts: TypeOpts) -> Result<()>;
    fn send_keys(&self, chord: &KeyChord) -> Result<()>;
    fn invoke_pattern(
        &self,
        target: ElementRef,
        pattern: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value>;
    fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()>;
    fn subscribe_events(&self, filter: EventFilter) -> Result<SubscriptionId>;
    fn unsubscribe(&self, sub: SubscriptionId) -> Result<()>;
}

/// A back-end that fails every call with `UnsupportedPlatform`. macOS and
/// Linux ship with this in M1; M3 swaps in real implementations.
pub struct StubBackend {
    pub platform: Platform,
}

impl AutomationBackend for StubBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: self.platform,
            has_uia: false,
            has_input_sim: false,
            has_screenshot: false,
            has_events: false,
        }
    }
    fn get_focus(&self) -> Result<ElementInfo> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn read_tree(&self, _r: Option<ElementRef>, _o: TreeOpts) -> Result<Vec<ElementInfo>> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn find(&self, _l: &Locator) -> Result<Option<ElementRef>> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn screenshot(&self, _o: ScreenshotOpts) -> Result<Screenshot> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn click(&self, _t: ClickTarget, _o: ClickOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn type_text(&self, _text: &str, _o: TypeOpts) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn send_keys(&self, _c: &KeyChord) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn invoke_pattern(
        &self,
        _t: ElementRef,
        _p: PatternKind,
        _a: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn window_op(&self, _t: ElementRef, _o: WindowOp) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
        Err(AutomationError::UnsupportedPlatform)
    }
    fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
        Err(AutomationError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_backend_reports_unsupported() {
        let b = StubBackend {
            platform: Platform::Macos,
        };
        let caps = b.capabilities();
        assert_eq!(caps.platform, Platform::Macos);
        assert!(!caps.has_uia);
        assert!(matches!(
            b.get_focus(),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.find(&Locator::default()),
            Err(AutomationError::UnsupportedPlatform)
        ));
        assert!(matches!(
            b.screenshot(ScreenshotOpts::default()),
            Err(AutomationError::UnsupportedPlatform)
        ));
    }
}
