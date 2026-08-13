use super::{run_process, VideoError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RENDER_TIMEOUT: Duration = Duration::from_secs(1_200);
const MAX_TIMELINE_CLIPS: usize = 64;
pub(crate) const MAX_TIMELINE_DURATION_SECONDS: f64 = 1_800.0;
pub(crate) const MAX_EXPORT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEffectSpec {
    pub id: String,
    #[serde(default)]
    pub params: HashMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTransitionSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub duration: f64,
    #[serde(default)]
    pub parameters: HashMap<String, Value>,
}

#[derive(Clone, Debug)]
pub(crate) struct VideoRenderClip {
    pub path: PathBuf,
    pub start_time: f64,
    pub end_time: f64,
    pub volume: f64,
    pub playback_speed: f64,
    pub has_audio: bool,
    pub effects: Vec<VideoEffectSpec>,
    pub transition_out: Option<VideoTransitionSpec>,
}

#[derive(Clone, Debug)]
pub(crate) struct VideoExportOptions {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub quality: String,
    pub codec: Option<String>,
    pub audio_bitrate: Option<u32>,
    pub video_bitrate: Option<u32>,
}

fn invalid(message: impl Into<String>) -> VideoError {
    VideoError::InvalidInput {
        message: message.into(),
    }
}

fn finite_in_range(value: f64, min: f64, max: f64, name: &str) -> Result<f64, VideoError> {
    if value.is_finite() && (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(invalid(format!("{name} must be between {min} and {max}")))
    }
}

fn numeric_param(
    params: &HashMap<String, Value>,
    name: &str,
    default: f64,
    min: f64,
    max: f64,
) -> Result<f64, VideoError> {
    let value = match params.get(name) {
        None => default,
        Some(value) => value
            .as_f64()
            .ok_or_else(|| invalid(format!("effect parameter '{name}' must be numeric")))?,
    };
    finite_in_range(value, min, max, name)
}

fn effect_name(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or(id)
}

pub(crate) fn validate_effect(effect: &VideoEffectSpec) -> Result<(), VideoError> {
    match effect_name(&effect.id) {
        "brightness-contrast" => {
            numeric_param(&effect.params, "brightness", 0.0, -100.0, 100.0)?;
            numeric_param(&effect.params, "contrast", 0.0, -100.0, 100.0)?;
        }
        "grayscale" => {}
        "blur" => {
            numeric_param(&effect.params, "amount", 10.0, 0.0, 100.0)?;
        }
        "sharpen" => {
            numeric_param(&effect.params, "amount", 10.0, 0.0, 100.0)?;
        }
        "saturation" => {
            numeric_param(&effect.params, "amount", 0.0, -100.0, 100.0)?;
        }
        "hue" => {
            numeric_param(&effect.params, "degrees", 0.0, -180.0, 180.0)?;
        }
        unsupported => {
            return Err(invalid(format!(
                "video effect '{unsupported}' is not supported by the native renderer"
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_transition(
    transition: &VideoTransitionSpec,
    from_duration: f64,
    to_duration: f64,
) -> Result<(), VideoError> {
    if !matches!(
        transition.kind.as_str(),
        "fade" | "dissolve" | "wipe" | "slide" | "zoom" | "blur"
    ) {
        return Err(invalid(format!(
            "video transition '{}' is not supported by the native renderer",
            transition.kind
        )));
    }
    finite_in_range(
        transition.duration,
        0.05,
        from_duration.min(to_duration),
        "transition duration",
    )?;
    Ok(())
}

fn effect_filter(effect: &VideoEffectSpec) -> Result<String, VideoError> {
    validate_effect(effect)?;
    match effect_name(&effect.id) {
        "brightness-contrast" => {
            let brightness =
                numeric_param(&effect.params, "brightness", 0.0, -100.0, 100.0)? / 100.0;
            let contrast =
                1.0 + numeric_param(&effect.params, "contrast", 0.0, -100.0, 100.0)? / 100.0;
            Ok(format!(
                "eq=brightness={brightness:.4}:contrast={contrast:.4}"
            ))
        }
        "grayscale" => Ok("hue=s=0".to_string()),
        "blur" => {
            let amount = numeric_param(&effect.params, "amount", 10.0, 0.0, 100.0)?;
            Ok(format!("boxblur={:.3}", 1.0 + amount * 0.19))
        }
        "sharpen" => {
            let amount = numeric_param(&effect.params, "amount", 10.0, 0.0, 100.0)?;
            Ok(format!("unsharp=5:5:{:.3}:5:5:0", amount / 50.0))
        }
        "saturation" => {
            let amount = numeric_param(&effect.params, "amount", 0.0, -100.0, 100.0)?;
            Ok(format!("eq=saturation={:.4}", 1.0 + amount / 100.0))
        }
        "hue" => {
            let degrees = numeric_param(&effect.params, "degrees", 0.0, -180.0, 180.0)?;
            Ok(format!("hue=h={degrees:.3}"))
        }
        _ => unreachable!("validate_effect rejects unsupported effects"),
    }
}

fn transition_filter_name(kind: &str) -> &'static str {
    match kind {
        "fade" => "fade",
        "dissolve" => "dissolve",
        "wipe" => "wipeleft",
        "slide" => "slideleft",
        "zoom" => "zoomin",
        "blur" => "fadegrays",
        _ => unreachable!("validate_transition rejects unsupported transitions"),
    }
}

fn atempo_chain(playback_speed: f64) -> String {
    let mut remaining = playback_speed;
    let mut factors = Vec::new();
    while remaining > 2.0 {
        factors.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        factors.push(0.5);
        remaining /= 0.5;
    }
    factors.push(remaining);
    factors
        .into_iter()
        .map(|factor| format!("atempo={factor:.6}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn validate_render_request(
    clips: &[VideoRenderClip],
    options: &VideoExportOptions,
) -> Result<Vec<f64>, VideoError> {
    if clips.is_empty() || clips.len() > MAX_TIMELINE_CLIPS {
        return Err(invalid(format!(
            "timeline must contain between 1 and {MAX_TIMELINE_CLIPS} clips"
        )));
    }
    if !(16..=7680).contains(&options.width)
        || !(16..=4320).contains(&options.height)
        || options.width % 2 != 0
        || options.height % 2 != 0
    {
        return Err(invalid(
            "render dimensions must be even and within 16x16 to 7680x4320",
        ));
    }
    if !(1..=120).contains(&options.fps) {
        return Err(invalid("render fps must be between 1 and 120"));
    }
    if !matches!(options.format.as_str(), "mp4" | "webm" | "gif") {
        return Err(invalid("render format must be mp4, webm, or gif"));
    }
    if !matches!(
        options.quality.as_str(),
        "low" | "medium" | "high" | "maximum"
    ) {
        return Err(invalid(
            "render quality must be low, medium, high, or maximum",
        ));
    }
    if let Some(codec) = options.codec.as_deref() {
        let allowed = match options.format.as_str() {
            "mp4" => matches!(codec, "libx264" | "h264_videotoolbox" | "mpeg4"),
            "webm" => matches!(codec, "libvpx-vp9" | "libvpx"),
            "gif" => codec == "gif",
            _ => false,
        };
        if !allowed {
            return Err(invalid(format!(
                "codec '{codec}' is not allowed for {} export",
                options.format
            )));
        }
    }
    if options
        .audio_bitrate
        .is_some_and(|value| !(32..=512).contains(&value))
    {
        return Err(invalid("audio bitrate must be between 32 and 512 kbps"));
    }
    if options
        .video_bitrate
        .is_some_and(|value| !(100..=200_000).contains(&value))
    {
        return Err(invalid("video bitrate must be between 100 and 200000 kbps"));
    }

    let mut durations = Vec::with_capacity(clips.len());
    for clip in clips {
        if !clip.start_time.is_finite()
            || !clip.end_time.is_finite()
            || clip.start_time < 0.0
            || clip.start_time >= clip.end_time
        {
            return Err(invalid("clip range must satisfy 0 <= startTime < endTime"));
        }
        finite_in_range(clip.volume, 0.0, 1.0, "clip volume")?;
        finite_in_range(clip.playback_speed, 0.1, 10.0, "clip playback speed")?;
        for effect in &clip.effects {
            validate_effect(effect)?;
        }
        durations.push((clip.end_time - clip.start_time) / clip.playback_speed);
    }
    for (index, clip) in clips.iter().enumerate().take(clips.len() - 1) {
        if let Some(transition) = &clip.transition_out {
            validate_transition(transition, durations[index], durations[index + 1])?;
        }
    }
    let total_duration = durations.iter().sum::<f64>()
        - clips
            .iter()
            .filter_map(|clip| clip.transition_out.as_ref())
            .map(|transition| transition.duration)
            .sum::<f64>();
    if total_duration > MAX_TIMELINE_DURATION_SECONDS {
        return Err(invalid(format!(
            "rendered timeline must not exceed {MAX_TIMELINE_DURATION_SECONDS:.0} seconds"
        )));
    }
    if let Some(video_bitrate) = options.video_bitrate {
        let total_bitrate_kbps = video_bitrate as u64
            + if options.format == "gif" {
                0
            } else {
                options.audio_bitrate.unwrap_or(128) as u64
            };
        let estimated_bytes = total_duration * total_bitrate_kbps as f64 * 1_000.0 / 8.0;
        if estimated_bytes > MAX_EXPORT_BYTES as f64 {
            return Err(invalid(format!(
                "requested bitrate and duration exceed the {MAX_EXPORT_BYTES}-byte IPC export limit"
            )));
        }
    }
    Ok(durations)
}

fn build_filter_graph(
    clips: &[VideoRenderClip],
    options: &VideoExportOptions,
    durations: &[f64],
) -> Result<(String, String, String), VideoError> {
    let mut filters = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        let mut video_filters = vec![
            format!(
                "scale={}:{}:force_original_aspect_ratio=decrease",
                options.width, options.height
            ),
            format!(
                "pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black",
                options.width, options.height
            ),
            "setsar=1".to_string(),
            format!("fps={}", options.fps),
        ];
        for effect in &clip.effects {
            video_filters.push(effect_filter(effect)?);
        }
        video_filters.push(format!("setpts=(PTS-STARTPTS)/{:.6}", clip.playback_speed));
        filters.push(format!(
            "[{index}:v:0]{}[v{index}]",
            video_filters.join(",")
        ));

        if options.format != "gif" {
            if clip.has_audio {
                filters.push(format!(
                    "[{index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume={:.4},{},asetpts=PTS-STARTPTS[a{index}]",
                    clip.volume,
                    atempo_chain(clip.playback_speed)
                ));
            } else {
                filters.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={:.6},asetpts=PTS-STARTPTS[a{index}]",
                    durations[index]
                ));
            }
        }
    }

    let mut video_label = "v0".to_string();
    let mut audio_label = "a0".to_string();
    let mut accumulated_duration = durations[0];
    for index in 1..clips.len() {
        let next_video = format!("v{index}");
        let next_audio = format!("a{index}");
        let output_video = format!("timeline_v{index}");
        let output_audio = format!("timeline_a{index}");
        if let Some(transition) = &clips[index - 1].transition_out {
            let offset = (accumulated_duration - transition.duration).max(0.0);
            filters.push(format!(
                "[{video_label}][{next_video}]xfade=transition={}:duration={:.6}:offset={offset:.6}[{output_video}]",
                transition_filter_name(&transition.kind),
                transition.duration
            ));
            if options.format != "gif" {
                filters.push(format!(
                    "[{audio_label}][{next_audio}]acrossfade=d={:.6}:c1=tri:c2=tri[{output_audio}]",
                    transition.duration
                ));
            }
            accumulated_duration += durations[index] - transition.duration;
        } else {
            filters.push(format!(
                "[{video_label}][{next_video}]concat=n=2:v=1:a=0[{output_video}]"
            ));
            if options.format != "gif" {
                filters.push(format!(
                    "[{audio_label}][{next_audio}]concat=n=2:v=0:a=1[{output_audio}]"
                ));
            }
            accumulated_duration += durations[index];
        }
        video_label = output_video;
        if options.format != "gif" {
            audio_label = output_audio;
        }
    }

    Ok((filters.join(";"), video_label, audio_label))
}

fn output_args(options: &VideoExportOptions, output_path: &Path) -> Vec<OsString> {
    let crf = match options.quality.as_str() {
        "low" => "32",
        "medium" => "26",
        "high" => "20",
        "maximum" => "16",
        _ => unreachable!("quality validated before building output args"),
    };
    let mut args = Vec::new();
    match options.format.as_str() {
        "mp4" => {
            args.extend([
                OsString::from("-c:v"),
                OsString::from(options.codec.as_deref().unwrap_or("libx264")),
                OsString::from("-preset"),
                OsString::from("veryfast"),
                OsString::from("-crf"),
                OsString::from(crf),
                OsString::from("-pix_fmt"),
                OsString::from("yuv420p"),
                OsString::from("-c:a"),
                OsString::from("aac"),
                OsString::from("-movflags"),
                OsString::from("+faststart"),
                OsString::from("-f"),
                OsString::from("mp4"),
            ]);
        }
        "webm" => {
            args.extend([
                OsString::from("-c:v"),
                OsString::from(options.codec.as_deref().unwrap_or("libvpx-vp9")),
                OsString::from("-crf"),
                OsString::from(crf),
                OsString::from("-b:v"),
                OsString::from("0"),
                OsString::from("-c:a"),
                OsString::from("libopus"),
                OsString::from("-f"),
                OsString::from("webm"),
            ]);
        }
        "gif" => {
            args.extend([
                OsString::from("-an"),
                OsString::from("-loop"),
                OsString::from("0"),
                OsString::from("-f"),
                OsString::from("gif"),
            ]);
        }
        _ => unreachable!("format validated before building output args"),
    }
    if let Some(bitrate) = options.video_bitrate {
        args.extend([
            OsString::from("-b:v"),
            OsString::from(format!("{bitrate}k")),
        ]);
    }
    if options.format != "gif" {
        if let Some(bitrate) = options.audio_bitrate {
            args.extend([
                OsString::from("-b:a"),
                OsString::from(format!("{bitrate}k")),
            ]);
        }
    }
    args.push(output_path.as_os_str().to_owned());
    args
}

pub(crate) async fn render_timeline(
    clips: &[VideoRenderClip],
    options: &VideoExportOptions,
    output_path: &Path,
) -> Result<(), VideoError> {
    let durations = validate_render_request(clips, options)?;
    let (filter_graph, video_label, audio_label) = build_filter_graph(clips, options, &durations)?;
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| VideoError::Io {
                message: format!("{}: {error}", parent.display()),
            })?;
    }

    let mut args = vec![
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-n"),
    ];
    for clip in clips {
        args.extend([
            OsString::from("-ss"),
            OsString::from(format!("{:.6}", clip.start_time)),
            OsString::from("-t"),
            OsString::from(format!("{:.6}", clip.end_time - clip.start_time)),
            OsString::from("-i"),
            clip.path.as_os_str().to_owned(),
        ]);
    }
    args.extend([
        OsString::from("-filter_complex"),
        OsString::from(filter_graph),
        OsString::from("-map"),
        OsString::from(format!("[{video_label}]")),
    ]);
    if options.format != "gif" {
        args.extend([
            OsString::from("-map"),
            OsString::from(format!("[{audio_label}]")),
        ]);
    }
    args.extend(output_args(options, output_path));

    run_process("ffmpeg", &args, RENDER_TIMEOUT).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        render_timeline, validate_effect, validate_render_request, validate_transition,
        VideoEffectSpec, VideoExportOptions, VideoRenderClip, VideoTransitionSpec,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn rejects_unsupported_effects_and_custom_transitions() {
        let unsupported = VideoEffectSpec {
            id: "plugin:unknown".to_string(),
            params: HashMap::new(),
        };
        assert!(validate_effect(&unsupported).is_err());

        let custom = VideoTransitionSpec {
            kind: "custom".to_string(),
            duration: 0.5,
            parameters: HashMap::new(),
        };
        assert!(validate_transition(&custom, 1.0, 1.0).is_err());
    }

    #[test]
    fn bounds_empty_long_and_oversized_timeline_exports() {
        let mut options = VideoExportOptions {
            format: "mp4".to_string(),
            width: 1280,
            height: 720,
            fps: 30,
            quality: "high".to_string(),
            codec: None,
            audio_bitrate: Some(128),
            video_bitrate: None,
        };
        assert!(validate_render_request(&[], &options).is_err());

        let clip = VideoRenderClip {
            path: Path::new("unused.mp4").to_path_buf(),
            start_time: 0.0,
            end_time: 1_801.0,
            volume: 1.0,
            playback_speed: 1.0,
            has_audio: true,
            effects: Vec::new(),
            transition_out: None,
        };
        assert!(validate_render_request(std::slice::from_ref(&clip), &options).is_err());

        let short_clip = VideoRenderClip {
            end_time: 10.0,
            ..clip
        };
        options.video_bitrate = Some(200_000);
        assert!(validate_render_request(&[short_clip], &options).is_err());
    }

    #[tokio::test]
    async fn renders_effects_transitions_and_export_against_real_ffmpeg() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }

        let directory = tempfile::tempdir().expect("temporary media directory");
        let first = directory.path().join("first.mp4");
        let second = directory.path().join("second.mp4");
        for (path, color) in [(&first, "red"), (&second, "blue")] {
            let generated = std::process::Command::new("ffmpeg")
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={color}:s=160x90:r=12:d=1.5"),
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=1.5",
                    "-shortest",
                    "-c:v",
                    "mpeg4",
                    "-c:a",
                    "aac",
                ])
                .arg(path)
                .output()
                .expect("generate video fixture");
            assert!(
                generated.status.success(),
                "{}",
                String::from_utf8_lossy(&generated.stderr)
            );
        }

        let clips = vec![
            VideoRenderClip {
                path: first,
                start_time: 0.0,
                end_time: 1.5,
                volume: 1.0,
                playback_speed: 1.0,
                has_audio: true,
                effects: vec![VideoEffectSpec {
                    id: "brightness-contrast".to_string(),
                    params: HashMap::from([("brightness".to_string(), json!(12.0))]),
                }],
                transition_out: Some(VideoTransitionSpec {
                    kind: "fade".to_string(),
                    duration: 0.25,
                    parameters: HashMap::new(),
                }),
            },
            VideoRenderClip {
                path: second,
                start_time: 0.0,
                end_time: 1.5,
                volume: 0.8,
                playback_speed: 1.0,
                has_audio: true,
                effects: Vec::new(),
                transition_out: None,
            },
        ];
        let output = directory.path().join("export.mp4");
        let options = VideoExportOptions {
            format: "mp4".to_string(),
            width: 320,
            height: 180,
            fps: 24,
            quality: "high".to_string(),
            codec: None,
            audio_bitrate: Some(128),
            video_bitrate: None,
        };

        render_timeline(&clips, &options, &output)
            .await
            .expect("render timeline");

        assert!(Path::new(&output).is_file());
        assert!(std::fs::metadata(output).expect("render metadata").len() > 0);

        let gif_output = directory.path().join("export.gif");
        let gif_options = VideoExportOptions {
            format: "gif".to_string(),
            width: 160,
            height: 90,
            fps: 12,
            quality: "medium".to_string(),
            codec: None,
            audio_bitrate: None,
            video_bitrate: None,
        };
        render_timeline(&clips, &gif_options, &gif_output)
            .await
            .expect("render GIF without dangling audio filters");
        assert!(
            std::fs::metadata(gif_output)
                .expect("GIF render metadata")
                .len()
                > 0
        );
    }
}
