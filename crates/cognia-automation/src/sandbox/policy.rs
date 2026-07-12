// ADR-0028 — tool-name → `SandboxPolicy` resolver.
//
// The renderer-side `cognia-sandboxed-tools` plugin (Phase 4.5) hands each
// `sandbox_*` tool call to the Rust dispatcher; the dispatcher uses this
// module to derive a `SandboxPolicy` from the tool name plus the call's
// inputs (writable / readable paths the caller asked for). Pure: no I/O.
//
// Phase 4.5 wires `policy_for` into the `sandbox_exec` Tauri command;
// until then the function is exercised only by this file's unit tests.
#![allow(dead_code)]

use std::path::PathBuf;

use crate::sandbox::types::{NetworkPolicy, SandboxError, SandboxPolicy};

/// Input the renderer passes to the dispatcher. Fields are optional because
/// each tool only uses a subset — Bash uses `writable` + `readable` +
/// `network_hosts`; Edit/Write/TextEditor use `target_files` + `readable`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PolicyRequest {
    /// For Bash: writable directories. For others: ignored.
    pub writable: Vec<PathBuf>,
    /// Common to all tools: readable directories (additionalDirectories
    /// equivalent, plus system paths the tool needs like /usr on Linux).
    pub readable: Vec<PathBuf>,
    /// For Edit / Write / TextEditor: the exact files allowed to be
    /// written. Empty = the tool call is rejected (no write target).
    pub target_files: Vec<PathBuf>,
    /// For Bash: per-call CPU cap (seconds). 0 inherits the default from
    /// `bash_defaults()`.
    pub max_cpu_seconds: u32,
    /// For Bash: per-call memory cap (MB). 0 inherits the default.
    pub max_memory_mb: u32,
    /// For Bash: network shape. `"off"` (default), `"on"`, or `"allowlist"`
    /// (consumes `network_hosts`).
    pub network: Option<String>,
    /// For Bash + `network = "allowlist"`: the hosts to allow.
    pub network_hosts: Vec<String>,
}

/// Default Bash resource caps. Centralised so settings UI can surface these
/// as the baseline for per-character / per-app overrides in Phase 7. Picked
/// loose enough that typical `git status` / `npm install` are unaffected.
pub fn bash_defaults() -> (u32, u32) {
    (300, 2048) // 5 minutes, 2 GB
}

/// Translate a tool name + request into a `SandboxPolicy`. The `tool` arg
/// is the renderer-side MCP tool name with the `sandbox_` prefix stripped
/// (so `bash`, `edit`, `write`, `text_editor`). Rejects unknown tools and
/// invalid combinations.
pub fn policy_for(tool: &str, req: PolicyRequest) -> Result<SandboxPolicy, SandboxError> {
    match tool {
        "bash" => {
            let network = parse_network(req.network.as_deref(), req.network_hosts)?;
            let (default_cpu, default_mem) = bash_defaults();
            let cpu = if req.max_cpu_seconds == 0 {
                default_cpu
            } else {
                req.max_cpu_seconds
            };
            let mem = if req.max_memory_mb == 0 {
                default_mem
            } else {
                req.max_memory_mb
            };
            if req.writable.is_empty() {
                return Err(SandboxError::InvalidPolicy {
                    reason: "bash policy needs at least one writable dir (cwd)".into(),
                });
            }
            Ok(SandboxPolicy::Bash {
                writable: req.writable,
                readable: req.readable,
                network,
                max_cpu_seconds: cpu,
                max_memory_mb: mem,
            })
        }
        "edit" | "write" | "text_editor" => {
            if req.target_files.is_empty() {
                return Err(SandboxError::InvalidPolicy {
                    reason: format!("{tool} policy needs at least one target file"),
                });
            }
            match tool {
                "edit" => Ok(SandboxPolicy::Edit {
                    target_files: req.target_files,
                    readable: req.readable,
                }),
                "write" => Ok(SandboxPolicy::Write {
                    target_files: req.target_files,
                    readable: req.readable,
                }),
                "text_editor" => Ok(SandboxPolicy::TextEditor {
                    target_files: req.target_files,
                    readable: req.readable,
                }),
                _ => unreachable!(),
            }
        }
        other => Err(SandboxError::InvalidPolicy {
            reason: format!("unknown sandbox tool {other:?}"),
        }),
    }
}

