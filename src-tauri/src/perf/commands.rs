//! Tauri command surface for the performance panel.
//!
//! All commands return `Result<T, String>` per the project convention. The
//! sampler is started/stopped by the renderer on panel mount/unmount; the
//! registry-backed hotspot commands work whether or not sampling is active.

use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

use super::registry::{SpanSnapshot, REGISTRY};
use super::sampler::{self, PerfFrame, PerfOpenLeaseRequest, PerfOpenLeaseResult, PerfSnapshot};
use super::PerfState;
use crate::crash::system_info::{self, SystemDetails};

struct TauriPerfHostPort {
    app: tauri::AppHandle,
    event_bus: Option<Arc<crate::companion_api::event_bus::EventBus>>,
}

impl sampler::PerfHostPort for TauriPerfHostPort {
    fn collect_managed(
        &self,
    ) -> Pin<Box<dyn Future<Output = Vec<crate::process_registry::ManagedProcess>> + Send + '_>>
    {
        Box::pin(crate::process_registry::collect(&self.app))
    }

    fn emit(&self, frame: &PerfFrame, deliveries: &[sampler::PerfDelivery]) {
        for delivery in deliveries {
            let mut targeted = frame.clone();
            targeted.lease_id = Some(delivery.lease_id.clone());
            targeted.requested_interval_ms = delivery.requested_interval_ms;
            if delivery.remote {
                let Some(event_bus) = self.event_bus.as_ref() else {
                    log::warn!(
                        "remote perf delivery unavailable while Companion server is stopped"
                    );
                    continue;
                };
                let Ok(payload) = serde_json::to_value(&targeted) else {
                    log::warn!("perf frame serialization failed");
                    continue;
                };
                event_bus.publish_ephemeral_to(
                    sampler::FRAME_EVENT.to_string(),
                    payload,
                    delivery.device_id.clone(),
                );
            } else {
                if let Err(error) = self.app.emit(sampler::FRAME_EVENT, &targeted) {
                    log::warn!("perf://frame emit failed: {error}");
                }
                if let Err(error) = self.app.emit(sampler::SAMPLE_EVENT, &targeted) {
                    log::warn!("perf://sample compatibility emit failed: {error}");
                }
            }
        }
    }
}

fn host_port(
    app: tauri::AppHandle,
    event_bus: Option<Arc<crate::companion_api::event_bus::EventBus>>,
) -> Arc<dyn sampler::PerfHostPort> {
    Arc::new(TauriPerfHostPort { app, event_bus })
}

/// A dial9 flight-recorder trace file on disk (surfaced for offline analysis).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFile {
    pub trace_id: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
}

const TRACE_ATTACHMENT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const TRACE_CHUNK_MAX_BYTES: usize = 1024 * 1024;
const TRACE_HANDLE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHandle {
    pub handle_id: String,
    pub trace_id: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub chunk_bytes: usize,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceChunk {
    pub offset: u64,
    pub next_offset: u64,
    pub data_base64: String,
    pub chunk_sha256: String,
    pub eof: bool,
    pub final_sha256: Option<String>,
}

struct OpenTrace {
    file: File,
    trace_id: String,
    size: u64,
    modified: Option<SystemTime>,
    expected_sha256: String,
    next_offset: u64,
    expires_at: Instant,
}

static OPEN_TRACES: Lazy<Mutex<HashMap<String, OpenTrace>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The directory dial9 writes binary traces into (mirrors `main.rs`).
fn trace_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("traces"))
}

fn trace_identity(name: &std::ffi::OsStr, meta: &std::fs::Metadata) -> String {
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64);
    format!(
        "trace-{}",
        hex::encode(Sha256::digest(format!(
            "{}\u{1f}{}\u{1f}{modified_ms:?}",
            name.to_string_lossy(),
            meta.len()
        )))
    )
}

fn hash_open_file(file: &mut File) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("trace_seek_failed:{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("trace_read_failed:{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("trace_seek_failed:{error}"))?;
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(unix)]
fn open_trace_no_follow(path: &std::path::Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("trace_open_failed:{error}"))
}

#[cfg(windows)]
fn open_trace_no_follow(path: &std::path::Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("trace_open_failed:{error}"))
}

