//! Tunnel ingress configuration for a headless Host (ADR-0235 §4).
//!
//! # Why a listener of its own
//!
//! A VS Code dev-tunnel forward connects to its target from `127.0.0.1` and
//! sets no Cloudflare header. Pointed at the HTTPS listener, every request it
//! carried would read as a direct loopback caller: operator endpoints, service
//! tokens, single-user Owner invitations and the pre-auth rate-limit exemption
//! would all be granted to the public internet. Pointed at the plaintext
//! browser listener, it would also be granted `LoopbackPlaintext` execution.
//!
//! So a forward only ever targets this listener. It binds `127.0.0.1` (the
//! forward runs on the same machine), serves the same router as the HTTPS
//! listener, and tags every request with
//! [`ListenerKind::TunnelIngress`](cognia_companion_security::request_origin::ListenerKind)
//! and `TransportPlane::TunnelIngress`. The tag is set by the listener, so
//! nothing a visitor sends can remove it.
//!
//! # Why it is off by default
//!
//! An enabled listener is only reachable from loopback, but its sole purpose
//! is to be forwarded publicly. A Host that is never bootstrapped over a
//! tunnel should not bind it. It is switched on by the bootstrapper
//! (`cognia-server tunnel-ingress enable`) and read at `serve` time.
//!
//! Config file: `<data_dir>/cognia/tunnel-ingress.json`

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "tunnel-ingress.json";
const CONFIG_SUBDIR: &str = "cognia";

/// Loopback port the tunnel forward targets.
///
/// Outside the ports this Host already uses: 27890 HTTPS, 27891 browser,
/// 27893/27894 file shares, 27895 the gateway.
pub const DEFAULT_TUNNEL_INGRESS_PORT: u16 = 27896;

/// On-disk shape. Absent file == the default, which is "off".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelIngressConfig {
    /// Whether to bind the tunnel ingress listener at all.
    pub enabled: bool,
    /// Loopback port for the listener.
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    DEFAULT_TUNNEL_INGRESS_PORT
}

impl Default for TunnelIngressConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_TUNNEL_INGRESS_PORT,
        }
    }
}

impl TunnelIngressConfig {
    /// Port `0` means "the default", never an ephemeral port: the forward has
    /// to name the port before the listener binds it.
    fn normalized(mut self) -> Self {
        if self.port == 0 {
            self.port = DEFAULT_TUNNEL_INGRESS_PORT;
        }
        self
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_SUBDIR).join(CONFIG_FILE)
}

/// Read the config. A missing or unparseable file yields the default.
///
/// Failing closed is deliberate: the default binds nothing, so the worst case
/// of a corrupt file is a forward with nothing to reach, never a listener the
/// owner did not ask for.
pub fn load(data_dir: &Path) -> TunnelIngressConfig {
    let Ok(raw) = std::fs::read_to_string(config_path(data_dir)) else {
        return TunnelIngressConfig::default();
    };
    serde_json::from_str::<TunnelIngressConfig>(&raw)
        .map(TunnelIngressConfig::normalized)
        .unwrap_or_default()
}

/// Persist the config (owner-only on Unix) and return what was saved.
///
/// Takes effect at the next `serve`: the bootstrapper writes it before the
/// service starts, or restarts the service after changing it.
pub fn save(data_dir: &Path, config: TunnelIngressConfig) -> Result<TunnelIngressConfig, String> {
    let config = config.normalized();
    let path = config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn missing_file_is_off_on_the_default_port() {
        let dir = temp_dir();
        let config = load(dir.path());
        assert!(!config.enabled);
        assert_eq!(config.port, DEFAULT_TUNNEL_INGRESS_PORT);
    }

    #[test]
    fn save_then_load_round_trips_and_is_owner_only() {
        let dir = temp_dir();
        let saved = save(
            dir.path(),
            TunnelIngressConfig {
                enabled: true,
                port: 28_123,
            },
        )
        .unwrap();
        assert_eq!(load(dir.path()), saved);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(config_path(dir.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn port_zero_means_the_default_not_an_ephemeral_port() {
        let dir = temp_dir();
        let saved = save(
            dir.path(),
            TunnelIngressConfig {
                enabled: true,
                port: 0,
            },
        )
        .unwrap();
        assert_eq!(saved.port, DEFAULT_TUNNEL_INGRESS_PORT);
        let path = config_path(dir.path());
        std::fs::write(&path, r#"{"enabled":true,"port":0}"#).unwrap();
        assert_eq!(load(dir.path()).port, DEFAULT_TUNNEL_INGRESS_PORT);
    }

    #[test]
    fn a_corrupt_config_reads_as_off() {
        let dir = temp_dir();
        let path = config_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!load(dir.path()).enabled);
        std::fs::write(&path, r#"{"enabled":"yes"}"#).unwrap();
        assert!(!load(dir.path()).enabled);
    }

    #[test]
    fn the_default_port_collides_with_no_other_host_listener() {
        assert_ne!(DEFAULT_TUNNEL_INGRESS_PORT, crate::server::DEFAULT_PORT);
        assert_ne!(
            DEFAULT_TUNNEL_INGRESS_PORT,
            crate::browser_access::DEFAULT_BROWSER_PORT
        );
    }
}
