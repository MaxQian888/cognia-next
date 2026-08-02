//! `ObservabilityEventV1` — the single cross-runtime wire format (ADR-0102).
//!
//! This is **not** a second envelope. The checked-in JSON Schema at
//! `packages/logging/src/schemas/observability-event-v1.schema.json` is the wire
//! authority; these types mirror it and the `schema_parity` tests below derive
//! their expectations from that file, so adding a property to the schema without
//! adding it here fails the build rather than silently producing a Rust writer
//! that drops fields.
//!
//! Golden fixtures live next to the schema in `schemas/fixtures/` and are shared
//! byte-for-byte with the TypeScript suite, so a renderer-written event and a
//! Rust-written event are provably the same shape.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{Error as DeError, Unexpected};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// Absolute path to the canonical JSON Schema, resolved at compile time.
pub const OBSERVABILITY_EVENT_V1_SCHEMA: &str =
    include_str!("../../../packages/logging/src/schemas/observability-event-v1.schema.json");

/// Discriminator for the V1 envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObservabilityEventKind {
    Log,
    Span,
    Crash,
    Lifecycle,
    Metric,
}

impl ObservabilityEventKind {
    pub const ALL: [Self; 5] = [
        Self::Log,
        Self::Span,
        Self::Crash,
        Self::Lifecycle,
        Self::Metric,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Log => "log",
            Self::Span => "span",
            Self::Crash => "crash",
            Self::Lifecycle => "lifecycle",
            Self::Metric => "metric",
        }
    }
}

impl fmt::Display for ObservabilityEventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Severity ladder. Ordering matters: `warn` and above are *protected* — a
/// bounded spool evicts everything below before it drops one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObservabilitySeverity {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl ObservabilitySeverity {
    pub const ALL: [Self; 6] = [
        Self::Trace,
        Self::Debug,
        Self::Info,
        Self::Warn,
        Self::Error,
        Self::Fatal,
    ];

    /// Mirrors `LEVEL_PRIORITY` in `packages/logging/src/types/log-level.ts`.
    pub fn priority(self) -> u8 {
        match self {
            Self::Trace => 0,
            Self::Debug => 1,
            Self::Info => 2,
            Self::Warn => 3,
            Self::Error => 4,
            Self::Fatal => 5,
        }
    }

    /// `warn+` — spools must not drop these to make room for chattier events.
    pub fn is_protected(self) -> bool {
        self.priority() >= Self::Warn.priority()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Fatal => "fatal",
        }
    }
}

impl fmt::Display for ObservabilitySeverity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every runtime that may write a V1 event. Host-injected — never taken from a
/// plugin or another untrusted producer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservabilityRuntime {
    Browser,
    Server,
    Tauri,
    Sidecar,
    Cli,
    Plugin,
    Companion,
    #[serde(rename = "capacitor-ios")]
    CapacitorIos,
    #[serde(rename = "capacitor-android")]
    CapacitorAndroid,
    Mcp,
    Internal,
    Unknown,
}

impl ObservabilityRuntime {
    pub const ALL: [Self; 12] = [
        Self::Browser,
        Self::Server,
        Self::Tauri,
        Self::Sidecar,
        Self::Cli,
        Self::Plugin,
        Self::Companion,
        Self::CapacitorIos,
        Self::CapacitorAndroid,
        Self::Mcp,
        Self::Internal,
        Self::Unknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Server => "server",
            Self::Tauri => "tauri",
            Self::Sidecar => "sidecar",
            Self::Cli => "cli",
            Self::Plugin => "plugin",
            Self::Companion => "companion",
            Self::CapacitorIos => "capacitor-ios",
            Self::CapacitorAndroid => "capacitor-android",
            Self::Mcp => "mcp",
            Self::Internal => "internal",
            Self::Unknown => "unknown",
        }
    }

    /// Native crash capture is a property of the *host*, not of the writer.
    /// Sidecars, CLIs, plugins and servers report lifecycle/error capture only;
    /// claiming minidump support from these would be a false capability.
    pub fn can_report_native_crash(self) -> bool {
        matches!(
            self,
            Self::Tauri | Self::CapacitorIos | Self::CapacitorAndroid
        )
    }
}

impl fmt::Display for ObservabilityRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Capture policy — `debug-session` is a 30-minute, local-only escalation and
/// never authorizes remote content upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ObservabilityCapturePolicy {
    #[default]
    MetadataOnly,
    DebugSession,
}

