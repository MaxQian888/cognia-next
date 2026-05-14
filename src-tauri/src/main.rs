// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Dial9 tokio telemetry — production flight recorder for async performance
    // analysis. Requires `tokio_unstable` flag in `.cargo/config.toml`.
    let trace_dir = dirs::data_dir()
        .map(|d| d.join("cognia").join("traces"))
        .unwrap_or_else(|| std::path::PathBuf::from("cognia-traces"));
    if let Err(e) = std::fs::create_dir_all(&trace_dir) {
        eprintln!("dial9: failed to create trace directory: {e}");
    }

    let cfg = dial9_tokio_telemetry::Dial9Config::builder()
        .base_path(trace_dir.join("trace.bin"))
        .max_file_size(20 * 1024 * 1024)      // rotate after 20 MiB
        .max_total_size(100 * 1024 * 1024)    // keep at most 100 MiB
        .build_or_disabled();

    let rt = dial9_tokio_telemetry::TracedRuntime::try_new(cfg)
        .expect("dial9 traced runtime failed to start");

    // Wire Tauri's async dispatcher to the dial9-traced runtime so every
    // spawned task (commands, sidecars, connectors, workflows) is instrumented.
    tauri::async_runtime::set(rt.runtime().handle().clone());

    // Run the Tauri app inside the traced runtime.  The wry event loop
    // (GUI thread) runs on the caller thread; tokio async work runs on
    // dial9-instrumented worker threads.
    rt.block_on(async {
        app_lib::run();
    });
}
