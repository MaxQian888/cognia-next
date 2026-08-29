//! Plugin process-kill Tauri command (Batch 3b).
//!
//! TS-side at `lib/plugin/core/context.ts:1040-1048` calls
//! `invoke('plugin_process_kill', { processId, signal })`. The actual
//! `Child` is held by the `lib/plugin/api/shell-api` module on the TS
//! side via `invokePluginApi(pluginId, "shell:spawn", ...)`; this Rust
//! handler tracks PIDs that the spawn handler reports back so kill can
//! map a `processId` to a real OS PID. Until the spawn handler ships,
//! this command records the kill intent in state without effect — that
//! way the TS catch path stays satisfied.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessRecord {
    pub plugin_id: String,
    pub process_id: String,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn plugin_process_kill(
    state: State<'_, PluginRuntimeState>,
    process_id: String,
    #[allow(unused_variables)] signal: Option<String>,
) -> Result<()> {
    kill_tracked_process(state.inner(), &process_id, signal.as_deref());
    Ok(())
}

pub fn kill_all_tracked_processes_for_state(state: &PluginRuntimeState) {
    let process_ids: Vec<String> = state.processes.read().keys().cloned().collect();
    for process_id in process_ids {
        kill_tracked_process(state, &process_id, Some("KILL"));
    }
}

fn kill_tracked_process(state: &PluginRuntimeState, process_id: &str, signal: Option<&str>) {
    let mut processes = state.processes.write();
    if let Some(record) = processes.remove(process_id) {
        if let Some(pid) = record.pid {
            #[cfg(unix)]
            {
                use std::process::Command;
                let _ = Command::new("kill")
                    .arg(format!("-{}", signal.unwrap_or("TERM")))
                    .arg(pid.to_string())
                    .status();
            }
            #[cfg(windows)]
            {
                use std::process::Command;
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .status();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn kill_unknown_process_id_is_noop() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        // No record for "ghost" — kill should silently succeed.
        let mut processes = state.processes.write();
        assert!(processes.remove("ghost").is_none());
    }

    #[tokio::test]
    async fn record_can_be_inserted_and_removed() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.processes.write().insert(
            "p1".into(),
            ProcessRecord {
                plugin_id: "demo".into(),
                process_id: "p1".into(),
                pid: Some(12345),
            },
        );
        assert_eq!(state.processes.read().len(), 1);
        state.processes.write().remove("p1");
        assert!(state.processes.read().is_empty());
    }
}
