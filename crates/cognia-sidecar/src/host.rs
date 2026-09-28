//! Host callbacks used by the shared sidecar supervisor.
use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;

/// Host-specific pieces of the sidecar supervisor. Everything else (spawn
/// lock, epochs, backoff, reader loop, hooks) is shared.
#[async_trait]
pub trait SidecarHost: Send + Sync + 'static {
    /// Absolute path to `claude-host.mjs` for this host.
    fn resolve_script(&self) -> Result<PathBuf, String>;

    /// Node executable used to probe and launch the sidecar. Headless hosts
    /// keep the deployment contract of resolving `node` from `PATH`; desktop
    /// hosts override this with the verified runtime bundled by Tauri.
    fn resolve_node_executable(&self) -> Result<PathBuf, String> {
        Ok(PathBuf::from("node"))
    }

    /// Deliver a sidecar event (`claude://message`, `a2ui://dispatch`) to
    /// whoever hosts the UI. Fire-and-forget: implementations log failures.
    fn emit(&self, channel: &str, payload: &Value);

    /// Inject host-resolved provider credentials into the child's env.
    /// Auth precedence (both hosts): OAuth bearer → API key; base URL is
    /// orthogonal and forwarded whenever set.
    async fn inject_env(&self, cmd: &mut Command);

    /// Host-owned recovery policy; no desktop or domain dependency in the supervisor.
    fn is_disabled(&self) -> bool;
    fn report_failure(&self);

    /// Answer host-owned services without importing their domain crates.
    async fn dispatch_host_rpc(&self, method: &str, params: &Value) -> Result<Value, String>;

    /// `"tauri"` | `"headless"` — for logs.
    fn kind(&self) -> &'static str;
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[derive(Default)]
    pub(crate) struct TestHost {
        pub(crate) disabled: bool,
        pub(crate) events: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl SidecarHost for TestHost {
        fn resolve_script(&self) -> Result<PathBuf, String> {
            Err("test host has no script".into())
        }
        fn emit(&self, _channel: &str, payload: &Value) {
            self.events.lock().push(payload.clone());
        }
        async fn inject_env(&self, _cmd: &mut Command) {}
        fn is_disabled(&self) -> bool {
            self.disabled
        }
        fn report_failure(&self) {}
        async fn dispatch_host_rpc(&self, method: &str, params: &Value) -> Result<Value, String> {
            Ok(serde_json::json!({ "method": method, "params": params }))
        }
        fn kind(&self) -> &'static str {
            "test"
        }
    }

    #[test]
    fn default_node_resolution_preserves_path_lookup() {
        assert_eq!(
            TestHost::default().resolve_node_executable().unwrap(),
            PathBuf::from("node")
        );
    }
}
