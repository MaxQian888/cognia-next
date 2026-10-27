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
//!    `crate::program_in_allowlist` stem-matcher.

use super::super::errors::{coded, WasmErrorCode};
use super::super::store::HostState;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Live host-owned ledgers prevent a retained Store from keeping revoked
/// process permissions. No filesystem writes or renderer RPCs occur here.
type SharedLedger<T> =
    std::sync::Arc<parking_lot::RwLock<std::collections::HashMap<String, Vec<T>>>>;

#[derive(Clone)]
pub struct LiveProcessGrants {
    plugin_id: String,
    permissions: SharedLedger<crate::PermissionGrant>,
    programs: SharedLedger<String>,
}

impl LiveProcessGrants {
    pub fn new(runtime: &crate::PluginRuntimeState, plugin_id: &str) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            permissions: runtime.permissions.clone(),
            programs: runtime.shell_allowlist.clone(),
        }
    }

    fn permission_granted(&self) -> bool {
        self.permissions
            .read()
            .get(&self.plugin_id)
            .is_some_and(|grants| {
                grants.iter().any(|grant| {
                    matches!(grant.permission.as_str(), "process:spawn" | "shell:execute")
                        && !crate::grant_expired(grant)
                })
            })
    }

    fn program_allowed(&self, program: &str) -> bool {
        self.programs
            .read()
            .get(&self.plugin_id)
            .is_some_and(|allowed| crate::program_in_allowlist(allowed, program))
    }

    async fn revoked(self, program: String) {
        loop {
            if !self.permission_granted() || !self.program_allowed(&program) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// Per-activation cancellation, reachable without locking the running Store.
#[derive(Clone, Debug)]
pub struct ProcessCancellation(tokio::sync::watch::Sender<bool>);

impl Default for ProcessCancellation {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}

impl ProcessCancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    pub fn same_execution(&self, other: &Self) -> bool {
        self.0.same_channel(&other.0)
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

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

/// Both imports share the capability/allowlist boundary and async I/O runner.
/// `None` preserves legacy exec's null stdin and output size behavior. The new
/// stdin operation bounds both input and each output stream explicitly.
pub async fn execute(
    state: &mut HostState,
    program: String,
    args: Vec<String>,
    options: ExecOptions,
    input: Option<Vec<u8>>,
) -> Result<ExecResult, String> {
    check(state).map_err(|e| coded(WasmErrorCode::CapabilityDenied, e))?;
    validate(&program, &args).map_err(|e| coded(WasmErrorCode::InvalidRequest, e))?;
    check_program_allowed(state, &program)
        .map_err(|e| coded(WasmErrorCode::CapabilityDenied, e))?;
    if input
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_STDIN_BYTES)
    {
        return Err(coded(
            WasmErrorCode::PayloadTooLarge,
            "process stdin exceeds 4 MiB",
        ));
    }
    let output_limit = if input.is_some() {
        MAX_OUTPUT_BYTES
    } else {
        usize::MAX
    };
    let cancellation = state.process_cancel.clone();
    let live_grants = state.process_grants.clone();
    if cancellation.is_cancelled() {
        return Err(coded(
            WasmErrorCode::Cancelled,
            "plugin execution was cancelled",
        ));
    }
    let timeout_ms = options
        .timeout_ms
        .map(u64::from)
        .unwrap_or(state.call_timeout_ms)
        .min(state.call_timeout_ms)
        .max(1);
    let mut command = tokio::process::Command::new(&program);
    command
        .args(&args)
        .env_clear()
        .envs(options.env)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = options.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cognia_exec_sandbox::proc_group::apply_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| {
        coded(
            WasmErrorCode::ProviderError,
            format!("spawn {program}: {e}"),
        )
    })?;
    let mut group = ProcessGroup(child.id());
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdin = child.stdin.take();
    let work = async {
        // Drains and writes must progress together: any one pipe can fill
        // while the child is waiting on another. Dropping stdin signals EOF.
        let (stdout, stderr, ()) = tokio::try_join!(
            read_output(stdout, output_limit),
            read_output(stderr, output_limit),
            write_input(stdin, input),
        )?;
        let status = child
            .wait()
            .await
            .map_err(|e| coded(WasmErrorCode::ProviderError, format!("wait process: {e}")))?;
        Ok(ExecResult {
            code: status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    };
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(coded(WasmErrorCode::Cancelled, "plugin execution was cancelled")),
        _ = async {
            match live_grants {
                Some(grants) => grants.revoked(program.clone()).await,
                None => std::future::pending().await,
            }
        } => Err(coded(WasmErrorCode::CapabilityDenied, "process permission or program allowlist was revoked")),
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), work) =>
            result.unwrap_or_else(|_| Err(coded(WasmErrorCode::Timeout,
                format!("process exec timed out after {timeout_ms}ms")))),
    };
    if result.is_err() {
        cognia_exec_sandbox::proc_group::kill_process_group(group.0);
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    // An aborted host call still drops the guard and kills its process group.
    // On normal completion preserve legacy subprocess behavior.
    group.0 = None;
    result
}

struct ProcessGroup(Option<u32>);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        cognia_exec_sandbox::proc_group::kill_process_group(self.0);
    }
}

