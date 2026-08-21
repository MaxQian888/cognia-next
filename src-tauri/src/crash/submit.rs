//! Consented submission of a local crash report to a diagnostic service.
//!
//! The renderer owns *whether* and *what* to send — it holds the connection,
//! renders the redacted preview, and collects the consent checkboxes. This
//! module owns everything the renderer cannot do: reading the report files,
//! capturing a current-state screenshot, building and signing the
//! `.cognia-diagnostic` package, and pushing it to the service.
//!
//! Packaging and upload stay native for a reason beyond capability. A package
//! can reach a gigabyte; handing it to the WebView only for the WebView to
//! hand it back out is two copies of it through the IPC boundary, and the
//! desktop CSP would block the request at the far end anyway.
//!
//! The upload sequence itself is not implemented here — it is
//! `cognia_observability::diagnostic_submit`, shared with the CLI so both
//! speak the same protocol. This file supplies the transport (the app's proxy
//! policy) and the local bookkeeping.

use std::path::{Path, PathBuf};

use cognia_observability::{
    create_diagnostic_package, delete_incident, exchange_installation_grant, fetch_receipt,
    installation_key_path, submit_package, withdraw_consent, AttachmentInput, AttachmentKind,
    DiagnosticPackageInput, DiagnosticTransport, HttpRequest, HttpResponse, InstallationIdentity,
    SubmissionRequest, SubmissionTarget, SubmitError,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::crash::receipts::{self, SubmissionRecord};

/// Frames a panic backtrace contributes to grouping, before the service's own
/// cap. Matches `MAX_GROUPING_FRAMES` on the service so neither side silently
/// truncates what the other counted on.
const MAX_BACKTRACE_FRAMES: usize = 64;

/// Connection the renderer resolved from its own settings.
///
/// Passed per call rather than held in native state: the renderer owns the
/// connection store (URL in per-account local state, session token in the
/// keyring), and duplicating it here would give the two halves two answers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticConnectionInput {
    pub base_url: String,
    pub tenant_id: String,
    pub project_id: String,
}

impl DiagnosticConnectionInput {
    fn target(&self) -> SubmissionTarget {
        SubmissionTarget::new(&self.base_url, &self.tenant_id, &self.project_id)
    }
}

/// The consent decisions the submission preview collected.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionConsentInput {
    /// Unchecked by default. A minidump can hold process memory, which is why
    /// the service gates reading it back behind a separate tenant opt-in.
    #[serde(default)]
    pub include_minidump: bool,
    /// Captured *now*, after consent — never a crash-time frame, because none
    /// exists. The copy in the consent panel says exactly that.
    #[serde(default)]
    pub include_screenshot: bool,
    /// Free text the user typed. Travels as its own package attachment so the
    /// service's privacy pass scans it like anything else.
    #[serde(default)]
    pub description: Option<String>,
}

/// What the renderer gets back — the stored record plus what actually moved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionOutcome {
    #[serde(flatten)]
    pub record: SubmissionRecord,
    pub uploaded_parts: usize,
    pub resumed_parts: usize,
    /// True when a screenshot was asked for but the platform refused capture,
    /// so the UI can say so instead of implying one was sent.
    pub screenshot_unavailable: bool,
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The desktop's `DiagnosticTransport`: async reqwest under the app's proxy
/// policy, driven synchronously.
///
/// `block_on` is safe here because every command below runs the submission on
/// a blocking task — a blocking thread is not an async context, so entering the
/// runtime from it does not panic. The alternative, an async transport trait,
/// would force a runtime into the CLI, which deliberately has none.
struct NativeTransport;

