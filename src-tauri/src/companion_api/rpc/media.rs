//! Media RPC adapters. The FFmpeg implementation stays in `cognia-media`;
//! this boundary owns caller-scoped source handles, workspace authorization,
//! and bounded binary transfers for HTTP and WebRTC alike.
use super::*;
use crate::media::{service, MediaSourceRegistry, VideoError};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) const COMMANDS: &[&str] = &[
    "video_get_info",
    "plugin_media_get_video_frame",
    "plugin_media_read_analysis_frame",
    "plugin_media_concatenate_videos",
    "plugin_media_apply_video_effect",
    "plugin_media_add_transition",
    "plugin_media_export_video",
    "video_analyze",
    "video_trim",
    "video_cleanup_analysis",
    "plugin_media_read_chunk",
    "plugin_media_close_transfer",
];
const CHUNK_BYTES: usize = 65_536;
const TRANSFER_BYTES: usize = 128 * 1024 * 1024;
const TRANSFER_TTL: Duration = Duration::from_secs(300);

struct Transfer {
    bytes: Vec<u8>,
    touched: Instant,
}
#[derive(Default)]
struct MediaCaller {
    sources: MediaSourceRegistry,
    outputs: Mutex<HashSet<PathBuf>>,
    analyses: Mutex<HashSet<PathBuf>>,
    transfers: Mutex<HashMap<String, Transfer>>,
}

type CallerKey = (String, String, String);
static CALLERS: once_cell::sync::Lazy<
    Mutex<
        HashMap<
            CallerKey,
            (
                std::sync::Weak<super::super::CompanionState>,
                Arc<MediaCaller>,
            ),
        >,
    >,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn caller(state: &SharedState, account_id: Option<&str>, device_id: &str) -> Arc<MediaCaller> {
    let key = (
        opaque_host_id(state),
        account_id.unwrap_or_default().to_string(),
        device_id.to_string(),
    );
    let mut callers = CALLERS.lock();
    callers.retain(|_, (host, _)| host.strong_count() > 0);
    callers
        .entry(key)
        .or_insert_with(|| (Arc::downgrade(state), Arc::new(MediaCaller::default())))
        .1
        .clone()
}

fn media_error(error: VideoError) -> (StatusCode, Json<RpcError>) {
    let (status, code, retryable) = match &error {
        VideoError::InvalidInput { .. } => (StatusCode::BAD_REQUEST, "INVALID_INPUT", false),
        VideoError::MissingDependency { .. } => {
            (StatusCode::SERVICE_UNAVAILABLE, "MISSING_DEPENDENCY", false)
        }
        VideoError::Io { .. } => (StatusCode::INTERNAL_SERVER_ERROR, "IO", true),
        VideoError::ProcessFailed { .. } => {
            (StatusCode::INTERNAL_SERVER_ERROR, "PROCESS_FAILED", false)
        }
        VideoError::Timeout { .. } => (StatusCode::GATEWAY_TIMEOUT, "TIMEOUT", true),
        VideoError::InvalidMetadata { .. } => (StatusCode::BAD_REQUEST, "INVALID_METADATA", false),
    };
    let mut rpc = RpcError::new(code, error.to_string());
    rpc.retryable = retryable;
    (status, Json(rpc))
}

impl MediaCaller {
    fn authorize_source(
        &self,
        host: &super::super::dispatch_host::DispatchHost,
        file: &str,
    ) -> Result<String, (StatusCode, Json<RpcError>)> {
        let path = Path::new(file)
            .canonicalize()
            .map_err(|e| RpcError::malformed(format!("media path does not resolve: {e}")))?;
        if !path.is_file() {
            return Err(RpcError::malformed(
                "media source must be a file".to_string(),
            ));
        }
        if !self.outputs.lock().contains(&path) {
            let parent = path
                .parent()
                .ok_or_else(|| RpcError::malformed("media source has no parent".to_string()))?;
            authorize_workspace_root(host, parent.to_string_lossy().into_owned())?;
        }
        Ok(path.to_string_lossy().into_owned())
    }

    fn remember_output(&self, path: &str) -> Result<(), (StatusCode, Json<RpcError>)> {
        let path = Path::new(path)
            .canonicalize()
            .map_err(|e| RpcError::internal(e.to_string()))?;
        self.outputs.lock().insert(path);
        Ok(())
    }

