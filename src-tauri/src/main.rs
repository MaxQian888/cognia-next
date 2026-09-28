// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // If we were relaunched as the out-of-process crash monitor, run that
    // server loop and exit — never boot the app.
    if app_lib::crash::monitor::maybe_run_monitor() {
        return;
    }

    // Install crash capture as early as possible so faults during boot are
    // still reported: the native handler spawns the monitor child + attaches
    // the platform exception handler, and the panic hook covers Rust panics.
    app_lib::crash::monitor::install_client();
    app_lib::crash::install_panic_hook();

    // rustls 0.23.x requires an explicit crypto provider; multiple crates pull
    // in both `aws-lc-rs` and `ring`, so auto-detection fails. Pick `ring` to
    // match axum-server's `tls-rustls` feature.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // Dial9 tokio telemetry — production flight recorder for async performance
    // analysis. Requires `tokio_unstable` flag in `.cargo/config.toml`.
    let trace_dir = dirs::data_dir()
        .map(|d| d.join("cognia").join("traces"))
        .unwrap_or_else(|| std::path::PathBuf::from("cognia-traces"));
    if let Err(e) = std::fs::create_dir_all(&trace_dir) {
        eprintln!("dial9: failed to create trace directory: {e}");
    }

    let (recorder, rt) =
        build_traced_runtime(&trace_dir).expect("dial9 traced runtime failed to start");

    // Wire Tauri's async dispatcher to the dial9-traced runtime so every
    // spawned task (commands, sidecars, connectors, workflows) is instrumented.
    tauri::async_runtime::set(rt.handle().clone());

    // The tao/wry event loop MUST be created on the main thread on Windows,
    // so run Tauri directly here — not inside `rt.block_on`, which would hop
    // to a tokio worker thread and panic. `rt` stays alive for the whole
    // process via this binding; Tauri's async work hops to it via the handle
    // registered above.
    app_lib::run();

    drop(rt);
    drop(recorder);
}

fn build_traced_runtime(trace_dir: &std::path::Path) -> std::io::Result<dial9::AttachedRuntime> {
    use dial9::Dial9HandleTokioExt;

    let writer = dial9::DiskBuffer::builder()
        .base_path(trace_dir.join("trace.bin"))
        .max_file_size(20 * 1024 * 1024)
        .max_total_size(100 * 1024 * 1024)
        .build();
    let recorder = dial9::recorder_or_disabled(writer).build();
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    let runtime = recorder
        .handle()
        .attach_tokio_runtime(builder, dial9::TokioAttachOptions::default())?;
    Ok((recorder, runtime))
}

#[cfg(test)]
mod tests {
    use super::build_traced_runtime;

    #[test]
    fn traced_runtime_executes_tasks_and_timers() {
        let directory = tempfile::tempdir().unwrap();
        let (recorder, runtime) = build_traced_runtime(directory.path()).unwrap();
        let result = runtime.block_on(async {
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                42
            })
            .await
            .unwrap()
        });
        assert_eq!(result, 42);
        drop(runtime);
        drop(recorder);
    }

    #[test]
    fn unavailable_trace_storage_keeps_runtime_working() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let (recorder, runtime) = build_traced_runtime(file.path()).unwrap();
        assert_eq!(runtime.block_on(async { 42 }), 42);
        drop(runtime);
        drop(recorder);
    }
}
