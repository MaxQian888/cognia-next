use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_GROUPING_FRAMES: usize = 64;
const MAX_FRAME_BYTES: usize = 1_024;
const MAX_STACKWALK_OUTPUT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_EVENT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SymbolArtifact {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct StackwalkSymbolicator {
    executable: PathBuf,
    temp_root: PathBuf,
    timeout: Duration,
}

impl StackwalkSymbolicator {
    pub fn new(executable: PathBuf, temp_root: PathBuf, timeout: Duration) -> Self {
        Self {
            executable,
            temp_root,
            timeout,
        }
    }

    pub async fn symbolize(
        &self,
        incident_id: uuid::Uuid,
        minidump: &[u8],
        symbols: &[SymbolArtifact],
    ) -> Result<StackwalkSummary, ProcessingFailure> {
        if tokio::fs::metadata(&self.executable).await.is_err() {
            return Err(ProcessingFailure::SymbolicatorUnavailable);
        }
        let work_dir = self.temp_root.join(incident_id.simple().to_string());
        if tokio::fs::create_dir_all(&work_dir).await.is_err() {
            return Err(ProcessingFailure::StorageUnavailable);
        }
        let dump_path = work_dir.join("incident.dmp");
        let output_path = work_dir.join("stackwalk.json");
        if tokio::fs::write(&dump_path, minidump).await.is_err() {
            cleanup_work_dir(&work_dir).await;
            return Err(ProcessingFailure::StorageUnavailable);
        }
        let symbols_root = work_dir.join("symbols");
        for symbol in symbols {
            let Some(relative_path) = safe_relative_path(&symbol.relative_path) else {
                cleanup_work_dir(&work_dir).await;
                return Err(ProcessingFailure::InvalidArtifact);
            };
            let path = symbols_root.join(relative_path);
            if let Some(parent) = path.parent() {
                if tokio::fs::create_dir_all(parent).await.is_err() {
                    cleanup_work_dir(&work_dir).await;
                    return Err(ProcessingFailure::StorageUnavailable);
                }
            }
            if tokio::fs::write(path, &symbol.bytes).await.is_err() {
                cleanup_work_dir(&work_dir).await;
                return Err(ProcessingFailure::StorageUnavailable);
            }
        }

        let mut command = tokio::process::Command::new(&self.executable);
        command
            .arg("--json")
            .arg("--no-interactive")
            .arg("--verbose")
            .arg("off")
            .arg("--output-file")
            .arg(&output_path);
        if !symbols.is_empty() {
            command.arg("--symbols-path").arg(&symbols_root);
        }
        command
            .arg(&dump_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let result = tokio::time::timeout(self.timeout, command.output()).await;
        let result = match result {
            Err(_) => {
                cleanup_work_dir(&work_dir).await;
                return Err(ProcessingFailure::SymbolicatorTimeout);
            }
            Ok(Err(_)) => {
                cleanup_work_dir(&work_dir).await;
                return Err(ProcessingFailure::SymbolicatorUnavailable);
            }
            Ok(Ok(result)) if !result.status.success() => {
                cleanup_work_dir(&work_dir).await;
                return Err(ProcessingFailure::InvalidArtifact);
            }
            Ok(Ok(result)) => result,
        };
        drop(result);

        let output = match read_bounded(&output_path, MAX_STACKWALK_OUTPUT_BYTES).await {
            Ok(output) => output,
            Err(failure) => {
                cleanup_work_dir(&work_dir).await;
                return Err(failure);
            }
        };
        let report = serde_json::from_slice::<Value>(&output)
            .map_err(|_| ProcessingFailure::InvalidArtifact)
            .and_then(|report| parse_stackwalk_report(&report));
        cleanup_work_dir(&work_dir).await;
        report
    }
}

pub fn validate_symbol_relative_path(value: &str) -> bool {
    safe_relative_path(value).is_some()
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    if path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        Some(path.to_owned())
    } else {
        None
    }
}

async fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ProcessingFailure> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| ProcessingFailure::InvalidArtifact)?;
    if metadata.len() > max_bytes {
        return Err(ProcessingFailure::InvalidArtifact);
    }
    tokio::fs::read(path)
        .await
        .map_err(|_| ProcessingFailure::InvalidArtifact)
}

async fn cleanup_work_dir(path: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(path).await {
        tracing::warn!(error = %error, path = %path.display(), "failed to remove symbolication temp directory");
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackwalkSummary {
    pub frames: Vec<String>,
    pub missing_symbols: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingFailure {
    CredentialDetected,
    InvalidArtifact,
    SymbolicatorUnavailable,
    SymbolicatorTimeout,
    StorageUnavailable,
    DatabaseUnavailable,
}

impl ProcessingFailure {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::SymbolicatorUnavailable
                | Self::SymbolicatorTimeout
                | Self::StorageUnavailable
                | Self::DatabaseUnavailable
        )
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::CredentialDetected => "credential_detected",
            Self::InvalidArtifact => "invalid_artifact",
            Self::SymbolicatorUnavailable => "symbolicator_unavailable",
            Self::SymbolicatorTimeout => "symbolicator_timeout",
            Self::StorageUnavailable => "storage_unavailable",
            Self::DatabaseUnavailable => "database_unavailable",
        }
    }
}

