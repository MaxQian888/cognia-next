//! Background-job supervisor wiring.
//!
//! Owns the process-wide [`JobSupervisor`] and the `host_rpc` dispatcher the
//! sidecar calls into.
//!
//! Storage is a process-global slot rather than Tauri managed state, matching
//! the idiom in [`crate::headless`]: the headless `cognia-server` binary has no
//! `app.state::<T>()` to read from, and background jobs must work there. Both
//! entry points call [`install`] at boot; everything else reads [`supervisor`].

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use cognia_jobs::{
    JobOwner, JobStore, JobSupervisor, MonitorCondition, MonitorRegistry, SpawnJobRequest,
};
use serde_json::{json, Value};

static SUPERVISOR: OnceLock<Arc<JobSupervisor>> = OnceLock::new();
static MONITORS: OnceLock<Arc<MonitorRegistry>> = OnceLock::new();

/// Create the supervisor rooted at `data_dir` (`<app_data>/cognia`) and install
/// it process-wide. Idempotent: a second call returns the existing instance.
///
/// Runs boot reconcile as part of installation — rows left `running` by a
/// previous lifetime become `interrupted` BEFORE any spawn, so the concurrency
/// caps never count ghosts.
pub fn install(data_dir: PathBuf) -> Result<Arc<JobSupervisor>, String> {
    if let Some(existing) = SUPERVISOR.get() {
        return Ok(Arc::clone(existing));
    }
    let store_handle =
        Arc::new(JobStore::new(data_dir.join("jobs.sqlite")).map_err(|e| e.to_string())?);
    let supervisor = Arc::new(JobSupervisor::new(
        Arc::clone(&store_handle),
        data_dir.join("jobs"),
    ));
    match supervisor.reconcile_on_boot() {
        Ok(ids) if !ids.is_empty() => {
            log::info!(
                "jobs: {} job(s) from a previous run marked interrupted on boot",
                ids.len()
            );
        }
        Ok(_) => {}
        Err(e) => log::warn!("jobs: boot reconcile failed: {e}"),
    }
    // A racing installer wins harmlessly — both built an equivalent supervisor.
    let _ = SUPERVISOR.set(Arc::clone(&supervisor));
    let installed = Arc::clone(SUPERVISOR.get().unwrap_or(&supervisor));

    // Monitors share the supervisor's store, so a watch is visible to exactly
    // the same readers as the jobs it watches.
    let monitors = Arc::new(MonitorRegistry::new(
        Arc::clone(&store_handle),
        Arc::clone(&installed),
    ));
    match monitors.reconcile_on_boot() {
        Ok(ids) if !ids.is_empty() => {
            log::info!("jobs: resumed {} durable monitor(s) on boot", ids.len());
        }
        Ok(_) => {}
        Err(e) => log::warn!("jobs: monitor boot reconcile failed: {e}"),
    }
    let _ = MONITORS.set(monitors);

    Ok(installed)
}

/// The installed supervisor, or `None` before boot has run.
pub fn supervisor() -> Option<Arc<JobSupervisor>> {
    SUPERVISOR.get().cloned()
}

/// The installed monitor registry, or `None` before boot has run.
pub fn monitors() -> Option<Arc<MonitorRegistry>> {
    MONITORS.get().cloned()
}

fn require_monitors() -> Result<Arc<MonitorRegistry>, String> {
    monitors().ok_or_else(|| "monitors are not available on this host".to_string())
}

fn require_supervisor() -> Result<Arc<JobSupervisor>, String> {
    supervisor().ok_or_else(|| "background jobs are not available on this host".to_string())
}

/// Parse the `owner` field shared by most methods.
fn owner_from(params: &Value) -> Result<JobOwner, String> {
    serde_json::from_value(params.get("owner").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("invalid owner: {e}"))
}

fn str_field(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing required field `{key}`"))
}

