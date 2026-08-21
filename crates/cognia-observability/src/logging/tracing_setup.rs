//! Structured tracing subscriber.
//!
//! Installs a `tracing` subscriber *alongside* `tauri-plugin-log`. The plugin
//! remains the sole owner of the global `log` logger — we deliberately do **not**
//! call `LogTracer::init` (only one global `log` logger may exist). New Rust code
//! emits structured `tracing` events that are written as JSON to
//! `cognia-structured.log`, gated by a runtime-mutable per-target level filter
//! whose semantics mirror the frontend's `perModuleLevels` (longest-prefix wins).
//!
//! The level map lives behind a `Lazy<Mutex<...>>` (the same pattern as
//! `platform::PLATFORM_LOGGING_STATE`). Changing levels rebuilds the tracing
//! callsite interest cache so the new thresholds take effect immediately.

use std::fs::{create_dir_all, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tracing::{Level, Metadata};
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Layer;

#[cfg(feature = "otel-export")]
use opentelemetry_sdk::trace::SdkTracer;
#[cfg(feature = "otel-export")]
use tracing_subscriber::registry::Registry;
#[cfg(feature = "otel-export")]
use tracing_subscriber::reload;

use crate::logging::native_bootstrap;

const STRUCTURED_LOG_FILE: &str = "cognia-structured.log";

/// A single per-target level rule. `target` is matched as a hierarchy prefix
/// (segments split on `:` / `::`), `level` is one of trace/debug/info/warn/error
/// (the frontend's `fatal` maps to `error`).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetLevel {
    pub target: String,
    pub level: String,
}

/// Status payload returned to the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TracingLevelsStatus {
    /// Whether the structured tracing subscriber was successfully installed.
    pub active: bool,
    /// Global default level (applies when no per-target rule matches).
    pub default_level: String,
    /// Active per-target rules.
    pub rules: Vec<TargetLevel>,
}

struct TracingState {
    default_level: Level,
    /// (prefix, level) rules; resolution picks the longest matching prefix.
    rules: Vec<(String, Level)>,
}

static TRACING_STATE: Lazy<Mutex<TracingState>> = Lazy::new(|| {
    Mutex::new(TracingState {
        default_level: Level::INFO,
        rules: Vec::new(),
    })
});

static INSTALLED: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "otel-export")]
type OtelLayer = tracing_opentelemetry::OpenTelemetryLayer<Registry, SdkTracer>;
#[cfg(feature = "otel-export")]
type OtelReloadHandle = reload::Handle<Option<OtelLayer>, Registry>;
#[cfg(feature = "otel-export")]
static OTEL_RELOAD_HANDLE: Lazy<Mutex<Option<OtelReloadHandle>>> = Lazy::new(|| Mutex::new(None));

#[cfg(feature = "otel-export")]
pub fn configure_otel_tracer(tracer: Option<SdkTracer>) -> Result<(), String> {
    let mut handle = OTEL_RELOAD_HANDLE
        .lock()
        .map_err(|_| "native OTLP reload handle lock poisoned".to_string())?;
    let handle = handle
        .as_mut()
        .ok_or_else(|| "structured tracing subscriber is not initialized".to_string())?;
    handle
        .reload(tracer.map(|tracer| tracing_opentelemetry::layer().with_tracer(tracer)))
        .map_err(|error| format!("native OTLP layer reload failed: {error}"))
}

/// Parse a level name into a `tracing::Level`. Unknown values fall back to
/// `INFO`; the frontend's `fatal` collapses to `error` (tracing has 5 levels).
fn parse_level(name: &str) -> Level {
    match name.trim().to_ascii_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "warn" | "warning" => Level::WARN,
        "error" | "fatal" => Level::ERROR,
        _ => Level::INFO,
    }
}

fn level_name(level: &Level) -> &'static str {
    match *level {
        Level::TRACE => "trace",
        Level::DEBUG => "debug",
        Level::INFO => "info",
        Level::WARN => "warn",
        Level::ERROR => "error",
    }
}

/// Resolve the effective level for `target` from the current rules using
/// longest-prefix matching, falling back to the default level.
fn resolve_level(state: &TracingState, target: &str) -> Level {
    let mut effective = state.default_level;
    let mut best_len = 0usize;
    for (prefix, level) in &state.rules {
        let matches = target == prefix
            || target.starts_with(&format!("{prefix}::"))
            || target.starts_with(&format!("{prefix}:"));
        if matches && prefix.len() > best_len {
            best_len = prefix.len();
            effective = *level;
        }
    }
    effective
}

/// Per-event filter decision. tracing orders levels so that
/// `TRACE > DEBUG > INFO > WARN > ERROR`; an event is shown when its level is at
/// least as severe as the effective threshold (`event_level <= threshold`).
fn event_enabled(meta: &Metadata<'_>) -> bool {
    let Ok(state) = TRACING_STATE.lock() else {
        return true;
    };
    let threshold = resolve_level(&state, meta.target());
    meta.level() <= &threshold
}

#[derive(Clone)]
struct SharedFileWriter(Arc<Mutex<std::fs::File>>);

impl Write for SharedFileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.0.lock() {
            Ok(mut file) => file.write(buf),
            // A poisoned lock must not crash the logging path; drop the line.
            Err(_) => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.0.lock() {
            Ok(mut file) => file.flush(),
            Err(_) => Ok(()),
        }
    }
}

