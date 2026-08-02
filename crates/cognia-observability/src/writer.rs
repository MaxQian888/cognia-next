//! The native V1 producer (ADR-0102 §3).
//!
//! Every Rust-side writer — Tauri logging and crash capture, the CLI/TUI, the
//! headless server, the diagnostic-service workers — goes through this type
//! rather than hand-building an envelope. Two properties are why it exists:
//!
//! 1. **Scope is host-injected and immutable.** Tenant, installation, runtime,
//!    process, build and app version are fixed at construction. A caller can
//!    name its module; it cannot claim to be a different runtime or tenant.
//!    This is the same rule the plugin host enforces, applied to ourselves.
//! 2. **The privacy gate is not optional.** `write` redacts before it spools.
//!    There is no code path from a caller's payload to the disk that skips it,
//!    so "this producer forgot to redact" is not a bug that can be written.

use std::sync::Mutex;

use crate::event::{
    ObservabilityCorrelation, ObservabilityEventKind, ObservabilityEventV1, ObservabilityPayload,
    ObservabilityPrivacy, ObservabilityRuntime, ObservabilityScope, ObservabilitySeverity,
};
use crate::privacy::{
    apply_observability_privacy, LocalDebugCaptureSession, PrivacyApplicationOptions,
    CLIENT_PRIVACY_MANIFEST_V1,
};
use crate::spool::{FileSpool, SpoolEnqueueResult, SpoolError, SpoolStats};

/// The immutable half of a producer's identity. Everything here is supplied by
/// the host at construction and cannot be overridden per event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriterIdentity {
    pub tenant_id: String,
    pub installation_id: String,
    pub runtime: ObservabilityRuntime,
    pub process_id: String,
    pub build_id: String,
    pub app_version: String,
    /// Optional provenance hint (`tauri`, `diagnostic`, …). Still host-supplied.
    pub origin: Option<String>,
}

/// What a caller may vary from event to event.
#[derive(Debug, Clone, Default)]
pub struct EventRequest {
    pub module: String,
    pub name: String,
    pub code: String,
    pub correlation: ObservabilityCorrelation,
    pub payload: ObservabilityPayload,
    /// Set only by the plugin host, which knows which plugin it is running.
    /// A plugin cannot set this for itself.
    pub plugin_id: Option<String>,
}

impl EventRequest {
    pub fn new(
        module: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        let code = code.into();
        let message = message.into();
        Self {
            module: module.into(),
            name: code.clone(),
            code,
            correlation: ObservabilityCorrelation::default(),
            payload: ObservabilityPayload::message(message),
            plugin_id: None,
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    pub fn with_payload(mut self, payload: ObservabilityPayload) -> Self {
        self.payload = payload;
        self
    }

    pub fn with_correlation(mut self, correlation: ObservabilityCorrelation) -> Self {
        self.correlation = correlation;
        self
    }
}

/// Injectable clock + id source so tests are deterministic and the writer is
/// usable from a crash handler, where allocating a UUID from the system RNG is
/// acceptable but wall-clock skew is not something to paper over.
pub struct WriterClock {
    pub now: Box<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>,
    pub next_id: Box<dyn Fn() -> String + Send + Sync>,
}

impl Default for WriterClock {
    fn default() -> Self {
        Self {
            now: Box::new(chrono::Utc::now),
            next_id: Box::new(|| uuid::Uuid::new_v4().to_string()),
        }
    }
}

impl std::fmt::Debug for WriterClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WriterClock { .. }")
    }
}

/// Result of one write.
#[derive(Debug, Clone, PartialEq)]
pub struct WriteOutcome {
    pub event: ObservabilityEventV1,
    pub result: SpoolEnqueueResult,
}

impl WriteOutcome {
    pub fn stats(&self) -> SpoolStats {
        self.result.stats()
    }

    pub fn is_stored(&self) -> bool {
        self.result.is_stored()
    }
}

/// The native V1 producer.
#[derive(Debug)]
pub struct ObservabilityWriter {
    identity: WriterIdentity,
    spool: Mutex<FileSpool>,
    debug_session: Mutex<Option<LocalDebugCaptureSession>>,
    clock: WriterClock,
}

