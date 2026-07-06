//! `cognia plugin status` - probe the running desktop bridge.

use anyhow::{bail, Result};
use serde::Serialize;

use crate::http_client::{endpoint_file_path, load_endpoint, probe_health, EndpointFile};
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

pub fn run(json: bool, ui: &mut RuntimeUi) -> Result<()> {
    let report = probe_bridge_status();
    run_with_report(json, report, ui)
}

fn run_with_report(json: bool, report: BridgeStatusReport, ui: &mut RuntimeUi) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet {
        print_human(&report);
    }

    if report.running {
        Ok(())
    } else if json {
        Err(crate::JsonFailureExit.into())
    } else {
        bail!(
            "cognia CLI bridge is not running: {}",
            report.error.as_deref().unwrap_or("unknown status")
        )
    }
}

pub(crate) fn probe_bridge_status() -> BridgeStatusReport {
    let endpoint_file = endpoint_file_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    build_status_report(endpoint_file, load_endpoint, probe_health)
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
