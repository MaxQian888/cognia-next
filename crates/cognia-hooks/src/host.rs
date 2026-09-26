//! What the hooks runtime needs from the binary it runs in (ADR-0196 P6c).
//!
//! Two things vary by host: where a packaged build ships `hooks/builtin/`
//! (the desktop's resource dir; the headless server has none), and which
//! plugin runtime contributes `commandHooks`. The desktop installs its host at
//! boot beside the crash handler's `AppHandle`; `cognia-server` installs one
//! with its headless services. A process that installs none — a unit test —
//! resolves the dev fallback for built-ins and merges no plugin layer.

use std::path::PathBuf;

use cognia_core::installed::Replaceable;

use crate::settings::ClaudeSettings;

/// The binary's side of the hooks runtime.
pub trait HooksHost: Send + Sync + 'static {
    /// The app resource dir, where a packaged build ships `hooks/builtin/`.
    fn resource_dir(&self) -> Option<PathBuf>;

    /// Merge enabled plugins' `commandHooks` under the user's hook groups.
    fn apply_plugin_command_hooks(&self, settings: &mut ClaudeSettings);
}

/// The installed host. Replaceable so a test can install and clear one.
pub static HOST: Replaceable<dyn HooksHost> = Replaceable::new("cognia_hooks::host::HOST");

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct FixedHost;

    impl HooksHost for FixedHost {
        fn resource_dir(&self) -> Option<PathBuf> {
            Some(PathBuf::from("/app/Resources"))
        }

        fn apply_plugin_command_hooks(&self, settings: &mut ClaudeSettings) {
            settings.model = Some("from-plugin".into());
        }
    }

    #[test]
    fn an_installed_host_answers_and_clearing_it_empties_the_slot() {
        // The only test in this crate that touches the slot, so no lock.
        assert!(HOST.try_get().is_none());
        HOST.set(Arc::new(FixedHost));
        let host = HOST.get().unwrap();
        assert_eq!(host.resource_dir(), Some(PathBuf::from("/app/Resources")));
        let mut settings = ClaudeSettings::default();
        host.apply_plugin_command_hooks(&mut settings);
        assert_eq!(settings.model.as_deref(), Some("from-plugin"));
        HOST.clear();
        assert!(HOST.try_get().is_none());
    }
}