impl DiagnosticTransport for NativeTransport {
    fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
        let method: reqwest::Method = request
            .method
            .parse()
            .map_err(|_| format!("invalid HTTP method {}", request.method))?;
        let (builder, _route) = crate::proxy_config::apply_reqwest_policy(
            reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)),
            &request.url,
        )
        .map_err(|error| error.to_string())?;
        let client = builder.build().map_err(|error| error.to_string())?;

        let mut pending = client.request(method, &request.url);
        for (name, value) in &request.headers {
            pending = pending.header(*name, value.as_str());
        }
        if let Some(body) = request.body {
            pending = pending.body(body.to_vec());
        }

        tauri::async_runtime::block_on(async move {
            let response = pending.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

// ---------------------------------------------------------------------------
// Local inputs
// ---------------------------------------------------------------------------

fn validate_stem(stem: &str) -> Result<(), String> {
    if stem.is_empty()
        || stem.contains("..")
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains(':')
    {
        return Err("invalid_report_stem".to_owned());
    }
    Ok(())
}

/// The Cognia data directory, which is the crash directory's parent.
fn data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|dir| dir.join("Cognia"))
        .ok_or_else(|| "crash_dir_unavailable".to_owned())
}

/// The installation identity, shared byte-for-byte with the CLI.
///
/// Same file, so `cognia crash submit` and the desktop app are one
/// installation to the service: submissions made by either are readable and
/// deletable by the other.
fn identity() -> Result<InstallationIdentity, String> {
    let path = installation_key_path(&data_dir()?);
    InstallationIdentity::load_or_create(&path).map_err(|error| format!("identity:{error}"))
}

/// Split a Rust backtrace into the frame strings the service groups on.
///
/// The crash report stores its backtrace as one blob of text. Left that way,
/// the service finds no frames at all and every panic fingerprints on module
/// and exception alone — every crash in the app collapsing into one group.
pub fn backtrace_frames(backtrace: &str) -> Vec<String> {
    backtrace
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // Drop the numbered-index prefix (`  12: foo::bar`) so the same frame
        // at a different depth is the same string.
        .map(|line| match line.split_once(": ") {
            Some((index, rest)) if index.trim_start().chars().all(|c| c.is_ascii_digit()) => rest,
            _ => line,
        })
        .filter(|line| !line.starts_with("at "))
        .map(str::to_owned)
        .take(MAX_BACKTRACE_FRAMES)
        .collect()
}

/// Build the structured events the package carries.
///
/// One event per report, shaped so the service's frame extractor recognizes
/// it: `stackFrames` is one of the keys it looks for, and the raw report rides
/// alongside for a human reading the package later.
fn events_for(report: &serde_json::Value) -> Vec<serde_json::Value> {
    let frames = report
        .get("backtrace")
        .and_then(serde_json::Value::as_str)
        .map(backtrace_frames)
        .unwrap_or_default();
    vec![serde_json::json!({
        "kind": "crash",
        "capturedAt": report.get("capturedAt").cloned().unwrap_or(serde_json::Value::Null),
        "message": report.get("message").cloned().unwrap_or(serde_json::Value::Null),
        "location": report.get("location").cloned().unwrap_or(serde_json::Value::Null),
        "stackFrames": frames,
        "report": report,
    })]
}

/// Capture a screenshot of the current screen into `dir`.
///
/// Returns `None` when the platform refuses — screen recording permission is
/// not granted, no monitor is attached, a headless session. A refused
/// screenshot never fails the submission: the report is worth more than the
/// optional attachment, and the caller reports the omission instead.
fn capture_screenshot(dir: &Path) -> Option<PathBuf> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use cognia_automation::automation::platform::shared::screenshot::capture_primary;
    use cognia_automation::automation::types::ScreenshotOpts;

    let shot = capture_primary(&ScreenshotOpts::default()).ok()?;
    let bytes = STANDARD.decode(shot.bytes).ok()?;
    let path = dir.join("screenshot.png");
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

#[derive(Debug)]
struct BuiltPackage {
    path: PathBuf,
    /// Kept alive for the lifetime of the package: dropping it removes the
    /// staging directory, and with it the package the caller is uploading.
    _staging: tempfile::TempDir,
    screenshot_unavailable: bool,
    included_minidump: bool,
    included_screenshot: bool,
}

