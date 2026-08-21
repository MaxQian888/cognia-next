//! Global panic hook. Installs once, chains the previous hook (so the default
//! stderr print + `tauri-plugin-log` capture still happen), and writes a
//! Minecraft-style crash report for every panic — main thread or any worker
//! (sidecar dispatch, connectors, workflow, terminal PTY).
//!
//! Recoverable panics (e.g. the automation worker's `catch_unwind` at
//! `automation/worker.rs:192`) still produce a diagnostic report here, but do
//! NOT raise the next-launch dialog — that is gated on the clean-exit
//! [`sentinel`](super::sentinel), which only a process-ending crash leaves set.

use crate::crash::context;
use crate::crash::report::{self, CrashKind, CrashReport};
use crate::crash::system_info;
use std::panic::PanicHookInfo;
use std::sync::atomic::{AtomicBool, Ordering};

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Install the global panic hook. Idempotent.
pub fn install() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Never let report writing itself unwind through the hook.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| write_report(info)));
        previous(info);
    }));
}

/// Coerce a panic payload to a string — mirrors `automation/worker.rs:253`,
/// handling the two common payload shapes.
fn payload_to_string(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&'static str>() {
        s.to_string()
    } else {
        "<non-string panic>".to_string()
    }
}

fn write_report(info: &PanicHookInfo<'_>) {
    let Some(dir) = crate::crash::crash_reports_dir() else {
        return;
    };

    let message = payload_to_string(info.payload());
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    let thread = std::thread::current().name().map(|n| n.to_string());
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();

    let crash = CrashReport {
        kind: CrashKind::Panic,
        captured_at: chrono::Utc::now().to_rfc3339(),
        thread,
        message: message.clone(),
        location,
        backtrace: Some(backtrace),
        dump_path: None,
        system: system_info::gather(),
        context: context::snapshot(),
        extra: report::app_extra(),
    };

    let stem = report::timestamped_stem(CrashKind::Panic);
    match crash.write_to(&dir, &stem) {
        Ok(written) => {
            log::error!(
                "crash: panic captured — {} ({})",
                message,
                written.txt_path.display()
            );
            if let Some(handle) = crate::crash::app_handle() {
                use tauri::Emitter;
                let _ = handle.emit("crash://captured", written.summary_json());
            }
        }
        Err(error) => {
            log::error!("crash: failed to write panic report: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_string_variants() {
        let s = String::from("owned");
        assert_eq!(payload_to_string(&s), "owned");
        let st: &'static str = "static";
        assert_eq!(payload_to_string(&st), "static");
        let n: i32 = 5;
        assert_eq!(payload_to_string(&n), "<non-string panic>");
    }

    #[test]
    fn install_is_idempotent() {
        // First call may or may not be the real install depending on test
        // ordering, but a second call must be a no-op (no panic, returns).
        install();
        install();
        assert!(INSTALLED.load(Ordering::SeqCst));
    }
}
