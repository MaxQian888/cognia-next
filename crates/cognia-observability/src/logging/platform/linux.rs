use super::{
    append_structured_payload, sanitize_error_message, sanitize_target, PlatformLogLevel,
    PlatformLogger, PlatformLoggerProbe,
};
use libsystemd::logging::{journal_send, Priority, SD_JOURNAL_SOCK_PATH};
use std::path::Path;
use std::sync::{Arc, Mutex};
use syslog::{Facility, Formatter3164, Logger, LoggerBackend};

enum LinuxBackend {
    Journald,
    Syslog(Mutex<Logger<LoggerBackend, Formatter3164>>),
}

pub(crate) struct LinuxPlatformLogger {
    backend: LinuxBackend,
}

pub(crate) fn probe_logger() -> PlatformLoggerProbe {
    if Path::new(SD_JOURNAL_SOCK_PATH).exists() {
        return PlatformLoggerProbe::success(
            Arc::new(LinuxPlatformLogger {
                backend: LinuxBackend::Journald,
            }),
            None,
        );
    }

    let formatter = Formatter3164 {
        facility: Facility::LOG_USER,
        hostname: None,
        process: "cognia".to_string(),
        pid: 0,
    };

    match syslog::unix(formatter) {
        Ok(writer) => PlatformLoggerProbe::success(
            Arc::new(LinuxPlatformLogger {
                backend: LinuxBackend::Syslog(Mutex::new(writer)),
            }),
            None,
        ),
        Err(error) => PlatformLoggerProbe::failure(
            "syslog",
            format!("linux_platform_logging_unavailable:{error}"),
        ),
    }
}

impl PlatformLogger for LinuxPlatformLogger {
    fn log(
        &self,
        level: PlatformLogLevel,
        target: &str,
        message: &str,
        data: Option<&str>,
    ) -> Result<(), String> {
        match &self.backend {
            LinuxBackend::Journald => {
                let fields = vec![
                    ("SYSLOG_IDENTIFIER".to_string(), "cognia".to_string()),
                    ("MODULE".to_string(), sanitize_target(target)),
                    ("TARGET".to_string(), sanitize_target(target)),
                    (
                        "PAYLOAD".to_string(),
                        append_structured_payload(message, data),
                    ),
                ];
                journal_send(
                    map_journald_priority(level),
                    message,
                    fields
                        .iter()
                        .map(|(key, value)| (key.as_str(), value.as_str())),
                )
                .map_err(|error| sanitize_error_message(error.to_string()))
            }
            LinuxBackend::Syslog(writer) => {
                let mut writer = writer
                    .lock()
                    .map_err(|_| "platform_logging_lock_poisoned".to_string())?;
                let rendered = format!(
                    "[{}] {}",
                    sanitize_target(target),
                    append_structured_payload(message, data)
                );
                match level {
                    PlatformLogLevel::Fatal => writer.crit(rendered),
                    PlatformLogLevel::Error => writer.err(rendered),
                    PlatformLogLevel::Warn => writer.warning(rendered),
                    PlatformLogLevel::Info => writer.notice(rendered),
                    PlatformLogLevel::Debug | PlatformLogLevel::Trace => writer.debug(rendered),
                }
                .map_err(|error| sanitize_error_message(error.to_string()))
            }
        }
    }

    fn is_available(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        match self.backend {
            LinuxBackend::Journald => "journald",
            LinuxBackend::Syslog(_) => "syslog",
        }
    }
}

fn map_journald_priority(level: PlatformLogLevel) -> Priority {
    match level {
        PlatformLogLevel::Fatal => Priority::Critical,
        PlatformLogLevel::Error => Priority::Error,
        PlatformLogLevel::Warn => Priority::Warning,
        PlatformLogLevel::Info => Priority::Notice,
        PlatformLogLevel::Debug | PlatformLogLevel::Trace => Priority::Debug,
    }
}

#[cfg(test)]
mod tests {
    use super::probe_logger;

    #[test]
    fn linux_platform_logger_prefers_journald_or_syslog() {
        let probe = probe_logger();
        assert!(matches!(probe.logger.name(), "journald" | "syslog"));
    }
}