    fn transfer(self: &Arc<Self>, bytes: Vec<u8>) -> Result<Value, (StatusCode, Json<RpcError>)> {
        let mut transfers = self.transfers.lock();
        transfers.retain(|_, t| t.touched.elapsed() < TRANSFER_TTL);
        let total: usize = transfers.values().map(|t| t.bytes.len()).sum();
        if bytes.len() > TRANSFER_BYTES.saturating_sub(total) {
            return Err(RpcError::malformed(
                "media transfer budget exceeded; close previous transfers before exporting again"
                    .to_string(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let len = bytes.len();
        transfers.insert(
            id.clone(),
            Transfer {
                bytes,
                touched: Instant::now(),
            },
        );
        drop(transfers);
        let owner = Arc::downgrade(self);
        let transfer_id = id.clone();
        tokio::spawn(async move {
            let mut delay = TRANSFER_TTL;
            loop {
                tokio::time::sleep(delay).await;
                let Some(caller) = owner.upgrade() else { break };
                let next = {
                    let mut transfers = caller.transfers.lock();
                    match transfers.get(&transfer_id) {
                        Some(transfer) if transfer.touched.elapsed() < TRANSFER_TTL => {
                            Some(TRANSFER_TTL.saturating_sub(transfer.touched.elapsed()))
                        }
                        _ => {
                            transfers.remove(&transfer_id);
                            None
                        }
                    }
                };
                match next {
                    Some(remaining) => delay = remaining,
                    None => break,
                }
            }
        });
        Ok(json!({ "transferId": id, "byteLength": len, "chunkEncoding": "base64" }))
    }

    fn chunk(
        &self,
        id: &str,
        offset: usize,
        length: usize,
        base64: bool,
    ) -> Result<Value, (StatusCode, Json<RpcError>)> {
        if length == 0 || length > CHUNK_BYTES {
            return Err(RpcError::malformed(
                "media chunk length must be between 1 and 65536".to_string(),
            ));
        }
        let mut transfers = self.transfers.lock();
        transfers.retain(|_, t| t.touched.elapsed() < TRANSFER_TTL);
        let transfer = transfers.get_mut(id).ok_or_else(|| {
            RpcError::malformed("media transfer is unknown or expired".to_string())
        })?;
        if offset > transfer.bytes.len() {
            return Err(RpcError::malformed(
                "media chunk offset exceeds transfer length".to_string(),
            ));
        }
        transfer.touched = Instant::now();
        let bytes =
            &transfer.bytes[offset..offset.saturating_add(length).min(transfer.bytes.len())];
        if base64 {
            Ok(Value::String(STANDARD.encode(bytes)))
        } else {
            to_json(bytes)
        }
    }
}

async fn write_export(
    host: &super::super::dispatch_host::DispatchHost,
    destination: &str,
    overwrite: bool,
    bytes: &[u8],
) -> Result<(), (StatusCode, Json<RpcError>)> {
    let requested = Path::new(destination);
    let parent = requested
        .parent()
        .ok_or_else(|| RpcError::malformed("export destination has no parent".to_string()))?;
    let parent = authorize_workspace_root(host, parent.to_string_lossy().into_owned())?;
    let name = requested
        .file_name()
        .ok_or_else(|| RpcError::malformed("export destination has no filename".to_string()))?;
    let target = Path::new(&parent).join(name);
    // Persist atomically in an authorized directory. Replacing a symlink replaces
    // the link itself, never its target. A failed render/write leaves no partial video.
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(&parent)
            .map_err(|e| RpcError::internal(e.to_string()))?;
        file.write_all(&bytes)
            .map_err(|e| RpcError::internal(e.to_string()))?;
        if overwrite {
            file.persist(&target)
        } else {
            file.persist_noclobber(&target)
        }
        .map_err(|e| RpcError::malformed(format!("could not save media export: {}", e.error)))?;
        Ok(())
    })
    .await
    .map_err(|e| RpcError::internal(e.to_string()))?
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    _scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let caller = caller(state, account_id, device_id);
    let registry = &caller.sources;
    match name {
        "video_get_info" => {
            let path: String = required(&args, "filePath")?;
            let path = caller.authorize_source(host, &path)?;
            to_json(
                service::video_get_info(registry, path)
                    .await
                    .map_err(media_error)?,
            )
        }
        "plugin_media_get_video_frame" => {
            let token = required(&args, "sourceToken")?;
            let time = required(&args, "time")?;
            let format: Option<String> = optional(&args, "format")?;
            let bytes = match format.as_deref() {
                None | Some("rgba") => {
                    service::plugin_media_get_video_frame(registry, token, time).await
                }
                Some("png") => service::video_frame_png(registry, token, time).await,
                _ => {
                    return Err(RpcError::malformed(
                        "frame format must be rgba or png".to_string(),
                    ))
                }
            }
            .map_err(media_error)?;
            caller.transfer(bytes)
        }
        "plugin_media_read_analysis_frame" => {
            let directory: String = required(&args, "outputDirectory")?;
            let requested: String = required(&args, "path")?;
            let directory = Path::new(&directory)
                .canonicalize()
                .map_err(|e| RpcError::malformed(e.to_string()))?;
            if !caller.analyses.lock().contains(&directory) {
                return Err(RpcError::forbidden(
                    "analysis output does not belong to this caller",
                ));
            }
            let path = Path::new(&requested)
                .canonicalize()
                .map_err(|e| RpcError::malformed(e.to_string()))?;
            if path.parent() != Some(directory.as_path())
                || path.extension().and_then(|s| s.to_str()) != Some("jpg")
                || !path.is_file()
            {
                return Err(RpcError::forbidden(
                    "requested frame is outside its analysis output",
                ));
            }
            let size = tokio::fs::metadata(&path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .len();
            if size > TRANSFER_BYTES as u64 {
                return Err(RpcError::malformed(
                    "analysis frame exceeds transfer limit".to_string(),
                ));
            }
            caller.transfer(
                tokio::fs::read(&path)
                    .await
                    .map_err(|e| RpcError::internal(e.to_string()))?,
            )
        }
        "plugin_media_concatenate_videos" => {
            let result =
                service::plugin_media_concatenate_videos(registry, required(&args, "clips")?)
                    .await
                    .map_err(media_error)?;
            caller.remember_output(&result.output_path)?;
            to_json(result)
        }
        "plugin_media_apply_video_effect" => {
            service::plugin_media_apply_video_effect(
                registry,
                required(&args, "sourceToken")?,
                required(&args, "effect")?,
            )
            .await
            .map_err(media_error)?;
            Ok(Value::Null)
        }
        "plugin_media_add_transition" => {
            service::plugin_media_add_transition(
                registry,
                required(&args, "fromClip")?,
                required(&args, "toClip")?,
                required(&args, "transition")?,
            )
            .await
            .map_err(media_error)?;
            Ok(Value::Null)
        }
        "plugin_media_export_video" => {
            let bytes = service::plugin_media_export_video(
                registry,
                required(&args, "clips")?,
                required(&args, "options")?,
            )
            .await
            .map_err(media_error)?;
            if let Some(destination) = optional::<String>(&args, "destinationPath")? {
                write_export(
                    host,
                    &destination,
                    optional(&args, "overwrite")?.unwrap_or(false),
                    &bytes,
                )
                .await?;
            }
            caller.transfer(bytes)
        }
        "video_analyze" => {
            let result = service::video_analyze(registry, required(&args, "options")?)
                .await
                .map_err(media_error)?;
            let directory = Path::new(&result.output_directory)
                .canonicalize()
                .map_err(|e| RpcError::internal(e.to_string()))?;
            caller.analyses.lock().insert(directory);
            to_json(result)
        }
        "video_trim" => {
            let result = service::video_trim(registry, required(&args, "options")?)
                .await
                .map_err(media_error)?;
            caller.remember_output(&result.output_path)?;
            to_json(result)
        }
        "video_cleanup_analysis" => {
            let directory: String = required(&args, "outputDirectory")?;
            let path = Path::new(&directory)
                .canonicalize()
                .map_err(|e| RpcError::malformed(e.to_string()))?;
            if !caller.analyses.lock().contains(&path) {
                return Err(RpcError::forbidden(
                    "analysis output does not belong to this caller",
                ));
            }
            service::video_cleanup_analysis(path.to_string_lossy().into_owned())
                .await
                .map_err(media_error)?;
            caller.analyses.lock().remove(&path);
            Ok(Value::Null)
        }
        "plugin_media_read_chunk" => {
            let encoding: Option<String> = optional(&args, "encoding")?;
            let base64 = match encoding.as_deref() {
                None => false,
                Some("base64") => true,
                Some(_) => {
                    return Err(RpcError::malformed(
                        "unsupported media chunk encoding".to_string(),
                    ))
                }
            };
            caller.chunk(
                &required::<String>(&args, "transferId")?,
                required(&args, "offset")?,
                optional(&args, "length")?.unwrap_or(CHUNK_BYTES),
                base64,
            )
        }
        "plugin_media_close_transfer" => {
            caller
                .transfers
                .lock()
                .remove(&required::<String>(&args, "transferId")?);
            Ok(Value::Null)
        }
        _ => Err(RpcError::unknown_command(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> SharedState {
        use super::super::super::*;
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(uuid::Uuid::new_v4().as_bytes().to_vec()),
            deny_list: Arc::new(deny_list::DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(idempotency::IdempotencyCache::new()),
            event_bus: event_bus::EventBus::new(),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }

    #[tokio::test]
    async fn real_headless_rpc_pipeline_confines_sources_and_round_trips_binary() {
        let state = state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let root = services.spawn_policy.workspaces_dir();
        std::fs::create_dir_all(root).unwrap();
        let workspace = tempfile::tempdir_in(root).unwrap();
        let source = workspace.path().join("source.mp4");
        let result = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x48:rate=4",
                "-t",
                "1",
                "-c:v",
                "mpeg4",
            ])
            .arg(&source)
            .output()
            .expect("ffmpeg fixture dependency");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let host = super::super::super::dispatch_host::DispatchHost::Headless(services);
        let call = |name: &'static str, args| {
            dispatch(
                name,
                args,
                &state,
                &host,
                "device-a",
                Some("account-a"),
                Some("service"),
            )
        };
        let info = call("video_get_info", json!({"filePath":source}))
            .await
            .unwrap();
        assert_eq!(info["width"], 64);
        let token = info["sourceToken"].as_str().unwrap();
        assert!(dispatch(
            "plugin_media_get_video_frame",
            json!({"sourceToken":token,"time":0}),
            &state,
            &host,
            "device-b",
            Some("account-a"),
            Some("service")
        )
        .await
        .is_err());
        assert!(dispatch(
            "plugin_media_get_video_frame",
            json!({"sourceToken":token,"time":0}),
            &state,
            &host,
            "device-a",
            Some("account-b"),
            Some("service")
        )
        .await
        .is_err());
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(call("video_get_info", json!({"filePath":outside.path()}))
            .await
            .is_err());
        #[cfg(unix)]
        {
            let link = workspace.path().join("escape.mp4");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert!(call("video_get_info", json!({"filePath":link}))
                .await
                .is_err());
        }
        for format in ["rgba", "png"] {
            let transfer = call(
                "plugin_media_get_video_frame",
                json!({"sourceToken":token,"time":0,"format":format}),
            )
            .await
            .unwrap();
            let id = transfer["transferId"].as_str().unwrap();
            let bytes: Vec<u8> = serde_json::from_value(
                call(
                    "plugin_media_read_chunk",
                    json!({"transferId":id,"offset":0}),
                )
                .await
                .unwrap(),
            )
            .unwrap();
            if format == "png" {
                assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            } else {
                assert_eq!(bytes.len(), 8 + 64 * 48 * 4);
            }
            call("plugin_media_close_transfer", json!({"transferId":id}))
                .await
                .unwrap();
            assert!(call(
                "plugin_media_read_chunk",
                json!({"transferId":id,"offset":0})
            )
            .await
            .is_err());
        }
        let trimmed = call(
            "video_trim",
            json!({"options":{"sourceToken":token,"startTime":0,"endTime":0.5,"format":"mp4"}}),
        )
        .await
        .unwrap();
        let generated = trimmed["outputPath"].as_str().unwrap();
        assert!(call("video_get_info", json!({"filePath":generated}))
            .await
            .is_ok());
        assert!(dispatch(
            "video_get_info",
            json!({"filePath":generated}),
            &state,
            &host,
            "device-b",
            Some("account-a"),
            Some("service")
        )
        .await
        .is_err());
        let clip = json!({"sourceToken":token,"startTime":0,"endTime":0.5,"volume":1,"playbackSpeed":1,"effects":[]});
        call(
            "plugin_media_apply_video_effect",
            json!({"sourceToken":token,"effect":{"id":"grayscale"}}),
        )
        .await
        .unwrap();
        call(
            "plugin_media_add_transition",
            json!({"fromClip":clip,"toClip":clip,"transition":{"type":"fade","duration":0.1}}),
        )
        .await
        .unwrap();
        let joined = call(
            "plugin_media_concatenate_videos",
            json!({"clips":[clip,clip]}),
        )
        .await
        .unwrap();
        let analysis = call(
            "video_analyze",
            json!({"options":{"sourceToken":token,"maxFrames":2,"width":64}}),
        )
        .await
        .unwrap();
        assert!(dispatch(
            "video_cleanup_analysis",
            json!({"outputDirectory":analysis["outputDirectory"]}),
            &state,
            &host,
            "device-b",
            Some("account-a"),
            Some("service")
        )
        .await
        .is_err());
        let frame = call("plugin_media_read_analysis_frame", json!({"outputDirectory":analysis["outputDirectory"],"path":analysis["frames"][0]["path"]})).await.unwrap();
        let frame_id = frame["transferId"].as_str().unwrap();
        let data: Vec<u8> = serde_json::from_value(
            call(
                "plugin_media_read_chunk",
                json!({"transferId":frame_id,"offset":0}),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(&data[..2], &[255, 216]);
        call(
            "plugin_media_close_transfer",
            json!({"transferId":frame_id}),
        )
        .await
        .unwrap();
        call(
            "video_cleanup_analysis",
            json!({"outputDirectory":analysis["outputDirectory"]}),
        )
        .await
        .unwrap();
        let destination = workspace.path().join("export.mp4");
        let export = call("plugin_media_export_video", json!({"clips":[clip],"options":{"format":"mp4","resolution":"480p","fps":4,"quality":"low"},"destinationPath":destination})).await.unwrap();
        let export_id = export["transferId"].as_str().unwrap();
        let chunk: Vec<u8> = serde_json::from_value(
            call(
                "plugin_media_read_chunk",
                json!({"transferId":export_id,"offset":0}),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(&chunk[4..8], b"ftyp");
        assert!(destination.is_file());
        assert!(
            write_export(&host, destination.to_str().unwrap(), false, b"test")
                .await
                .is_err()
        );
        assert!(
            write_export(&host, outside.path().to_str().unwrap(), true, b"test")
                .await
                .is_err()
        );
        call(
            "plugin_media_close_transfer",
            json!({"transferId":export_id}),
        )
        .await
        .unwrap();
        tokio::fs::remove_file(generated).await.unwrap();
        tokio::fs::remove_file(joined["outputPath"].as_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn chunk_transfers_are_bounded_and_caller_scoped() {
        let caller = Arc::new(MediaCaller::default());
        let other = MediaCaller::default();
        let bytes = vec![255; CHUNK_BYTES + 3];
        let descriptor = caller.transfer(bytes.clone()).unwrap();
        let id = descriptor["transferId"].as_str().unwrap();
        assert_eq!(descriptor["byteLength"], bytes.len());
        assert!(other.chunk(id, 0, 1, false).is_err());
        assert_eq!(
            caller
                .chunk(id, 0, CHUNK_BYTES, false)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            CHUNK_BYTES
        );
        assert_eq!(
            caller.chunk(id, CHUNK_BYTES, CHUNK_BYTES, false).unwrap(),
            json!([255, 255, 255])
        );
        assert_eq!(
            caller.chunk(id, CHUNK_BYTES, CHUNK_BYTES, true).unwrap(),
            json!("////")
        );
        let compact = caller.chunk(id, 0, CHUNK_BYTES, true).unwrap();
        let encoded = compact.as_str().unwrap();
        assert_eq!(encoded.len(), CHUNK_BYTES.div_ceil(3) * 4);
        assert_eq!(STANDARD.decode(encoded).unwrap(), bytes[..CHUNK_BYTES]);
        assert!(other.chunk(id, 0, 1, true).is_err());
        assert!(caller.chunk(id, bytes.len() + 1, 1, false).is_err());
        assert!(caller.chunk(id, 0, CHUNK_BYTES + 1, false).is_err());
        assert!(caller.chunk(id, 0, 0, false).is_err());
        caller.transfers.lock().get_mut(id).unwrap().touched = Instant::now() - TRANSFER_TTL;
        assert!(caller.chunk(id, 0, 1, false).is_err());
    }

    #[test]
    fn errors_preserve_media_codes_and_retryability() {
        let (status, Json(error)) = media_error(VideoError::MissingDependency {
            binary: "ffmpeg".into(),
        });
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "MISSING_DEPENDENCY");
        assert!(!error.retryable);
        assert!(
            !media_error(VideoError::InvalidInput {
                message: "bad range".into()
            })
            .1
             .0
            .retryable
        );
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert_eq!(COMMANDS.len(), 12);
        assert_eq!(
            COMMANDS.iter().copied().collect::<HashSet<_>>().len(),
            COMMANDS.len()
        );
    }
}