impl ObservabilityCapturePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MetadataOnly => "metadata-only",
            Self::DebugSession => "debug-session",
        }
    }
}

/// Immutable execution scope. Host-injected on every boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityScope {
    pub tenant_id: String,
    pub installation_id: String,
    pub runtime: ObservabilityRuntime,
    pub process_id: String,
    pub module: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub build_id: String,
    pub app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// W3C-compatible correlation. All fields optional; `traceparent` is derived
/// from a 128-bit trace id and 64-bit span id when both are valid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityCorrelation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
}

/// Redaction provenance. `removed_fields` names the paths the privacy gate
/// dropped so an incident can say what is missing instead of hiding the gap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityPrivacy {
    pub redaction_version: String,
    pub capture_policy: ObservabilityCapturePolicy,
    pub content_captured: bool,
    pub removed_fields: Vec<String>,
}

impl ObservabilityPrivacy {
    /// Default posture: metadata only, nothing captured, nothing removed yet.
    pub fn metadata_only(redaction_version: impl Into<String>) -> Self {
        Self {
            redaction_version: redaction_version.into(),
            capture_policy: ObservabilityCapturePolicy::MetadataOnly,
            content_captured: false,
            removed_fields: Vec::new(),
        }
    }
}

/// Spool position. Monotonic per runtime; the watermark is the highest
/// acknowledged sequence at the time the event was written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityDelivery {
    pub spool_sequence: u64,
    pub flush_watermark: u64,
}

/// Payload. `message` is required; the schema allows additional properties, so
/// producer-specific fields ride in `extra` without a schema bump.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityPayload {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// JSON numbers, not `f64`: the renderer writes `2`, and re-encoding it as
    /// `2.0` would make an otherwise-identical Rust and TypeScript event differ
    /// in the golden-parity diff. `serde_json::Number` keeps the wire form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_event_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ObservabilityPayload {
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            ..Self::default()
        }
    }

    pub fn with_data(mut self, data: Map<String, Value>) -> Self {
        self.data = Some(data);
        self
    }

    pub fn with_stack(mut self, stack: impl Into<String>) -> Self {
        self.stack = Some(stack.into());
        self
    }

    pub fn with_tags<I, S>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tags = Some(tags.into_iter().map(Into::into).collect());
        self
    }

    /// Record an attempt counter. Integral by construction, so it serializes as
    /// `2` rather than `2.0` and stays byte-comparable with the TS writer.
    pub fn with_attempt(mut self, attempt: u64) -> Self {
        self.attempt = Some(Number::from(attempt));
        self
    }

    /// Record a duration. Non-finite input is dropped rather than written —
    /// JSON has no representation for it and the schema forbids it.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Number::from_f64(duration_ms);
        self
    }

    /// `durationMs` as an `f64`, regardless of whether it was written as an
    /// integer or a float.
    pub fn duration_ms_f64(&self) -> Option<f64> {
        self.duration_ms.as_ref().and_then(Number::as_f64)
    }
}

fn serialize_schema_version<S: Serializer>(_: &(), serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_u8(1)
}

fn deserialize_schema_version<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    let version = u64::deserialize(deserializer)?;
    if version == 1 {
        Ok(())
    } else {
        Err(D::Error::invalid_value(
            Unexpected::Unsigned(version),
            &"the constant 1",
        ))
    }
}

/// The V1 envelope. Root field order matches the schema's `required` list so a
/// serialized Rust event diffs cleanly against a serialized renderer event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityEventV1 {
    #[serde(
        rename = "schemaVersion",
        serialize_with = "serialize_schema_version",
        deserialize_with = "deserialize_schema_version"
    )]
    pub schema_version: (),
    pub event_id: String,
    pub occurred_at: String,
    pub kind: ObservabilityEventKind,
    pub severity: ObservabilitySeverity,
    pub name: String,
    pub code: String,
    pub scope: ObservabilityScope,
    #[serde(default)]
    pub correlation: ObservabilityCorrelation,
    pub privacy: ObservabilityPrivacy,
    #[serde(default)]
    pub delivery: ObservabilityDelivery,
    pub payload: ObservabilityPayload,
}

