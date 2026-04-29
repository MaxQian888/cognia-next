use super::{
    append_structured_payload, sanitize_target, PlatformLogLevel, PlatformLogger,
    PlatformLoggerProbe,
};
use oslog::{Level, OsLog};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const SUBSYSTEM: &str = "com.cognia.app";

pub(crate) struct MacOsPlatformLogger {
    logs: Mutex<HashMap<String, OsLog>>,
}

pub(crate) fn probe_logger() -> PlatformLoggerProbe {
    PlatformLoggerProbe::success(
        Arc::new(MacOsPlatformLogger {
            logs: Mutex::new(HashMap::new()),
        }),
        None,
    )
}

impl PlatformLogger for MacOsPlatformLogger {
    fn log(
        &self,
        level: PlatformLogLevel,
        target: &str,
        message: &str,
        data: Option<&str>,
    ) -> Result<(), String> {
        let category = sanitize_target(target);
        let mut logs = self
            .logs
            .lock()
            .map_err(|_| "platform_logging_lock_poisoned".to_string())?;
        let entry = logs
            .entry(category.clone())
            .or_insert_with(|| OsLog::new(SUBSYSTEM, &category));
        entry.with_level(map_level(level), &append_structured_payload(message, data));
        Ok(())
    }

    fn is_available(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "os_log"
    }
}

fn map_level(level: PlatformLogLevel) -> Level {
    match level {
        PlatformLogLevel::Fatal => Level::Fault,
        PlatformLogLevel::Error => Level::Error,
        PlatformLogLevel::Warn => Level::Default,
        PlatformLogLevel::Info => Level::Info,
        PlatformLogLevel::Debug | PlatformLogLevel::Trace => Level::Debug,
    }
}

#[cfg(test)]
mod tests {
    use super::probe_logger;

    #[test]
    fn macos_platform_logger_reports_os_log_backend() {
        let probe = probe_logger();
        assert_eq!(probe.logger.name(), "os_log");
    }
}
