//! ADR-0028 / T2 — Node 24 `--permission` argv composer (Rust side).
//!
//! Mirrors `lib/plugin/launcher/launchPluginJs.ts:nodePermissionArgs` so
//! the Tauri-side spawn handler can derive the `--allow-*` flags from a
//! plugin manifest without trusting renderer-supplied argv. The
//! ADR-0028 V1 ships the helper; the actual `Command::new("node")`
//! invocation will be wired by the upcoming plugin-system refactor
//! (the TS-side helper has the same disclaimer at the top of
//! `launchPluginJs.ts`).
//!
//! Permissions follow Node's strict deny-by-default model:
//!   - `--permission` enables the model.
//!   - `--allow-fs-read=<csv>` / `--allow-fs-write=<csv>` accept paths.
//!   - `--allow-net=<csv>` accepts hosts.
//!   - `--allow-child-process=<csv>` accepts subprocess names.
//!
//! Empty lists are **omitted**, not expanded to `*`. The fail-safe is
//! deny — callers must supply concrete paths / hosts for a path to
//! become reachable.

use serde::{Deserialize, Serialize};

/// Concrete capability bundle the spawn handler builds from the plugin
/// manifest before composing the argv.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePermissionScope {
    /// Absolute read-allowed paths.
    #[serde(default)]
    pub read_paths: Vec<String>,
    /// Absolute write-allowed paths.
    #[serde(default)]
    pub write_paths: Vec<String>,
    /// Hostnames the plugin may reach (for `--allow-net`).
    #[serde(default)]
    pub net_hosts: Vec<String>,
    /// Sub-program names the plugin may spawn.
    #[serde(default)]
    pub allowed_subprocesses: Vec<String>,
}

/// Compose the `--permission --allow-*` prefix for a Node 24 spawn.
/// Returns the argv WITHOUT the entry path / extra args — callers
/// append those themselves.
pub fn node_permission_args(scope: &NodePermissionScope) -> Vec<String> {
    let mut args: Vec<String> = vec!["--permission".into()];
    if !scope.read_paths.is_empty() {
        args.push(format!("--allow-fs-read={}", scope.read_paths.join(",")));
    }
    if !scope.write_paths.is_empty() {
        args.push(format!("--allow-fs-write={}", scope.write_paths.join(",")));
    }
    if !scope.net_hosts.is_empty() {
        args.push(format!("--allow-net={}", scope.net_hosts.join(",")));
    }
    if !scope.allowed_subprocesses.is_empty() {
        args.push(format!(
            "--allow-child-process={}",
            scope.allowed_subprocesses.join(",")
        ));
    }
    args
}

/// Compose the full `node` argv for a plugin entry: permission prefix
/// + entry path + extra args.
pub fn build_launch_argv(
    entry_path: &str,
    scope: &NodePermissionScope,
    extra_args: &[String],
) -> Vec<String> {
    let mut argv = node_permission_args(scope);
    argv.push(entry_path.into());
    argv.extend(extra_args.iter().cloned());
    argv
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgvArgs {
    pub entry_path: String,
    #[serde(default)]
    pub scope: NodePermissionScope,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

/// Tauri command — returns the composed argv. Stable shape locked in
/// for the upcoming spawn handler; callers should pass the result to
/// `Command::new("node").args(...)` once the host is wired.
#[tauri::command]
pub async fn plugin_node_permission_argv(
    args: LaunchArgvArgs,
) -> std::result::Result<Vec<String>, String> {
    Ok(build_launch_argv(
        &args.entry_path,
        &args.scope,
        &args.extra_args,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_scope_emits_only_the_permission_switch() {
        assert_eq!(
            node_permission_args(&NodePermissionScope::default()),
            vec!["--permission"]
        );
    }

    #[test]
    fn each_capability_translates_to_its_flag() {
        let scope = NodePermissionScope {
            read_paths: vec!["/tmp/cognia/in".into()],
            write_paths: vec!["/tmp/cognia/out".into(), "/tmp/cognia/scratch".into()],
            net_hosts: vec!["api.example.com".into()],
            allowed_subprocesses: vec!["git".into(), "curl".into()],
        };
        let argv = node_permission_args(&scope);
        assert_eq!(
            argv,
            vec![
                "--permission".to_string(),
                "--allow-fs-read=/tmp/cognia/in".to_string(),
                "--allow-fs-write=/tmp/cognia/out,/tmp/cognia/scratch".to_string(),
                "--allow-net=api.example.com".to_string(),
                "--allow-child-process=git,curl".to_string(),
            ]
        );
    }

    #[test]
    fn build_launch_argv_prefixes_permission_and_appends_entry_and_args() {
        let scope = NodePermissionScope {
            read_paths: vec!["/etc/hosts".into()],
            ..Default::default()
        };
        let argv = build_launch_argv(
            "plugins/my-plugin/index.mjs",
            &scope,
            &["--watch".into(), "--port=8080".into()],
        );
        assert_eq!(
            argv,
            vec![
                "--permission".to_string(),
                "--allow-fs-read=/etc/hosts".to_string(),
                "plugins/my-plugin/index.mjs".to_string(),
                "--watch".to_string(),
                "--port=8080".to_string(),
            ]
        );
    }

    #[test]
    fn empty_lists_are_omitted_not_starred() {
        // Fail-safe = deny: an empty `net_hosts` must NOT become
        // `--allow-net=*`, otherwise a buggy manifest auto-opens the net.
        let scope = NodePermissionScope {
            net_hosts: vec![],
            ..Default::default()
        };
        let argv = node_permission_args(&scope);
        assert!(!argv.iter().any(|a| a.starts_with("--allow-net")));
    }

    #[test]
    fn comma_separation_uses_no_padding() {
        let scope = NodePermissionScope {
            read_paths: vec!["/a".into(), "/b".into(), "/c".into()],
            ..Default::default()
        };
        let argv = node_permission_args(&scope);
        assert_eq!(argv[1], "--allow-fs-read=/a,/b,/c");
    }
}
