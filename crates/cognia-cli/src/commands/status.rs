//! `cognia plugin status` - probe the running desktop bridge.

use anyhow::{bail, Result};
use serde::Serialize;

use crate::engine::bridge_client::{
    endpoint_file_path_for, load_endpoint_from, probe_health, EndpointFile,
};
use std::path::Path;
use crate::ui::{style, RuntimeUi};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct BridgeStatusReport {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    pub(crate) ok: bool,
    pub(crate) action: &'static str,
    pub(crate) running: bool,
    #[serde(rename = "endpointFile")]
    pub(crate) endpoint_file: Option<String>,
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: Option<String>,
    pub(crate) error: Option<String>,
}

pub fn run(
    json: bool,
    query: Option<&str>,
    endpoint_file: Option<&Path>,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let report = probe_bridge_status_at(endpoint_file);
    run_with_report(json, query, report, ui)
}

fn run_with_report(
    json: bool,
    query: Option<&str>,
    report: BridgeStatusReport,
    ui: &mut RuntimeUi,
) -> Result<()> {
    if json {
        crate::shared::print_json_projected(&report, query)?;
    } else if !ui.flags.quiet {
        print_human(&report);
    }

    if report.running {
        Ok(())
    } else if json {
        Err(crate::shared::JsonFailureExit.into())
    } else {
        bail!(
            "cognia CLI bridge is not running: {}",
            report.error.as_deref().unwrap_or("unknown status")
        )
    }
}

/// Probe the bridge, optionally honoring an `--endpoint-file` override.
pub(crate) fn probe_bridge_status_at(path: Option<&Path>) -> BridgeStatusReport {
    let endpoint_file = endpoint_file_path_for(path)
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    build_status_report(
        endpoint_file,
        || load_endpoint_from(path),
        probe_health,
    )
}

fn build_status_report<Load, Health>(
    endpoint_file: Option<String>,
    load: Load,
    health: Health,
) -> BridgeStatusReport
where
    Load: FnOnce() -> Result<EndpointFile>,
    Health: FnOnce(&EndpointFile) -> Result<()>,
{
    let endpoint = match load() {
        Ok(endpoint) => endpoint,
        Err(err) => {
            return BridgeStatusReport {
                schema_version: 1,
                ok: false,
                action: "status",
                running: false,
                endpoint_file,
                base_url: None,
                error: Some(err.to_string()),
            };
        }
    };

    let base_url = endpoint.base_url.clone();
    match health(&endpoint) {
        Ok(()) => BridgeStatusReport {
            schema_version: 1,
            ok: true,
            action: "status",
            running: true,
            endpoint_file,
            base_url: Some(base_url),
            error: None,
        },
        Err(err) => BridgeStatusReport {
            schema_version: 1,
            ok: false,
            action: "status",
            running: false,
            endpoint_file,
            base_url: Some(base_url),
            error: Some(err.to_string()),
        },
    }
}

fn print_human(report: &BridgeStatusReport) {
    if report.running {
        println!(
            "{}{} {}",
            style::success_prefix(),
            style::ok("bridge running"),
            style::bold(report.base_url.as_deref().unwrap_or("<unknown endpoint>"))
        );
    } else {
        println!("{}bridge unavailable", style::warn_prefix());
    }

    if let Some(path) = &report.endpoint_file {
        println!("  endpoint file: {}", style::dim(path));
    }
    if let Some(base_url) = &report.base_url {
        println!("  base URL: {}", style::dim(base_url));
    }
    if let Some(error) = &report.error {
        println!("  error: {error}");
    }
}

#[derive(Debug, Serialize)]
struct OverviewReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    bridge: OverviewBridgeSection,
    host: OverviewHostSection,
}