/// Why a candidate event is not a valid V1 event. Carries the offending *path*,
/// never the offending value — a rejection must not leak the bytes it rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventError {
    #[error("{path} must not be empty")]
    Empty { path: &'static str },
    #[error("{path} exceeds its maximum length of {max}")]
    TooLong { path: &'static str, max: usize },
    #[error("{path} is not an RFC 3339 timestamp")]
    Timestamp { path: &'static str },
    #[error("{path} is not a W3C traceparent")]
    Traceparent { path: &'static str },
    #[error("{path} must not be negative")]
    Negative { path: &'static str },
    #[error("privacy.removedFields contains a duplicate entry")]
    DuplicateRemovedField,
}

const TRACEPARENT_LEN: usize = 55;

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$` without a regex dep.
fn is_traceparent(value: &str) -> bool {
    if value.len() != TRACEPARENT_LEN {
        return false;
    }
    let mut parts = value.split('-');
    let (Some(version), Some(trace), Some(span), Some(flags), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return false;
    };
    is_lower_hex(version, 2)
        && is_lower_hex(trace, 32)
        && is_lower_hex(span, 16)
        && is_lower_hex(flags, 2)
}

/// Build a `traceparent` from a trace/span id pair, or `None` when either is
/// not a valid non-zero W3C id. Mirrors `createTraceparent` in the TS adapter.
pub fn create_traceparent(trace_id: Option<&str>, span_id: Option<&str>) -> Option<String> {
    let trace_id = trace_id?;
    let span_id = span_id?;
    if !is_lower_hex(trace_id, 32) || !is_lower_hex(span_id, 16) {
        return None;
    }
    if trace_id.bytes().all(|b| b == b'0') || span_id.bytes().all(|b| b == b'0') {
        return None;
    }
    Some(format!("00-{trace_id}-{span_id}-01"))
}

fn require_non_empty(value: &str, path: &'static str) -> Result<(), EventError> {
    if value.is_empty() {
        Err(EventError::Empty { path })
    } else {
        Ok(())
    }
}

fn require_len(value: &str, path: &'static str, max: usize) -> Result<(), EventError> {
    require_non_empty(value, path)?;
    if value.chars().count() > max {
        Err(EventError::TooLong { path, max })
    } else {
        Ok(())
    }
}

fn require_optional_non_empty(
    value: Option<&String>,
    path: &'static str,
) -> Result<(), EventError> {
    match value {
        Some(value) => require_non_empty(value, path),
        None => Ok(()),
    }
}

impl ObservabilityEventV1 {
    /// Construct a V1 event with the required roots filled in. Callers layer
    /// correlation/privacy/delivery on top; `validate` is the gate before a
    /// write.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        event_id: impl Into<String>,
        occurred_at: impl Into<String>,
        kind: ObservabilityEventKind,
        severity: ObservabilitySeverity,
        name: impl Into<String>,
        code: impl Into<String>,
        scope: ObservabilityScope,
        privacy: ObservabilityPrivacy,
        payload: ObservabilityPayload,
    ) -> Self {
        Self {
            schema_version: (),
            event_id: event_id.into(),
            occurred_at: occurred_at.into(),
            kind,
            severity,
            name: name.into(),
            code: code.into(),
            scope,
            correlation: ObservabilityCorrelation::default(),
            privacy,
            delivery: ObservabilityDelivery::default(),
            payload,
        }
    }

    pub fn with_correlation(mut self, correlation: ObservabilityCorrelation) -> Self {
        self.correlation = correlation;
        self
    }

    pub fn with_delivery(mut self, spool_sequence: u64, flush_watermark: u64) -> Self {
        self.delivery = ObservabilityDelivery {
            spool_sequence,
            flush_watermark,
        };
        self
    }

    /// `warn+` — a bounded spool must reject rather than silently drop these.
    pub fn is_protected(&self) -> bool {
        self.severity.is_protected()
    }

    /// Enforce every constraint the JSON Schema declares. Runs on the write
    /// path in every Rust producer so an invalid event never reaches a spool.
    pub fn validate(&self) -> Result<(), EventError> {
        require_len(&self.event_id, "eventId", 160)?;
        require_non_empty(&self.occurred_at, "occurredAt")?;
        if chrono::DateTime::parse_from_rfc3339(&self.occurred_at).is_err() {
            return Err(EventError::Timestamp { path: "occurredAt" });
        }
        require_len(&self.name, "name", 512)?;
        require_len(&self.code, "code", 160)?;

        require_non_empty(&self.scope.tenant_id, "scope.tenantId")?;
        require_non_empty(&self.scope.installation_id, "scope.installationId")?;
        require_non_empty(&self.scope.process_id, "scope.processId")?;
        require_non_empty(&self.scope.module, "scope.module")?;
        require_non_empty(&self.scope.build_id, "scope.buildId")?;
        require_non_empty(&self.scope.app_version, "scope.appVersion")?;
        require_optional_non_empty(self.scope.plugin_id.as_ref(), "scope.pluginId")?;
        require_optional_non_empty(self.scope.origin.as_ref(), "scope.origin")?;

        if let Some(traceparent) = &self.correlation.traceparent {
            if !is_traceparent(traceparent) {
                return Err(EventError::Traceparent {
                    path: "correlation.traceparent",
                });
            }
        }
        if let Some(tracestate) = &self.correlation.tracestate {
            if tracestate.chars().count() > 512 {
                return Err(EventError::TooLong {
                    path: "correlation.tracestate",
                    max: 512,
                });
            }
        }
        require_optional_non_empty(self.correlation.trace_id.as_ref(), "correlation.traceId")?;
        require_optional_non_empty(self.correlation.span_id.as_ref(), "correlation.spanId")?;
        require_optional_non_empty(
            self.correlation.parent_span_id.as_ref(),
            "correlation.parentSpanId",
        )?;
        require_optional_non_empty(
            self.correlation.session_id.as_ref(),
            "correlation.sessionId",
        )?;
        require_optional_non_empty(
            self.correlation.request_id.as_ref(),
            "correlation.requestId",
        )?;
        require_optional_non_empty(
            self.correlation.execution_id.as_ref(),
            "correlation.executionId",
        )?;
        require_optional_non_empty(
            self.correlation.workflow_id.as_ref(),
            "correlation.workflowId",
        )?;
        require_optional_non_empty(self.correlation.step_id.as_ref(), "correlation.stepId")?;

        require_non_empty(&self.privacy.redaction_version, "privacy.redactionVersion")?;
        let mut seen = BTreeMap::new();
        for field in &self.privacy.removed_fields {
            require_non_empty(field, "privacy.removedFields[]")?;
            if seen.insert(field.as_str(), ()).is_some() {
                return Err(EventError::DuplicateRemovedField);
            }
        }

        if let Some(duration) = self.payload.duration_ms_f64() {
            if duration < 0.0 {
                return Err(EventError::Negative {
                    path: "payload.durationMs",
                });
            }
        }

        Ok(())
    }

    /// Serialize one NDJSON line. Validation runs first so a spool file never
    /// contains a line that the service would later reject.
    pub fn to_ndjson_line(&self) -> Result<String, EventError> {
        self.validate()?;
        // `serde_json::to_string` on a validated struct cannot fail: every field
        // is a plain JSON-representable type and the schema forbids non-finite
        // numbers, which `validate` has already ruled out for `durationMs`.
        Ok(serde_json::to_string(self).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/logging/src/schemas/fixtures")
    }

    fn fixtures() -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = std::fs::read_dir(fixture_dir())
            .expect("golden fixture dir exists")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()?.to_str()? != "json" {
                    return None;
                }
                let name = path.file_name()?.to_str()?.to_string();
                Some((name, std::fs::read_to_string(&path).ok()?))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        assert!(!out.is_empty(), "golden fixtures must exist");
        out
    }

    fn schema() -> Value {
        serde_json::from_str(OBSERVABILITY_EVENT_V1_SCHEMA).expect("schema parses")
    }

    fn schema_properties(pointer: &str) -> Vec<String> {
        let schema = schema();
        let node = schema.pointer(pointer).expect("schema node exists");
        node.get("properties")
            .and_then(Value::as_object)
            .expect("node declares properties")
            .keys()
            .cloned()
            .collect()
    }

    fn schema_enum(pointer: &str) -> Vec<String> {
        let schema = schema();
        schema
            .pointer(pointer)
            .and_then(|node| node.get("enum"))
            .and_then(Value::as_array)
            .expect("enum node exists")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("enum entries are strings")
                    .to_string()
            })
            .collect()
    }

    // --- golden parity -----------------------------------------------------

    #[test]
    fn every_golden_fixture_round_trips_without_loss() {
        for (name, raw) in fixtures() {
            let original: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|error| panic!("{name} is not JSON: {error}"));
            let event: ObservabilityEventV1 = serde_json::from_str(&raw)
                .unwrap_or_else(|error| panic!("{name} does not parse as V1: {error}"));
            event
                .validate()
                .unwrap_or_else(|error| panic!("{name} fails validation: {error}"));
            let reserialized: Value =
                serde_json::to_value(&event).expect("validated event serializes");
            assert_eq!(reserialized, original, "{name} lost or changed a field");
        }
    }

    #[test]
    fn golden_fixtures_cover_every_event_kind() {
        let kinds: Vec<ObservabilityEventKind> = fixtures()
            .iter()
            .map(|(_, raw)| {
                serde_json::from_str::<ObservabilityEventV1>(raw)
                    .expect("fixture parses")
                    .kind
            })
            .collect();
        for kind in ObservabilityEventKind::ALL {
            assert!(
                kinds.contains(&kind),
                "no golden fixture exercises kind `{kind}`"
            );
        }
    }

    #[test]
    fn ndjson_line_is_single_line_and_reparses() {
        for (name, raw) in fixtures() {
            let event: ObservabilityEventV1 = serde_json::from_str(&raw).expect("fixture parses");
            let line = event.to_ndjson_line().expect("validated event serializes");
            assert!(!line.contains('\n'), "{name} produced a multi-line record");
            let back: ObservabilityEventV1 =
                serde_json::from_str(&line).expect("NDJSON line reparses");
            assert_eq!(back, event, "{name} did not survive the NDJSON round trip");
        }
    }

    // --- schema parity (derives expectations from the checked-in schema) ---

    #[test]
    fn root_fields_match_the_schema() {
        let raw = std::fs::read_to_string(fixture_dir().join("log-full.json")).expect("fixture");
        let event: ObservabilityEventV1 = serde_json::from_str(&raw).expect("parses");
        let serialized = serde_json::to_value(&event).expect("serializes");
        let mut actual: Vec<String> = serialized
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect();
        let mut expected = schema_properties("");
        actual.sort();
        expected.sort();
        assert_eq!(
            actual, expected,
            "Rust root fields drifted from the JSON Schema"
        );
    }

    #[test]
    fn nested_object_fields_match_the_schema() {
        let raw = std::fs::read_to_string(fixture_dir().join("log-full.json")).expect("fixture");
        let event: ObservabilityEventV1 = serde_json::from_str(&raw).expect("parses");
        let serialized = serde_json::to_value(&event).expect("serializes");

        for (field, pointer) in [
            ("scope", "/$defs/scope"),
            ("correlation", "/$defs/correlation"),
            ("privacy", "/$defs/privacy"),
            ("delivery", "/$defs/delivery"),
        ] {
            let mut actual: Vec<String> = serialized
                .get(field)
                .and_then(Value::as_object)
                .unwrap_or_else(|| panic!("`{field}` serialized as an object"))
                .keys()
                .cloned()
                .collect();
            let mut expected = schema_properties(pointer);
            actual.sort();
            expected.sort();
            assert_eq!(
                actual, expected,
                "Rust `{field}` fields drifted from the JSON Schema"
            );
        }
    }

    #[test]
    fn kind_enum_matches_the_schema() {
        let expected = schema_enum("/properties/kind");
        let actual: Vec<String> = ObservabilityEventKind::ALL
            .iter()
            .map(|kind| kind.as_str().to_string())
            .collect();
        assert_eq!(actual, expected);
        for value in &expected {
            let parsed: ObservabilityEventKind =
                serde_json::from_value(Value::String(value.clone())).expect("schema value parses");
            assert_eq!(parsed.as_str(), value);
        }
    }

    #[test]
    fn severity_enum_matches_the_schema() {
        let expected = schema_enum("/properties/severity");
        let actual: Vec<String> = ObservabilitySeverity::ALL
            .iter()
            .map(|severity| severity.as_str().to_string())
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn runtime_enum_matches_the_schema() {
        let mut expected = schema_enum("/$defs/scope/properties/runtime");
        let mut actual: Vec<String> = ObservabilityRuntime::ALL
            .iter()
            .map(|runtime| runtime.as_str().to_string())
            .collect();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
        for value in &expected {
            let parsed: ObservabilityRuntime =
                serde_json::from_value(Value::String(value.clone())).expect("schema value parses");
            assert_eq!(parsed.as_str(), value);
        }
    }

    #[test]
    fn capture_policy_enum_matches_the_schema() {
        let mut expected = schema_enum("/$defs/privacy/properties/capturePolicy");
        let mut actual = vec![
            ObservabilityCapturePolicy::MetadataOnly
                .as_str()
                .to_string(),
            ObservabilityCapturePolicy::DebugSession
                .as_str()
                .to_string(),
        ];
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn required_root_fields_match_the_schema() {
        let schema = schema();
        let expected: Vec<String> = schema["required"]
            .as_array()
            .expect("required list")
            .iter()
            .map(|value| value.as_str().expect("string").to_string())
            .collect();
        // Dropping any required field must fail deserialization.
        let raw = std::fs::read_to_string(fixture_dir().join("log-minimal.json")).expect("fixture");
        for field in expected {
            let mut value: Value = serde_json::from_str(&raw).expect("fixture parses");
            value.as_object_mut().expect("object").remove(&field);
            // `correlation` and `delivery` carry serde defaults on purpose: a
            // producer that emits neither is still a well-formed event and the
            // spool stamps delivery. Everything else must be rejected.
            if matches!(field.as_str(), "correlation" | "delivery") {
                assert!(
                    serde_json::from_value::<ObservabilityEventV1>(value).is_ok(),
                    "`{field}` should default rather than fail"
                );
            } else {
                assert!(
                    serde_json::from_value::<ObservabilityEventV1>(value).is_err(),
                    "missing `{field}` was accepted"
                );
            }
        }
    }

    #[test]
    fn unknown_root_fields_are_rejected() {
        let raw = std::fs::read_to_string(fixture_dir().join("log-minimal.json")).expect("fixture");
        let mut value: Value = serde_json::from_str(&raw).expect("parses");
        value
            .as_object_mut()
            .expect("object")
            .insert("bogus".into(), Value::Bool(true));
        assert!(serde_json::from_value::<ObservabilityEventV1>(value).is_err());
    }

    #[test]
    fn schema_version_other_than_one_is_rejected() {
        let raw = std::fs::read_to_string(fixture_dir().join("log-minimal.json")).expect("fixture");
        let mut value: Value = serde_json::from_str(&raw).expect("parses");
        value.as_object_mut().expect("object")["schemaVersion"] = Value::from(2);
        assert!(serde_json::from_value::<ObservabilityEventV1>(value).is_err());
    }

    #[test]
    fn payload_extras_survive_the_round_trip() {
        let raw = std::fs::read_to_string(fixture_dir().join("metric.json")).expect("fixture");
        let event: ObservabilityEventV1 = serde_json::from_str(&raw).expect("parses");
        assert_eq!(
            event
                .payload
                .extra
                .get("metricValue")
                .and_then(Value::as_i64),
            Some(128)
        );
        let back: Value = serde_json::to_value(&event).expect("serializes");
        assert_eq!(back["payload"]["metricUnit"], Value::from("events"));
    }

    // --- validation --------------------------------------------------------

    fn sample() -> ObservabilityEventV1 {
        let raw = std::fs::read_to_string(fixture_dir().join("log-minimal.json")).expect("fixture");
        serde_json::from_str(&raw).expect("parses")
    }

    #[test]
    fn empty_event_id_is_rejected() {
        let mut event = sample();
        event.event_id.clear();
        assert_eq!(event.validate(), Err(EventError::Empty { path: "eventId" }));
    }

    #[test]
    fn over_long_name_is_rejected() {
        let mut event = sample();
        event.name = "n".repeat(513);
        assert_eq!(
            event.validate(),
            Err(EventError::TooLong {
                path: "name",
                max: 512
            })
        );
    }

    #[test]
    fn over_long_event_id_is_rejected() {
        let mut event = sample();
        event.event_id = "e".repeat(161);
        assert!(matches!(
            event.validate(),
            Err(EventError::TooLong {
                path: "eventId",
                ..
            })
        ));
    }

    #[test]
    fn over_long_code_is_rejected() {
        let mut event = sample();
        event.code = "c".repeat(161);
        assert!(matches!(
            event.validate(),
            Err(EventError::TooLong { path: "code", .. })
        ));
    }

    #[test]
    fn non_rfc3339_timestamp_is_rejected() {
        let mut event = sample();
        event.occurred_at = "2026-08-01 09:15".into();
        assert_eq!(
            event.validate(),
            Err(EventError::Timestamp { path: "occurredAt" })
        );
    }

    #[test]
    fn empty_scope_fields_are_rejected() {
        for (mutate, path) in [
            (
                (|e: &mut ObservabilityEventV1| e.scope.tenant_id.clear()) as fn(&mut _),
                "scope.tenantId",
            ),
            (|e| e.scope.installation_id.clear(), "scope.installationId"),
            (|e| e.scope.process_id.clear(), "scope.processId"),
            (|e| e.scope.module.clear(), "scope.module"),
            (|e| e.scope.build_id.clear(), "scope.buildId"),
            (|e| e.scope.app_version.clear(), "scope.appVersion"),
        ] {
            let mut event = sample();
            mutate(&mut event);
            assert_eq!(event.validate(), Err(EventError::Empty { path }));
        }
    }

    #[test]
    fn empty_optional_scope_fields_are_rejected() {
        let mut event = sample();
        event.scope.plugin_id = Some(String::new());
        assert_eq!(
            event.validate(),
            Err(EventError::Empty {
                path: "scope.pluginId"
            })
        );

        let mut event = sample();
        event.scope.origin = Some(String::new());
        assert_eq!(
            event.validate(),
            Err(EventError::Empty {
                path: "scope.origin"
            })
        );
    }

    #[test]
    fn malformed_traceparent_is_rejected() {
        for candidate in [
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-011",
            "",
        ] {
            let mut event = sample();
            event.correlation.traceparent = Some(candidate.into());
            assert_eq!(
                event.validate(),
                Err(EventError::Traceparent {
                    path: "correlation.traceparent"
                }),
                "`{candidate}` should not validate"
            );
        }
    }

    #[test]
    fn well_formed_traceparent_is_accepted() {
        let mut event = sample();
        event.correlation.traceparent =
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".into());
        assert_eq!(event.validate(), Ok(()));
    }

    #[test]
    fn over_long_tracestate_is_rejected() {
        let mut event = sample();
        event.correlation.tracestate = Some("x".repeat(513));
        assert!(matches!(
            event.validate(),
            Err(EventError::TooLong {
                path: "correlation.tracestate",
                ..
            })
        ));
    }

    #[test]
    fn empty_optional_correlation_ids_are_rejected() {
        let mut event = sample();
        event.correlation.session_id = Some(String::new());
        assert_eq!(
            event.validate(),
            Err(EventError::Empty {
                path: "correlation.sessionId"
            })
        );
    }

    #[test]
    fn duplicate_removed_fields_are_rejected() {
        let mut event = sample();
        event.privacy.removed_fields =
            vec!["payload.data.prompt".into(), "payload.data.prompt".into()];
        assert_eq!(event.validate(), Err(EventError::DuplicateRemovedField));
    }

    #[test]
    fn empty_removed_field_entry_is_rejected() {
        let mut event = sample();
        event.privacy.removed_fields = vec![String::new()];
        assert_eq!(
            event.validate(),
            Err(EventError::Empty {
                path: "privacy.removedFields[]"
            })
        );
    }

    #[test]
    fn empty_redaction_version_is_rejected() {
        let mut event = sample();
        event.privacy.redaction_version.clear();
        assert_eq!(
            event.validate(),
            Err(EventError::Empty {
                path: "privacy.redactionVersion"
            })
        );
    }

    #[test]
    fn negative_duration_is_rejected() {
        let mut event = sample();
        event.payload = event.payload.clone().with_duration_ms(-1.0);
        assert_eq!(
            event.validate(),
            Err(EventError::Negative {
                path: "payload.durationMs"
            })
        );
    }

    #[test]
    fn integral_numbers_keep_their_wire_form() {
        let payload = ObservabilityPayload::message("m")
            .with_attempt(2)
            .with_duration_ms(1250.0);
        let json = serde_json::to_value(&payload).expect("serializes");
        assert_eq!(json["attempt"], Value::from(2));
        // 1250.0 is integral, but it arrived as an f64 and JSON keeps it as a
        // float — producers that need the integer form pass it through
        // `with_attempt`-style integral setters.
        assert_eq!(payload.duration_ms_f64(), Some(1250.0));
    }

    #[test]
    fn non_finite_duration_is_dropped_rather_than_written() {
        let payload = ObservabilityPayload::message("m").with_duration_ms(f64::INFINITY);
        assert_eq!(payload.duration_ms, None);
        let payload = ObservabilityPayload::message("m").with_duration_ms(f64::NAN);
        assert_eq!(payload.duration_ms, None);
    }

    #[test]
    fn ndjson_line_rejects_an_invalid_event() {
        let mut event = sample();
        event.name.clear();
        assert!(event.to_ndjson_line().is_err());
    }

    // --- helpers -----------------------------------------------------------

    #[test]
    fn traceparent_is_built_only_from_valid_non_zero_ids() {
        assert_eq!(
            create_traceparent(
                Some("4bf92f3577b34da6a3ce929d0e0e4736"),
                Some("00f067aa0ba902b7")
            ),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".into())
        );
        assert_eq!(
            create_traceparent(Some("short"), Some("00f067aa0ba902b7")),
            None
        );
        assert_eq!(create_traceparent(None, Some("00f067aa0ba902b7")), None);
        assert_eq!(
            create_traceparent(Some("4bf92f3577b34da6a3ce929d0e0e4736"), None),
            None
        );
        assert_eq!(
            create_traceparent(Some(&"0".repeat(32)), Some("00f067aa0ba902b7")),
            None,
            "an all-zero trace id is not a valid W3C context"
        );
        assert_eq!(
            create_traceparent(
                Some("4bf92f3577b34da6a3ce929d0e0e4736"),
                Some(&"0".repeat(16))
            ),
            None,
            "an all-zero span id is not a valid W3C context"
        );
    }

    #[test]
    fn severity_priority_matches_the_typescript_ladder() {
        assert_eq!(ObservabilitySeverity::Trace.priority(), 0);
        assert_eq!(ObservabilitySeverity::Debug.priority(), 1);
        assert_eq!(ObservabilitySeverity::Info.priority(), 2);
        assert_eq!(ObservabilitySeverity::Warn.priority(), 3);
        assert_eq!(ObservabilitySeverity::Error.priority(), 4);
        assert_eq!(ObservabilitySeverity::Fatal.priority(), 5);
    }

    #[test]
    fn warn_and_above_are_protected() {
        for severity in ObservabilitySeverity::ALL {
            assert_eq!(
                severity.is_protected(),
                severity.priority() >= 3,
                "{severity} protection is wrong"
            );
        }
    }

    #[test]
    fn only_host_runtimes_claim_native_crash_capture() {
        for runtime in ObservabilityRuntime::ALL {
            let expected = matches!(
                runtime,
                ObservabilityRuntime::Tauri
                    | ObservabilityRuntime::CapacitorIos
                    | ObservabilityRuntime::CapacitorAndroid
            );
            assert_eq!(
                runtime.can_report_native_crash(),
                expected,
                "{runtime} native-crash claim is wrong"
            );
        }
    }

    #[test]
    fn builders_produce_a_valid_event() {
        let event = ObservabilityEventV1::new(
            "event-1",
            "2026-08-01T09:15:00Z",
            ObservabilityEventKind::Lifecycle,
            ObservabilitySeverity::Info,
            "recovery.started",
            "recovery.started",
            ObservabilityScope {
                tenant_id: "tenant-local".into(),
                installation_id: "install-1".into(),
                runtime: ObservabilityRuntime::Tauri,
                process_id: "main-1".into(),
                module: "recovery".into(),
                plugin_id: None,
                build_id: "build-1".into(),
                app_version: "0.1.0".into(),
                origin: None,
            },
            ObservabilityPrivacy::metadata_only("privacy-v1-2026-08-01"),
            ObservabilityPayload::message("Recovery started")
                .with_tags(["recovery"])
                .with_stack("at recovery"),
        )
        .with_correlation(ObservabilityCorrelation {
            session_id: Some("session-1".into()),
            ..ObservabilityCorrelation::default()
        })
        .with_delivery(7, 6);

        assert_eq!(event.validate(), Ok(()));
        assert!(!event.is_protected());
        assert_eq!(event.delivery.spool_sequence, 7);
        assert_eq!(event.delivery.flush_watermark, 6);
        assert_eq!(
            event.payload.tags.as_deref(),
            Some(["recovery".to_string()].as_slice())
        );
    }

    #[test]
    fn payload_with_data_is_preserved() {
        let mut data = Map::new();
        data.insert("subsystem".into(), Value::from("plugins"));
        let payload = ObservabilityPayload::message("checkpoint").with_data(data);
        assert_eq!(
            payload.data.as_ref().and_then(|d| d.get("subsystem")),
            Some(&Value::from("plugins"))
        );
    }

    #[test]
    fn metadata_only_privacy_captures_nothing() {
        let privacy = ObservabilityPrivacy::metadata_only("privacy-v1");
        assert!(!privacy.content_captured);
        assert_eq!(
            privacy.capture_policy,
            ObservabilityCapturePolicy::MetadataOnly
        );
        assert!(privacy.removed_fields.is_empty());
    }

    #[test]
    fn kind_and_severity_display_as_wire_values() {
        assert_eq!(ObservabilityEventKind::Crash.to_string(), "crash");
        assert_eq!(ObservabilitySeverity::Fatal.to_string(), "fatal");
        assert_eq!(
            ObservabilityRuntime::CapacitorIos.to_string(),
            "capacitor-ios"
        );
    }
}
