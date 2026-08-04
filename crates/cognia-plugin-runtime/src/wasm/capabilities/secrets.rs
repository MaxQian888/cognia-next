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
    use super::super::super::store::test_host_state;
    use super::*;

    fn st(caps: &[&str]) -> HostState {
        test_host_state("demo", caps)
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
