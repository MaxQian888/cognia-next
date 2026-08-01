//! `cognia:plugin/logger` host import.

use super::super::store::HostState;
use log::Level;

const MAX_SCOPE_CHARS: usize = 64;
const MAX_MESSAGE_CHARS: usize = 4_096;

#[derive(Debug, Clone, Copy)]
pub enum WasmLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl WasmLogLevel {
    pub fn as_log_level(self) -> Level {
        match self {
            Self::Trace => Level::Trace,
            Self::Debug => Level::Debug,
            Self::Info => Level::Info,
            Self::Warn => Level::Warn,
            Self::Error => Level::Error,
        }
    }
}

/// Pipe a guest log call into the host's structured tracing pipeline. Always
/// allowed (no capability required), but the host injects plugin identity,
/// bounds guest-controlled fields, and owns the only transport.
pub fn log(state: &HostState, level: WasmLogLevel, scope: &str, message: &str) {
    let scope = normalize_field(scope, MAX_SCOPE_CHARS);
    let message = normalize_field(message, MAX_MESSAGE_CHARS);
    let plugin_id = state.plugin_id.as_str();
    match level {
        WasmLogLevel::Trace => {
            tracing::trace!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Debug => {
            tracing::debug!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Info => {
            tracing::info!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Warn => {
            tracing::warn!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Error => {
            tracing::error!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
    }
}

fn normalize_field(value: &str, max_chars: usize) -> String {
    let mut normalized = String::with_capacity(value.len().min(max_chars));
    for character in value.chars().take(max_chars) {
        normalized.push(if matches!(character, '\r' | '\n' | '\0') {
            ' '
        } else {
            character
        });
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_levels_map_to_log_crate_levels() {
        assert_eq!(WasmLogLevel::Trace.as_log_level(), Level::Trace);
        assert_eq!(WasmLogLevel::Debug.as_log_level(), Level::Debug);
        assert_eq!(WasmLogLevel::Info.as_log_level(), Level::Info);
        assert_eq!(WasmLogLevel::Warn.as_log_level(), Level::Warn);
        assert_eq!(WasmLogLevel::Error.as_log_level(), Level::Error);
    }

    #[test]
    fn guest_fields_are_single_line_and_bounded_by_characters() {
        assert_eq!(normalize_field("a\r\nb\0c", 10), "a  b c");
        assert_eq!(normalize_field("日志事件", 2), "日志");
        assert_eq!(normalize_field(&"x".repeat(100), 64).len(), 64);
    }
}
