//! Process exit-code constants and the sentinel error used to short-circuit
//! `main()` after a machine-readable JSON failure payload has been printed.

use std::fmt;

/// Exit code for a lint run that surfaced errors (see [`crate::commands::lint`]).
pub(crate) const LINT_ERROR_EXIT_CODE: i32 = 1;
/// Exit code after a `--json` command emitted a failure payload to stdout.
pub(crate) const JSON_FAILURE_EXIT_CODE: i32 = 1;

/// Sentinel returned by `--json` command paths once they have already printed
/// a machine-readable failure payload. `main()` maps it to
/// [`JSON_FAILURE_EXIT_CODE`] without printing a second (human) error report.
#[derive(Debug)]
pub(crate) struct JsonFailureExit;

impl fmt::Display for JsonFailureExit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON failure payload emitted")
    }
}

impl std::error::Error for JsonFailureExit {}

#[cfg(test)]
pub(crate) mod test_env {
    use std::ffi::OsString;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn restore(key: &str, value: Option<OsString>) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}