fn resolve_trace(trace_id: &str) -> Result<(std::path::PathBuf, std::fs::Metadata), String> {
    let dir = trace_dir().ok_or("trace_dir_unavailable")?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|error| format!("trace_dir_unavailable:{error}"))?;
    for entry in std::fs::read_dir(&canonical_dir)
        .map_err(|error| format!("trace_list_failed:{error}"))?
        .flatten()
    {
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|error| format!("trace_stat_failed:{error}"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        if trace_identity(&entry.file_name(), &metadata) != trace_id {
            continue;
        }
        let parent = entry
            .path()
            .parent()
            .and_then(|value| value.canonicalize().ok())
            .ok_or("trace_parent_unavailable")?;
        if parent != canonical_dir {
            return Err("trace_path_escape".into());
        }
        return Ok((entry.path(), metadata));
    }
    Err("trace_not_found".into())
}

#[tauri::command]
pub fn perf_snapshot(state: tauri::State<'_, PerfState>) -> Result<PerfSnapshot, String> {
    state.sampler.snapshot(None, None, super::now_ms())
}

#[tauri::command]
pub fn perf_open_lease(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerfState>,
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
    input: PerfOpenLeaseRequest,
    remote: Option<bool>,
) -> Result<PerfOpenLeaseResult, String> {
    Ok(sampler::open_lease(
        state.sampler.clone(),
        input,
        remote.unwrap_or(false),
        host_port(app, companion.event_bus.read().clone()),
    ))
}

#[tauri::command]
pub fn perf_renew_lease(
    state: tauri::State<'_, PerfState>,
    lease_id: String,
    device_id: Option<String>,
) -> Result<(), String> {
    state
        .sampler
        .renew(&lease_id, device_id.as_deref(), super::now_ms())
        .map(|_| ())
}

#[tauri::command]
pub fn perf_close_lease(
    state: tauri::State<'_, PerfState>,
    lease_id: String,
    device_id: Option<String>,
) -> Result<(), String> {
    state.sampler.close(&lease_id, device_id.as_deref())?;
    Ok(())
}

#[tauri::command]
pub fn perf_lease_snapshot(
    state: tauri::State<'_, PerfState>,
    lease_id: String,
    device_id: Option<String>,
) -> Result<PerfSnapshot, String> {
    state
        .sampler
        .snapshot(Some(&lease_id), device_id.as_deref(), super::now_ms())
}

#[tauri::command]
pub fn perf_read_observations(
    state: tauri::State<'_, PerfState>,
    lease_id: String,
    after_sequence: Option<u64>,
    device_id: Option<String>,
) -> Result<Vec<PerfFrame>, String> {
    state.sampler.read_observations(
        &lease_id,
        after_sequence,
        device_id.as_deref(),
        super::now_ms(),
    )
}

#[tauri::command]
pub fn perf_start_sampling(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerfState>,
    interval_ms: Option<u64>,
) -> Result<(), String> {
    sampler::start(
        state.sampler.clone(),
        interval_ms.unwrap_or(sampler::DEFAULT_INTERVAL_MS),
        host_port(app, None),
    );
    Ok(())
}

#[tauri::command]
pub fn perf_set_interval(
    state: tauri::State<'_, PerfState>,
    interval_ms: u64,
) -> Result<(), String> {
    state.sampler.set_legacy_interval(interval_ms);
    Ok(())
}

#[tauri::command]
pub fn perf_stop_sampling(state: tauri::State<'_, PerfState>) -> Result<(), String> {
    state.sampler.close_legacy();
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
            trace_id: trace_identity(&entry.file_name(), &meta),
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(files)
}

