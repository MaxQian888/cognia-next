//! Native local-video processing for Cognia.
//!
//! This crate owns FFmpeg/FFprobe discovery, metadata probing, frame extraction,
//! focused analysis, near-duplicate removal, and trimming. Callers learn one
//! small set of serializable command types; process details stay private.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::RwLock;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;

mod editing;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const FRAME_TIMEOUT: Duration = Duration::from_secs(120);
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(600);
const TRIM_TIMEOUT: Duration = Duration::from_secs(1_200);
const MAX_FRAME_EDGE: u32 = 2048;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VideoError {
    #[error("The media path is invalid: {message}")]
    InvalidInput { message: String },
    #[error("Required media tool '{binary}' was not found on PATH")]
    MissingDependency { binary: String },
    #[error("Failed to access media: {message}")]
    Io { message: String },
    #[error("{binary} failed: {message}")]
    ProcessFailed { binary: String, message: String },
    #[error("{binary} timed out after {timeout_seconds} seconds")]
    Timeout {
        binary: String,
        timeout_seconds: u64,
    },
    #[error("Could not read media metadata: {message}")]
    InvalidMetadata { message: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoInfo {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub file_size: u64,
    pub has_audio: bool,
    pub source_token: String,
}

#[derive(Default)]
pub struct MediaSourceRegistry {
    sources: RwLock<HashMap<String, PathBuf>>,
}

impl MediaSourceRegistry {
    fn register(&self, path: PathBuf) -> Result<String, VideoError> {
        let mut sources = self.sources.write().map_err(|_| VideoError::Io {
            message: "media source registry lock is poisoned".to_string(),
        })?;
        if let Some((token, _)) = sources.iter().find(|(_, registered)| **registered == path) {
            return Ok(token.clone());
        }
        let token = uuid::Uuid::new_v4().to_string();
        sources.insert(token.clone(), path);
        Ok(token)
    }

    fn resolve(&self, token: &str) -> Result<PathBuf, VideoError> {
        self.sources
            .read()
            .map_err(|_| VideoError::Io {
                message: "media source registry lock is poisoned".to_string(),
            })?
            .get(token)
            .cloned()
            .ok_or_else(|| VideoError::InvalidInput {
                message: "media source token is unknown or expired".to_string(),
            })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoAnalysisMode {
    Keyframes,
    #[default]
    Scene,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAnalysisOptions {
    pub source_token: String,
    pub mode: Option<VideoAnalysisMode>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub max_frames: Option<usize>,
    pub width: Option<u32>,
    pub deduplicate: Option<bool>,
    pub duplicate_threshold: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoAnalysisFrameReason {
    Keyframe,
    SceneChange,
    UniformFallback,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAnalysisFrame {
    pub path: String,
    pub timestamp: f64,
    pub reason: VideoAnalysisFrameReason,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAnalysisRange {
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAnalysisManifest {
    pub source_path: String,
    pub output_directory: String,
    pub mode: VideoAnalysisMode,
    pub range: VideoAnalysisRange,
    pub metadata: NativeVideoInfo,
    pub candidate_count: usize,
    pub deduplicated_count: usize,
    pub frames: Vec<VideoAnalysisFrame>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTrimOptions {
    pub source_token: String,
    pub start_time: f64,
    pub end_time: f64,
    pub format: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTrimResult {
    pub output_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedVideoClipInput {
    pub source_token: String,
    pub start_time: f64,
    pub end_time: f64,
    pub volume: f64,
    pub playback_speed: f64,
    #[serde(default)]
    pub effects: Vec<editing::VideoEffectSpec>,
    pub transition_out: Option<editing::VideoTransitionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportCommandOptions {
    pub format: String,
    pub resolution: String,
    pub fps: u32,
    pub quality: String,
    pub codec: Option<String>,
    pub audio_bitrate: Option<u32>,
    pub video_bitrate: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEditResult {
    pub output_path: String,
}

#[derive(Clone, Debug)]
struct NormalizedAnalysisOptions {
    mode: VideoAnalysisMode,
    start_time: f64,
    end_time: f64,
    max_frames: usize,
    width: u32,
    deduplicate: bool,
    duplicate_threshold: f64,
}

fn normalize_analysis_options(
    options: VideoAnalysisOptions,
    metadata: &NativeVideoInfo,
) -> Result<NormalizedAnalysisOptions, VideoError> {
    let duration = metadata.duration_ms as f64 / 1000.0;
    if duration <= 0.0 {
        return Err(VideoError::InvalidMetadata {
            message: "video duration must be greater than zero".to_string(),
        });
    }
    let start_time = options.start_time.unwrap_or(0.0);
    let end_time = options.end_time.unwrap_or(duration).min(duration);
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time < 0.0
        || start_time >= end_time
    {
        return Err(VideoError::InvalidInput {
            message: format!(
                "analysis range must satisfy 0 <= startTime < endTime <= {duration:.3}"
            ),
        });
    }
    let duplicate_threshold = options.duplicate_threshold.unwrap_or(2.0);
    if !duplicate_threshold.is_finite() || !(0.0..=255.0).contains(&duplicate_threshold) {
        return Err(VideoError::InvalidInput {
            message: "duplicateThreshold must be between 0 and 255".to_string(),
        });
    }

    Ok(NormalizedAnalysisOptions {
        mode: options.mode.unwrap_or_default(),
        start_time,
        end_time,
        max_frames: options.max_frames.unwrap_or(60).clamp(1, 100),
        width: options.width.unwrap_or(512).clamp(64, 2048),
        deduplicate: options.deduplicate.unwrap_or(true),
        duplicate_threshold,
    })
}

fn select_distinct_indices(thumbnails: &[Vec<u8>], threshold: f64) -> Vec<usize> {
    let mut selected = Vec::new();
    for (index, thumbnail) in thumbnails.iter().enumerate() {
        let Some(previous_index) = selected.last().copied() else {
            selected.push(index);
            continue;
        };
        let previous: &Vec<u8> = &thumbnails[previous_index];
        if previous.len() != thumbnail.len() || thumbnail.is_empty() {
            selected.push(index);
            continue;
        }
        let mean_absolute_difference = previous
            .iter()
            .zip(thumbnail)
            .map(|(left, right)| (*left as f64 - *right as f64).abs())
            .sum::<f64>()
            / thumbnail.len() as f64;
        if mean_absolute_difference > threshold {
            selected.push(index);
        }
    }
    selected
}

fn calculate_frame_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    if width == 0 || height == 0 || width.max(height) <= max_edge {
        return (width, height);
    }
    let scale = max_edge as f64 / width.max(height) as f64;
    let scaled_width = (((width as f64 * scale).round() as u32).max(2)) & !1;
    let scaled_height = (((height as f64 * scale).round() as u32).max(2)) & !1;
    (scaled_width, scaled_height)
}

fn parse_showinfo_timestamps(stderr: &[u8], offset: f64) -> Vec<f64> {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter_map(|line| {
            line.split_whitespace()
                .find_map(|part| part.strip_prefix("pts_time:"))
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
                .map(|value| value + offset)
        })
        .collect()
}

fn evenly_sample_indices(candidate_count: usize, max_frames: usize) -> Vec<usize> {
    if candidate_count <= max_frames {
        return (0..candidate_count).collect();
    }
    if max_frames == 1 {
        return vec![0];
    }
    (0..max_frames)
        .map(|index| {
            ((index as f64 * (candidate_count - 1) as f64) / (max_frames - 1) as f64).round()
                as usize
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: ProbeFormat,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
}

fn parse_f64(value: Option<&str>) -> Option<f64> {
    value?
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    value?.parse::<u64>().ok()
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let (numerator, denominator) = value.split_once('/').unwrap_or((value, "1"));
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    if numerator.is_finite() && denominator.is_finite() && denominator > 0.0 {
        Some(numerator / denominator)
    } else {
        None
    }
}

fn parse_probe_output(output: &[u8]) -> Result<NativeVideoInfo, VideoError> {
    let document: ProbeDocument =
        serde_json::from_slice(output).map_err(|error| VideoError::InvalidMetadata {
            message: error.to_string(),
        })?;
    let video = document
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| VideoError::InvalidMetadata {
            message: "no video stream was found".to_string(),
        })?;

    let duration_seconds = parse_f64(document.format.duration.as_deref())
        .or_else(|| parse_f64(video.duration.as_deref()))
        .unwrap_or(0.0)
        .max(0.0);
    let fps = parse_frame_rate(video.avg_frame_rate.as_deref())
        .filter(|value| *value > 0.0)
        .or_else(|| parse_frame_rate(video.r_frame_rate.as_deref()))
        .unwrap_or(0.0);

    Ok(NativeVideoInfo {
        duration_ms: (duration_seconds * 1000.0).round() as u64,
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps,
        codec: video
            .codec_name
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        file_size: parse_u64(document.format.size.as_deref()).unwrap_or(0),
        has_audio: document
            .streams
            .iter()
            .any(|stream| stream.codec_type.as_deref() == Some("audio")),
        source_token: String::new(),
    })
}

async fn resolve_media_file(file_path: &str) -> Result<PathBuf, VideoError> {
    if file_path.trim().is_empty() {
        return Err(VideoError::InvalidInput {
            message: "filePath must not be empty".to_string(),
        });
    }
    let path = Path::new(file_path);
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", path.display()),
        })?;
    if !metadata.is_file() {
        return Err(VideoError::InvalidInput {
            message: format!("{} is not a file", path.display()),
        });
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", path.display()),
        })
}

async fn run_process(
    binary: &str,
    args: &[OsString],
    timeout: Duration,
) -> Result<Output, VideoError> {
    let mut command = Command::new(binary);
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| VideoError::Timeout {
            binary: binary.to_string(),
            timeout_seconds: timeout.as_secs(),
        })?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                VideoError::MissingDependency {
                    binary: binary.to_string(),
                }
            } else {
                VideoError::Io {
                    message: format!("could not start {binary}: {error}"),
                }
            }
        })?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(VideoError::ProcessFailed {
            binary: binary.to_string(),
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

async fn probe_video(path: &Path) -> Result<NativeVideoInfo, VideoError> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-print_format"),
        OsString::from("json"),
        OsString::from("-show_streams"),
        OsString::from("-show_format"),
        path.as_os_str().to_owned(),
    ];
    let output = run_process("ffprobe", &args, PROBE_TIMEOUT).await?;
    parse_probe_output(&output.stdout)
}

#[derive(Debug)]
struct CandidateFrame {
    path: PathBuf,
    timestamp: f64,
}

fn candidate_paths(output_directory: &Path) -> Result<Vec<PathBuf>, VideoError> {
    let mut paths = std::fs::read_dir(output_directory)
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", output_directory.display()),
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn remove_candidate_files(output_directory: &Path) -> Result<(), VideoError> {
    for path in candidate_paths(output_directory)? {
        std::fs::remove_file(&path).map_err(|error| VideoError::Io {
            message: format!("{}: {error}", path.display()),
        })?;
    }
    Ok(())
}

fn build_analysis_filter(mode: VideoAnalysisMode, width: u32, uniform_fps: Option<f64>) -> String {
    let scale = format!("scale='min(iw,{width})':-2");
    if let Some(fps) = uniform_fps {
        return format!("fps={fps:.8},{scale},showinfo");
    }
    match mode {
        VideoAnalysisMode::Keyframes => {
            format!("select='eq(pict_type,I)',{scale},showinfo")
        }
        VideoAnalysisMode::Scene => {
            format!("select='eq(n,0)+gt(scene,0.30)',{scale},showinfo")
        }
    }
}

async fn extract_candidate_frames(
    input_path: &Path,
    output_directory: &Path,
    options: &NormalizedAnalysisOptions,
    warnings: &mut Vec<String>,
) -> Result<(Vec<CandidateFrame>, VideoAnalysisFrameReason), VideoError> {
    let range_duration = options.end_time - options.start_time;
    let candidate_limit = options.max_frames.saturating_mul(4).clamp(4, 400);
    let output_pattern = output_directory.join("frame-%04d.jpg");
    let mut reason = match options.mode {
        VideoAnalysisMode::Keyframes => VideoAnalysisFrameReason::Keyframe,
        VideoAnalysisMode::Scene => VideoAnalysisFrameReason::SceneChange,
    };

    let run_extraction = |filter: String, frame_limit: usize| {
        let args = vec![
            OsString::from("-nostdin"),
            OsString::from("-v"),
            OsString::from("info"),
            OsString::from("-ss"),
            OsString::from(format!("{:.6}", options.start_time)),
            OsString::from("-i"),
            input_path.as_os_str().to_owned(),
            OsString::from("-t"),
            OsString::from(format!("{range_duration:.6}")),
            OsString::from("-vf"),
            OsString::from(filter),
            OsString::from("-fps_mode"),
            OsString::from("vfr"),
            OsString::from("-frames:v"),
            OsString::from(frame_limit.to_string()),
            OsString::from("-q:v"),
            OsString::from("3"),
            output_pattern.as_os_str().to_owned(),
        ];
        async move { run_process("ffmpeg", &args, ANALYSIS_TIMEOUT).await }
    };

    let mut output = run_extraction(
        build_analysis_filter(options.mode, options.width, None),
        candidate_limit,
    )
    .await?;
    let mut paths = candidate_paths(output_directory)?;

    if paths.len() < options.max_frames.min(4) {
        remove_candidate_files(output_directory)?;
        let uniform_fps = options.max_frames as f64 / range_duration;
        output = run_extraction(
            build_analysis_filter(options.mode, options.width, Some(uniform_fps)),
            options.max_frames,
        )
        .await?;
        paths = candidate_paths(output_directory)?;
        reason = VideoAnalysisFrameReason::UniformFallback;
        warnings.push(
            "The selected sampler produced too few frames; uniform sampling was used.".to_string(),
        );
    }

    if paths.is_empty() {
        return Err(VideoError::InvalidMetadata {
            message: "ffmpeg did not extract any video frames".to_string(),
        });
    }

    let timestamps = parse_showinfo_timestamps(&output.stderr, options.start_time);
    let timestamps = if timestamps.len() == paths.len() {
        timestamps
    } else {
        warnings.push(
            "FFmpeg timestamp output was incomplete; timestamps were reconstructed.".to_string(),
        );
        let denominator = paths.len().saturating_sub(1).max(1) as f64;
        (0..paths.len())
            .map(|index| options.start_time + range_duration * index as f64 / denominator)
            .collect()
    };

    Ok((
        paths
            .into_iter()
            .zip(timestamps)
            .map(|(path, timestamp)| CandidateFrame { path, timestamp })
            .collect(),
        reason,
    ))
}

async fn read_thumbnail_strip(frames: &[CandidateFrame]) -> Result<Vec<Vec<u8>>, VideoError> {
    if frames.is_empty() {
        return Ok(Vec::new());
    }
    let first = frames
        .first()
        .and_then(|frame| frame.path.file_name())
        .and_then(|name| name.to_str())
        .ok_or_else(|| VideoError::InvalidInput {
            message: "candidate frame name is not valid UTF-8".to_string(),
        })?;
    if first != "frame-0001.jpg" {
        return Err(VideoError::InvalidMetadata {
            message: "candidate frame sequence does not start at frame-0001.jpg".to_string(),
        });
    }
    let directory = frames[0]
        .path
        .parent()
        .ok_or_else(|| VideoError::InvalidInput {
            message: "candidate frame has no parent directory".to_string(),
        })?;
    let pattern = directory.join("frame-%04d.jpg");
    let args = vec![
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-framerate"),
        OsString::from("1"),
        OsString::from("-start_number"),
        OsString::from("1"),
        OsString::from("-i"),
        pattern.as_os_str().to_owned(),
        OsString::from("-frames:v"),
        OsString::from(frames.len().to_string()),
        OsString::from("-vf"),
        OsString::from("scale=16:16,format=gray"),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("-pix_fmt"),
        OsString::from("gray"),
        OsString::from("pipe:1"),
    ];
    let output = run_process("ffmpeg", &args, FRAME_TIMEOUT).await?;
    if output.stdout.len() != frames.len() * 256 {
        return Err(VideoError::InvalidMetadata {
            message: format!(
                "thumbnail strip contained {} bytes; expected {}",
                output.stdout.len(),
                frames.len() * 256
            ),
        });
    }
    Ok(output
        .stdout
        .chunks_exact(256)
        .map(|chunk| chunk.to_vec())
        .collect())
}

struct TemporaryPathGuard {
    path: PathBuf,
    directory: bool,
    armed: bool,
}

impl TemporaryPathGuard {
    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            directory: true,
            armed: true,
        }
    }

    fn file(path: PathBuf) -> Self {
        Self {
            path,
            directory: false,
            armed: true,
        }
    }

    fn retain(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryPathGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if self.directory {
            let _ = std::fs::remove_dir_all(&self.path);
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn media_temp_root() -> PathBuf {
    std::env::temp_dir().join("cognia-video")
}

async fn resolve_render_clips(
    registry: &MediaSourceRegistry,
    clips: &[AuthorizedVideoClipInput],
) -> Result<(Vec<editing::VideoRenderClip>, Vec<NativeVideoInfo>), VideoError> {
    let mut resolved = Vec::with_capacity(clips.len());
    let mut metadata = Vec::with_capacity(clips.len());
    for clip in clips {
        let path = registry.resolve(&clip.source_token)?;
        let info = probe_video(&path).await?;
        let duration = info.duration_ms as f64 / 1000.0;
        if !clip.end_time.is_finite() || clip.end_time > duration + 0.001 {
            return Err(VideoError::InvalidInput {
                message: format!(
                    "clip endTime must not exceed the authorized source duration ({duration:.3})"
                ),
            });
        }
        resolved.push(editing::VideoRenderClip {
            path,
            start_time: clip.start_time,
            end_time: clip.end_time,
            volume: clip.volume,
            playback_speed: clip.playback_speed,
            has_audio: info.has_audio,
            effects: clip.effects.clone(),
            transition_out: clip.transition_out.clone(),
        });
        metadata.push(info);
    }
    Ok((resolved, metadata))
}

fn export_dimensions(resolution: &str) -> Result<(u32, u32), VideoError> {
    match resolution {
        "480p" => Ok((854, 480)),
        "720p" => Ok((1280, 720)),
        "1080p" => Ok((1920, 1080)),
        "4k" => Ok((3840, 2160)),
        _ => Err(VideoError::InvalidInput {
            message: "export resolution must be 480p, 720p, 1080p, or 4k".to_string(),
        }),
    }
}

fn normalize_export_options(
    options: VideoExportCommandOptions,
) -> Result<editing::VideoExportOptions, VideoError> {
    let (width, height) = export_dimensions(&options.resolution)?;
    Ok(editing::VideoExportOptions {
        format: options.format,
        width,
        height,
        fps: options.fps,
        quality: options.quality,
        codec: options.codec,
        audio_bitrate: options.audio_bitrate,
        video_bitrate: options.video_bitrate,
    })
}

async fn analyze_video(
    input_path: &Path,
    metadata: NativeVideoInfo,
    options: NormalizedAnalysisOptions,
) -> Result<VideoAnalysisManifest, VideoError> {
    let output_directory = media_temp_root().join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&output_directory)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", output_directory.display()),
        })?;
    let mut cleanup_guard = TemporaryPathGuard::directory(output_directory.clone());

    let result = async {
        let mut warnings = Vec::new();
        let (candidates, reason) =
            extract_candidate_frames(input_path, &output_directory, &options, &mut warnings)
                .await?;
        let candidate_count = candidates.len();

        let distinct_indices = if options.deduplicate && candidates.len() > 1 {
            match read_thumbnail_strip(&candidates).await {
                Ok(thumbnails) => select_distinct_indices(&thumbnails, options.duplicate_threshold),
                Err(error) => {
                    warnings.push(format!("Near-duplicate detection was skipped: {error}"));
                    (0..candidates.len()).collect()
                }
            }
        } else {
            (0..candidates.len()).collect()
        };
        let deduplicated_count = candidate_count.saturating_sub(distinct_indices.len());
        let sampled_positions = evenly_sample_indices(distinct_indices.len(), options.max_frames);
        let selected_indices = sampled_positions
            .into_iter()
            .map(|position| distinct_indices[position])
            .collect::<HashSet<_>>();

        let mut frames = Vec::with_capacity(selected_indices.len());
        for (index, candidate) in candidates.into_iter().enumerate() {
            if selected_indices.contains(&index) {
                frames.push(VideoAnalysisFrame {
                    path: candidate.path.to_string_lossy().into_owned(),
                    timestamp: candidate.timestamp,
                    reason,
                });
            } else if let Err(error) = std::fs::remove_file(&candidate.path) {
                warnings.push(format!(
                    "Could not remove unused frame {}: {error}",
                    candidate.path.display()
                ));
            }
        }
        frames.sort_by(|left, right| left.timestamp.total_cmp(&right.timestamp));

        Ok(VideoAnalysisManifest {
            source_path: input_path.to_string_lossy().into_owned(),
            output_directory: output_directory.to_string_lossy().into_owned(),
            mode: options.mode,
            range: VideoAnalysisRange {
                start_time: options.start_time,
                end_time: options.end_time,
            },
            metadata,
            candidate_count,
            deduplicated_count,
            frames,
            warnings,
        })
    }
    .await;

    if result.is_ok() {
        cleanup_guard.retain();
    }
    result
}

async fn extract_frame(
    input_path: &Path,
    metadata: &NativeVideoInfo,
    time: f64,
) -> Result<NativeVideoFrame, VideoError> {
    let duration = metadata.duration_ms as f64 / 1000.0;
    if !time.is_finite() || time < 0.0 || time > duration {
        return Err(VideoError::InvalidInput {
            message: format!("time must be between 0 and {duration:.3} seconds"),
        });
    }
    let (width, height) =
        calculate_frame_dimensions(metadata.width, metadata.height, MAX_FRAME_EDGE);
    if width == 0 || height == 0 {
        return Err(VideoError::InvalidMetadata {
            message: "video dimensions must be greater than zero".to_string(),
        });
    }
    let args = vec![
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-ss"),
        OsString::from(format!("{time:.6}")),
        OsString::from("-i"),
        input_path.as_os_str().to_owned(),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        OsString::from(format!("scale={width}:{height},format=rgba")),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("-pix_fmt"),
        OsString::from("rgba"),
        OsString::from("pipe:1"),
    ];
    let output = run_process("ffmpeg", &args, FRAME_TIMEOUT).await?;
    let expected_length = width as usize * height as usize * 4;
    if output.stdout.len() != expected_length {
        return Err(VideoError::InvalidMetadata {
            message: format!(
                "decoded frame contained {} bytes; expected {expected_length}",
                output.stdout.len()
            ),
        });
    }
    Ok(NativeVideoFrame {
        data: output.stdout,
        width,
        height,
    })
}

async fn trim_video(
    input_path: &Path,
    metadata: &NativeVideoInfo,
    options: &VideoTrimOptions,
) -> Result<VideoTrimResult, VideoError> {
    let duration = metadata.duration_ms as f64 / 1000.0;
    if !options.start_time.is_finite()
        || !options.end_time.is_finite()
        || options.start_time < 0.0
        || options.start_time >= options.end_time
        || options.end_time > duration
    {
        return Err(VideoError::InvalidInput {
            message: format!("trim range must satisfy 0 <= startTime < endTime <= {duration:.3}"),
        });
    }
    if options.format != "mp4" {
        return Err(VideoError::InvalidInput {
            message: "only mp4 trim output is supported".to_string(),
        });
    }
    let output_parent = media_temp_root().join("trims");
    tokio::fs::create_dir_all(&output_parent)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", output_parent.display()),
        })?;
    let output_path = output_parent.join(format!("{}.mp4", uuid::Uuid::new_v4()));
    let mut cleanup_guard = TemporaryPathGuard::file(output_path.clone());
    let segment_duration = options.end_time - options.start_time;
    let args = vec![
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-n"),
        OsString::from("-i"),
        input_path.as_os_str().to_owned(),
        OsString::from("-ss"),
        OsString::from(format!("{:.6}", options.start_time)),
        OsString::from("-t"),
        OsString::from(format!("{segment_duration:.6}")),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a?"),
        OsString::from("-c:v"),
        OsString::from("libx264"),
        OsString::from("-preset"),
        OsString::from("veryfast"),
        OsString::from("-crf"),
        OsString::from("20"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        output_path.as_os_str().to_owned(),
    ];
    run_process("ffmpeg", &args, TRIM_TIMEOUT).await?;
    cleanup_guard.retain();
    Ok(VideoTrimResult {
        output_path: output_path.to_string_lossy().into_owned(),
    })
}

async fn cleanup_analysis_directory(output_directory: &str) -> Result<(), VideoError> {
    let path = PathBuf::from(output_directory);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| VideoError::InvalidInput {
            message: "analysis directory has no valid identifier".to_string(),
        })?;
    uuid::Uuid::parse_str(name).map_err(|_| VideoError::InvalidInput {
        message: "analysis directory is not owned by Cognia".to_string(),
    })?;
    let expected_parent = tokio::fs::canonicalize(media_temp_root())
        .await
        .map_err(|error| VideoError::Io {
            message: format!("could not resolve Cognia media temp root: {error}"),
        })?;
    let actual_parent = path.parent().ok_or_else(|| VideoError::InvalidInput {
        message: "analysis directory has no parent".to_string(),
    })?;
    let actual_parent = tokio::fs::canonicalize(actual_parent)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("could not resolve analysis directory parent: {error}"),
        })?;
    if actual_parent != expected_parent {
        return Err(VideoError::InvalidInput {
            message: "analysis directory is outside the Cognia media temp root".to_string(),
        });
    }
    tokio::fs::remove_dir_all(&path)
        .await
        .map_err(|error| VideoError::Io {
            message: format!("{}: {error}", path.display()),
        })
}

fn pack_frame_response(frame: NativeVideoFrame) -> Vec<u8> {
    let mut response = Vec::with_capacity(frame.data.len() + 8);
    response.extend_from_slice(&frame.width.to_le_bytes());
    response.extend_from_slice(&frame.height.to_le_bytes());
    response.extend_from_slice(&frame.data);
    response
}

pub mod commands {
    use super::{
        analyze_video, cleanup_analysis_directory, extract_frame, normalize_analysis_options,
        normalize_export_options, pack_frame_response, probe_video, resolve_media_file,
        resolve_render_clips, trim_video, AuthorizedVideoClipInput, MediaSourceRegistry,
        NativeVideoInfo, TemporaryPathGuard, VideoAnalysisManifest, VideoAnalysisOptions,
        VideoEditResult, VideoError, VideoExportCommandOptions, VideoTrimOptions, VideoTrimResult,
    };
    use crate::editing::{self, VideoEffectSpec, VideoTransitionSpec};
    use tauri::ipc::Response;
    use tauri::State;

    #[tauri::command]
    pub async fn video_get_info(
        state: State<'_, MediaSourceRegistry>,
        file_path: String,
    ) -> Result<NativeVideoInfo, VideoError> {
        let path = resolve_media_file(&file_path).await?;
        let mut metadata = probe_video(&path).await?;
        metadata.source_token = state.register(path)?;
        Ok(metadata)
    }

    #[tauri::command]
    pub async fn plugin_media_get_video_frame(
        state: State<'_, MediaSourceRegistry>,
        source_token: String,
        time: f64,
    ) -> Result<Response, VideoError> {
        let path = state.resolve(&source_token)?;
        let metadata = probe_video(&path).await?;
        let frame = extract_frame(&path, &metadata, time).await?;
        Ok(Response::new(pack_frame_response(frame)))
    }

    #[tauri::command]
    pub async fn plugin_media_concatenate_videos(
        state: State<'_, MediaSourceRegistry>,
        clips: Vec<AuthorizedVideoClipInput>,
    ) -> Result<VideoEditResult, VideoError> {
        let (resolved, metadata) = resolve_render_clips(&state, &clips).await?;
        let first = metadata.first().ok_or_else(|| VideoError::InvalidInput {
            message: "at least one clip is required for concatenation".to_string(),
        })?;
        let width = first.width.clamp(16, 7680) & !1;
        let height = first.height.clamp(16, 4320) & !1;
        let fps = if first.fps.is_finite() && first.fps > 0.0 {
            first.fps.round().clamp(1.0, 120.0) as u32
        } else {
            30
        };
        let options = editing::VideoExportOptions {
            format: "mp4".to_string(),
            width,
            height,
            fps,
            quality: "high".to_string(),
            codec: None,
            audio_bitrate: None,
            video_bitrate: None,
        };
        let output_path = super::media_temp_root()
            .join("edits")
            .join(format!("{}.mp4", uuid::Uuid::new_v4()));
        let mut cleanup_guard = TemporaryPathGuard::file(output_path.clone());
        editing::render_timeline(&resolved, &options, &output_path).await?;
        cleanup_guard.retain();
        Ok(VideoEditResult {
            output_path: output_path.to_string_lossy().into_owned(),
        })
    }

    #[tauri::command]
    pub async fn plugin_media_apply_video_effect(
        state: State<'_, MediaSourceRegistry>,
        source_token: String,
        effect: VideoEffectSpec,
    ) -> Result<(), VideoError> {
        state.resolve(&source_token)?;
        editing::validate_effect(&effect)
    }

    #[tauri::command]
    pub async fn plugin_media_add_transition(
        state: State<'_, MediaSourceRegistry>,
        from_clip: AuthorizedVideoClipInput,
        to_clip: AuthorizedVideoClipInput,
        transition: VideoTransitionSpec,
    ) -> Result<(), VideoError> {
        let (resolved, _) = resolve_render_clips(&state, &[from_clip, to_clip]).await?;
        let from_duration =
            (resolved[0].end_time - resolved[0].start_time) / resolved[0].playback_speed;
        let to_duration =
            (resolved[1].end_time - resolved[1].start_time) / resolved[1].playback_speed;
        editing::validate_transition(&transition, from_duration, to_duration)
    }

    #[tauri::command]
    pub async fn plugin_media_export_video(
        state: State<'_, MediaSourceRegistry>,
        clips: Vec<AuthorizedVideoClipInput>,
        options: VideoExportCommandOptions,
    ) -> Result<Response, VideoError> {
        let (resolved, _) = resolve_render_clips(&state, &clips).await?;
        let options = normalize_export_options(options)?;
        let output_path = super::media_temp_root().join("exports").join(format!(
            "{}.{}",
            uuid::Uuid::new_v4(),
            options.format
        ));
        let mut cleanup_guard = TemporaryPathGuard::file(output_path.clone());
        editing::render_timeline(&resolved, &options, &output_path).await?;
        let output_size = tokio::fs::metadata(&output_path)
            .await
            .map_err(|error| VideoError::Io {
                message: format!("{}: {error}", output_path.display()),
            })?
            .len();
        if output_size > editing::MAX_EXPORT_BYTES {
            tokio::fs::remove_file(&output_path)
                .await
                .map_err(|error| VideoError::Io {
                    message: format!("{}: {error}", output_path.display()),
                })?;
            cleanup_guard.retain();
            return Err(VideoError::InvalidInput {
                message: format!(
                    "rendered export is {output_size} bytes; the IPC export limit is {} bytes",
                    editing::MAX_EXPORT_BYTES
                ),
            });
        }
        let bytes = tokio::fs::read(&output_path)
            .await
            .map_err(|error| VideoError::Io {
                message: format!("{}: {error}", output_path.display()),
            })?;
        tokio::fs::remove_file(&output_path)
            .await
            .map_err(|error| VideoError::Io {
                message: format!("{}: {error}", output_path.display()),
            })?;
        cleanup_guard.retain();
        Ok(Response::new(bytes))
    }

    #[tauri::command]
    pub async fn video_analyze(
        state: State<'_, MediaSourceRegistry>,
        options: VideoAnalysisOptions,
    ) -> Result<VideoAnalysisManifest, VideoError> {
        let path = state.resolve(&options.source_token)?;
        let mut metadata = probe_video(&path).await?;
        metadata.source_token.clone_from(&options.source_token);
        let normalized = normalize_analysis_options(options, &metadata)?;
        analyze_video(&path, metadata, normalized).await
    }

    #[tauri::command]
    pub async fn video_trim(
        state: State<'_, MediaSourceRegistry>,
        options: VideoTrimOptions,
    ) -> Result<VideoTrimResult, VideoError> {
        let path = state.resolve(&options.source_token)?;
        let metadata = probe_video(&path).await?;
        trim_video(&path, &metadata, &options).await
    }

    #[tauri::command]
    pub async fn video_cleanup_analysis(output_directory: String) -> Result<(), VideoError> {
        cleanup_analysis_directory(&output_directory).await
    }
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_video, calculate_frame_dimensions, cleanup_analysis_directory,
        evenly_sample_indices, extract_frame, normalize_analysis_options, parse_probe_output,
        parse_showinfo_timestamps, probe_video, resolve_media_file, select_distinct_indices,
        trim_video, MediaSourceRegistry, NativeVideoInfo, VideoAnalysisMode, VideoAnalysisOptions,
        VideoTrimOptions,
    };
    use std::path::Path;

    #[test]
    fn parses_video_metadata_from_ffprobe_json() {
        let output = br#"{
          "streams": [
            {
              "codec_type": "video",
              "codec_name": "h264",
              "width": 1920,
              "height": 1080,
              "avg_frame_rate": "30000/1001",
              "duration": "12.500"
            },
            {
              "codec_type": "audio",
              "codec_name": "aac"
            }
          ],
          "format": {
            "duration": "12.500",
            "size": "4096",
            "bit_rate": "800000"
          }
        }"#;

        let info = parse_probe_output(output).expect("valid ffprobe output");

        assert_eq!(info.duration_ms, 12_500);
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert!((info.fps - 29.970_029).abs() < 0.001);
        assert_eq!(info.codec, "h264");
        assert_eq!(info.file_size, 4096);
        assert!(info.has_audio);
    }

    #[test]
    fn normalizes_a_focused_analysis_range_and_enforces_limits() {
        let metadata = NativeVideoInfo {
            duration_ms: 12_500,
            width: 1920,
            height: 1080,
            fps: 30.0,
            codec: "h264".to_string(),
            file_size: 4096,
            has_audio: true,
            source_token: String::new(),
        };
        let options = VideoAnalysisOptions {
            source_token: "source-token".to_string(),
            mode: Some(VideoAnalysisMode::Scene),
            start_time: Some(2.0),
            end_time: Some(8.0),
            max_frames: Some(500),
            width: Some(4096),
            deduplicate: None,
            duplicate_threshold: None,
        };

        let normalized =
            normalize_analysis_options(options, &metadata).expect("valid focused range");

        assert_eq!(normalized.start_time, 2.0);
        assert_eq!(normalized.end_time, 8.0);
        assert_eq!(normalized.max_frames, 100);
        assert_eq!(normalized.width, 2048);
        assert!(normalized.deduplicate);
    }

    #[test]
    fn rejects_an_empty_analysis_range() {
        let metadata = NativeVideoInfo {
            duration_ms: 10_000,
            width: 1280,
            height: 720,
            fps: 24.0,
            codec: "h264".to_string(),
            file_size: 1024,
            has_audio: false,
            source_token: String::new(),
        };
        let options = VideoAnalysisOptions {
            source_token: "source-token".to_string(),
            mode: None,
            start_time: Some(5.0),
            end_time: Some(5.0),
            max_frames: None,
            width: None,
            deduplicate: None,
            duplicate_threshold: None,
        };

        assert!(normalize_analysis_options(options, &metadata).is_err());
    }

    #[test]
    fn removes_only_adjacent_near_duplicate_thumbnails() {
        let thumbnails = vec![
            vec![10_u8; 256],
            vec![11_u8; 256],
            vec![80_u8; 256],
            vec![81_u8; 256],
        ];

        assert_eq!(select_distinct_indices(&thumbnails, 2.0), vec![0, 2]);
    }

    #[test]
    fn bounds_large_frame_payloads_while_preserving_aspect_ratio() {
        assert_eq!(calculate_frame_dimensions(3840, 2160, 2048), (2048, 1152));
        assert_eq!(calculate_frame_dimensions(1280, 720, 2048), (1280, 720));
    }

    #[test]
    fn parses_ffmpeg_showinfo_timestamps_and_offsets_a_focused_range() {
        let stderr = b"[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0.000\n\
                       [Parsed_showinfo_2] n: 1 pts: 42 pts_time:1.750\n";

        assert_eq!(parse_showinfo_timestamps(stderr, 2.0), vec![2.0, 3.75]);
    }

    #[test]
    fn evenly_samples_candidates_including_both_ends() {
        assert_eq!(evenly_sample_indices(10, 4), vec![0, 3, 6, 9]);
        assert_eq!(evenly_sample_indices(3, 5), vec![0, 1, 2]);
    }

    #[test]
    fn resolves_only_paths_registered_behind_an_opaque_source_token() {
        let registry = MediaSourceRegistry::default();
        let path = Path::new("/tmp/source.mp4").to_path_buf();
        let token = registry.register(path.clone()).expect("register source");

        assert_eq!(registry.resolve(&token).expect("resolve source"), path);
        assert_eq!(
            registry
                .register(Path::new("/tmp/source.mp4").to_path_buf())
                .expect("register same source"),
            token
        );
        assert!(registry.resolve("caller-controlled-path").is_err());
    }

    #[tokio::test]
    async fn cleanup_rejects_directories_not_owned_by_cognia_media() {
        let unrelated = tempfile::tempdir().expect("unrelated temporary directory");

        assert!(
            cleanup_analysis_directory(&unrelated.path().to_string_lossy())
                .await
                .is_err()
        );
        assert!(unrelated.path().is_dir());
    }

    #[tokio::test]
    async fn runs_the_video_pipeline_against_a_real_ffmpeg_fixture() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }

        let directory = tempfile::tempdir().expect("temporary media directory");
        let source = directory.path().join("source.mp4");
        let generated = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=12",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=44100",
                "-t",
                "3",
                "-c:v",
                "mpeg4",
                "-q:v",
                "3",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&source)
            .output()
            .expect("generate video fixture");
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );

        let source_path = source.to_string_lossy().into_owned();
        let resolved = resolve_media_file(&source_path)
            .await
            .expect("resolve generated video");
        let metadata = probe_video(&resolved).await.expect("probe generated video");
        assert_eq!((metadata.width, metadata.height), (320, 180));
        assert!(metadata.has_audio);

        let frame = extract_frame(&resolved, &metadata, 1.0)
            .await
            .expect("decode frame");
        assert_eq!((frame.width, frame.height), (320, 180));
        assert_eq!(frame.data.len(), 320 * 180 * 4);

        let analysis_options = VideoAnalysisOptions {
            source_token: "test-source".to_string(),
            mode: Some(VideoAnalysisMode::Scene),
            start_time: Some(0.5),
            end_time: Some(2.5),
            max_frames: Some(6),
            width: Some(160),
            deduplicate: Some(true),
            duplicate_threshold: Some(2.0),
        };
        let normalized = normalize_analysis_options(analysis_options, &metadata)
            .expect("normalize analysis options");
        let manifest = analyze_video(&resolved, metadata.clone(), normalized)
            .await
            .expect("analyze focused range");
        assert!(!manifest.frames.is_empty());
        assert!(manifest.frames.len() <= 6);
        assert!(manifest
            .frames
            .iter()
            .all(|frame| Path::new(&frame.path).is_file()));
        assert!(manifest
            .frames
            .iter()
            .all(|frame| (0.5..=2.5).contains(&frame.timestamp)));

        let trimmed = trim_video(
            &resolved,
            &metadata,
            &VideoTrimOptions {
                source_token: "test-source".to_string(),
                start_time: 0.5,
                end_time: 2.0,
                format: "mp4".to_string(),
            },
        )
        .await
        .expect("trim video");
        assert!(Path::new(&trimmed.output_path).is_file());
        assert!(trimmed.output_path.contains("cognia-video"));

        cleanup_analysis_directory(&manifest.output_directory)
            .await
            .expect("remove analysis output directory");
        tokio::fs::remove_file(trimmed.output_path)
            .await
            .expect("remove trimmed output");
    }
}
