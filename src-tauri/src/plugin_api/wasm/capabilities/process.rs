//! `cognia:plugin/process` host import.
//!
//! Capability key: `process:spawn` (also accepts the looser `shell:execute`
//! alias for compatibility with the existing TS plugin permission set).
//!
//! Two gates apply to every `process.exec`, both DENY-by-default:
//! 1. `check` — the plugin must hold `process:spawn` (or `shell:execute`).
//! 2. `check_program_allowed` — the program must appear in the plugin's
//!    declared `shellCommands` allowlist (mirrored into `HostState` at
//!    activation). This is full parity with the TS `ctx.shell.execute` gate
//!    (`PluginRuntimeState::shell_command_allowed`); both share the
//!    `crate::plugin_api::program_in_allowlist` stem-matcher.

use super::super::store::HostState;

#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub fn check(state: &HostState) -> Result<(), String> {
    if state.capabilities.allows("process:spawn") || state.capabilities.allows("shell:execute") {
        Ok(())
    } else {
        Err(format!(
            "capability `process:spawn` not granted to plugin `{}`",
            state.plugin_id
        ))
    }
}

/// DENY-by-default program allowlist gate. The program must appear in the
/// plugin's declared `shellCommands` (mirrored into `HostState.shell_allowlist`
/// at activation). Shares the stem-matcher with the TS shell gate so `git`,
/// `git.exe`, and `/usr/bin/git` all match a declared `git`, but an undeclared
/// program is refused — even when the capability is granted.
pub fn check_program_allowed(state: &HostState, program: &str) -> Result<(), String> {
    if crate::plugin_api::program_in_allowlist(&state.shell_allowlist, program) {
        Ok(())
    } else {
        Err(format!(
            "process exec: program `{program}` is not in plugin `{}`'s declared shellCommands allowlist",
            state.plugin_id
        ))
    }
}

/// Light validator for the host-side runner. Rejects empty program names
/// and absurd argv lengths so a buggy plugin can't DoS the host by
/// pushing 10 GiB worth of arguments before the kernel rejects them.
pub fn validate(program: &str, args: &[String]) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("process exec: empty program name".into());
    }
    if args.len() > 1024 {
        return Err("process exec: argv too long (max 1024)".into());
    }
    for (i, a) in args.iter().enumerate() {
        if a.contains('\0') {
            return Err(format!("process exec: arg[{i}] contains NUL byte"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn st(caps: &[&str]) -> HostState {
        st_with_allow(caps, &[])
    }

    fn st_with_allow(caps: &[&str], allow: &[&str]) -> HostState {
        HostState {
            plugin_id: "demo".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            shell_allowlist: allow.iter().map(|s| (*s).to_string()).collect(),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn check_accepts_either_capability() {
        assert!(check(&st(&["process:spawn"])).is_ok());
        assert!(check(&st(&["shell:execute"])).is_ok());
        assert!(check(&st(&[])).is_err());
    }

    #[test]
    fn check_program_allowed_is_deny_by_default() {
        // No declared shellCommands → every program denied, even with cap.
        let state = st(&["process:spawn"]);
        assert!(check_program_allowed(&state, "git").is_err());
        assert!(check_program_allowed(&state, "echo").is_err());
    }

    #[test]
    fn check_program_allowed_matches_declared_program_by_stem() {
        let state = st_with_allow(&["process:spawn"], &["git", "node"]);
        assert!(check_program_allowed(&state, "git").is_ok());
        assert!(check_program_allowed(&state, "git.exe").is_ok()); // .exe stem tolerated
        assert!(check_program_allowed(&state, "/usr/bin/git").is_ok()); // absolute-path stem
        assert!(check_program_allowed(&state, "node").is_ok());
        assert!(check_program_allowed(&state, "rm").is_err()); // undeclared → denied
    }

    #[test]
    fn check_program_allowed_rejects_empty_program() {
        let state = st_with_allow(&["process:spawn"], &["git"]);
        assert!(check_program_allowed(&state, "   ").is_err());
    }

    #[test]
    fn validate_rejects_empty_program() {
        let err = validate("", &[]).unwrap_err();
        assert!(err.contains("empty program"));
        let err = validate("  \t", &[]).unwrap_err();
        assert!(err.contains("empty program"));
    }

    #[test]
    fn validate_rejects_oversized_argv() {
        let args: Vec<String> = (0..2000).map(|i| i.to_string()).collect();
        let err = validate("echo", &args).unwrap_err();
        assert!(err.contains("argv too long"));
    }

    #[test]
    fn validate_rejects_nul_bytes_in_args() {
        let args = vec!["ok".into(), "bad\0arg".into()];
        let err = validate("echo", &args).unwrap_err();
        assert!(err.contains("NUL byte"));
    }

    #[test]
    fn validate_passes_normal_argv() {
        assert!(validate("echo", &["hello".into(), "world".into()]).is_ok());
    }
}
