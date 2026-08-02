//! The privacy gate for native V1 producers (ADR-0102 §5).
//!
//! This is a port of `packages/logging/src/privacy-manifest.ts`, not a second
//! policy: the manifest version, key lists, replacement token, text patterns and
//! the 30-minute local debug session are the same values, and the shared fixture
//! corpus under `packages/logging/src/schemas/privacy-fixtures/` is replayed by
//! both suites. A Tauri- or CLI-written event must be redacted exactly as a
//! renderer-written one, or an incident assembled from both would leak through
//! whichever half is weaker.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::{ObservabilityCapturePolicy, ObservabilityEventV1, ObservabilityPayload};

/// Versioned key/pattern manifest. `version` is stamped into every event's
/// `privacy.redactionVersion` so a reader can tell which rules produced it.
///
/// Serialize-only by design: the manifest is compiled in, never read from disk
/// or the network. A deserializable manifest would be an injection point for
/// weakening redaction from outside the binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientPrivacyManifest {
    pub version: &'static str,
    /// Keys whose *values* are product content. Removed outright unless a local
    /// debug session is active; the path is reported in `removedFields`.
    pub blocked_content_keys: &'static [&'static str],
    /// Keys whose values are credentials. Always replaced, never kept, and
    /// never reported as "removed" — the field still exists, its value does not.
    pub secret_keys: &'static [&'static str],
    pub replacement: &'static str,
}

pub const CLIENT_PRIVACY_MANIFEST_V1: ClientPrivacyManifest = ClientPrivacyManifest {
    version: "privacy-v1-2026-08-01",
    blocked_content_keys: &[
        "prompt",
        "prompts",
        "messages",
        "messageContent",
        "input",
        "output",
        "toolInput",
        "toolOutput",
        "fileBody",
        "fileContent",
        "requestBody",
        "responseBody",
    ],
    secret_keys: &[
        "password",
        "passwd",
        "token",
        "accessToken",
        "refreshToken",
        "secret",
        "apiKey",
        "authorization",
        "cookie",
        "clientSecret",
        "privateKey",
    ],
    replacement: "[REDACTED]",
};

/// A local, time-boxed escalation to content capture. `remote_allowed` is
/// structurally `false`: a debug session never authorizes remote content upload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDebugCaptureSession {
    pub id: String,
    pub started_at: String,
    pub expires_at: String,
    /// Always `false`. Serialized so the renderer and native shapes match.
    pub remote_allowed: bool,
}

pub const DEBUG_SESSION_TTL_MS: i64 = 30 * 60_000;

/// Create a 30-minute local debug session starting at `now`.
pub fn create_local_debug_capture_session(
    id: impl Into<String>,
    now: chrono::DateTime<chrono::Utc>,
) -> LocalDebugCaptureSession {
    LocalDebugCaptureSession {
        id: id.into(),
        started_at: to_iso(now),
        expires_at: to_iso(now + chrono::Duration::milliseconds(DEBUG_SESSION_TTL_MS)),
        remote_allowed: false,
    }
}

/// Millisecond-precision ISO-8601 with a `Z` suffix — the exact shape
/// `Date.prototype.toISOString()` produces, so timestamps compare across
/// runtimes without a normalization step.
fn to_iso(value: chrono::DateTime<chrono::Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn is_debug_session_active(
    session: Option<&LocalDebugCaptureSession>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let Some(session) = session else {
        return false;
    };
    if session.remote_allowed {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(&session.expires_at)
        .map(|expiry| now < expiry.with_timezone(&chrono::Utc))
        .unwrap_or(false)
}

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*").expect("bearer pattern"));
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b").expect("email pattern")
});
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:[A-Za-z]:\\|/(?:Users|home|var|tmp|private|opt|etc)/)[^\s"']+"#)
        .expect("path pattern")
});

/// Apply the free-text rules in the same order as the TypeScript gate. Order is
/// load-bearing: `Bearer <token>` must collapse before the email rule can chew
/// on a token that happens to contain an `@`.
fn redact_text(value: &str) -> String {
    let stage = BEARER.replace_all(value, "[REDACTED]");
    let stage = EMAIL.replace_all(&stage, "[REDACTED_EMAIL]");
    PATH.replace_all(&stage, "[REDACTED_PATH]").into_owned()
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| !matches!(c, '-' | '_' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

fn key_set(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|key| normalize_key(key)).collect()
}

struct SanitizeContext<'a> {
    allow_content: bool,
    blocked: BTreeSet<String>,
    secrets: BTreeSet<String>,
    replacement: &'a str,
    removed: BTreeSet<String>,
}