/// Assemble a signed package for one local report.
fn build_package(
    crash_dir: &Path,
    stem: &str,
    consent: &SubmissionConsentInput,
    identity: &InstallationIdentity,
) -> Result<BuiltPackage, String> {
    let json_path = crash_dir.join(format!("{stem}.json"));
    let report: serde_json::Value = std::fs::read(&json_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| "report_not_found".to_owned())?;

    let staging = tempfile::tempdir().map_err(|error| format!("staging:{error}"))?;
    let mut attachments = Vec::new();

    let text_path = crash_dir.join(format!("{stem}.txt"));
    if text_path.exists() {
        attachments.push(AttachmentInput {
            name: "report.txt".to_owned(),
            path: text_path,
            media_type: "text/plain; charset=utf-8".to_owned(),
            kind: AttachmentKind::Metadata,
        });
    }

    let mut included_minidump = false;
    if consent.include_minidump {
        let dump_path = crash_dir.join(format!("{stem}.dmp"));
        if dump_path.exists() {
            included_minidump = true;
            attachments.push(AttachmentInput {
                name: "crash.dmp".to_owned(),
                path: dump_path,
                media_type: "application/x-dmp".to_owned(),
                kind: AttachmentKind::Minidump,
            });
        }
    }

    let mut screenshot_unavailable = false;
    let mut included_screenshot = false;
    if consent.include_screenshot {
        match capture_screenshot(staging.path()) {
            Some(path) => {
                included_screenshot = true;
                attachments.push(AttachmentInput {
                    name: "screenshot.png".to_owned(),
                    path,
                    media_type: "image/png".to_owned(),
                    kind: AttachmentKind::Screenshot,
                });
            }
            None => screenshot_unavailable = true,
        }
    }

    if let Some(description) = consent
        .description
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        let path = staging.path().join("description.txt");
        std::fs::write(&path, description).map_err(|error| format!("description:{error}"))?;
        attachments.push(AttachmentInput {
            name: "description.txt".to_owned(),
            path,
            media_type: "text/plain; charset=utf-8".to_owned(),
            kind: AttachmentKind::UserDescription,
        });
    }

    let package = staging.path().join("incident.cognia-diagnostic");
    create_diagnostic_package(
        &package,
        DiagnosticPackageInput {
            incident_id: Uuid::new_v4(),
            created_at: chrono::Utc::now(),
            build_id: build_id(&report),
            app_version: app_version(&report),
            platform: platform_label(&report),
            events: events_for(&report),
            attachments,
            source_watermarks: Default::default(),
            missing_sources: Default::default(),
            redaction_version: "client-v1".to_owned(),
        },
        identity.signing_key(),
    )
    .map_err(|error| format!("package:{error}"))?;

    Ok(BuiltPackage {
        path: package,
        _staging: staging,
        screenshot_unavailable,
        included_minidump,
        included_screenshot,
    })
}