fn u64_field(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

/// Dispatch one `host_rpc` frame. Returns the value to put in `result`.
///
/// Every arm is answered here in Rust — nothing is forwarded to the renderer,
/// which is what lets the same call succeed headless and under remote driving.
pub async fn dispatch_host_rpc(method: &str, params: &Value) -> Result<Value, String> {
    let sup = require_supervisor()?;
    match method {
        "jobs.spawn" => {
            let req: SpawnJobRequest = serde_json::from_value(params.clone())
                .map_err(|e| format!("invalid spawn request: {e}"))?;
            let rec = sup.spawn(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "jobs.read" => {
            let id = str_field(params, "jobId")?;
            let from = u64_field(params, "fromOffset", 0);
            let max = u64_field(params, "maxBytes", 30_000) as usize;
            let slice = sup.read(&id, from, max).map_err(|e| e.to_string())?;
            serde_json::to_value(slice).map_err(|e| e.to_string())
        }
        "jobs.wait" => {
            let id = str_field(params, "jobId")?;
            let from = u64_field(params, "fromOffset", 0);
            let max = u64_field(params, "maxBytes", 30_000) as usize;
            // Bounded host-side so a caller cannot pin a worker indefinitely;
            // the sidecar's own schema already caps this at 30s.
            let wait_ms = u64_field(params, "waitMs", 0).min(30_000);
            let slice = sup
                .wait_for_output(&id, from, max, Duration::from_millis(wait_ms))
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(slice).map_err(|e| e.to_string())
        }
        "jobs.kill" => {
            let id = str_field(params, "jobId")?;
            // `requester` present ⇒ scoped permission check. The sidecar always
            // sends it, so an agent can never reach another session's job.
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            let rec = sup
                .kill(&id, requester.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "jobs.killByPid" => {
            let pid = params
                .get("pid")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "missing required field `pid`".to_string())?
                as u32;
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            // `matched: false` is a normal answer, not an error — it tells the
            // caller the pid is not a job so it may fall back to a raw signal.
            match sup
                .kill_by_pid(pid, requester.as_ref())
                .await
                .map_err(|e| e.to_string())?
            {
                Some(rec) => Ok(json!({ "matched": true, "job": rec })),
                None => Ok(json!({ "matched": false })),
            }
        }
        "jobs.list" => {
            let owner = match params.get("owner") {
                Some(Value::Null) | None => None,
                Some(_) => Some(owner_from(params)?),
            };
            let rows = sup.list(owner.as_ref()).map_err(|e| e.to_string())?;
            Ok(json!({ "jobs": rows }))
        }
        "jobs.killOwnedBy" => {
            let owner = owner_from(params)?;
            let ids = sup.kill_owned_by(&owner).await.map_err(|e| e.to_string())?;
            Ok(json!({ "killed": ids }))
        }
        // --- monitors ------------------------------------------------------
        // Registration and waiting are SEPARATE calls on purpose: that is what
        // lets the sidecar block for a while and then stop blocking without
        // losing the watch, which is the whole blocking→async degradation.
        "monitors.register" => {
            let reg = require_monitors()?;
            let condition: MonitorCondition =
                serde_json::from_value(params.get("condition").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("invalid condition: {e}"))?;
            let owner = owner_from(params)?;
            let expires_at_ms = params.get("expiresAtMs").and_then(|v| v.as_i64());
            let label = params
                .get("label")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let rec = reg
                .register(condition, owner, expires_at_ms, label)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.wait" => {
            let reg = require_monitors()?;
            let id = str_field(params, "monitorId")?;
            // Bounded host-side so one caller cannot pin a worker forever.
            let wait_ms = u64_field(params, "waitMs", 0).min(60_000);
            let rec = reg
                .wait(&id, Duration::from_millis(wait_ms))
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.cancel" => {
            let reg = require_monitors()?;
            let id = str_field(params, "monitorId")?;
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            let rec = reg
                .cancel(&id, requester.as_ref())
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.list" => {
            let reg = require_monitors()?;
            let owner = match params.get("owner") {
                Some(Value::Null) | None => None,
                Some(_) => Some(owner_from(params)?),
            };
            let rows = reg.list(owner.as_ref()).map_err(|e| e.to_string())?;
            Ok(json!({ "monitors": rows }))
        }
        // Called by the renderer/scheduler when a background subagent settles
        // or a scheduled task's run finishes — the linkage that lets an agent
        // wait on work it did not start.
        "monitors.signalUpstream" => {
            let reg = require_monitors()?;
            let source = str_field(params, "source")?;
            let id = str_field(params, "id")?;
            let fired = reg
                .signal_upstream(&source, &id)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "fired": fired }))
        }
        other => Err(format!("unknown host_rpc method `{other}`")),
    }
}

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

#[tauri::command]
pub async fn background_job_spawn_scheduled(
    task_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    if command.trim().is_empty() {
        return Err("background command must not be empty".to_string());
    }
    #[cfg(windows)]
    let (program, args) = (
        "powershell.exe".to_string(),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            command.clone(),
        ],
    );
    #[cfg(not(windows))]
    let (program, args) = (
        "/bin/sh".to_string(),
        vec!["-lc".to_string(), command.clone()],
    );

    dispatch_host_rpc(
        "jobs.spawn",
        &serde_json::to_value(SpawnJobRequest {
            command,
            program,
            args,
            cwd,
            env: Default::default(),
            owner: JobOwner::ScheduledTask { task_id },
            windows_verbatim_arguments: false,
            label,
        })
        .map_err(|e| e.to_string())?,
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
    use super::*;

    #[test]
    fn str_field_reports_the_missing_key_by_name() {
        let params = json!({});
        let err = str_field(&params, "jobId").unwrap_err();
        assert!(err.contains("jobId"), "got {err}");
    }

    #[test]
    fn str_field_reads_a_present_value() {
        assert_eq!(str_field(&json!({ "jobId": "j1" }), "jobId").unwrap(), "j1");
    }

    #[test]
    fn u64_field_falls_back_to_the_default_for_missing_or_wrong_types() {
        let params = json!({ "a": 7, "b": "not-a-number" });
        assert_eq!(u64_field(&params, "a", 1), 7);
        assert_eq!(u64_field(&params, "b", 1), 1);
        assert_eq!(u64_field(&params, "missing", 42), 42);
    }

    #[test]
    fn owner_parses_each_tagged_variant() {
        let s = owner_from(&json!({ "owner": { "kind": "session", "sessionId": "s1" } })).unwrap();
        assert_eq!(
            s,
            JobOwner::Session {
                session_id: "s1".into()
            }
        );
        let a = owner_from(&json!({ "owner": { "kind": "app" } })).unwrap();
        assert_eq!(a, JobOwner::App);
    }

    #[test]
    fn owner_rejects_an_unknown_kind_instead_of_defaulting() {
        // Silently defaulting to `App` would quietly widen a job's lifetime
        // past what the caller asked for.
        assert!(owner_from(&json!({ "owner": { "kind": "nonsense" } })).is_err());
        assert!(owner_from(&json!({})).is_err());
    }

    #[tokio::test]
    async fn an_unknown_method_is_rejected_by_name() {
        // Runs before any `install`, so it also pins the not-available path.
        let err = dispatch_host_rpc("jobs.teleport", &json!({}))
            .await
            .unwrap_err();
        assert!(
            err.contains("not available") || err.contains("jobs.teleport"),
            "got {err}"
        );
    }
}