fn parse_network(kind: Option<&str>, hosts: Vec<String>) -> Result<NetworkPolicy, SandboxError> {
    match kind.unwrap_or("off") {
        "off" => Ok(NetworkPolicy::Off),
        "on" => Ok(NetworkPolicy::On),
        "allowlist" => {
            if hosts.is_empty() {
                return Err(SandboxError::InvalidPolicy {
                    reason: "network=allowlist needs at least one host".into(),
                });
            }
            Ok(NetworkPolicy::Allowlist { hosts })
        }
        other => Err(SandboxError::InvalidPolicy {
            reason: format!("unknown network policy {other:?}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash_req() -> PolicyRequest {
        PolicyRequest {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/usr")],
            ..Default::default()
        }
    }

    #[test]
    fn bash_policy_uses_defaults_when_caps_zero() {
        let p = policy_for("bash", bash_req()).unwrap();
        let SandboxPolicy::Bash {
            max_cpu_seconds,
            max_memory_mb,
            network,
            ..
        } = p
        else {
            panic!("expected Bash variant");
        };
        let (default_cpu, default_mem) = bash_defaults();
        assert_eq!(max_cpu_seconds, default_cpu);
        assert_eq!(max_memory_mb, default_mem);
        // Network defaults to off.
        assert_eq!(network, NetworkPolicy::Off);
    }

    #[test]
    fn bash_policy_honours_custom_caps() {
        let req = PolicyRequest {
            max_cpu_seconds: 10,
            max_memory_mb: 256,
            ..bash_req()
        };
        let SandboxPolicy::Bash {
            max_cpu_seconds,
            max_memory_mb,
            ..
        } = policy_for("bash", req).unwrap()
        else {
            panic!()
        };
        assert_eq!(max_cpu_seconds, 10);
        assert_eq!(max_memory_mb, 256);
    }

    #[test]
    fn bash_policy_rejects_empty_writable() {
        let req = PolicyRequest {
            writable: vec![],
            ..bash_req()
        };
        let err = policy_for("bash", req).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[test]
    fn bash_network_allowlist_requires_hosts() {
        let req = PolicyRequest {
            network: Some("allowlist".into()),
            network_hosts: vec![],
            ..bash_req()
        };
        let err = policy_for("bash", req).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[test]
    fn bash_network_allowlist_passes_hosts_through() {
        let req = PolicyRequest {
            network: Some("allowlist".into()),
            network_hosts: vec!["api.anthropic.com".into(), "github.com".into()],
            ..bash_req()
        };
        let SandboxPolicy::Bash { network, .. } = policy_for("bash", req).unwrap() else {
            panic!()
        };
        match network {
            NetworkPolicy::Allowlist { hosts } => {
                assert_eq!(hosts, vec!["api.anthropic.com", "github.com"]);
            }
            _ => panic!("expected Allowlist"),
        }
    }

    #[test]
    fn edit_write_text_editor_require_target_files() {
        for tool in ["edit", "write", "text_editor"] {
            let req = PolicyRequest::default();
            let err = policy_for(tool, req).unwrap_err();
            assert!(matches!(err, SandboxError::InvalidPolicy { .. }), "{tool}");
        }
    }

    #[test]
    fn edit_emits_edit_variant() {
        let req = PolicyRequest {
            target_files: vec![PathBuf::from("/a.txt")],
            ..Default::default()
        };
        assert!(matches!(
            policy_for("edit", req),
            Ok(SandboxPolicy::Edit { .. })
        ));
    }

    #[test]
    fn write_emits_write_variant() {
        let req = PolicyRequest {
            target_files: vec![PathBuf::from("/a.txt")],
            ..Default::default()
        };
        assert!(matches!(
            policy_for("write", req),
            Ok(SandboxPolicy::Write { .. })
        ));
    }

    #[test]
    fn text_editor_emits_text_editor_variant() {
        let req = PolicyRequest {
            target_files: vec![PathBuf::from("/a.txt")],
            ..Default::default()
        };
        assert!(matches!(
            policy_for("text_editor", req),
            Ok(SandboxPolicy::TextEditor { .. })
        ));
    }

    #[test]
    fn unknown_tool_is_rejected() {
        let err = policy_for("not_a_tool", PolicyRequest::default()).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[test]
    fn invalid_network_kind_is_rejected() {
        let req = PolicyRequest {
            network: Some("maybe".into()),
            ..bash_req()
        };
        let err = policy_for("bash", req).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }
}
