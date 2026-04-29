use super::{PlatformLogLevel, PlatformLogger};

pub(crate) struct NoopPlatformLogger {
    backend: &'static str,
}

impl NoopPlatformLogger {
    pub(crate) const fn new(backend: &'static str) -> Self {
        Self { backend }
    }
}

impl PlatformLogger for NoopPlatformLogger {
    fn log(
        &self,
        _level: PlatformLogLevel,
        _target: &str,
        _message: &str,
        _data: Option<&str>,
    ) -> Result<(), String> {
        Ok(())
    }

    fn is_available(&self) -> bool {
        false
    }

    fn name(&self) -> &'static str {
        self.backend
    }
}

#[cfg(test)]
mod tests {
    use super::{NoopPlatformLogger, PlatformLogger};
    use crate::logging::platform::PlatformLogLevel;

    #[test]
    fn noop_logger_reports_unavailable_backend_without_erroring() {
        let logger = NoopPlatformLogger::new("event_log");

        assert!(!logger.is_available());
        assert_eq!(logger.name(), "event_log");
        assert!(logger
            .log(
                PlatformLogLevel::Warn,
                "app_lib::startup",
                "noop entry",
                None
            )
            .is_ok());
    }
}