async fn write_input(
    stdin: Option<tokio::process::ChildStdin>,
    input: Option<Vec<u8>>,
) -> Result<(), String> {
    if let (Some(mut stdin), Some(input)) = (stdin, input) {
        if let Err(error) = stdin.write_all(&input).await {
            // Programs may deliberately close/ignore stdin. Preserve their
            // exit status and diagnostics instead of hiding them with EPIPE.
            if error.kind() != std::io::ErrorKind::BrokenPipe {
                return Err(coded(
                    WasmErrorCode::ProviderError,
                    format!("write stdin: {error}"),
                ));
            }
        }
    }
    Ok(())
}

async fn read_output(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await.map_err(|e| {
            coded(
                WasmErrorCode::ProviderError,
                format!("read process output: {e}"),
            )
        })?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            return Err(coded(
                WasmErrorCode::PayloadTooLarge,
                "process output exceeds 8 MiB",
            ));
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

pub fn check(state: &HostState) -> Result<(), String> {
    if state
        .process_grants
        .as_ref()
        .map(LiveProcessGrants::permission_granted)
        .unwrap_or_else(|| {
            state.capabilities.allows("process:spawn") || state.capabilities.allows("shell:execute")
        })
    {
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
    if state
        .process_grants
        .as_ref()
        .map(|grants| grants.program_allowed(program))
        .unwrap_or_else(|| crate::program_in_allowlist(&state.shell_allowlist, program))
    {
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
    use super::super::super::store::test_host_state;
    use super::*;

    #[test]
    fn legacy_exec_types_and_signature_are_unchanged() {
        let wit = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src-tauri/wit/cognia-plugin.wit"
        ));
        let compact: String = wit.split_whitespace().collect();
        assert!(compact.contains("recordexec-options{cwd:option<string>,env:list<tuple<string,string>>,timeout-ms:option<u32>,}"));
        assert!(compact.contains("recordexec-result{code:s32,stdout:list<u8>,stderr:list<u8>,}"));
        assert!(compact.contains("exec:func(program:string,args:list<string>,options:exec-options)->result<exec-result,string>;"));
    }

    #[tokio::test]
    async fn cancellation_is_observed_even_when_sent_before_subscribing() {
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
            .await
            .unwrap();
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn denied_requests_never_reach_process_creation() {
        let mut denied = st_with_allow(&[], &["not-installed"]);
        let err = execute(
            &mut denied,
            "not-installed".into(),
            vec![],
            ExecOptions::default(),
            Some(vec![0; MAX_STDIN_BYTES + 1]),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED:"));
        let mut unlisted = st_with_allow(&["process:spawn"], &[]);
        let err = execute(
            &mut unlisted,
            "not-installed".into(),
            vec![],
            ExecOptions::default(),
            Some(vec![]),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED:"));
        assert!(err.contains("shellCommands"));
        let mut allowed = st_with_allow(&["process:spawn"], &["not-installed"]);
        let err = execute(
            &mut allowed,
            "not-installed".into(),
            vec![],
            ExecOptions::default(),
            Some(vec![0; MAX_STDIN_BYTES + 1]),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("PAYLOAD_TOO_LARGE:"));
    }

    #[cfg(unix)]
    async fn shell(script: &str, input: Option<Vec<u8>>) -> Result<ExecResult, String> {
        let mut state = st_with_allow(&["process:spawn"], &["sh"]);
        execute(
            &mut state,
            "/bin/sh".into(),
            vec!["-c".into(), script.into()],
            ExecOptions {
                timeout_ms: Some(5000),
                ..Default::default()
            },
            input,
        )
        .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn binary_stdin_and_both_output_streams_make_progress_together() {
        let input: Vec<u8> = (0..262144).map(|n| (n % 256) as u8).collect();
        let output = shell(
            "/usr/bin/head -c 131072 /dev/zero; /usr/bin/head -c 131072 /dev/zero >&2; /bin/cat",
            Some(input.clone()),
        )
        .await
        .unwrap();
        assert_eq!(output.code, 0);
        assert_eq!(&output.stdout[131072..], input);
        assert_eq!(output.stderr, vec![0; 131072]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn null_and_empty_stdin_both_signal_eof() {
        for input in [None, Some(vec![])] {
            let output = shell("/bin/cat; printf eof", input).await.unwrap();
            assert_eq!(output.code, 0);
            assert_eq!(output.stdout, b"eof");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_exit_and_stderr_survive_closed_stdin() {
        let output = shell(
            "exec 0<&-; printf diagnostic >&2; exit 7",
            Some(vec![0; 262144]),
        )
        .await
        .unwrap();
        assert_eq!(output.code, 7);
        assert_eq!(output.stderr, b"diagnostic");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn new_operation_rejects_excess_output_instead_of_truncating() {
        let error = shell(
            &format!("/usr/bin/head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1),
            Some(vec![]),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("PAYLOAD_TOO_LARGE:"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_output_size_behavior_remains_available() {
        let output = shell(
            &format!("/usr/bin/head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1),
            None,
        )
        .await
        .unwrap();
        assert_eq!(output.stdout.len(), MAX_OUTPUT_BYTES + 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_environment_is_cleared_and_explicit_overrides_work() {
        let mut state = st_with_allow(&["process:spawn"], &["sh"]);
        let output = execute(
            &mut state,
            "/bin/sh".into(),
            vec![
                "-c".into(),
                "test -z \"${HOME+x}\" && printf %s \"$COGNIA_WASM_EXPLICIT\"".into(),
            ],
            ExecOptions {
                env: vec![("COGNIA_WASM_EXPLICIT".into(), "explicit".into())],
                ..Default::default()
            },
            Some(vec![]),
        )
        .await
        .unwrap();
        assert_eq!(output.code, 0);
        assert_eq!(output.stdout, b"explicit");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn requested_timeout_cannot_outlive_the_store_budget() {
        let mut state = st_with_allow(&["process:spawn"], &["sleep"]);
        state.call_timeout_ms = 50;
        let started = std::time::Instant::now();
        let error = execute(
            &mut state,
            "/bin/sleep".into(),
            vec!["10".into()],
            ExecOptions {
                timeout_ms: Some(5000),
                ..Default::default()
            },
            Some(vec![]),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("TIMEOUT:"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_stops_a_running_child() {
        let mut state = st_with_allow(&["process:spawn"], &["sleep"]);
        let cancellation = state.process_cancel.clone();
        let task = tokio::spawn(async move {
            execute(
                &mut state,
                "/bin/sleep".into(),
                vec!["10".into()],
                ExecOptions::default(),
                Some(vec![]),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancellation.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.starts_with("CANCELLED:"));
    }

    fn st(caps: &[&str]) -> HostState {
        st_with_allow(caps, &[])
    }

    fn st_with_allow(caps: &[&str], allow: &[&str]) -> HostState {
        let mut state = test_host_state("demo", caps);
        state.shell_allowlist = allow.iter().map(|s| (*s).to_string()).collect();
        state
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