/// Returns `None` when the value was removed outright (blocked content key).
fn sanitize_value(
    value: &Value,
    path: &str,
    key_hint: Option<&str>,
    ctx: &mut SanitizeContext<'_>,
) -> Option<Value> {
    if let Some(hint) = key_hint {
        let normalized = normalize_key(hint);
        if ctx.blocked.contains(&normalized) && !ctx.allow_content {
            ctx.removed.insert(path.to_string());
            return None;
        }
        if ctx.secrets.contains(&normalized) {
            return Some(Value::String(ctx.replacement.to_string()));
        }
    }

    match value {
        Value::String(text) => Some(Value::String(redact_text(text))),
        Value::Array(items) => {
            let sanitized = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    sanitize_value(item, &format!("{path}[{index}]"), None, ctx)
                })
                .collect();
            Some(Value::Array(sanitized))
        }
        Value::Object(entries) => {
            let mut result = Map::new();
            for (key, nested) in entries {
                let nested_path = format!("{path}.{key}");
                if let Some(sanitized) = sanitize_value(nested, &nested_path, Some(key), ctx) {
                    result.insert(key.clone(), sanitized);
                }
            }
            Some(Value::Object(result))
        }
        other => Some(other.clone()),
    }
}

/// How the gate was configured for one call.
#[derive(Debug, Clone, Default)]
pub struct PrivacyApplicationOptions<'a> {
    pub manifest: Option<&'a ClientPrivacyManifest>,
    pub debug_session: Option<&'a LocalDebugCaptureSession>,
}

/// Redact one event's payload and rewrite its `privacy` block to describe what
/// happened. Always run this before a native producer writes to a spool — the
/// spool is a durable artifact and an unredacted line there is a leak even if
/// nothing ever uploads it.
pub fn apply_observability_privacy(
    event: &ObservabilityEventV1,
    options: &PrivacyApplicationOptions<'_>,
    now: chrono::DateTime<chrono::Utc>,
) -> ObservabilityEventV1 {
    let manifest = options.manifest.unwrap_or(&CLIENT_PRIVACY_MANIFEST_V1);
    let allow_content = is_debug_session_active(options.debug_session, now);

    let mut ctx = SanitizeContext {
        allow_content,
        blocked: key_set(manifest.blocked_content_keys),
        secrets: key_set(manifest.secret_keys),
        replacement: manifest.replacement,
        removed: event.privacy.removed_fields.iter().cloned().collect(),
    };

    // Round-trip the payload through `Value` so the flattened `extra` map is
    // sanitized on exactly the same terms as the named fields — a producer must
    // not be able to smuggle content past the gate by inventing a key.
    let payload_value = serde_json::to_value(&event.payload).unwrap_or(Value::Null);
    let sanitized = sanitize_value(&payload_value, "payload", None, &mut ctx)
        .unwrap_or(Value::Object(Map::new()));
    let payload: ObservabilityPayload = serde_json::from_value(sanitized)
        .unwrap_or_else(|_| ObservabilityPayload::message(redact_text(&event.payload.message)));

    let mut result = event.clone();
    result.payload = payload;
    result.privacy.redaction_version = manifest.version.to_string();
    result.privacy.capture_policy = if allow_content {
        ObservabilityCapturePolicy::DebugSession
    } else {
        ObservabilityCapturePolicy::MetadataOnly
    };
    result.privacy.content_captured = allow_content;
    result.privacy.removed_fields = ctx.removed.into_iter().collect();
    result
}

/// A credential class confident enough that finding one rejects the whole
/// attachment rather than redacting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HighConfidenceCredentialKind {
    AwsAccessKey,
    Jwt,
    PrivateKey,
    ProviderSecret,
}

impl HighConfidenceCredentialKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwsAccessKey => "aws-access-key",
            Self::Jwt => "jwt",
            Self::PrivateKey => "private-key",
            Self::ProviderSecret => "provider-secret",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighConfidenceCredentialFinding {
    pub kind: HighConfidenceCredentialKind,
    pub occurrences: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialScanResult {
    pub reject: bool,
    /// Counts only — never the matched bytes. A rejection report that quoted the
    /// credential would be the leak it exists to prevent.
    pub findings: Vec<HighConfidenceCredentialFinding>,
}

static AWS_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").expect("aws pattern"));
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")
        .expect("jwt pattern")
});
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----").expect("pem pattern")
});
static PROVIDER_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:sk|rk)-[A-Za-z0-9_\-]{24,}\b").expect("provider pattern"));

