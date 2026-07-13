//! `cognia:plugin/logger` host import.

use super::super::store::HostState;
use log::Level;

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

/// Pipe a guest log call into the host's `log` crate. Always allowed (no
/// capability required) — every plugin can produce diagnostic output.
pub fn log(state: &HostState, level: WasmLogLevel, scope: &str, message: &str) {
    let pid = &state.plugin_id;
    let level = level.as_log_level();
    log::log!(level, "[plugin:{pid}:{scope}] {message}");
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
}
