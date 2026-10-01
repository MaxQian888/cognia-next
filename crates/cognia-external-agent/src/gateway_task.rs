//! Shared task configuration and ownership rules for native and sandbox execution.
pub use cognia_sandboxd::gateway_task::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_task_api_retains_safe_task_identity_validation() {
        let environment = std::collections::HashMap::from([(
            PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"../escape","runtime":"codex","binding":{},"files":{}})
                .to_string(),
        )]);
        assert!(task_home(&environment, std::path::Path::new("/tmp")).is_err());
    }
}