/// Streaming-friendly scan for credentials in an untrusted attachment. Mirrors
/// `scanHighConfidenceCredentials` so a client-side rejection and a server-side
/// rejection agree on what counts.
pub fn scan_high_confidence_credentials(input: &[u8]) -> CredentialScanResult {
    let text = String::from_utf8_lossy(input);
    let mut findings: Vec<HighConfidenceCredentialFinding> = [
        (HighConfidenceCredentialKind::AwsAccessKey, &*AWS_KEY),
        (HighConfidenceCredentialKind::Jwt, &*JWT),
        (HighConfidenceCredentialKind::PrivateKey, &*PRIVATE_KEY),
        (
            HighConfidenceCredentialKind::ProviderSecret,
            &*PROVIDER_SECRET,
        ),
    ]
    .into_iter()
    .filter_map(|(kind, pattern)| {
        let occurrences = pattern.find_iter(&text).count();
        (occurrences > 0).then_some(HighConfidenceCredentialFinding { kind, occurrences })
    })
    .collect();
    findings.sort_by_key(|finding| finding.kind.as_str());

    CredentialScanResult {
        reject: !findings.is_empty(),
        findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PrivacyFixture {
        #[allow(dead_code)]
        name: String,
        debug_session: bool,
        input: ObservabilityPayload,
        expected: ExpectedFixture,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedFixture {
        payload: Value,
        removed_fields: Vec<String>,
        capture_policy: ObservabilityCapturePolicy,
        content_captured: bool,
    }

    fn base_event() -> ObservabilityEventV1 {
        let raw = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/logging/src/schemas/fixtures/log-minimal.json"),
        )
        .expect("golden fixture");
        serde_json::from_str(&raw).expect("parses")
    }

    fn fixtures() -> Vec<(String, PrivacyFixture)> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/logging/src/schemas/privacy-fixtures");
        let mut out: Vec<(String, PrivacyFixture)> = std::fs::read_dir(dir)
            .expect("privacy fixture dir exists")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()?.to_str()? != "json" {
                    return None;
                }
                let name = path.file_name()?.to_str()?.to_string();
                let raw = std::fs::read_to_string(&path).ok()?;
                Some((
                    name,
                    serde_json::from_str(&raw).expect("privacy fixture parses"),
                ))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        assert!(!out.is_empty());
        out
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-08-01T09:15:00Z")
            .expect("timestamp")
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn every_shared_fixture_matches_the_typescript_gate() {
        for (file, fixture) in fixtures() {
            let mut event = base_event();
            event.payload = fixture.input;
            let session = fixture
                .debug_session
                .then(|| create_local_debug_capture_session("debug-1", now()));
            let options = PrivacyApplicationOptions {
                manifest: None,
                debug_session: session.as_ref(),
            };

            let result = apply_observability_privacy(&event, &options, now());
            let payload = serde_json::to_value(&result.payload).expect("serializes");

            assert_eq!(payload, fixture.expected.payload, "{file} payload diverged");
            assert_eq!(
                result.privacy.removed_fields, fixture.expected.removed_fields,
                "{file} removedFields diverged"
            );
            assert_eq!(
                result.privacy.capture_policy, fixture.expected.capture_policy,
                "{file} capturePolicy diverged"
            );
            assert_eq!(
                result.privacy.content_captured, fixture.expected.content_captured,
                "{file} contentCaptured diverged"
            );
        }
    }

    #[test]
    fn manifest_version_is_stamped_onto_the_event() {
        let event = base_event();
        let result =
            apply_observability_privacy(&event, &PrivacyApplicationOptions::default(), now());
        assert_eq!(
            result.privacy.redaction_version,
            CLIENT_PRIVACY_MANIFEST_V1.version
        );
    }

    #[test]
    fn removed_fields_are_sorted_and_deduplicated() {
        let mut event = base_event();
        event.privacy.removed_fields =
            vec!["payload.data.zeta".into(), "payload.data.alpha".into()];
        let mut data = Map::new();
        data.insert("prompt".into(), Value::from("hidden"));
        event.payload = ObservabilityPayload::message("m").with_data(data);

        let result =
            apply_observability_privacy(&event, &PrivacyApplicationOptions::default(), now());
        assert_eq!(
            result.privacy.removed_fields,
            vec![
                "payload.data.alpha".to_string(),
                "payload.data.prompt".to_string(),
                "payload.data.zeta".to_string(),
            ]
        );
    }

    #[test]
    fn payload_extras_are_sanitized_like_named_fields() {
        let mut event = base_event();
        let mut payload = ObservabilityPayload::message("m");
        payload
            .extra
            .insert("toolOutput".into(), Value::from("product content"));
        payload
            .extra
            .insert("apiKey".into(), Value::from("abcdef0123456789"));
        event.payload = payload;

        let result =
            apply_observability_privacy(&event, &PrivacyApplicationOptions::default(), now());
        assert!(!result.payload.extra.contains_key("toolOutput"));
        assert_eq!(
            result.payload.extra.get("apiKey"),
            Some(&Value::from("[REDACTED]"))
        );
        assert_eq!(result.privacy.removed_fields, vec!["payload.toolOutput"]);
    }

    #[test]
    fn expired_debug_session_falls_back_to_metadata_only() {
        let session = create_local_debug_capture_session("debug-1", now());
        let mut event = base_event();
        let mut data = Map::new();
        data.insert("prompt".into(), Value::from("plan"));
        event.payload = ObservabilityPayload::message("m").with_data(data);

        let options = PrivacyApplicationOptions {
            manifest: None,
            debug_session: Some(&session),
        };
        let during =
            apply_observability_privacy(&event, &options, now() + chrono::Duration::minutes(29));
        assert!(during.privacy.content_captured);

        let after =
            apply_observability_privacy(&event, &options, now() + chrono::Duration::minutes(31));
        assert!(!after.privacy.content_captured);
        assert_eq!(after.privacy.removed_fields, vec!["payload.data.prompt"]);
    }

    #[test]
    fn a_session_claiming_remote_access_is_not_honoured() {
        let mut session = create_local_debug_capture_session("debug-1", now());
        // A forged session cannot buy content capture by flipping the flag.
        session.remote_allowed = true;
        let options = PrivacyApplicationOptions {
            manifest: None,
            debug_session: Some(&session),
        };
        let result = apply_observability_privacy(&base_event(), &options, now());
        assert!(!result.privacy.content_captured);
    }

    #[test]
    fn debug_session_ttl_is_thirty_minutes() {
        let session = create_local_debug_capture_session("debug-1", now());
        let started = chrono::DateTime::parse_from_rfc3339(&session.started_at).expect("iso");
        let expires = chrono::DateTime::parse_from_rfc3339(&session.expires_at).expect("iso");
        assert_eq!((expires - started).num_minutes(), 30);
        assert!(!session.remote_allowed);
        assert!(session.started_at.ends_with('Z'));
    }

    #[test]
    fn key_normalization_ignores_case_and_separators() {
        assert_eq!(normalize_key("client_secret"), "clientsecret");
        assert_eq!(normalize_key("Client-Secret"), "clientsecret");
        assert_eq!(normalize_key("API KEY"), "apikey");
    }

    #[test]
    fn credential_scan_reports_counts_without_the_matched_bytes() {
        let sample = concat!(
            "AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLZ\n",
            "-----BEGIN PRIVATE KEY-----\n",
            "sk-abcdefghijklmnopqrstuvwxyz012345\n"
        );
        let result = scan_high_confidence_credentials(sample.as_bytes());
        assert!(result.reject);
        let kinds: Vec<&str> = result
            .findings
            .iter()
            .map(|finding| finding.kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            vec!["aws-access-key", "private-key", "provider-secret"]
        );
        assert_eq!(result.findings[0].occurrences, 2);
        let serialized = serde_json::to_string(&result).expect("serializes");
        assert!(!serialized.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn credential_scan_accepts_clean_input() {
        let result = scan_high_confidence_credentials(b"nothing sensitive here");
        assert!(!result.reject);
        assert!(result.findings.is_empty());
    }

    #[test]
    fn credential_scan_detects_a_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let result = scan_high_confidence_credentials(jwt.as_bytes());
        assert!(result.reject);
        assert_eq!(result.findings[0].kind, HighConfidenceCredentialKind::Jwt);
    }

    #[test]
    fn credential_scan_tolerates_non_utf8_bytes() {
        let mut bytes = vec![0xff, 0xfe, 0x00];
        bytes.extend_from_slice(b"AKIAIOSFODNN7EXAMPLE");
        let result = scan_high_confidence_credentials(&bytes);
        assert!(result.reject);
    }

    #[test]
    fn bearer_token_is_redacted_before_the_email_rule_runs() {
        // `Bearer` values can contain `.` and `-`; if the email rule ran first
        // it could rewrite part of a token and leave the rest in place.
        assert_eq!(
            redact_text("Authorization: Bearer a.b-c_d"),
            "Authorization: [REDACTED]"
        );
    }

    #[test]
    fn redacted_event_still_validates() {
        let mut event = base_event();
        let mut data = Map::new();
        data.insert("prompt".into(), Value::from("secret"));
        event.payload = ObservabilityPayload::message("Contact a@b.co").with_data(data);
        let result =
            apply_observability_privacy(&event, &PrivacyApplicationOptions::default(), now());
        assert_eq!(result.validate(), Ok(()));
        assert_eq!(result.payload.message, "Contact [REDACTED_EMAIL]");
    }
}
