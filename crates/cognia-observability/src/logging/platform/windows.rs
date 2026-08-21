use super::{sanitize_error_message, PlatformLogLevel, PlatformLogger, PlatformLoggerProbe};
use eventlog::EventLog;
use log::{Level, Log, RecordBuilder};
use std::sync::Arc;

const EVENT_SOURCE: &str = "Cognia";

pub(crate) struct WindowsPlatformLogger {
    inner: EventLog,
}

pub(crate) fn probe_logger() -> PlatformLoggerProbe {
    let registration_error = eventlog::register(EVENT_SOURCE)
        .err()
        .map(|error| format!("event_log_source_registration_failed:{error}"));

    match EventLog::new(EVENT_SOURCE, Level::Trace) {
        Ok(inner) => PlatformLoggerProbe::success(
            Arc::new(WindowsPlatformLogger { inner }),
            registration_error.map(sanitize_error_message),
        ),
        Err(error) => PlatformLoggerProbe::failure(
            "event_log",
            format!("event_log_initialization_failed:{error}"),
        ),
    }
}

impl PlatformLogger for WindowsPlatformLogger {
    fn log(
        &self,
        level: PlatformLogLevel,
        target: &str,
        message: &str,
        data: Option<&str>,
    ) -> Result<(), String> {
        let level = match level {
            PlatformLogLevel::Fatal | PlatformLogLevel::Error => Level::Error,
            PlatformLogLevel::Warn => Level::Warn,
            PlatformLogLevel::Info => Level::Info,
            PlatformLogLevel::Debug | PlatformLogLevel::Trace => Level::Debug,
        };
        let rendered = append_structured_data(message, data);
        let args = format_args!("{rendered}");
        let record = RecordBuilder::new()
            .level(level)
            .target(target)
            .args(args)
            .build();
        Log::log(&self.inner, &record);
        Ok(())
    }

    fn is_available(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "event_log"
    }
}

fn append_structured_data(message: &str, data: Option<&str>) -> String {
    match data {
        Some(data) if !data.is_empty() => format!("{message} | {data}"),
        _ => message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{append_structured_data, probe_logger};

    #[test]
    fn windows_platform_logger_reports_event_log_backend() {
        let probe = probe_logger();
        assert_eq!(probe.logger.name(), "event_log");
    }

    #[test]
    fn append_structured_data_includes_non_empty_payload() {
        assert_eq!(
            append_structured_data("startup failed", Some("{\"traceId\":\"abc\"}")),
            "startup failed | {\"traceId\":\"abc\"}"
        );
    }

    #[test]
    fn append_structured_data_ignores_missing_payload() {
        assert_eq!(
            append_structured_data("startup failed", None),
            "startup failed"
        );
        assert_eq!(
            append_structured_data("startup failed", Some("")),
            "startup failed"
        );
    }
}
