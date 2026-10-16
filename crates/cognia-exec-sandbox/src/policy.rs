// ADR-0028 — tool-name → `SandboxPolicy` resolver.
//
// The renderer-side `cognia-sandboxed-tools` plugin (Phase 4.5) hands each
// `sandbox_*` tool call to the Rust dispatcher; the dispatcher uses this
// module to derive a `SandboxPolicy` from the tool name plus the call's
// inputs (writable / readable paths the caller asked for). When the host supplies
// a read ceiling, paths are canonicalized before containment is checked.
//
// `cognia-automation`'s `sandbox_exec` command and the `cognia-sandbox-exec`
// CLI helper both use `policy_for` before entering `run_confined`.

use std::path::PathBuf;

use crate::types::{NetworkPolicy, SandboxError, SandboxPolicy};

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
    /// Host-resolved read ceiling, stamped after model request clamping. Empty
    /// preserves legacy callers; nonempty roots are checked after symlink
    /// resolution as well as the frontend's lexical preflight.
    pub readable_roots: Vec<PathBuf>,
    /// For Edit / Write / TextEditor: the exact files allowed to be
    /// written. Empty = the tool call is rejected (no write target).
    pub target_files: Vec<PathBuf>,
    /// For Bash: per-call CPU cap (seconds). 0 inherits the default from
    /// `bash_defaults()`.
    pub max_cpu_seconds: u32,
    /// For Bash: per-call memory cap (MB). 0 inherits the default.
    pub max_memory_mb: u32,
    /// For Bash: per-call process-count cap for the whole sandboxed tree.
    /// 0 inherits `BASH_DEFAULT_MAX_PROCESSES`. Honoured on Linux
    /// (`RLIMIT_NPROC` inside the unshared user namespace) and Windows (Job
    /// Object `ActiveProcessLimit`); macOS has no per-tree primitive, so
    /// the backend documents the gap rather than applying a uid-wide limit.
    pub max_processes: u32,
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

/// Default process ceiling for a Bash sandbox — the same bound the container
/// tiers apply (the runner's pids-limit default). On Linux it lands as
/// `RLIMIT_NPROC` inside the unshared user namespace, so it counts only the
/// sandbox's own tree; on Windows it is the Job Object's `ActiveProcessLimit`.
/// 512 is comfortably above a `make -j` fan-out and far below a fork bomb.
pub const BASH_DEFAULT_MAX_PROCESSES: u32 = 512;

/// Translate a tool name + request into a `SandboxPolicy`. The `tool` arg
/// is the renderer-side MCP tool name with the `sandbox_` prefix stripped
/// (so `bash`, `edit`, `write`, `text_editor`). Rejects unknown tools and
/// invalid combinations.
pub fn policy_for(tool: &str, mut req: PolicyRequest) -> Result<SandboxPolicy, SandboxError> {
    req.readable = clamp_readable(req.readable, &req.readable_roots)?;
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
            let processes = if req.max_processes == 0 {
                BASH_DEFAULT_MAX_PROCESSES
            } else {
                req.max_processes
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
                max_processes: processes,
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

fn clamp_readable(
    requested: Vec<PathBuf>,
    roots: &[PathBuf],
) -> Result<Vec<PathBuf>, SandboxError> {
    if roots.is_empty() {
        return Ok(requested);
    }
    let canonicalize = |paths: &[PathBuf]| {
        crate::paths::safe_canonicalize_all(paths).map_err(|error| SandboxError::InvalidPolicy {
            reason: format!("readable scope: {error}; configure Settings → Sandbox readable roots"),
        })
    };
    let roots = canonicalize(roots)?;
    let requested = canonicalize(&requested)?;
    let mut narrowed = Vec::new();
    for path in requested {
        let matches: Vec<PathBuf> = if roots.iter().any(|root| path_under_root(&path, root)) {
            vec![path.clone()]
        } else {
            roots
                .iter()
                .filter(|root| path_under_root(root, &path))
                .cloned()
                .collect()
        };
        if matches.is_empty() {
            return Err(SandboxError::InvalidPolicy {
                reason: format!(
                    "readable path {} outside the configured read ceiling; configure Settings → Sandbox readable roots",
                    path.display()
                ),
            });
        }
        for matched in matches {
            if !narrowed.contains(&matched) {
                narrowed.push(matched);
            }
        }
    }
    Ok(narrowed)
}

fn path_under_root(path: &std::path::Path, root: &std::path::Path) -> bool {
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
    #[cfg(windows)]
    {
        let path: Vec<_> = path.components().collect();
        let root: Vec<_> = root.components().collect();
        path.len() >= root.len()
            && path.iter().zip(root.iter()).all(|(a, b)| {
                a.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
            })
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

    fn scoped_read_request(readable: Vec<PathBuf>, roots: Vec<PathBuf>) -> PolicyRequest {
        serde_json::from_value(serde_json::json!({
            "writable": [std::env::temp_dir()],
            "readable": readable,
            "readableRoots": roots,
        }))
        .unwrap()
    }

    #[test]
    fn readable_ceiling_keeps_descendants_and_narrows_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("project");
        let inside = root.join("src");
        for (requested, expected) in [
            (inside.clone(), vec![inside]),
            (base, vec![root.clone()]),
        ] {
            let req = scoped_read_request(vec![requested], vec![root.clone()]);
            let SandboxPolicy::Bash { readable, .. } = policy_for("bash", req).unwrap() else {
                panic!("expected Bash variant");
            };
            assert_eq!(readable, expected);
        }
    }

    #[test]
    fn readable_ceiling_refuses_outside_and_component_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        for requested in [base.join("other"), base.join("project-other")] {
            let req = scoped_read_request(vec![requested], vec![base.join("project")]);
            let error = policy_for("bash", req).unwrap_err().to_string();
            assert!(error.contains("Settings → Sandbox readable roots"), "{error}");
        }
    }

    #[test]
    fn absent_readable_ceiling_preserves_the_request() {
        let req = bash_req();
        let expected = req.readable.clone();
        let SandboxPolicy::Bash { readable, .. } = policy_for("bash", req).unwrap() else {
            panic!("expected Bash variant");
        };
        assert_eq!(readable, expected);
    }

    #[cfg(unix)]
    #[test]
    fn readable_ceiling_resolves_symlinks_before_containment() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let req = scoped_read_request(vec![link], vec![root]);
        assert!(policy_for("bash", req).is_err());
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
            max_processes: 64,
            ..bash_req()
        };
        let SandboxPolicy::Bash {
            max_cpu_seconds,
            max_memory_mb,
            max_processes,
            ..
        } = policy_for("bash", req).unwrap()
        else {
            panic!()
        };
        assert_eq!(max_cpu_seconds, 10);
        assert_eq!(max_memory_mb, 256);
        assert_eq!(max_processes, 64);
    }

    #[test]
    fn bash_policy_defaults_the_process_cap() {
        let SandboxPolicy::Bash { max_processes, .. } = policy_for("bash", bash_req()).unwrap()
        else {
            panic!("expected Bash variant")
        };
        assert_eq!(max_processes, BASH_DEFAULT_MAX_PROCESSES);
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
