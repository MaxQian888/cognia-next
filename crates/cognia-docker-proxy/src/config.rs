//! The proxy's configuration, read from the environment Compose sets.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;

use crate::policy::ProxyPolicy;

/// Where clients reach the proxy.
pub const LISTEN_ENV: &str = "COGNIA_DOCKER_PROXY_LISTEN";
/// The real daemon socket.
pub const UPSTREAM_ENV: &str = "COGNIA_DOCKER_PROXY_UPSTREAM";
/// OCI runtimes a container may ask for, comma-separated (default `runc,runsc`).
pub const RUNTIMES_ENV: &str = "COGNIA_DOCKER_PROXY_RUNTIMES";
/// Shared with `cognia-server`: the `cognia.deployment` label value.
pub const DEPLOYMENT_ENV: &str = "COGNIA_DEPLOYMENT_ID";
/// Shared with `cognia-server`: the one volume a workspace mounts.
pub const WORKSPACES_VOLUME_ENV: &str = "COGNIA_WORKSPACES_VOLUME";

pub const DEFAULT_LISTEN: &str = "tcp://0.0.0.0:2375";
pub const DEFAULT_UPSTREAM: &str = "unix:///var/run/docker.sock";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Listen {
    Tcp(SocketAddr),
    Unix(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyConfig {
    pub listen: Listen,
    /// The daemon's Unix socket.
    pub upstream: PathBuf,
    pub policy: ProxyPolicy,
}

fn parse_listen(raw: &str) -> Result<Listen, String> {
    if let Some(path) = raw.strip_prefix("unix://") {
        if path.is_empty() {
            return Err(format!("{LISTEN_ENV} names no socket path"));
        }
        return Ok(Listen::Unix(PathBuf::from(path)));
    }
    let addr = raw.strip_prefix("tcp://").unwrap_or(raw);
    addr.parse::<SocketAddr>()
        .map(Listen::Tcp)
        .map_err(|e| format!("{LISTEN_ENV}={raw:?} is not tcp://host:port or unix:///path: {e}"))
}

fn required(lookup: &impl Fn(&str) -> Option<String>, key: &str) -> Result<String, String> {
    match lookup(key).map(|v| v.trim().to_string()) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(format!(
            "{key} is required: the proxy admits only this deployment's containers and volumes"
        )),
    }
}

impl ProxyConfig {
    /// Read the configuration through `lookup` (the process environment in
    /// `main`). A missing deployment id or workspaces volume refuses to start:
    /// without them every create would be refused, or worse, every one admitted.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let listen = parse_listen(
            lookup(LISTEN_ENV)
                .filter(|v| !v.trim().is_empty())
                .as_deref()
                .unwrap_or(DEFAULT_LISTEN)
                .trim(),
        )?;
        let upstream_raw = lookup(UPSTREAM_ENV)
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_UPSTREAM.to_string());
        let upstream = upstream_raw
            .trim()
            .strip_prefix("unix://")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("{UPSTREAM_ENV}={upstream_raw:?} must be unix:///path"))?;
        let mut policy = ProxyPolicy::new(
            required(&lookup, DEPLOYMENT_ENV)?,
            required(&lookup, WORKSPACES_VOLUME_ENV)?,
        );
        if let Some(raw) = lookup(RUNTIMES_ENV).filter(|v| !v.trim().is_empty()) {
            let runtimes: BTreeSet<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if runtimes.is_empty() {
                return Err(format!("{RUNTIMES_ENV} names no runtime"));
            }
            policy.allowed_runtimes = runtimes;
        }
        Ok(Self {
            listen,
            upstream,
            policy,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn defaults_to_the_compose_shape() {
        let config = ProxyConfig::from_lookup(lookup(&[
            (DEPLOYMENT_ENV, "dep1"),
            (WORKSPACES_VOLUME_ENV, "dep1_workspaces"),
        ]))
        .unwrap();
        assert_eq!(config.listen, Listen::Tcp("0.0.0.0:2375".parse().unwrap()));
        assert_eq!(config.upstream, PathBuf::from("/var/run/docker.sock"));
        assert_eq!(config.policy, ProxyPolicy::new("dep1", "dep1_workspaces"));
    }

    #[test]
    fn reads_a_unix_listener_and_a_runtime_list() {
        let config = ProxyConfig::from_lookup(lookup(&[
            (LISTEN_ENV, "unix:///run/cognia/docker.sock"),
            (UPSTREAM_ENV, "unix:///run/docker.sock"),
            (RUNTIMES_ENV, "runc, "),
            (DEPLOYMENT_ENV, "dep1"),
            (WORKSPACES_VOLUME_ENV, "w"),
        ]))
        .unwrap();
        assert_eq!(
            config.listen,
            Listen::Unix("/run/cognia/docker.sock".into())
        );
        assert_eq!(config.upstream, PathBuf::from("/run/docker.sock"));
        assert_eq!(
            config.policy.allowed_runtimes,
            ["runc".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn refuses_to_start_without_a_deployment_or_with_a_bad_address() {
        assert!(ProxyConfig::from_lookup(lookup(&[(WORKSPACES_VOLUME_ENV, "w")])).is_err());
        assert!(ProxyConfig::from_lookup(lookup(&[(DEPLOYMENT_ENV, "dep1")])).is_err());
        assert!(ProxyConfig::from_lookup(lookup(&[
            (DEPLOYMENT_ENV, " "),
            (WORKSPACES_VOLUME_ENV, "w"),
        ]))
        .is_err());
        let base = [(DEPLOYMENT_ENV, "d"), (WORKSPACES_VOLUME_ENV, "w")];
        for (key, value) in [
            (LISTEN_ENV, "nowhere"),
            (LISTEN_ENV, "unix://"),
            (UPSTREAM_ENV, "tcp://127.0.0.1:2375"),
            (RUNTIMES_ENV, ","),
        ] {
            let mut pairs = base.to_vec();
            pairs.push((key, value));
            assert!(
                ProxyConfig::from_lookup(lookup(&pairs)).is_err(),
                "{key}={value}"
            );
        }
    }
}