pub fn retry_delay(attempt: u32) -> Option<Duration> {
    match attempt {
        1 => Some(Duration::from_secs(5)),
        2 => Some(Duration::from_secs(30)),
        3 => Some(Duration::from_secs(120)),
        4 => Some(Duration::from_secs(300)),
        _ => None,
    }
}

pub fn compatible_build_family(build_id: &str) -> String {
    build_id
        .split(['+', '-'])
        .next()
        .unwrap_or(build_id)
        .trim()
        .to_owned()
}

pub fn parse_stackwalk_report(report: &Value) -> Result<StackwalkSummary, ProcessingFailure> {
    let threads = report
        .get("threads")
        .and_then(Value::as_array)
        .ok_or(ProcessingFailure::InvalidArtifact)?;
    let requested = report
        .get("requesting_thread")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let thread = requested
        .and_then(|index| threads.get(index))
        .or_else(|| {
            threads
                .iter()
                .find(|thread| thread.get("crashed").and_then(Value::as_bool) == Some(true))
        })
        .or_else(|| threads.first())
        .ok_or(ProcessingFailure::InvalidArtifact)?;
    let frames = thread
        .get("frames")
        .and_then(Value::as_array)
        .ok_or(ProcessingFailure::InvalidArtifact)?
        .iter()
        .filter_map(format_stackwalk_frame)
        .take(MAX_GROUPING_FRAMES)
        .collect::<Vec<_>>();
    if frames.is_empty() {
        return Err(ProcessingFailure::InvalidArtifact);
    }

    let mut missing_symbols = report
        .get("modules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|module| module.get("missing_symbols").and_then(Value::as_bool) == Some(true))
        .filter_map(|module| {
            module
                .get("filename")
                .or_else(|| module.get("code_file"))
                .and_then(Value::as_str)
                .and_then(bounded_nonempty)
        })
        .collect::<Vec<_>>();
    missing_symbols.sort();
    missing_symbols.dedup();

    Ok(StackwalkSummary {
        frames,
        missing_symbols,
    })
}

pub fn extract_structured_frames(body: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    find_frame_value(&value)
        .map(frames_from_value)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|frame| bounded_nonempty(&frame))
        .take(MAX_GROUPING_FRAMES)
        .collect()
}

pub fn extract_event_frames(body: &[u8]) -> Result<Vec<String>, ProcessingFailure> {
    let decoded = if body.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        let decoder = zstd::stream::read::Decoder::new(body)
            .map_err(|_| ProcessingFailure::InvalidArtifact)?;
        let mut decoded = Vec::new();
        decoder
            .take(MAX_DECOMPRESSED_EVENT_BYTES + 1)
            .read_to_end(&mut decoded)
            .map_err(|_| ProcessingFailure::InvalidArtifact)?;
        if decoded.len() as u64 > MAX_DECOMPRESSED_EVENT_BYTES {
            return Err(ProcessingFailure::InvalidArtifact);
        }
        decoded
    } else {
        body.to_vec()
    };
    let direct = extract_structured_frames(&decoded);
    if !direct.is_empty() {
        return Ok(direct);
    }
    Ok(decoded
        .split(|byte| *byte == b'\n')
        .flat_map(extract_structured_frames)
        .take(MAX_GROUPING_FRAMES)
        .collect())
}