impl ObservabilityWriter {
    pub fn new(identity: WriterIdentity, spool: FileSpool) -> Self {
        Self {
            identity,
            spool: Mutex::new(spool),
            debug_session: Mutex::new(None),
            clock: WriterClock::default(),
        }
    }

    pub fn with_clock(mut self, clock: WriterClock) -> Self {
        self.clock = clock;
        self
    }

    pub fn identity(&self) -> &WriterIdentity {
        &self.identity
    }

    /// Start a local, 30-minute content-capture session. Local only — this
    /// never authorizes remote content upload, and the flag is not persisted,
    /// so a restart ends it.
    pub fn begin_debug_session(&self) -> LocalDebugCaptureSession {
        let now = (self.clock.now)();
        let session =
            crate::privacy::create_local_debug_capture_session((self.clock.next_id)(), now);
        if let Ok(mut slot) = self.debug_session.lock() {
            *slot = Some(session.clone());
        }
        session
    }

    pub fn end_debug_session(&self) {
        if let Ok(mut slot) = self.debug_session.lock() {
            *slot = None;
        }
    }

    fn scope(&self, module: &str, plugin_id: Option<String>) -> ObservabilityScope {
        ObservabilityScope {
            tenant_id: self.identity.tenant_id.clone(),
            installation_id: self.identity.installation_id.clone(),
            runtime: self.identity.runtime,
            process_id: self.identity.process_id.clone(),
            // An empty module would fail validation; fall back to the runtime
            // name rather than rejecting a log line for a cosmetic reason.
            module: if module.is_empty() {
                self.identity.runtime.as_str().to_string()
            } else {
                module.to_string()
            },
            plugin_id,
            build_id: self.identity.build_id.clone(),
            app_version: self.identity.app_version.clone(),
            origin: self.identity.origin.clone(),
        }
    }

    /// Build a redacted, validated event without spooling it. Used by the
    /// crash path, which assembles an event before it has a usable spool.
    pub fn build(
        &self,
        kind: ObservabilityEventKind,
        severity: ObservabilitySeverity,
        request: EventRequest,
    ) -> ObservabilityEventV1 {
        let now = (self.clock.now)();
        let event = ObservabilityEventV1::new(
            (self.clock.next_id)(),
            now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            kind,
            severity,
            if request.name.is_empty() {
                request.code.clone()
            } else {
                request.name.clone()
            },
            request.code.clone(),
            self.scope(&request.module, request.plugin_id.clone()),
            ObservabilityPrivacy::metadata_only(CLIENT_PRIVACY_MANIFEST_V1.version),
            request.payload.clone(),
        )
        .with_correlation(request.correlation.clone());

        let session = self.debug_session.lock().ok().and_then(|slot| slot.clone());
        apply_observability_privacy(
            &event,
            &PrivacyApplicationOptions {
                manifest: None,
                debug_session: session.as_ref(),
            },
            now,
        )
    }

    /// Redact, validate and spool one event.
    pub fn write(
        &self,
        kind: ObservabilityEventKind,
        severity: ObservabilitySeverity,
        request: EventRequest,
    ) -> Result<WriteOutcome, SpoolError> {
        let event = self.build(kind, severity, request);
        let mut spool = self
            .spool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = spool.enqueue(&event)?;
        let event = match &result {
            SpoolEnqueueResult::Stored { record, .. } => record.event.clone(),
            SpoolEnqueueResult::CapacityExhausted { .. } => event,
        };
        Ok(WriteOutcome { event, result })
    }

    pub fn log(
        &self,
        severity: ObservabilitySeverity,
        request: EventRequest,
    ) -> Result<WriteOutcome, SpoolError> {
        self.write(ObservabilityEventKind::Log, severity, request)
    }

    pub fn lifecycle(
        &self,
        severity: ObservabilitySeverity,
        request: EventRequest,
    ) -> Result<WriteOutcome, SpoolError> {
        self.write(ObservabilityEventKind::Lifecycle, severity, request)
    }

    pub fn metric(&self, request: EventRequest) -> Result<WriteOutcome, SpoolError> {
        self.write(
            ObservabilityEventKind::Metric,
            ObservabilitySeverity::Trace,
            request,
        )
    }

