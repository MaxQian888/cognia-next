//! Persisted companion reachability preference — how this desktop wants to be
//! reachable, remembered across restarts.
//!
//! # Why this exists
//!
//! The companion server and the mDNS broadcaster were both pure in-memory
//! toggles owned by Settings → Companion. Nothing persisted them and nothing
//! restored them, so the observable behaviour was:
//!
//! 1. the user switches the server on, binds it to the LAN, switches mDNS on;
//! 2. a paired phone auto-discovers the desktop and connects;
//! 3. the user quits and reopens the app;
//! 4. **the phone can no longer find the desktop at all** — the listener is
//!    down and nothing is advertising — until the user walks back into
//!    Settings and flips the same two switches again.
//!
//! Step 4 reads as "auto-discovery is broken", because from the phone's side
//! it is indistinguishable from one. The only automatic path that ever started
//! the server was `fleet_monitor_restore`, and it starts it *loopback-only*
//! (`bind_loopback_only = true`), which no off-machine client can reach.
//!
//! This module stores the user's intent so [`super::commands::
//! companion_reachability_restore`] can re-establish it at boot.
//!
//! # What is deliberately NOT written here
//!
//! Only surfaces that represent a **user decision** write this file — today
//! that is Settings → Companion. `companion_server_start` itself does not,
//! because internal callers start the server for their own reasons on their own
//! terms: `fleet_monitor_start` brings it up loopback-only as an ingress for
//! hook scripts, and if that path wrote the config it would silently downgrade
//! a user who had chosen LAN binding to loopback on the next boot. Intent and
//! side effect are different things and only intent belongs on disk.
//!
//! # Relationship to the other channel configs
//!
//! Follows the same split as [`super::tunnel_config`] and
//! [`super::browser_access`]: non-secret preferences in a plain JSON file under
//! the data dir, `0o600`, absent file == "nothing enabled". There is no secret
//! here, so no keyring leg.
//!
//! Config file: `<data_dir>/cognia/reachability.json`

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "reachability.json";
const CONFIG_SUBDIR: &str = "cognia";

/// The user's saved answer to "how should this desktop be reachable?".
///
/// Every field carries `#[serde(default)]` so a file written by an older build
/// — or hand-edited to drop a key — still loads, with the missing key reading
/// as its default rather than failing the whole parse and silently reverting
/// every *other* preference too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachabilityConfig {
    /// Start the companion HTTPS listener at boot.
    #[serde(default)]
    pub server_enabled: bool,
    /// Port to bind. Defaults to [`super::server::DEFAULT_PORT`].
    #[serde(default = "default_port")]
    pub port: u16,
    /// `true` → `127.0.0.1` (this machine only); `false` → `0.0.0.0` (LAN).
    ///
    /// Defaults to `true`: a restored-but-unspecified binding must be the
    /// narrow one. A config that lost this key must not widen exposure.
    #[serde(default = "default_bind_loopback_only")]
    pub bind_loopback_only: bool,
    /// Advertise `_cognia._tcp.local.` once the server is up.
    #[serde(default)]
    pub mdns_enabled: bool,
}

fn default_port() -> u16 {
    super::server::DEFAULT_PORT
}

fn default_bind_loopback_only() -> bool {
    true
}

impl Default for ReachabilityConfig {
    fn default() -> Self {
        Self {
            server_enabled: false,
            port: default_port(),
            bind_loopback_only: default_bind_loopback_only(),
            mdns_enabled: false,
        }
    }
}

impl ReachabilityConfig {
    /// Whether restoring this config would put anything on the network.
    ///
    /// Used by the boot restore to skip all work — including resolving the TLS
    /// material — for the overwhelmingly common "never configured" install.
    pub fn restores_anything(&self) -> bool {
        self.server_enabled
    }

    /// Whether mDNS should be advertised after a successful server start.
    ///
    /// Advertising without a listener would publish an address that refuses
    /// every connection, so the broadcaster is gated on the server, not just on
    /// its own switch.
    pub fn advertises(&self) -> bool {
        self.server_enabled && self.mdns_enabled
    }
}

fn config_path(data_dir: Option<&Path>) -> PathBuf {
    match data_dir {
        Some(dir) => dir.join(CONFIG_SUBDIR).join(CONFIG_FILE),
        None => std::env::temp_dir().join(CONFIG_SUBDIR).join(CONFIG_FILE),
    }
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn store_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(path).map(|m| m.permissions()) {
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    Ok(())
}

/// Load the saved preference. A missing **or unreadable** file reads as the
/// default, which enables nothing — the fail-safe direction for a config whose
/// only power is to open a network listener.
pub fn load_config(data_dir: Option<&Path>) -> ReachabilityConfig {
    load_json(&config_path(data_dir))
        .unwrap_or_default()
        .unwrap_or_default()
}

/// Persist the preference.
pub fn save_config(data_dir: Option<&Path>, config: &ReachabilityConfig) -> Result<(), String> {
    store_json(&config_path(data_dir), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cognia-reachability-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_reads_as_nothing_enabled() {
        let dir = temp_dir("missing");
        let config = load_config(Some(&dir));
        assert_eq!(config, ReachabilityConfig::default());
        assert!(!config.server_enabled);
        assert!(!config.mdns_enabled);
        assert!(!config.restores_anything());
    }

    #[test]
    fn the_default_binding_is_the_narrow_one() {
        // A default that binds 0.0.0.0 would mean "config lost → exposure
        // widened", which is the wrong direction for every failure mode this
        // file has (absent, truncated, hand-edited, written by an older build).
        assert!(ReachabilityConfig::default().bind_loopback_only);
        assert_eq!(ReachabilityConfig::default().port, super::default_port());
    }

    #[test]
    fn a_saved_config_round_trips() {
        let dir = temp_dir("roundtrip");
        let config = ReachabilityConfig {
            server_enabled: true,
            port: 31337,
            bind_loopback_only: false,
            mdns_enabled: true,
        };
        save_config(Some(&dir), &config).unwrap();
        assert_eq!(load_config(Some(&dir)), config);
    }

    #[test]
    fn a_file_missing_a_key_keeps_the_other_preferences() {
        // The whole point of the per-field `#[serde(default)]`: a partial file
        // must not fail the parse and revert every preference to off.
        let dir = temp_dir("partial");
        let path = config_path(Some(&dir));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"serverEnabled":true,"bindLoopbackOnly":false}"#).unwrap();

        let config = load_config(Some(&dir));
        assert!(config.server_enabled);
        assert!(!config.bind_loopback_only);
        assert_eq!(config.port, super::default_port(), "absent port defaults");
        assert!(!config.mdns_enabled, "absent mdns reads as off");
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_enabled_instead_of_panicking() {
        let dir = temp_dir("corrupt");
        let path = config_path(Some(&dir));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();

        assert_eq!(load_config(Some(&dir)), ReachabilityConfig::default());
    }

    #[test]
    fn mdns_does_not_advertise_without_a_listener() {
        // Advertising `_cognia._tcp` while the server is down publishes an
        // address that refuses every connection — a phone would "discover" the
        // desktop and then fail to connect, which is worse than finding
        // nothing.
        let config = ReachabilityConfig {
            server_enabled: false,
            mdns_enabled: true,
            ..Default::default()
        };
        assert!(!config.advertises());

        let config = ReachabilityConfig {
            server_enabled: true,
            mdns_enabled: true,
            ..Default::default()
        };
        assert!(config.advertises());
    }

    #[test]
    fn the_config_is_written_owner_only() {
        let dir = temp_dir("perms");
        save_config(Some(&dir), &ReachabilityConfig::default()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(config_path(Some(&dir)))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
