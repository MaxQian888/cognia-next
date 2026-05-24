//! Crash-report subsystem — Minecraft-style.
//!
//! When the Rust side dies, write a self-contained, timestamped report so the
//! incident is recoverable even when the webview is gone. Two capture paths:
//!
//! - **Rust panics** — a global `std::panic::set_hook` (`panic_hook`) captures
//!   the payload + location + a full `std::backtrace::Backtrace` and writes a
//!   `.txt` (human-readable) + `.json` report.
//! - **Native hard-crashes** (SIGSEGV, stack overflow, abort, WebView2 / UIA
//!   faults) — an out-of-process monitor (`monitor`) using `crash-handler` +
//!   `minidumper` writes a `.dmp` plus a companion `.txt`/`.json`. The monitor
//!   rides the main binary via a hidden `--crash-monitor` argument.
//!
//! A clean-exit `sentinel` records whether the previous run terminated
//! normally; it — not the mere presence of a report — is what drives the
//! next-launch dialog, so recoverable automation-worker panics (which still
//! produce diagnostic reports) never raise a false "the app crashed" prompt.
//!
//! Reports live next to the file logger at
//! `<data_local_dir>/Cognia/crash-reports/`, mirroring the resolution in
//! [`crate::logging::native_bootstrap`].

pub mod commands;
pub mod context;
pub mod monitor;
pub mod panic_hook;
pub mod report;
pub mod sentinel;
pub mod system_info;

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::AppHandle;

/// Root folder name under `data_local_dir` — the same `"Cognia"` the file
/// logger uses (`native_bootstrap::APP_LOG_DIR_NAME`) so crash reports sit
/// beside `logs/cognia.log`.
const APP_DIR_NAME: &str = "Cognia";

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Resolve (and create) the crash-reports directory. Returns `None` when the
/// platform data dir can't be resolved or the directory can't be created —
/// callers degrade to logging-only.
pub fn crash_reports_dir() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?
        .join(APP_DIR_NAME)
        .join("crash-reports");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Register the app handle so capture paths can emit `crash://captured` to the
/// webview when it's still alive. Safe to call once; later calls are ignored.
pub fn install_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub(crate) fn app_handle() -> Option<AppHandle> {
    APP_HANDLE.get().cloned()
}

/// Install the global panic hook. Cheap, no app handle required — call as
/// early as possible (before Tauri builds) so boot-time panics are captured.
pub fn install_panic_hook() {
    panic_hook::install();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_reports_dir_is_under_cognia() {
        // Can't assert creation in every sandbox, but the path shape must be
        // stable: <...>/Cognia/crash-reports.
        if let Some(dir) = crash_reports_dir() {
            assert!(dir.ends_with("crash-reports"));
            assert!(dir
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n == APP_DIR_NAME)
                .unwrap_or(false));
        }
    }
}
