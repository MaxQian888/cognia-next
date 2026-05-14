//! `cognia:plugin/secrets` host import — wraps the OS keyring.

use super::super::store::HostState;
use super::require;

/// Compose the per-plugin keyring service identifier so two plugins can't
/// see each other's secrets even if they pick colliding key names.
pub(crate) fn service_id(plugin_id: &str) -> String {
    format!("com.cognia.plugin/{plugin_id}/v1")
}

pub fn check_read(state: &HostState) -> Result<(), String> {
    require(state, "secrets:read")
}

pub fn check_write(state: &HostState) -> Result<(), String> {
    require(state, "secrets:write")
}

#[cfg(test)]
mod tests {
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn st(caps: &[&str]) -> HostState {
        HostState {
            plugin_id: "demo".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn service_id_isolates_plugins() {
        let a = service_id("alpha");
        let b = service_id("beta");
        assert!(a.contains("alpha"));
        assert!(b.contains("beta"));
        assert_ne!(a, b);
    }

    #[test]
    fn read_and_write_caps_are_independent() {
        let read_only = st(&["secrets:read"]);
        let write_only = st(&["secrets:write"]);
        let none = st(&[]);
        assert!(check_read(&read_only).is_ok());
        assert!(check_write(&read_only).is_err());
        assert!(check_read(&write_only).is_err());
        assert!(check_write(&write_only).is_ok());
        assert!(check_read(&none).is_err());
        assert!(check_write(&none).is_err());
    }
}