impl<'a> MakeWriter<'a> for SharedFileWriter {
    type Writer = SharedFileWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn structured_log_path() -> Option<PathBuf> {
    let dir = native_bootstrap::log_dir()?;
    if create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join(STRUCTURED_LOG_FILE))
}

/// Install the structured tracing subscriber. Idempotent and safe to call once
/// at startup. Returns `false` (without erroring) when the log file can't be
/// opened or a global subscriber is already set.
pub fn init() -> bool {
    if INSTALLED.load(Ordering::SeqCst) {
        return true;
    }

    let Some(path) = structured_log_path() else {
        return false;
    };
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => file,
        Err(_) => return false,
    };

    let writer = SharedFileWriter(Arc::new(Mutex::new(file)));

    #[cfg(feature = "otel-export")]
    let installed = {
        let file_layer = tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_writer(writer.clone())
            .with_filter(filter_fn(event_enabled));
        let (otel_layer, otel_handle) = reload::Layer::new(None::<OtelLayer>);
        let subscriber = tracing_subscriber::registry()
            .with(otel_layer)
            .with(file_layer);
        let installed = tracing::subscriber::set_global_default(subscriber).is_ok();
        if installed {
            if let Ok(mut handle) = OTEL_RELOAD_HANDLE.lock() {
                *handle = Some(otel_handle);
            }
            match crate::telemetry::init_tracer() {
                Ok(tracer) => {
                    if let Err(error) = configure_otel_tracer(Some(tracer)) {
                        log::warn!("native OTLP exporter disabled: {error}");
                    }
                }
                Err(error) => log::warn!("native OTLP exporter disabled: {error}"),
            }
        }
        installed
    };
    #[cfg(not(feature = "otel-export"))]
    let installed = {
        let file_layer = tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_writer(writer)
            .with_filter(filter_fn(event_enabled));
        let subscriber = tracing_subscriber::registry().with(file_layer);
        tracing::subscriber::set_global_default(subscriber).is_ok()
    };
    if !installed {
        return false;
    }

    INSTALLED.store(true, Ordering::SeqCst);
    tracing::info!(target: "logging", "structured tracing subscriber installed");
    true
}

/// Current per-target level configuration.
pub fn get_levels() -> TracingLevelsStatus {
    let state = TRACING_STATE.lock().expect("tracing state lock");
    TracingLevelsStatus {
        active: INSTALLED.load(Ordering::SeqCst),
        default_level: level_name(&state.default_level).to_string(),
        rules: state
            .rules
            .iter()
            .map(|(target, level)| TargetLevel {
                target: target.clone(),
                level: level_name(level).to_string(),
            })
            .collect(),
    }
}

/// Replace the per-target level rules (and optionally the global default), then
/// rebuild the tracing interest cache so the change takes effect immediately.
pub fn set_levels(rules: Vec<TargetLevel>, default_level: Option<String>) -> TracingLevelsStatus {
    if let Ok(mut state) = TRACING_STATE.lock() {
        if let Some(default_level) = default_level {
            state.default_level = parse_level(&default_level);
        }
        state.rules = rules
            .into_iter()
            .filter(|rule| !rule.target.trim().is_empty())
            .map(|rule| (rule.target.trim().to_string(), parse_level(&rule.level)))
            .collect();
    }
    // Force callsites to re-evaluate their interest against the new thresholds.
    tracing::callsite::rebuild_interest_cache();
    get_levels()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(default: Level, rules: &[(&str, Level)]) -> TracingState {
        TracingState {
            default_level: default,
            rules: rules.iter().map(|(t, l)| (t.to_string(), *l)).collect(),
        }
    }

    #[test]
    fn resolve_falls_back_to_default_without_rules() {
        let st = state(Level::INFO, &[]);
        assert_eq!(resolve_level(&st, "network"), Level::INFO);
    }

    #[test]
    fn resolve_honors_exact_and_prefix_matches() {
        let st = state(Level::INFO, &[("network", Level::DEBUG)]);
        assert_eq!(resolve_level(&st, "network"), Level::DEBUG);
        assert_eq!(resolve_level(&st, "network::lark"), Level::DEBUG);
        assert_eq!(resolve_level(&st, "network:lark"), Level::DEBUG);
    }

    #[test]
    fn resolve_prefers_longest_prefix() {
        let st = state(
            Level::INFO,
            &[("network", Level::DEBUG), ("network::lark", Level::TRACE)],
        );
        assert_eq!(resolve_level(&st, "network::lark::ws"), Level::TRACE);
        assert_eq!(resolve_level(&st, "network::slack"), Level::DEBUG);
    }

    #[test]
    fn resolve_ignores_sibling_targets() {
        let st = state(Level::INFO, &[("net", Level::TRACE)]);
        assert_eq!(resolve_level(&st, "network"), Level::INFO);
    }

    #[test]
    fn event_enabled_respects_threshold_ordering() {
        let st = state(Level::INFO, &[]);
        // INFO threshold: WARN/ERROR/INFO shown, DEBUG/TRACE hidden.
        assert!(Level::WARN <= st.default_level);
        assert!(Level::INFO <= st.default_level);
        assert!(Level::DEBUG > st.default_level);
        assert!(Level::TRACE > st.default_level);
    }

    #[test]
    fn parse_level_maps_fatal_to_error_and_unknown_to_info() {
        assert_eq!(parse_level("fatal"), Level::ERROR);
        assert_eq!(parse_level("ERROR"), Level::ERROR);
        assert_eq!(parse_level("trace"), Level::TRACE);
        assert_eq!(parse_level("nonsense"), Level::INFO);
    }
}