#[tauri::command]
pub fn perf_trace_open(trace_id: String) -> Result<TraceHandle, String> {
    let (path, listed_meta) = resolve_trace(&trace_id)?;
    if listed_meta.len() > TRACE_ATTACHMENT_MAX_BYTES {
        return Err("trace_attachment_too_large".into());
    }
    let mut file = open_trace_no_follow(&path)?;
    let opened_meta = file
        .metadata()
        .map_err(|error| format!("trace_stat_failed:{error}"))?;
    if !opened_meta.is_file()
        || opened_meta.len() != listed_meta.len()
        || opened_meta.modified().ok() != listed_meta.modified().ok()
    {
        return Err("trace_identity_changed".into());
    }
    let expected_sha256 = hash_open_file(&mut file)?;
    let handle_id = uuid::Uuid::now_v7().to_string();
    let expires_at = Instant::now() + TRACE_HANDLE_TTL;
    let expires_at_ms = super::now_ms() + TRACE_HANDLE_TTL.as_millis() as i64;
    let mut registry = OPEN_TRACES.lock();
    registry.retain(|_, trace| trace.expires_at > Instant::now());
    registry.insert(
        handle_id.clone(),
        OpenTrace {
            file,
            trace_id: trace_id.clone(),
            size: opened_meta.len(),
            modified: opened_meta.modified().ok(),
            expected_sha256: expected_sha256.clone(),
            next_offset: 0,
            expires_at,
        },
    );
    Ok(TraceHandle {
        handle_id,
        trace_id,
        size_bytes: opened_meta.len(),
        sha256: expected_sha256,
        chunk_bytes: TRACE_CHUNK_MAX_BYTES,
        expires_at_ms,
    })
}

#[tauri::command]
pub fn perf_trace_read_chunk(
    handle_id: String,
    offset: u64,
    length: Option<usize>,
) -> Result<TraceChunk, String> {
    let mut registry = OPEN_TRACES.lock();
    registry.retain(|_, trace| trace.expires_at > Instant::now());
    let trace = registry.get_mut(&handle_id).ok_or("trace_handle_expired")?;
    if offset != trace.next_offset {
        return Err("trace_chunk_must_be_sequential".into());
    }
    let current = trace
        .file
        .metadata()
        .map_err(|error| format!("trace_stat_failed:{error}"))?;
    if current.len() != trace.size || current.modified().ok() != trace.modified {
        return Err("trace_identity_changed".into());
    }
    let limit = length
        .unwrap_or(TRACE_CHUNK_MAX_BYTES)
        .clamp(1, TRACE_CHUNK_MAX_BYTES);
    let available = trace.size.saturating_sub(offset).min(limit as u64) as usize;
    trace
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|error| format!("trace_seek_failed:{error}"))?;
    let mut bytes = vec![0_u8; available];
    trace
        .file
        .read_exact(&mut bytes)
        .map_err(|error| format!("trace_read_failed:{error}"))?;
    let next_offset = offset + bytes.len() as u64;
    let eof = next_offset == trace.size;
    let final_sha256 = if eof {
        let actual = hash_open_file(&mut trace.file)?;
        if actual != trace.expected_sha256 {
            return Err("trace_final_hash_mismatch".into());
        }
        Some(actual)
    } else {
        None
    };
    trace.next_offset = next_offset;
    trace.expires_at = Instant::now() + TRACE_HANDLE_TTL;
    Ok(TraceChunk {
        offset,
        next_offset,
        data_base64: STANDARD.encode(&bytes),
        chunk_sha256: hex::encode(Sha256::digest(&bytes)),
        eof,
        final_sha256,
    })
}

#[tauri::command]
pub fn perf_trace_close(handle_id: String) -> Result<(), String> {
    OPEN_TRACES
        .lock()
        .remove(&handle_id)
        .map(|_| ())
        .ok_or_else(|| "trace_handle_expired".to_string())
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
        let handle = sampler::SamplerHandle::default();
        let snap = handle.snapshot(None, None, crate::perf::now_ms()).unwrap();
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"intervalMs\":1000"));
        assert!(json.contains("\"wireVersion\":1"));
    }

    #[test]
    fn trace_file_serializes_camel_case() {
        let tf = TraceFile {
            trace_id: "trace-opaque".to_string(),
            size_bytes: 42,
            modified_ms: Some(123),
        };
        let json = serde_json::to_string(&tf).unwrap();
        assert!(json.contains("\"sizeBytes\":42"));
        assert!(json.contains("\"traceId\":\"trace-opaque\""));
        assert!(json.contains("\"modifiedMs\":123"));
    }

    #[test]
    fn trace_identity_is_opaque_and_stable_for_metadata() {
        let root = std::env::temp_dir().join(format!("cognia-perf-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("secret-trace-name.bin");
        std::fs::write(&path, b"trace").unwrap();
        let metadata = path.metadata().unwrap();
        let identity = trace_identity(std::ffi::OsStr::new("secret-trace-name.bin"), &metadata);
        assert!(identity.starts_with("trace-"));
        assert!(!identity.contains("secret-trace-name"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
