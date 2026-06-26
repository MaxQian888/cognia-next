//! `cognia:plugin/clipboard` host import.

use super::super::store::HostState;
use super::require;

pub fn check_read(state: &HostState) -> Result<(), String> {
    require(state, "clipboard:read")
}

pub fn check_write(state: &HostState) -> Result<(), String> {
    require(state, "clipboard:write")
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
            shell_allowlist: Vec::new(),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn read_and_write_caps_are_independent() {
        assert!(check_read(&st(&["clipboard:read"])).is_ok());
        assert!(check_write(&st(&["clipboard:read"])).is_err());
        assert!(check_read(&st(&["clipboard:write"])).is_err());
        assert!(check_write(&st(&["clipboard:write"])).is_ok());
    }
}
