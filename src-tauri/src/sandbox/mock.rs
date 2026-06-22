// ADR-0028 — `MockSandboxBackend`. Used by:
//   - this crate's own integration tests for `sandbox_exec` dispatch logic;
//   - downstream Phase 5+ test fixtures (sandboxed-tools plugin) that need
//     to verify a SandboxCommand reaches the runner without actually
//     touching the OS.
//
// Today (Phase 4.1) only the in-file tests consume this; Phase 4.5's
// sandbox dispatcher tests will be the second consumer.
#![allow(dead_code)]
//
// Records every call into an in-memory ring so tests can assert "the
// runner received THIS argv + THIS policy". Returns a canned successful
// result by default; tests can override via `set_next_result`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{
    SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

/// One recorded call. Cloned out of the ring for test assertions; the
/// originals live in the `Arc<Mutex<…>>` so multiple test handles share
/// them.
#[derive(Debug, Clone)]
pub struct RecordedCall {
    pub command: SandboxCommand,
    pub policy: SandboxPolicy,
}

#[derive(Debug, Default)]
struct Inner {
    calls: Vec<RecordedCall>,
    /// Stack of pre-canned results. Each `run()` pops the back; when empty
    /// the default success result (exit 0, empty stdout/stderr) is used.
    next: Vec<Result<SandboxResult, SandboxError>>,
    available: bool,
    setup_calls: u32,
}

#[derive(Debug, Clone, Default)]
pub struct MockSandboxBackend {
    inner: Arc<Mutex<Inner>>,
}

impl MockSandboxBackend {
    pub fn new() -> Self {
        let mut inner = Inner::default();
        inner.available = true;
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Force the backend to report unavailable. Used to exercise the
    /// strict-mode deny path (`sandbox unavailable → tool call refused`).
    pub fn set_unavailable(&self) {
        self.inner.lock().expect("mock lock").available = false;
    }

    /// Push a pre-canned result onto the stack. The next call to `run()`
    /// pops the back, so the call order matches LIFO of pushes. Tests
    /// typically only push one.
    pub fn set_next_result(&self, result: Result<SandboxResult, SandboxError>) {
        self.inner.lock().expect("mock lock").next.push(result);
    }

    /// Snapshot every recorded call so far.
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.inner.lock().expect("mock lock").calls.clone()
    }

    /// Number of times `first_time_setup` was invoked.
    pub fn setup_call_count(&self) -> u32 {
        self.inner.lock().expect("mock lock").setup_calls
    }
}

#[async_trait]
impl SandboxedExec for MockSandboxBackend {
    async fn run(
        &self,
        command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        let mut g = self.inner.lock().expect("mock lock");
        g.calls.push(RecordedCall { command, policy });
        if let Some(next) = g.next.pop() {
            return next;
        }
        Ok(SandboxResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            duration: Duration::from_millis(0),
            timed_out: false,
        })
    }

    fn is_available(&self) -> bool {
        self.inner.lock().expect("mock lock").available
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        let mut g = self.inner.lock().expect("mock lock");
        g.setup_calls += 1;
        g.available = true;
        Ok(())
    }

    fn health(&self) -> SandboxHealth {
        let g = self.inner.lock().expect("mock lock");
        SandboxHealth {
            available: g.available,
            backend: "mock".into(),
            version: "test-only".into(),
            last_error: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use crate::sandbox::types::NetworkPolicy;

    fn sample_cmd() -> SandboxCommand {
        SandboxCommand {
            argv: vec!["ls".into(), "-la".into()],
            cwd: PathBuf::from("/tmp"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(5),
        }
    }

    fn sample_policy() -> SandboxPolicy {
        SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 5,
            max_memory_mb: 128,
        }
    }

    #[tokio::test]
    async fn default_run_returns_success_and_records_call() {
        let mock = MockSandboxBackend::new();
        let result = mock.run(sample_cmd(), sample_policy()).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(mock.calls().len(), 1);
        assert_eq!(mock.calls()[0].command.argv, vec!["ls", "-la"]);
    }

    #[tokio::test]
    async fn set_next_result_consumed_lifo() {
        let mock = MockSandboxBackend::new();
        mock.set_next_result(Err(SandboxError::BackendFailed {
            reason: "stub failure".into(),
        }));
        let err = mock.run(sample_cmd(), sample_policy()).await.unwrap_err();
        assert!(matches!(err, SandboxError::BackendFailed { .. }));

        // Next call falls back to default success.
        let ok = mock.run(sample_cmd(), sample_policy()).await.unwrap();
        assert_eq!(ok.exit_code, 0);
    }

    #[tokio::test]
    async fn is_available_reflects_setter() {
        let mock = MockSandboxBackend::new();
        assert!(mock.is_available());
        mock.set_unavailable();
        assert!(!mock.is_available());
    }

    #[tokio::test]
    async fn first_time_setup_re_enables() {
        let mock = MockSandboxBackend::new();
        mock.set_unavailable();
        mock.first_time_setup().await.unwrap();
        assert!(mock.is_available());
        assert_eq!(mock.setup_call_count(), 1);
    }

    #[tokio::test]
    async fn health_reports_mock_backend() {
        let mock = MockSandboxBackend::new();
        let h = mock.health();
        assert_eq!(h.backend, "mock");
        assert!(h.available);
    }
}