#[derive(Debug, Serialize)]
struct OverviewBridgeSection {
    running: bool,
    #[serde(
        rename = "endpointFile",
        skip_serializing_if = "Option::is_none"
    )]
    endpoint_file: Option<String>,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct OverviewHostSection {
    ok: bool,
    checks: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// `cognia status` — composite probe of every local control plane:
/// the desktop CLI bridge (loopback, token-authenticated) and the
/// headless service (server URL, credentials, catalog, probes). The
/// command succeeds when at least one plane is usable; a fully dark
/// machine exits non-zero so scripts can gate on it.
pub fn run_overview(
    json: bool,
    query: Option<&str>,
    endpoint_file: Option<&Path>,
    host_config: crate::commands::host::HostConfig,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let bridge = probe_bridge_status_at(endpoint_file);
    let (host_checks, host_error) = match crate::commands::host::load_catalog() {
        Ok(catalog) => {
            let (checks, terminal) =
                crate::commands::host::probe_host_plane(&catalog, &host_config, false);
            (checks, terminal.map(|failure| failure.describe()))
        }
        Err(failure) => (Vec::new(), Some(failure.describe())),
    };
    let host_ok = host_error.is_none()
        && !host_checks.is_empty()
        && host_checks
            .iter()
            .all(|check| check["status"].as_str() != Some("fail"));
    let ok = bridge.running || host_ok;

    if json {
        let report = OverviewReport {
            schema_version: 1,
            ok,
            action: "status",
            bridge: OverviewBridgeSection {
                running: bridge.running,
                endpoint_file: bridge.endpoint_file.clone(),
                base_url: bridge.base_url.clone(),
                error: bridge.error.clone(),
            },
            host: OverviewHostSection {
                ok: host_ok,
                checks: host_checks.clone(),
                error: host_error.clone(),
            },
        };
        crate::shared::print_json_projected(&report, query)?;
    } else if !ui.flags.quiet {
        println!("{}", style::bold("Desktop bridge"));
        print_human(&bridge);
        println!("{}", style::bold("Headless service"));
        if host_checks.is_empty() && host_error.is_none() {
            println!("  {}no checks ran", style::warn_prefix());
        }
        for check in &host_checks {
            println!(
                "  [{:<4}] {}: {}",
                check["status"].as_str().unwrap_or("?"),
                check["name"].as_str().unwrap_or("check"),
                check["detail"].as_str().unwrap_or("")
            );
        }
        if let Some(error) = &host_error {
            println!("  error: {error}");
        }
    }

    if ok {
        Ok(())
    } else if json {
        Err(crate::shared::JsonFailureExit.into())
    } else {
        bail!("no cognia control plane is reachable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    #[test]
    fn status_report_hides_dev_token_when_running() {
        let report = build_status_report(
            Some("C:/Users/dev/AppData/Roaming/cognia/cli-endpoint.json".into()),
            || {
                Ok(EndpointFile {
                    base_url: "http://127.0.0.1:4567".into(),
                    dev_token: "secret-token".into(),
                })
            },
            |_| Ok(()),
        );

        assert!(report.running);
        let json = serde_json::to_string(&report).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["action"], "status");
        assert!(json.contains("http://127.0.0.1:4567"));
        assert!(!json.contains("secret-token"));
    }

    #[test]
    fn status_report_carries_endpoint_loader_error() {
        let report = build_status_report(
            Some("missing.json".into()),
            || Err(anyhow!("no running cognia detected")),
            |_| Ok(()),
        );

        assert!(!report.running);
        assert_eq!(report.endpoint_file.as_deref(), Some("missing.json"));
        assert_eq!(report.base_url, None);
        assert!(report
            .error
            .as_deref()
            .unwrap()
            .contains("no running cognia detected"));
        let parsed = serde_json::to_value(&report).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["action"], "status");
    }

    #[test]
    fn status_report_carries_health_error_with_base_url() {
        let report = build_status_report(
            Some("endpoint.json".into()),
            || {
                Ok(EndpointFile {
                    base_url: "http://127.0.0.1:4567".into(),
                    dev_token: "secret-token".into(),
                })
            },
            |_| Err(anyhow!("could not reach bridge")),
        );

        assert!(!report.running);
        assert_eq!(report.base_url.as_deref(), Some("http://127.0.0.1:4567"));
        assert!(report.error.as_deref().unwrap().contains("could not reach"));
    }
}