    pub fn span(&self, request: EventRequest) -> Result<WriteOutcome, SpoolError> {
        self.write(
            ObservabilityEventKind::Span,
            ObservabilitySeverity::Debug,
            request,
        )
    }

    /// Record a crash. Always `fatal`, always synchronously durable — the next
    /// instruction may be the one that ends the process.
    pub fn crash(&self, request: EventRequest) -> Result<WriteOutcome, SpoolError> {
        self.write(
            ObservabilityEventKind::Crash,
            ObservabilitySeverity::Fatal,
            request,
        )
    }

    pub fn stats(&self) -> SpoolStats {
        self.spool
            .lock()
            .map(|spool| spool.stats())
            .unwrap_or_else(|poisoned| poisoned.into_inner().stats())
    }

    /// Run `operation` against the underlying spool (read a batch, ack, drain).
    pub fn with_spool<T>(&self, operation: impl FnOnce(&mut FileSpool) -> T) -> T {
        let mut spool = self
            .spool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut spool)
    }

    pub fn close(&self) -> Result<(), SpoolError> {
        self.with_spool(|spool| spool.close())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spool::SpoolLimits;
    use serde_json::{Map, Value};
    use tempfile::TempDir;

    fn identity(runtime: ObservabilityRuntime) -> WriterIdentity {
        WriterIdentity {
            tenant_id: "tenant-local".into(),
            installation_id: "install-1".into(),
            runtime,
            process_id: "proc-1".into(),
            build_id: "build-2026-08-01-01".into(),
            app_version: "0.1.0".into(),
            origin: Some("tauri".into()),
        }
    }

    fn fixed_clock() -> WriterClock {
        let counter = std::sync::atomic::AtomicU64::new(0);
        WriterClock {
            now: Box::new(|| {
                chrono::DateTime::parse_from_rfc3339("2026-08-01T09:15:00Z")
                    .expect("timestamp")
                    .with_timezone(&chrono::Utc)
            }),
            next_id: Box::new(move || {
                let next = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                format!("event-{next}")
            }),
        }
    }

    fn writer(dir: &TempDir, runtime: ObservabilityRuntime) -> ObservabilityWriter {
        let spool = FileSpool::open(
            dir.path(),
            SpoolLimits {
                max_events: 100,
                max_bytes: 1024 * 1024,
            },
        )
        .expect("spool opens");
        ObservabilityWriter::new(identity(runtime), spool).with_clock(fixed_clock())
    }

    #[test]
    fn a_written_event_is_schema_valid_and_carries_host_scope() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Tauri);
        let outcome = writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("crash", "log.crash.ready", "Crash monitor ready"),
            )
            .expect("write");

        assert!(outcome.is_stored());
        let event = &outcome.event;
        assert_eq!(event.validate(), Ok(()));
        assert_eq!(event.scope.tenant_id, "tenant-local");
        assert_eq!(event.scope.runtime, ObservabilityRuntime::Tauri);
        assert_eq!(event.scope.process_id, "proc-1");
        assert_eq!(event.scope.build_id, "build-2026-08-01-01");
        assert_eq!(event.scope.module, "crash");
        assert_eq!(event.delivery.spool_sequence, 1);
    }

    #[test]
    fn the_privacy_gate_runs_on_every_write() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Cli);
        let mut data = Map::new();
        data.insert("prompt".into(), Value::from("do the thing"));
        data.insert("apiKey".into(), Value::from("abcdef0123456789"));

        let outcome = writer
            .log(
                ObservabilitySeverity::Warn,
                EventRequest::new("cli", "log.cli.request", "Request prepared").with_payload(
                    ObservabilityPayload::message("Request prepared").with_data(data),
                ),
            )
            .expect("write");

        let data = outcome.event.payload.data.as_ref().expect("data survives");
        assert!(!data.contains_key("prompt"), "content key must be removed");
        assert_eq!(data.get("apiKey"), Some(&Value::from("[REDACTED]")));
        assert_eq!(
            outcome.event.privacy.removed_fields,
            vec!["payload.data.prompt"]
        );
        assert_eq!(
            outcome.event.privacy.redaction_version,
            CLIENT_PRIVACY_MANIFEST_V1.version
        );
    }

    #[test]
    fn a_caller_cannot_override_host_injected_scope() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Sidecar);
        // The request type has no tenant/runtime/build fields at all, so the
        // only way a caller could forge scope is by smuggling it in the
        // payload — where it stays payload data and never becomes scope.
        let mut data = Map::new();
        data.insert("tenantId".into(), Value::from("tenant-evil"));
        let outcome = writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("sidecar", "log.sidecar", "hi")
                    .with_payload(ObservabilityPayload::message("hi").with_data(data)),
            )
            .expect("write");

        assert_eq!(outcome.event.scope.tenant_id, "tenant-local");
        assert_eq!(outcome.event.scope.runtime, ObservabilityRuntime::Sidecar);
    }

    #[test]
    fn only_the_host_can_attach_a_plugin_id() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Plugin);
        let mut request = EventRequest::new("plugin", "log.plugin", "hello");
        request.plugin_id = Some("web-tools".into());
        let outcome = writer
            .log(ObservabilitySeverity::Info, request)
            .expect("write");
        assert_eq!(outcome.event.scope.plugin_id.as_deref(), Some("web-tools"));

        let plain = writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("plugin", "log.plugin", "hello"),
            )
            .expect("write");
        assert_eq!(plain.event.scope.plugin_id, None);
    }

    #[test]
    fn an_empty_module_falls_back_to_the_runtime_name() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Cli);
        let outcome = writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("", "log.anon", "anonymous"),
            )
            .expect("write");
        assert_eq!(outcome.event.scope.module, "cli");
        assert_eq!(outcome.event.validate(), Ok(()));
    }

    #[test]
    fn name_defaults_to_the_code_when_omitted() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Cli);
        let mut request = EventRequest::new("cli", "log.cli.thing", "message");
        request.name.clear();
        let outcome = writer
            .log(ObservabilitySeverity::Info, request)
            .expect("write");
        assert_eq!(outcome.event.name, "log.cli.thing");
    }

    #[test]
    fn each_event_kind_has_a_helper_that_sets_the_right_discriminator() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Tauri);
        let request = || EventRequest::new("m", "c", "message");

        assert_eq!(
            writer
                .log(ObservabilitySeverity::Info, request())
                .expect("log")
                .event
                .kind,
            ObservabilityEventKind::Log
        );
        assert_eq!(
            writer
                .lifecycle(ObservabilitySeverity::Info, request())
                .expect("lifecycle")
                .event
                .kind,
            ObservabilityEventKind::Lifecycle
        );
        assert_eq!(
            writer.metric(request()).expect("metric").event.kind,
            ObservabilityEventKind::Metric
        );
        assert_eq!(
            writer.span(request()).expect("span").event.kind,
            ObservabilityEventKind::Span
        );

        let crash = writer.crash(request()).expect("crash");
        assert_eq!(crash.event.kind, ObservabilityEventKind::Crash);
        assert_eq!(crash.event.severity, ObservabilitySeverity::Fatal);
    }

    #[test]
    fn a_debug_session_widens_capture_only_while_it_is_open() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Tauri);
        let mut data = Map::new();
        data.insert("prompt".into(), Value::from("keep me"));
        let request = || {
            EventRequest::new("m", "c", "message").with_payload(
                ObservabilityPayload::message("message").with_data({
                    let mut copy = Map::new();
                    copy.insert("prompt".into(), Value::from("keep me"));
                    copy
                }),
            )
        };
        let _ = data;

        let before = writer
            .log(ObservabilitySeverity::Info, request())
            .expect("write");
        assert!(!before.event.privacy.content_captured);

        let session = writer.begin_debug_session();
        assert!(!session.remote_allowed, "never authorizes remote upload");
        let during = writer
            .log(ObservabilitySeverity::Info, request())
            .expect("write");
        assert!(during.event.privacy.content_captured);
        assert!(during
            .event
            .payload
            .data
            .as_ref()
            .expect("data")
            .contains_key("prompt"));

        writer.end_debug_session();
        let after = writer
            .log(ObservabilitySeverity::Info, request())
            .expect("write");
        assert!(!after.event.privacy.content_captured);
    }

    #[test]
    fn writes_land_in_the_spool_and_survive_a_reopen() {
        let dir = TempDir::new().expect("tempdir");
        {
            let writer = writer(&dir, ObservabilityRuntime::Tauri);
            writer
                .log(
                    ObservabilitySeverity::Error,
                    EventRequest::new("m", "c", "durable"),
                )
                .expect("write");
            writer.close().expect("close");
        }
        let reopened = FileSpool::open(dir.path(), SpoolLimits::default()).expect("reopen");
        assert_eq!(reopened.stats().event_count, 1);
        assert_eq!(reopened.list(0, 1)[0].event.payload.message, "durable");
    }

    #[test]
    fn stats_are_readable_through_the_writer() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Cli);
        writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("m", "c", "a"),
            )
            .expect("write");
        assert_eq!(writer.stats().event_count, 1);
        assert_eq!(writer.stats().last_sequence, 1);
    }

    #[test]
    fn with_spool_exposes_read_and_ack() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Cli);
        for index in 0..3 {
            writer
                .log(
                    ObservabilitySeverity::Info,
                    EventRequest::new("m", "c", format!("m{index}")),
                )
                .expect("write");
        }
        let records = writer.with_spool(|spool| spool.list(0, 10));
        assert_eq!(records.len(), 3);
        writer
            .with_spool(|spool| spool.ack_through(3))
            .expect("ack");
        assert_eq!(writer.stats().event_count, 0);
    }

    #[test]
    fn build_produces_a_redacted_event_without_spooling_it() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Tauri);
        let mut data = Map::new();
        data.insert("toolOutput".into(), Value::from("content"));
        let event = writer.build(
            ObservabilityEventKind::Crash,
            ObservabilitySeverity::Fatal,
            EventRequest::new("crash", "crash.native.panic", "panic")
                .with_payload(ObservabilityPayload::message("panic").with_data(data)),
        );
        assert_eq!(event.validate(), Ok(()));
        assert_eq!(
            event.privacy.removed_fields,
            vec!["payload.data.toolOutput"]
        );
        assert_eq!(writer.stats().event_count, 0, "build must not spool");
    }

    #[test]
    fn correlation_passes_through_untouched() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Tauri);
        let correlation = ObservabilityCorrelation {
            traceparent: Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".into()),
            trace_id: Some("4bf92f3577b34da6a3ce929d0e0e4736".into()),
            span_id: Some("00f067aa0ba902b7".into()),
            session_id: Some("session-1".into()),
            ..ObservabilityCorrelation::default()
        };
        let outcome = writer
            .log(
                ObservabilitySeverity::Info,
                EventRequest::new("m", "c", "message").with_correlation(correlation.clone()),
            )
            .expect("write");
        assert_eq!(outcome.event.correlation, correlation);
        assert_eq!(outcome.event.validate(), Ok(()));
    }

    #[test]
    fn capacity_exhaustion_is_surfaced_rather_than_swallowed() {
        let dir = TempDir::new().expect("tempdir");
        let spool = FileSpool::open(
            dir.path(),
            SpoolLimits {
                max_events: 1,
                max_bytes: 1024 * 1024,
            },
        )
        .expect("spool");
        let writer = ObservabilityWriter::new(identity(ObservabilityRuntime::Cli), spool)
            .with_clock(fixed_clock());
        writer
            .log(
                ObservabilitySeverity::Error,
                EventRequest::new("m", "c", "first"),
            )
            .expect("write");
        let second = writer
            .log(
                ObservabilitySeverity::Error,
                EventRequest::new("m", "c", "second"),
            )
            .expect("write");
        assert!(!second.is_stored());
        assert_eq!(second.stats().rejected_protected_events, 1);
    }

    #[test]
    fn identity_is_readable_but_not_mutable_through_the_writer() {
        let dir = TempDir::new().expect("tempdir");
        let writer = writer(&dir, ObservabilityRuntime::Companion);
        assert_eq!(writer.identity().runtime, ObservabilityRuntime::Companion);
        assert_eq!(writer.identity().build_id, "build-2026-08-01-01");
    }
}
