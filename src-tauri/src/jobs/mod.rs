//! Desktop command shells for the shared background-job host runtime.

pub use cognia_jobs::host::{dispatch_host_rpc, install, monitors, supervisor};
use cognia_jobs::{JobOwner, MonitorCondition, SpawnJobRequest};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Renderer/remote-controller projection of the same supervisor used by the
/// sidecar. These commands intentionally return the wire JSON unchanged so
/// desktop, mobile, and headless Companion clients share one contract.
#[tauri::command]
pub async fn background_job_list(owner: Option<JobOwner>) -> Result<Value, String> {
    dispatch_host_rpc("jobs.list", &json!({ "owner": owner })).await
}

#[tauri::command]
pub async fn background_job_read(
    job_id: String,
    from_offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "jobs.read",
        &json!({
            "jobId": job_id,
            "fromOffset": from_offset.unwrap_or(0),
            "maxBytes": max_bytes.unwrap_or(30_000),
        }),
    )
    .await
}

#[tauri::command]
pub async fn background_job_kill(job_id: String) -> Result<Value, String> {
    // No requester means the trusted user-facing control surface may stop any
    // owner. Agent calls always use host_rpc directly and include a requester.
    dispatch_host_rpc("jobs.kill", &json!({ "jobId": job_id })).await
}

/// The platform shell a command string runs under. Shared by every
/// renderer-facing spawn so a scheduled script and a bridge command are parsed
/// by the same interpreter.
fn shell_invocation(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )
    }
    #[cfg(not(windows))]
    {
        (
            "/bin/sh".to_string(),
            vec!["-lc".to_string(), command.to_string()],
        )
    }
}

async fn spawn_shell_job(
    command: String,
    cwd: PathBuf,
    owner: JobOwner,
    label: Option<String>,
) -> Result<Value, String> {
    if command.trim().is_empty() {
        return Err("background command must not be empty".to_string());
    }
    let (program, args) = shell_invocation(&command);
    spawn_job(command, program, args, cwd, owner, label).await
}

/// Hand a fully formed argv to the supervisor. `command` is the display line
/// the Job Center shows; `program` + `args` are what actually runs.
async fn spawn_job(
    command: String,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    owner: JobOwner,
    label: Option<String>,
) -> Result<Value, String> {
    spawn_job_with_env(
        command,
        program,
        args,
        cwd,
        Default::default(),
        owner,
        label,
    )
    .await
}

async fn spawn_job_with_env(
    command: String,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    owner: JobOwner,
    label: Option<String>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "jobs.spawn",
        &serde_json::to_value(SpawnJobRequest {
            command,
            program,
            args,
            cwd,
            env,
            owner,
            windows_verbatim_arguments: false,
            label,
        })
        .map_err(|e| e.to_string())?,
    )
    .await
}

#[tauri::command]
pub async fn background_job_spawn_scheduled(
    task_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    spawn_shell_job(command, cwd, JobOwner::ScheduledTask { task_id }, label).await
}

/// Owner-session prefix of every job an External Bridge MCP client starts.
/// One synthetic session per client keeps the per-session job cap, listing and
/// `killOwnedBy` scoped to that client, and the prefix means this command can
/// never mint a job that impersonates a real chat session.
pub const BRIDGE_JOB_SESSION_PREFIX: &str = "external-bridge:jobs:";

/// The owner session for a bridge client, or an error for an id that could
/// smuggle a different session (empty, oversized, or outside `[A-Za-z0-9._:-]`).
fn bridge_job_owner(client_id: &str) -> Result<JobOwner, String> {
    let valid = !client_id.is_empty()
        && client_id.len() <= 160
        && client_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid {
        return Err("invalid bridge client id".to_string());
    }
    Ok(JobOwner::Session {
        session_id: format!("{BRIDGE_JOB_SESSION_PREFIX}{client_id}"),
    })
}

/// Start a shell command for an External Bridge MCP client (`shell_run`).
/// Desktop-local: the renderer has already resolved `cwd` inside a workspace
/// root the client was granted and run the command-safety classifier.
#[tauri::command]
pub async fn background_job_spawn_bridge(
    client_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    let owner = bridge_job_owner(&client_id)?;
    spawn_shell_job(command, cwd, owner, label).await
}

/// Owner-session prefix of every job a chat composer's `!` line starts.
///
/// Prefixed, not the bare chat session id, for two reasons. The sidecar reaps
/// every job owned by `Session { session_id }` when that conversation's agent
/// session tears down (`sidecar/src/tools/session.ts`), which would kill a
/// build the user moved to the background. And a paired client calling this
/// command must not be able to mint a job the agent then lists and reads as one
/// of its own shells. The prefix keeps the user's jobs out of the agent's
/// `list_shells`, its kill scope and its per-session job cap.
pub const CHAT_SHELL_JOB_SESSION_PREFIX: &str = "chat-shell:";

/// The owner a chat session's `!` jobs are filed under, or an error for an id
/// that could smuggle a different session (empty, oversized, or outside
/// `[A-Za-z0-9._:-]`).
fn chat_shell_job_owner(session_id: &str) -> Result<JobOwner, String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 160
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid {
        return Err("invalid chat session id".to_string());
    }
    Ok(JobOwner::Session {
        session_id: format!("{CHAT_SHELL_JOB_SESSION_PREFIX}{session_id}"),
    })
}

