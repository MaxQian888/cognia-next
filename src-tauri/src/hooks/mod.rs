//! The settings-hook runtime lives in `cognia-hooks` (ADR-0196 P6c). This
//! module re-exports it at its old path, so `generate_handler!`'s
//! `hooks::commands::…` and every `crate::hooks::…` call resolve unchanged.
//! What stays is the desktop's [`HooksHost`]: the app resource dir and the
//! managed plugin runtime.

pub use cognia_hooks::*;

use std::path::PathBuf;
use std::sync::Arc;

use cognia_hooks::host::{HooksHost, HOST};
use cognia_hooks::settings::ClaudeSettings;
use tauri::Manager as _;

/// The desktop's side of the hooks runtime.
struct DesktopHooksHost(tauri::AppHandle);

impl HooksHost for DesktopHooksHost {
    fn resource_dir(&self) -> Option<PathBuf> {
        self.0.path().resource_dir().ok()
    }

    fn apply_plugin_command_hooks(&self, settings: &mut ClaudeSettings) {
        let runtime = self.0.state::<crate::plugin_api::PluginRuntimeState>();
        crate::plugin_api::command_hooks::apply_plugin_command_hooks(settings, runtime.inner());
    }
}

/// Install the desktop host. The boot step that publishes the crash handler's
/// `AppHandle` calls it, which is when the lookup this replaced started
/// answering.
pub(crate) fn install_desktop_host(app: tauri::AppHandle) {
    HOST.set(Arc::new(DesktopHooksHost(app)));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boot never runs in a unit-test process and the headless install is
    /// compiled out of tests, so settings loaded here merge no plugin layer —
    /// the behaviour the suites that call `load_effective_settings` assume.
    #[test]
    fn unit_tests_run_without_a_hooks_host() {
        assert!(HOST.try_get().is_none());
    }
}
