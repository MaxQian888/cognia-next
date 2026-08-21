//! Out-of-process native-crash monitor (`crash-handler` + `minidumper`).
//!
//! Writing a minidump from inside a crashed process is unreliable — its memory
//! may be corrupt. So a sibling monitor process (the same binary, relaunched
//! with `--crash-monitor <socket>`) owns the `minidumper::Server`; the app
//! process installs a `crash_handler::CrashHandler` that, on a native fault,
//! pings the monitor and requests the dump cross-process.
//!
//! The app also forwards the latest redacted context + app state as `KIND_META`
//! messages, so the monitor can render a companion `.txt`/`.json` next to the
//! `.dmp` in the same MC-style layout as panic reports.

// ADR-0067 Tier C: this was `#[cfg(desktop)]`, a cfg emitted by tauri-build's
// build script. A plain library crate never receives it, so keeping it here
// would have silently reduced the whole monitor to the no-op stubs below
// instead of failing to compile. The predicate below is what `desktop` means
// and is exactly how `crash-handler`/`minidumper` are gated in Cargo.toml.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop_impl::{install_client, maybe_run_monitor, send_meta};

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn maybe_run_monitor() -> bool {
    false
}
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn install_client() {}
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn send_meta(_bytes: &[u8]) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_impl {
    use crate::crash::report::{self, CrashKind, CrashReport, MonitorMeta};
    use crate::crash::system_info;
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex, OnceLock};

    /// Message kind carrying the serialized [`MonitorMeta`] envelope.
    const KIND_META: u32 = 1;
    const MONITOR_ARG: &str = "--crash-monitor";

    static CLIENT: OnceLock<Arc<minidumper::Client>> = OnceLock::new();
    static MONITOR_CHILD: OnceLock<Mutex<std::process::Child>> = OnceLock::new();

    /// If this process was launched as the crash monitor, run the server loop
    /// and return `true` so `main` exits without booting the app.
    pub fn maybe_run_monitor() -> bool {
        let mut args = std::env::args();
        while let Some(arg) = args.next() {
            if arg == MONITOR_ARG {
                if let Some(socket) = args.next() {
                    run_monitor(&socket);
                    return true;
                }
            }
        }
        false
    }

    fn run_monitor(socket_path: &str) {
        let dir = crate::crash::crash_reports_dir();
        let socket = minidumper::SocketName::path(socket_path);
        let mut server = match minidumper::Server::with_name(socket) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("crash-monitor: failed to bind socket: {error}");
                return;
            }
        };
        let shutdown = AtomicBool::new(false);
        let handler = MonitorHandler {
            dir,
            last_meta: Mutex::new(None),
            stem: Mutex::new(None),
        };
        if let Err(error) = server.run(Box::new(handler), &shutdown, None) {
            eprintln!("crash-monitor: server loop error: {error}");
        }
    }

    /// Spawn the monitor child, connect the client, and install the native
    /// crash handler. Best-effort — logs and returns on any failure so the app
    /// still boots (it just loses native-crash capture; panics are unaffected).
    pub fn install_client() {
        if crate::crash::crash_reports_dir().is_none() {
            return;
        }
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(_) => return,
        };

        let socket_path =
            std::env::temp_dir().join(format!("cognia-crash-{}.sock", std::process::id()));
        let _ = fs::remove_file(&socket_path);
        let socket_str = socket_path.to_string_lossy().to_string();
        let socket = minidumper::SocketName::path(&socket_str);

        let mut child: Option<std::process::Child> = None;
        let mut connected: Option<minidumper::Client> = None;
        for _ in 0..50 {
            if let Ok(client) = minidumper::Client::with_name(socket) {
                connected = Some(client);
                break;
            }
            if child.is_none() {
                child = match std::process::Command::new(&exe)
                    .arg(MONITOR_ARG)
                    .arg(&socket_str)
                    .spawn()
                {
                    Ok(child) => Some(child),
                    Err(error) => {
                        log::warn!("crash: failed to spawn monitor: {error}");
                        return;
                    }
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let client = match connected {
            Some(client) => Arc::new(client),
            None => {
                log::warn!("crash: monitor connection timed out; native capture disabled");
                return;
            }
        };
        let _ = CLIENT.set(client.clone());

        let client_for_crash = client;
        #[allow(unsafe_code)]
        let attach = crash_handler::CrashHandler::attach(unsafe {
            crash_handler::make_crash_event(move |cc: &crash_handler::CrashContext| {
                // Flush in-flight messages before the dump (matters on macOS).
                let _ = client_for_crash.ping();
                crash_handler::CrashEventResult::Handled(client_for_crash.request_dump(cc).is_ok())
            })
        });
        let handler = match attach {
            Ok(handler) => handler,
            Err(error) => {
                log::warn!("crash: failed to attach native handler: {error}");
                return;
            }
        };

        // On Linux only the designated ptracer may inspect us for crashes.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if let Some(child) = child.as_ref() {
            handler.set_ptracer(Some(child.id()));
        }

        // The handler detaches on drop — keep it for the whole process.
        std::mem::forget(handler);
        if let Some(child) = child {
            let _ = MONITOR_CHILD.set(Mutex::new(child));
        }
    }

    /// Forward the latest serialized [`MonitorMeta`] to the monitor. Best-effort.
    pub fn send_meta(bytes: &[u8]) {
        if let Some(client) = CLIENT.get() {
            let _ = client.send_message(KIND_META, bytes);
        }
    }

    struct MonitorHandler {
        dir: Option<PathBuf>,
        last_meta: Mutex<Option<Vec<u8>>>,
        stem: Mutex<Option<String>>,
    }

    impl MonitorHandler {
        fn write_companion(&self, dmp_path: &Path) {
            let Some(dir) = self.dir.clone() else {
                return;
            };
            let stem = self
                .stem
                .lock()
                .ok()
                .and_then(|s| s.clone())
                .or_else(|| {
                    dmp_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(String::from)
                })
                .unwrap_or_else(|| report::timestamped_stem(CrashKind::Native));

            let meta: MonitorMeta = self
                .last_meta
                .lock()
                .ok()
                .and_then(|m| m.clone())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();

            let crash = CrashReport {
                kind: CrashKind::Native,
                captured_at: chrono::Utc::now().to_rfc3339(),
                thread: None,
                message: "Native crash captured via minidump".to_string(),
                location: None,
                backtrace: None,
                dump_path: Some(dmp_path.to_string_lossy().to_string()),
                system: system_info::gather(),
                context: meta.context,
                extra: meta.extra,
            };
            if let Err(error) = crash.write_to(&dir, &stem) {
                eprintln!("crash-monitor: failed to write companion report: {error}");
            }
        }
    }

    impl minidumper::ServerHandler for MonitorHandler {
        fn create_minidump_file(&self) -> Result<(File, PathBuf), std::io::Error> {
            let dir = self.dir.clone().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "crash-reports directory unavailable",
                )
            })?;
            fs::create_dir_all(&dir)?;
            let stem = report::timestamped_stem(CrashKind::Native);
            let dmp_path = dir.join(format!("{stem}.dmp"));
            if let Ok(mut slot) = self.stem.lock() {
                *slot = Some(stem);
            }
            let file = File::create(&dmp_path)?;
            Ok((file, dmp_path))
        }

        fn on_minidump_created(
            &self,
            result: Result<minidumper::MinidumpBinary, minidumper::Error>,
        ) -> minidumper::LoopAction {
            match result {
                Ok(mut md_bin) => {
                    use std::io::Write;
                    let _ = md_bin.file.flush();
                    self.write_companion(&md_bin.path);
                }
                Err(error) => {
                    eprintln!("crash-monitor: failed to write minidump: {error:#}");
                }
            }
            // One dump per crashed client; tear the monitor down.
            minidumper::LoopAction::Exit
        }

        fn on_message(&self, kind: u32, buffer: Vec<u8>) {
            if kind == KIND_META {
                if let Ok(mut slot) = self.last_meta.lock() {
                    *slot = Some(buffer);
                }
            }
        }

        fn on_client_disconnected(&self, num_clients: usize) -> minidumper::LoopAction {
            // App exited cleanly (no crash) — don't leave an orphan monitor.
            if num_clients == 0 {
                minidumper::LoopAction::Exit
            } else {
                minidumper::LoopAction::Continue
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn send_meta_without_client_is_noop() {
            // No client connected in unit tests — must not panic.
            send_meta(b"{}");
        }

        #[test]
        fn maybe_run_monitor_false_without_flag() {
            // The test harness isn't launched with --crash-monitor.
            assert!(!maybe_run_monitor());
        }
    }
}