fn app_version(report: &serde_json::Value) -> String {
    report
        .pointer("/extra/appVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_owned()
}

/// Build identity the service groups on.
///
/// Version plus architecture: the same release on x86_64 and aarch64 produces
/// different frames, so folding them into one build family would group two
/// genuinely different stacks together.
fn build_id(report: &serde_json::Value) -> String {
    let arch = report
        .pointer("/system/arch")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(std::env::consts::ARCH);
    format!("{}-{arch}", app_version(report))
}

fn platform_label(report: &serde_json::Value) -> String {
    report
        .pointer("/system/family")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(std::env::consts::OS)
        .to_owned()
}

/// The incident's `exception`, one of the two fields grouping keys on.
fn exception_for(report: &serde_json::Value) -> String {
    report
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

/// Translate a submission failure into a stable code the UI can translate.
///
/// Never the raw error text: the renderer shows a localized string, and a
/// service message is neither localized nor guaranteed to be free of detail
/// the user should not have to read.
pub fn submit_error_code(error: &SubmitError) -> String {
    if error.is_ingest_disabled() {
        return "ingest_disabled".to_owned();
    }
    if error.is_unauthorized() {
        return "unauthorized".to_owned();
    }
    match error {
        SubmitError::Service { code, .. } => code.clone(),
        SubmitError::Transport(_) => "network_unavailable".to_owned(),
        SubmitError::Malformed { .. } => "malformed_response".to_owned(),
        SubmitError::Package(_) => "package_invalid".to_owned(),
        _ => "submission_failed".to_owned(),
    }
}

/// Mint an uploader grant from the installation proof.
///
/// No user interaction: the machine proves it is the installation it claims to
/// be with the key that also signs its packages, which is what lets a crash be
/// submitted without asking anyone to paste a token.
fn uploader_grant(
    connection: &DiagnosticConnectionInput,
    identity: &InstallationIdentity,
) -> Result<String, String> {
    exchange_installation_grant(
        &NativeTransport,
        &connection.target(),
        identity,
        chrono::Utc::now().timestamp(),
    )
    .map_err(|error| submit_error_code(&error))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Package and submit one local crash report.
///
/// Everything here is blocking — file IO, zip, network — so it runs on a
/// blocking task rather than occupying an async worker for the length of an
/// upload.
#[tauri::command]
pub async fn crash_submit_report(
    connection: DiagnosticConnectionInput,
    stem: String,
    consent: SubmissionConsentInput,
) -> Result<SubmissionOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || submit_blocking(connection, stem, consent))
        .await
        .map_err(|_| "submission_task_failed".to_owned())?
}

fn submit_blocking(
    connection: DiagnosticConnectionInput,
    stem: String,
    consent: SubmissionConsentInput,
) -> Result<SubmissionOutcome, String> {
    validate_stem(&stem)?;
    let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
    let identity = identity()?;
    let built = build_package(&crash_dir, &stem, &consent, &identity)?;
    let grant = uploader_grant(&connection, &identity)?;

    let report: serde_json::Value = std::fs::read(crash_dir.join(format!("{stem}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(serde_json::Value::Null);

    let receipt = submit_package(
        &NativeTransport,
        &connection.target(),
        &grant,
        SubmissionRequest {
            package: &built.path,
            module: "cognia-desktop",
            exception: &exception_for(&report),
        },
    )
    .map_err(|error| submit_error_code(&error))?;

    // A resumed submission keeps the credential stored the first time: the
    // service withholds it precisely because a second one could never verify.
    let previous = receipts::load(&crash_dir, &stem);
    let record = SubmissionRecord {
        incident_id: receipt.incident_id,
        support_code: receipt.support_code,
        client_state: receipt.client_state,
        processing_state: receipt.processing_state,
        service_url: connection.base_url.clone(),
        submitted_at: chrono::Utc::now().to_rfc3339(),
        deletion_credential: receipt.deletion_credential.or_else(|| {
            previous
                .as_ref()
                .and_then(|old| old.deletion_credential.clone())
        }),
        withdrawn_at: None,
        included_minidump: built.included_minidump,
        included_screenshot: built.included_screenshot,
    };
    receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;

    Ok(SubmissionOutcome {
        record,
        uploaded_parts: receipt.uploaded_parts,
        resumed_parts: receipt.resumed_parts,
        screenshot_unavailable: built.screenshot_unavailable,
    })
}

/// Every stored submission record, keyed by report stem.
#[tauri::command]
pub async fn crash_submission_records(
) -> Result<std::collections::BTreeMap<String, SubmissionRecord>, String> {
    let Some(dir) = crate::crash::crash_reports_dir() else {
        return Ok(Default::default());
    };
    Ok(receipts::load_all(&dir))
}

/// Re-read the service's receipt so the local state stops being a snapshot.
#[tauri::command]
pub async fn crash_refresh_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<SubmissionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let mut record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = uploader_grant(&connection, &identity()?)?;
        let receipt = fetch_receipt(
            &NativeTransport,
            &connection.target(),
            &grant,
            &record.incident_id,
        )
        .map_err(|error| submit_error_code(&error))?;
        if let Some(state) = receipt.get("clientState").and_then(|v| v.as_str()) {
            record.client_state = state.to_owned();
        }
        if let Some(state) = receipt.get("processingState").and_then(|v| v.as_str()) {
            record.processing_state = state.to_owned();
        }
        if let Some(code) = receipt.get("supportCode").and_then(|v| v.as_str()) {
            record.support_code = code.to_owned();
        }
        receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;
        Ok(record)
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

/// Withdraw consent for a submitted report.
///
/// Blocks processing and schedules immediate deletion service-side. Kept
/// distinct from a plain delete because it is the route that stays available
/// while the service's intake switch is off — the one moment a withdrawal
/// matters most.
#[tauri::command]
pub async fn crash_withdraw_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<SubmissionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let mut record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = uploader_grant(&connection, &identity()?)?;
        withdraw_consent(
            &NativeTransport,
            &connection.target(),
            &grant,
            &record.incident_id,
        )
        .map_err(|error| submit_error_code(&error))?;
        record.withdrawn_at = Some(chrono::Utc::now().to_rfc3339());
        record.client_state = "deleted".to_owned();
        record.processing_state = "deleted".to_owned();
        receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;
        Ok(record)
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

/// Delete the remote incident and forget the local record.
///
/// The local record is dropped only after the service confirms: forgetting it
/// first would strand an incident nothing on this machine can address again.
#[tauri::command]
pub async fn crash_delete_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = uploader_grant(&connection, &identity()?)?;
        delete_incident(
            &NativeTransport,
            &connection.target(),
            &grant,
            &record.incident_id,
        )
        .map_err(|error| submit_error_code(&error))?;
        receipts::remove(&crash_dir, &stem).map_err(|error| format!("receipt:{error}"))?;
        Ok(())
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_report_stems_that_could_escape_the_crash_directory() {
        assert!(validate_stem("crash-2026-05-25_14-30-00-panic").is_ok());
        for invalid in ["", "../secrets", "a/b", "a\\b", "C:x"] {
            assert!(validate_stem(invalid).is_err(), "{invalid} must be refused");
        }
    }

    #[test]
    fn a_backtrace_becomes_frames_the_service_can_group_on() {
        let backtrace = "\
   0: cognia_next::crash::panic_hook::install::{{closure}}
             at /src/crash/panic_hook.rs:31:9
   1: core::panicking::panic_fmt
   2: cognia_next::workflow::run

";
        assert_eq!(
            backtrace_frames(backtrace),
            vec![
                "cognia_next::crash::panic_hook::install::{{closure}}",
                "core::panicking::panic_fmt",
                "cognia_next::workflow::run",
            ]
        );
    }

    #[test]
    fn frame_extraction_is_bounded_and_survives_unnumbered_output() {
        let numbered = (0..200)
            .map(|index| format!("  {index}: frame::{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(backtrace_frames(&numbered).len(), MAX_BACKTRACE_FRAMES);
        // A backtrace captured without indices still yields frames rather than
        // collapsing to nothing.
        assert_eq!(
            backtrace_frames("frame_one\nframe_two"),
            vec!["frame_one", "frame_two"]
        );
        assert!(backtrace_frames("").is_empty());
    }

    #[test]
    fn the_event_carries_frames_under_a_key_the_service_looks_for() {
        let report = serde_json::json!({
            "kind": "panic",
            "capturedAt": "2026-08-20T00:00:00Z",
            "message": "boom",
            "location": "src/lib.rs:1",
            "backtrace": "  0: alpha\n  1: beta",
        });
        let events = events_for(&report);
        assert_eq!(events.len(), 1);
        // `stackFrames` is one of the four keys `find_frame_value` searches;
        // the raw `backtrace` string is not, which is why it is reshaped.
        assert_eq!(
            events[0]["stackFrames"],
            serde_json::json!(["alpha", "beta"])
        );
        assert_eq!(events[0]["kind"], serde_json::json!("crash"));
        // The untouched report rides along for a human reading the package.
        assert_eq!(events[0]["report"]["message"], serde_json::json!("boom"));
    }

    #[test]
    fn a_report_without_a_backtrace_still_produces_one_event() {
        let events = events_for(&serde_json::json!({"kind": "native", "message": "sigsegv"}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["stackFrames"], serde_json::json!([]));
    }

    #[test]
    fn build_identity_separates_architectures_of_the_same_release() {
        let intel =
            serde_json::json!({"system": {"arch": "x86_64"}, "extra": {"appVersion": "1.2.3"}});
        let arm =
            serde_json::json!({"system": {"arch": "aarch64"}, "extra": {"appVersion": "1.2.3"}});
        assert_eq!(build_id(&intel), "1.2.3-x86_64");
        assert_ne!(build_id(&intel), build_id(&arm));
        // A report missing the fields still yields something groupable.
        assert!(!build_id(&serde_json::Value::Null).is_empty());
        assert_eq!(
            exception_for(&serde_json::json!({"kind": "panic"})),
            "panic"
        );
        assert_eq!(exception_for(&serde_json::Value::Null), "unknown");
    }

    #[test]
    fn platform_label_prefers_the_captured_family_over_the_building_host() {
        assert_eq!(
            platform_label(&serde_json::json!({"system": {"family": "windows"}})),
            "windows"
        );
        assert_eq!(
            platform_label(&serde_json::Value::Null),
            std::env::consts::OS
        );
    }

    #[test]
    fn failures_become_codes_the_ui_can_translate_rather_than_service_prose() {
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 503,
                code: "ingest_disabled".to_owned()
            }),
            "ingest_disabled"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 401,
                code: "invalid_upload_grant".to_owned()
            }),
            "unauthorized"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 413,
                code: "IncidentTooLarge".to_owned()
            }),
            "IncidentTooLarge"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Transport("dns".to_owned())),
            "network_unavailable"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Malformed { status: 502 }),
            "malformed_response"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Invalid("no id")),
            "submission_failed"
        );
    }

    #[test]
    fn a_connection_target_tolerates_a_trailing_slash_from_the_settings_field() {
        let connection = DiagnosticConnectionInput {
            base_url: "https://diag.example.com/".to_owned(),
            tenant_id: "tenant".to_owned(),
            project_id: "project".to_owned(),
        };
        assert_eq!(connection.target().base_url, "https://diag.example.com");
    }

    #[test]
    fn packaging_carries_the_report_and_honours_each_consent_flag() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-00-panic";
        std::fs::write(
            crash_dir.path().join(format!("{stem}.json")),
            serde_json::to_vec(&serde_json::json!({
                "kind": "panic",
                "message": "boom",
                "backtrace": "  0: alpha",
                "system": {"arch": "x86_64", "family": "macos"},
                "extra": {"appVersion": "9.9.9"},
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(crash_dir.path().join(format!("{stem}.txt")), b"human text").unwrap();
        std::fs::write(crash_dir.path().join(format!("{stem}.dmp")), b"MDMP").unwrap();

        let identity = InstallationIdentity::from_seed(&[3_u8; 32]);

        // Minidump withheld by default.
        let without = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput::default(),
            &identity,
        )
        .unwrap();
        assert!(!without.included_minidump);
        let (_, parts) = cognia_observability::read_package_parts(&without.path).unwrap();
        let kinds: Vec<&str> = parts.iter().map(|part| part.artifact_kind).collect();
        assert_eq!(kinds, vec!["manifest", "events", "attachment"]);

        // …and included only when the user says so.
        let with = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput {
                include_minidump: true,
                include_screenshot: false,
                description: Some("  ".to_owned()),
            },
            &identity,
        )
        .unwrap();
        assert!(with.included_minidump);
        let (_, parts) = cognia_observability::read_package_parts(&with.path).unwrap();
        let kinds: Vec<&str> = parts.iter().map(|part| part.artifact_kind).collect();
        // A whitespace-only description contributes nothing rather than an
        // empty attachment.
        assert_eq!(kinds, vec!["manifest", "events", "attachment", "minidump"]);
    }

    #[test]
    fn a_typed_description_becomes_its_own_scannable_attachment() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-desc";
        std::fs::write(
            crash_dir.path().join(format!("{stem}.json")),
            br#"{"kind":"panic","message":"boom"}"#,
        )
        .unwrap();
        let identity = InstallationIdentity::from_seed(&[4_u8; 32]);
        let built = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput {
                include_minidump: false,
                include_screenshot: false,
                description: Some("I was exporting a workflow".to_owned()),
            },
            &identity,
        )
        .unwrap();
        let (manifest, _) = cognia_observability::read_package_parts(&built.path).unwrap();
        assert!(manifest
            .inventory()
            .iter()
            .any(|entry| entry.path == "attachments/description.txt"));
    }

    #[test]
    fn packaging_refuses_a_report_that_is_not_there() {
        let crash_dir = tempfile::tempdir().unwrap();
        let identity = InstallationIdentity::from_seed(&[5_u8; 32]);
        let error = build_package(
            crash_dir.path(),
            "crash-missing",
            &SubmissionConsentInput::default(),
            &identity,
        )
        .unwrap_err();
        assert_eq!(error, "report_not_found");
    }
}
