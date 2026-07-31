//! Tauri command surface for in-app turn tracking. Heavy git2 work runs on a
//! blocking thread (libgit2 is sync) so the tokio reactor is never wedged, and
//! the renderer fire-and-forgets these — attribution must never block a turn.

use serde::Deserialize;

use super::engine::engine;
use super::{BeginOutcome, CodeAdoptionTurn, TurnMeta};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBeginArgs {
    pub cwd: String,
    pub session_id: String,
    pub run_id: u32,
    #[serde(default)]
    pub model: Option<String>,
    pub agent_kind: String,
}

#[tauri::command]
pub async fn code_adoption_turn_begin(args: TurnBeginArgs) -> Result<BeginOutcome, String> {
    tokio::task::spawn_blocking(move || {
        engine().turn_begin(
            args.cwd,
            TurnMeta {
                session_id: args.session_id,
                run_id: args.run_id,
                model: args.model,
                agent_kind: args.agent_kind,
            },
        )
    })
    .await
    .map_err(|e| format!("code_adoption_turn_begin panicked: {e}"))?
}

#[tauri::command]
pub async fn code_adoption_turn_end(turn_key: String) -> Result<Option<CodeAdoptionTurn>, String> {
    tokio::task::spawn_blocking(move || engine().turn_end(&turn_key))
        .await
        .map_err(|e| format!("code_adoption_turn_end panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn begin_non_git_cwd_reports_skipped() {
        let tmp = tempfile::TempDir::new().unwrap();
        let out = code_adoption_turn_begin(TurnBeginArgs {
            cwd: tmp.path().to_str().unwrap().to_string(),
            session_id: "cmd-s1".to_string(),
            run_id: 1,
            model: None,
            agent_kind: "in-app".to_string(),
        })
        .await
        .unwrap();
        assert_eq!(
            out,
            BeginOutcome::skipped(super::super::SkipReason::NotGitRepo)
        );
    }

    #[tokio::test]
    async fn end_unknown_turn_key_is_none() {
        let out = code_adoption_turn_end("cmd-unknown:0".to_string())
            .await
            .unwrap();
        assert!(out.is_none());
    }
}