/// Start a chat composer's `!` line as a supervised job.
///
/// Takes explicit argv rather than a command string: the renderer builds it
/// from the user's configured shell (`lib/shell-intelligence/shell-argv.ts`),
/// so a `fish` or `pwsh` user's line is parsed by their shell, not by the
/// host's `/bin/sh`. `command` is the line as typed, kept for display.
#[tauri::command]
pub async fn background_job_spawn_session(
    session_id: String,
    command: String,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    let owner = chat_shell_job_owner(&session_id)?;
    if command.trim().is_empty() {
        return Err("background command must not be empty".to_string());
    }
    if program.trim().is_empty() {
        return Err("background job program must not be empty".to_string());
    }
    spawn_job_with_env(command, program, args, cwd, inherited_env(), owner, label).await
}

/// The host process environment, as `terminal_exec` hands it to its child.
///
/// The supervisor spawns under `env_clear()`, so a job sent without an env
/// would start with no `PATH` or `HOME`: `!pnpm build` would fail to find
/// `pnpm`, and a login shell could not find the user's profile. A `!` line
/// used to run through `terminal_exec`, which inherits this environment, and
/// moving it onto the supervisor must not change what the line can see.
/// Non-UTF-8 entries are skipped because the wire format is JSON strings.
fn inherited_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// Long-poll a job's output: returns as soon as bytes past `from_offset` land
/// or the job settles, or after `wait_ms` (capped at 30s host-side).
#[tauri::command]
pub async fn background_job_wait(
    job_id: String,
    from_offset: Option<u64>,
    max_bytes: Option<u64>,
    wait_ms: Option<u64>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "jobs.wait",
        &json!({
            "jobId": job_id,
            "fromOffset": from_offset.unwrap_or(0),
            "maxBytes": max_bytes.unwrap_or(30_000),
            "waitMs": wait_ms.unwrap_or(0),
        }),
    )
    .await
}

#[tauri::command]
pub async fn background_monitor_list(owner: Option<JobOwner>) -> Result<Value, String> {
    dispatch_host_rpc("monitors.list", &json!({ "owner": owner })).await
}

#[tauri::command]
pub async fn background_monitor_cancel(monitor_id: String) -> Result<Value, String> {
    dispatch_host_rpc("monitors.cancel", &json!({ "monitorId": monitor_id })).await
}

#[tauri::command]
pub async fn background_monitor_register_scheduled(
    task_id: String,
    condition: MonitorCondition,
    expires_at_ms: Option<i64>,
    label: Option<String>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "monitors.register",
        &json!({
            "condition": condition,
            "owner": JobOwner::ScheduledTask { task_id },
            "expiresAtMs": expires_at_ms,
            "label": label,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn scheduled_job_rejects_empty_commands_before_spawning() {
        let result = super::background_job_spawn_scheduled(
            "task-1".into(),
            "  ".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(result.unwrap_err(), "background command must not be empty");
    }

    #[tokio::test]
    async fn bridge_job_rejects_empty_commands_before_spawning() {
        let result = super::background_job_spawn_bridge(
            "client-a".into(),
            " ".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(result.unwrap_err(), "background command must not be empty");
    }

    #[test]
    fn bridge_job_owner_is_a_prefixed_session() {
        let owner = super::bridge_job_owner("mcp:client-7").unwrap();
        assert_eq!(
            owner,
            cognia_jobs::JobOwner::Session {
                session_id: "external-bridge:jobs:mcp:client-7".into()
            }
        );
    }

    #[test]
    fn bridge_job_owner_refuses_ids_that_could_smuggle_a_session() {
        for bad in ["", "a/b", "a b", "x\ny", &"a".repeat(161)] {
            assert!(
                super::bridge_job_owner(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn chat_shell_job_owner_is_a_prefixed_session() {
        let owner = super::chat_shell_job_owner("sess_abc-1").unwrap();
        assert_eq!(
            owner,
            cognia_jobs::JobOwner::Session {
                session_id: "chat-shell:sess_abc-1".into()
            }
        );
    }

    #[test]
    fn chat_shell_job_owner_refuses_ids_that_could_smuggle_a_session() {
        for bad in ["", "a/b", "a b", "x\ny", &"a".repeat(161)] {
            assert!(
                super::chat_shell_job_owner(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn inherited_env_carries_the_host_path() {
        let env = super::inherited_env();
        if let Ok(path) = std::env::var("PATH") {
            assert_eq!(env.get("PATH"), Some(&path));
        }
    }

    #[tokio::test]
    async fn session_job_rejects_an_invalid_session_before_spawning() {
        let result = super::background_job_spawn_session(
            "../other".into(),
            "echo hi".into(),
            "/bin/sh".into(),
            vec!["-lc".into(), "echo hi".into()],
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(result.unwrap_err(), "invalid chat session id");
    }

    #[tokio::test]
    async fn session_job_rejects_empty_commands_and_programs_before_spawning() {
        let empty_command = super::background_job_spawn_session(
            "sess-1".into(),
            "  ".into(),
            "/bin/sh".into(),
            vec![],
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(
            empty_command.unwrap_err(),
            "background command must not be empty"
        );
        let empty_program = super::background_job_spawn_session(
            "sess-1".into(),
            "echo hi".into(),
            " ".into(),
            vec!["-c".into(), "echo hi".into()],
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(
            empty_program.unwrap_err(),
            "background job program must not be empty"
        );
    }

    #[tokio::test]
    async fn bridge_job_rejects_an_invalid_client_before_spawning() {
        let result = super::background_job_spawn_bridge(
            "../chat".into(),
            "echo hi".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(result.unwrap_err(), "invalid bridge client id");
    }
}
