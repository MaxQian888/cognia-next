//! `cognia:plugin/process` host import.
//!
//! Capability key: `process:spawn` (also accepts the looser `shell:execute`
//! alias for compatibility with the existing TS plugin permission set).
//! Per-plugin allow-listing of programs lives in v0.2 — for now any granted
//! plugin can exec any user-runnable binary, which mirrors the trust model
//! of the existing TS `ctx.shell.execute`.

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
        HostState {
            plugin_id: "demo".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
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
