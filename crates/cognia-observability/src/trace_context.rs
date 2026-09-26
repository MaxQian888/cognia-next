//! W3C trace-context propagation for inbound requests (ADR-0196 E3b).
//!
//! The companion's remote-execution path accepts a `traceparent` from its
//! callers and parents its span on it. That needs neither Tauri nor the
//! desktop logging host, so it sits behind `tracing-host` (which
//! `desktop-host` implies) and the companion core and `cognia-server` can link
//! it alone. `telemetry` re-exports both functions at their old path.

/// A W3C `traceparent` header, lowercased, when it is well formed: version
/// `00`, a non-zero 32-hex trace id and 16-hex parent id, and 2-hex flags.
pub fn validate_traceparent(value: &str) -> Option<String> {
    let value = value.trim();
    let mut parts = value.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let parent_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some()
        || version != "00"
        || trace_id.len() != 32
        || parent_id.len() != 16
        || flags.len() != 2
        || ![version, trace_id, parent_id, flags]
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
        || trace_id.bytes().all(|byte| byte == b'0')
        || parent_id.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

/// Parent `span` on the caller's `traceparent`, when OTLP export is compiled
/// in and a propagator is installed. Without `otel-export` there is no
/// OpenTelemetry context to join, and this does nothing.
#[cfg(feature = "otel-export")]
pub fn set_parent(span: &tracing::Span, traceparent: Option<&str>) {
    use opentelemetry::global;
    use tracing_opentelemetry::OpenTelemetrySpanExt;

    let Some(traceparent) = traceparent.filter(|value| !value.is_empty()) else {
        return;
    };
    let carrier =
        std::collections::HashMap::from([("traceparent".to_string(), traceparent.to_string())]);
    let parent = global::get_text_map_propagator(|propagator| propagator.extract(&carrier));
    let _ = span.set_parent(parent);
}

/// Parent `span` on the caller's `traceparent`: a no-op without `otel-export`.
#[cfg(not(feature = "otel-export"))]
pub fn set_parent(_span: &tracing::Span, _traceparent: Option<&str>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_traceparent_is_normalized_to_lowercase() {
        assert_eq!(
            validate_traceparent(" 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01 ")
                .as_deref(),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        );
    }

    #[test]
    fn malformed_or_all_zero_ids_are_refused() {
        for value in [
            "",
            "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-ff",
            "00-4bf92f3577b34da6a3ce929d0e0e473z-00f067aa0ba902b7-01",
        ] {
            assert_eq!(validate_traceparent(value), None, "{value:?}");
        }
    }

    #[test]
    fn setting_a_parent_without_a_traceparent_is_harmless() {
        let span = tracing::info_span!("trace_context_test");
        set_parent(&span, None);
        set_parent(&span, Some(""));
    }
}