fn find_frame_value(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(object) => {
            for key in ["stackFrames", "symbolizedFrames", "frames", "stack"] {
                if let Some(frames) = object.get(key) {
                    return Some(frames);
                }
            }
            for key in ["payload", "crash", "exception", "error"] {
                if let Some(found) = object.get(key).and_then(find_frame_value) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn frames_from_value(value: &Value) -> Vec<String> {
    match value {
        Value::String(stack) => stack.lines().map(str::to_owned).collect(),
        Value::Array(frames) => frames
            .iter()
            .filter_map(|frame| match frame {
                Value::String(frame) => Some(frame.to_owned()),
                Value::Object(_) => format_structured_frame(frame),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn format_structured_frame(frame: &Value) -> Option<String> {
    let module = string_field(frame, &["module", "moduleName"]);
    let function = string_field(frame, &["function", "functionName", "name"]);
    match (module, function) {
        (Some(module), Some(function)) => bounded_nonempty(&format!("{module}!{function}")),
        (None, Some(function)) => bounded_nonempty(function),
        (Some(module), None) => bounded_nonempty(module),
        (None, None) => None,
    }
}

fn format_stackwalk_frame(frame: &Value) -> Option<String> {
    let module = string_field(frame, &["module", "module_name"])?;
    if let Some(function) = string_field(frame, &["function", "function_name"]) {
        let mut rendered = format!("{module}!{function}");
        if let Some(file) = string_field(frame, &["file", "source_file"]) {
            if let Some(line) = frame.get("line").and_then(Value::as_u64) {
                rendered.push_str(&format!(" ({file}:{line})"));
            }
        }
        return bounded_nonempty(&rendered);
    }
    let offset = frame
        .get("module_offset")
        .or_else(|| frame.get("offset"))
        .and_then(value_as_string)
        .unwrap_or_else(|| "unknown".to_owned());
    bounded_nonempty(&format!("{module}+{offset}"))
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_owned()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn bounded_nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(MAX_FRAME_BYTES).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn stackwalk_parser_prefers_the_crashing_thread_and_reports_missing_symbols() {
        let report = json!({
            "requesting_thread": 1,
            "threads": [
                {"frames": [{"module": "worker", "function": "background"}]},
                {"frames": [
                    {"module": "cognia", "function": "crash_now", "file": "main.rs", "line": 42},
                    {"module": "libsystem", "module_offset": "0x10"}
                ]}
            ],
            "modules": [
                {"filename": "cognia", "missing_symbols": false},
                {"filename": "libsystem", "missing_symbols": true}
            ]
        });

        let parsed = parse_stackwalk_report(&report).expect("valid stackwalk report");
        assert_eq!(
            parsed.frames,
            ["cognia!crash_now (main.rs:42)", "libsystem+0x10"]
        );
        assert_eq!(parsed.missing_symbols, ["libsystem"]);
    }

    #[test]
    fn structured_parser_accepts_v1_crash_and_plain_stack_payloads() {
        let v1 = br#"{"kind":"crash","payload":{"stackFrames":["app!panic","runtime!abort"]}}"#;
        let plain = br#"{"stack":"first\nsecond\nthird"}"#;

        assert_eq!(
            extract_structured_frames(v1),
            ["app!panic", "runtime!abort"]
        );
        assert_eq!(
            extract_structured_frames(plain),
            ["first", "second", "third"]
        );
    }

    #[test]
    fn event_parser_reads_zstd_ndjson_without_accepting_path_traversal() {
        let ndjson = b"{\"kind\":\"log\"}\n{\"kind\":\"crash\",\"payload\":{\"stackFrames\":[\"app!boom\"]}}\n";
        let compressed = zstd::stream::encode_all(&ndjson[..], 1).unwrap();
        assert_eq!(extract_event_frames(&compressed).unwrap(), ["app!boom"]);
        assert_eq!(
            safe_relative_path("app/ABC/app.sym"),
            Some(PathBuf::from("app/ABC/app.sym"))
        );
        assert_eq!(safe_relative_path("../secret"), None);
        assert_eq!(safe_relative_path("/absolute.sym"), None);
    }

    #[test]
    fn build_family_is_compatible_but_keeps_major_minor_patch_identity() {
        assert_eq!(compatible_build_family("1.8.2+macos.15"), "1.8.2");
        assert_eq!(compatible_build_family("2026.08.01-beta.2"), "2026.08.01");
        assert_eq!(compatible_build_family("desktop-main"), "desktop");
    }

    #[test]
    fn retry_policy_is_bounded_and_classifies_permanent_failures() {
        assert_eq!(retry_delay(1), Some(std::time::Duration::from_secs(5)));
        assert_eq!(retry_delay(4), Some(std::time::Duration::from_secs(300)));
        assert_eq!(retry_delay(5), None);
        assert!(!ProcessingFailure::CredentialDetected.retryable());
        assert!(ProcessingFailure::SymbolicatorUnavailable.retryable());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stackwalk_symbolicator_uses_machine_readable_output_and_cleans_up() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("cognia-stackwalk-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("fake-stackwalk");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-file" ]; then
    shift
    out="$1"
  fi
  shift
done
printf '%s' '{"requesting_thread":0,"threads":[{"frames":[{"module":"app","function":"crash"}]}],"modules":[]}' > "$out"
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let symbolicator =
            StackwalkSymbolicator::new(executable, root.join("work"), Duration::from_secs(2));
        let incident_id = uuid::Uuid::new_v4();
        let summary = symbolicator
            .symbolize(incident_id, b"MDMP", &[])
            .await
            .unwrap();
        assert_eq!(summary.frames, ["app!crash"]);
        assert!(!root
            .join("work")
            .join(incident_id.simple().to_string())
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
