//! Desktop command surface (ADR-0234 Phase 2 item 8). The `#[tauri::command]`
//! shells sit behind `tauri-host`; everything they do is a call on
//! [`RemoteDesktopState`], which the tests drive without Tauri. Errors cross
//! IPC as the `remote_desktop_*` code, optionally followed by `: detail`.

use crate::{
    credentials::CredentialKind,
    error::{RemoteDesktopError, Result},
    host::{ProbeOutcome, ProbeRequest, RemoteDesktopHost},
    session::{SessionMode, SessionOpened, SessionRenewed},
    target::{RemoteTarget, TargetDraft},
};
use cognia_problem::paging::Page;
use std::path::Path;

/// Managed app state. A store that cannot be opened (corrupt file, newer
/// version) leaves the app running and every command refusing with why.
pub struct RemoteDesktopState(std::result::Result<RemoteDesktopHost, RemoteDesktopError>);

impl RemoteDesktopState {
    pub fn open(root: &Path) -> Self {
        let host = RemoteDesktopHost::open(root);
        if let Err(error) = &host {
            log::error!("remote desktop store unavailable: {error}");
        }
        Self(host)
    }

    /// No data directory to keep targets in.
    pub fn unavailable() -> Self {
        Self(Err(RemoteDesktopError::new("remote_desktop_storage_unavailable")))
    }

    pub fn from_host(host: RemoteDesktopHost) -> Self {
        Self(Ok(host))
    }

    pub fn host(&self) -> Result<&RemoteDesktopHost> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

fn wire<T>(result: Result<T>) -> std::result::Result<T, String> {
    result.map_err(|error| error.to_string())
}

pub async fn target_list(
    state: &RemoteDesktopState,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> std::result::Result<Page<RemoteTarget>, String> {
    wire(async { state.host()?.list_targets(page_size, page_token.as_deref()).await }.await)
}

pub async fn target_save(state: &RemoteDesktopState, draft: TargetDraft) -> std::result::Result<RemoteTarget, String> {
    wire(async { state.host()?.save_target(draft).await }.await)
}

pub async fn target_delete(state: &RemoteDesktopState, target_id: String) -> std::result::Result<(), String> {
    wire(async { state.host()?.delete_target(&target_id).await }.await)
}

pub async fn credential_set(
    state: &RemoteDesktopState,
    target_id: String,
    binding_id: String,
    kind: CredentialKind,
    value: Option<String>,
) -> std::result::Result<RemoteTarget, String> {
    wire(async { state.host()?.set_credential(&target_id, &binding_id, kind, value).await }.await)
}

pub async fn target_probe(state: &RemoteDesktopState, request: ProbeRequest) -> std::result::Result<ProbeOutcome, String> {
    wire(async { state.host()?.probe(request).await }.await)
}

pub async fn session_open(
    state: &RemoteDesktopState,
    target_id: String,
    binding_id: String,
    mode: SessionMode,
    takeover: bool,
) -> std::result::Result<SessionOpened, String> {
    wire(async {
        state
            .host()?
            .open_session(&target_id, &binding_id, mode, takeover)
            .await
    }
    .await)
}

pub fn session_renew(state: &RemoteDesktopState, session_id: String) -> std::result::Result<SessionRenewed, String> {
    wire(state.host().and_then(|host| host.renew_session(&session_id)))
}

pub fn session_close(state: &RemoteDesktopState, session_id: String) -> std::result::Result<(), String> {
    wire(state.host().map(|host| host.close_session(&session_id)))
}

#[cfg(feature = "tauri-host")]
mod shells {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub async fn remote_desktop_target_list(
        state: State<'_, RemoteDesktopState>,
        page_size: Option<u32>,
        page_token: Option<String>,
    ) -> std::result::Result<Page<RemoteTarget>, String> {
        target_list(&state, page_size, page_token).await
    }

    #[tauri::command]
    pub async fn remote_desktop_target_save(
        state: State<'_, RemoteDesktopState>,
        draft: TargetDraft,
    ) -> std::result::Result<RemoteTarget, String> {
        target_save(&state, draft).await
    }

    #[tauri::command]
    pub async fn remote_desktop_target_delete(
        state: State<'_, RemoteDesktopState>,
        target_id: String,
    ) -> std::result::Result<(), String> {
        target_delete(&state, target_id).await
    }

    #[tauri::command]
    pub async fn remote_desktop_credential_set(
        state: State<'_, RemoteDesktopState>,
        target_id: String,
        binding_id: String,
        kind: CredentialKind,
        value: Option<String>,
    ) -> std::result::Result<RemoteTarget, String> {
        credential_set(&state, target_id, binding_id, kind, value).await
    }

    #[tauri::command]
    pub async fn remote_desktop_target_probe(
        state: State<'_, RemoteDesktopState>,
        request: ProbeRequest,
    ) -> std::result::Result<ProbeOutcome, String> {
        target_probe(&state, request).await
    }

    #[tauri::command]
    pub async fn remote_desktop_session_open(
        state: State<'_, RemoteDesktopState>,
        target_id: String,
        binding_id: String,
        mode: SessionMode,
        takeover: bool,
    ) -> std::result::Result<SessionOpened, String> {
        session_open(&state, target_id, binding_id, mode, takeover).await
    }

    #[tauri::command]
    pub async fn remote_desktop_session_renew(
        state: State<'_, RemoteDesktopState>,
        session_id: String,
    ) -> std::result::Result<SessionRenewed, String> {
        session_renew(&state, session_id)
    }

    #[tauri::command]
    pub async fn remote_desktop_session_close(
        state: State<'_, RemoteDesktopState>,
        session_id: String,
    ) -> std::result::Result<(), String> {
        session_close(&state, session_id)
    }
}

#[cfg(feature = "tauri-host")]
pub use shells::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unreadable_store_refuses_every_command_with_its_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(crate::target::STORE_FILE), b"{not json").unwrap();
        let state = RemoteDesktopState::open(dir.path());
        assert_eq!(
            target_list(&state, None, None).await.unwrap_err(),
            "remote_desktop_storage_corrupt"
        );
        assert_eq!(
            session_renew(&state, "s".into()).unwrap_err(),
            "remote_desktop_storage_corrupt"
        );
        assert_eq!(
            session_close(&state, "s".into()).unwrap_err(),
            "remote_desktop_storage_corrupt"
        );
        assert_eq!(
            target_delete(&RemoteDesktopState::unavailable(), "t".into())
                .await
                .unwrap_err(),
            "remote_desktop_storage_unavailable"
        );
    }

    #[tokio::test]
    async fn a_healthy_store_answers_through_the_wire_shape() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteDesktopState::open(dir.path());
        let page = target_list(&state, Some(10), None).await.unwrap();
        assert!(page.items.is_empty());
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            serde_json::json!({"items": []})
        );
        assert_eq!(
            session_renew(&state, "missing".into()).unwrap_err(),
            "remote_desktop_session_not_found"
        );
        session_close(&state, "missing".into()).unwrap();
        target_delete(&state, "missing".into()).await.unwrap();
        let error = target_probe(
            &state,
            ProbeRequest::Draft {
                host: "127.0.0.1".into(),
                port: 5900,
                adapter: crate::target::Adapter::Vnc,
                confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "remote_desktop_endpoint_forbidden");
    }
}
