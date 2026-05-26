//! Tauri command surface for the performance panel.
//!
//! All commands return `Result<T, String>` per the project convention. The
//! sampler is started/stopped by the renderer on panel mount/unmount; the
//! registry-backed hotspot commands work whether or not sampling is active.

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

use super::registry::{SpanSnapshot, REGISTRY};
use super::sampler::{self, PerfSample};
use super::PerfState;
use crate::crash::system_info::{self, SystemDetails};

/// Initial pull for the panel: recent ring history + current sampler state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub samples: Vec<PerfSample>,
    pub running: bool,
    pub interval_ms: u64,
}

/// A dial9 flight-recorder trace file on disk (surfaced for offline analysis).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFile {
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
}

/// The directory dial9 writes binary traces into (mirrors `main.rs`).
fn trace_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("traces"))
}

#[tauri::command]
pub fn perf_snapshot(state: tauri::State<'_, PerfState>) -> Result<PerfSnapshot, String> {
    Ok(PerfSnapshot {
        samples: state.sampler.recent(),
        running: state.sampler.is_running(),
        interval_ms: state.sampler.interval(),
    })
}

#[tauri::command]
pub fn perf_start_sampling(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerfState>,
    interval_ms: Option<u64>,
) -> Result<(), String> {
    sampler::start(
        app,
        state.sampler.clone(),
        interval_ms.unwrap_or(sampler::DEFAULT_INTERVAL_MS),
    );
    Ok(())
}

#[tauri::command]
pub fn perf_set_interval(
    state: tauri::State<'_, PerfState>,
    interval_ms: u64,
) -> Result<(), String> {
    state.sampler.set_interval(interval_ms);
    Ok(())
}

#[tauri::command]
pub fn perf_stop_sampling(state: tauri::State<'_, PerfState>) -> Result<(), String> {
    state.sampler.stop();
    Ok(())
}

#[tauri::command]
pub fn perf_hotspots() -> Result<Vec<SpanSnapshot>, String> {
    Ok(REGISTRY.snapshot())
}

#[tauri::command]
pub fn perf_reset_hotspots() -> Result<(), String> {
    REGISTRY.reset();
    Ok(())
}

#[tauri::command]
pub fn perf_system_details() -> Result<SystemDetails, String> {
    Ok(system_info::gather())
}

#[tauri::command]
pub fn perf_list_traces() -> Result<Vec<TraceFile>, String> {
    let Some(dir) = trace_dir() else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // Directory not yet created (dial9 disabled / nothing traced) — empty.
        return Ok(Vec::new());
    };
    let mut files: Vec<TraceFile> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        files.push(TraceFile {
            name: entry.file_name().to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(files)
}

#[tauri::command]
pub async fn perf_open_trace_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = trace_dir().ok_or("trace_dir_unavailable")?;
    // Best-effort create so "open folder" works even before the first trace.
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open_failed:{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_dir_ends_with_expected_segments() {
        if let Some(dir) = trace_dir() {
            assert!(dir.ends_with("traces"));
            assert!(dir.to_string_lossy().contains("cognia"));
        }
    }

    #[test]
    fn perf_snapshot_struct_serializes_camel_case() {
        let snap = PerfSnapshot {
            samples: Vec::new(),
            running: true,
            interval_ms: 1000,
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"intervalMs\":1000"));
        assert!(json.contains("\"running\":true"));
    }

    #[test]
    fn trace_file_serializes_camel_case() {
        let tf = TraceFile {
            name: "trace.bin".to_string(),
            size_bytes: 42,
            modified_ms: Some(123),
        };
        let json = serde_json::to_string(&tf).unwrap();
        assert!(json.contains("\"sizeBytes\":42"));
        assert!(json.contains("\"modifiedMs\":123"));
    }
}
