//! Desktop-only SIWC boundary. No legacy subscription owner is consulted.
use cognia_subscription::siwc::responses::{
    Authority, Model, ResponseChunk, ResponseHead, Responses,
};
use cognia_subscription::siwc::{SiwcConnection, SiwcManager, SiwcSignOutResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
mod app_server;

struct Profile {
    generation: String,
    manager: SiwcManager,
    responses: Arc<Responses>,
    authority: Authority,
    execution_gate: tokio::sync::Mutex<()>,
}
struct Process {
    connection: String,
    profile: String,
    stop: tokio::sync::watch::Sender<bool>,
    backend: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
}
#[derive(Default)]
struct Inner {
    profiles: Mutex<HashMap<String, Arc<Profile>>>,
    processes: Mutex<HashMap<String, Process>>,
}
#[derive(Clone, Default)]
pub struct SiwcState(Arc<Inner>);

impl SiwcState {
    /// Called synchronously under the native account lifecycle lock. Drop all
    /// capabilities first; asynchronous process cleanup cannot reopen them.
    pub fn invalidate(&self) {
        for (_, profile) in self.0.profiles.lock().drain() {
            profile.manager.cancel_all();
            profile.responses.cancel_all();
        }
        for (id, process) in self.0.processes.lock().drain() {
            process.stop.send_replace(true);
            tauri::async_runtime::spawn(async move {
                let _ = process.backend.kill(&id).await;
            });
        }
    }
    fn profile(&self, app: &AppHandle, id: &str) -> Result<Arc<Profile>, String> {
        let security = app.state::<crate::account_auth::AccountSecuritySession>();
        security.attach_siwc(self.clone());
        let generation = security.unlock_generation(id)?;
        let existing = security.with_unlock_generation(id, &generation, || {
            self.0
                .profiles
                .lock()
                .get(id)
                .filter(|p| p.generation == generation)
                .cloned()
        })?;
        if let Some(profile) = existing {
            return Ok(profile);
        }
        // Store construction has no side effects. An absent list does not
        // create a Host ID, protected file, keychain entry or registration.
        let manager = SiwcManager::new(
            app.path()
                .app_data_dir()
                .map_err(|_| "siwc_store_unavailable")?
                .join("cognia"),
            id.into(),
        )?;
        let authority_app = app.clone();
        let authority_id = id.to_owned();
        let expected = generation.clone();
        let authority: Authority = Arc::new(move || {
            authority_app
                .state::<crate::account_auth::AccountSecuritySession>()
                .assert_unlock_generation(&authority_id, &expected)
        });
        let responses = Responses::new(manager.clone(), authority.clone())?;
        let profile = Arc::new(Profile {
            generation: generation.clone(),
            manager,
            responses,
            authority,
            execution_gate: tokio::sync::Mutex::new(()),
        });
        // Lock order is active→profiles, shared with AccountSecuritySession
        // invalidation. A lock cannot miss a just-published native manager.
        security.with_unlock_generation(id, &generation, || {
            let mut profiles = self.0.profiles.lock();
            profiles.entry(id.into()).or_insert(profile).clone()
        })
    }
    async fn stop_connection(&self, profile_id: &str, connection: &str) {
        let owned: Vec<_> = {
            let mut processes = self.0.processes.lock();
            let ids: Vec<_> = processes
                .iter()
                .filter(|(_, p)| p.profile == profile_id && p.connection == connection)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| processes.remove(&id).map(|p| (id, p)))
                .collect()
        };
        for (id, process) in owned {
            process.stop.send_replace(true);
            let _ = process.backend.kill(&id).await;
        }
    }
}

#[tauri::command]
pub async fn siwc_list_connections(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
) -> Result<Vec<SiwcConnection>, String> {
    let profile = state.profile(&app, &local_account_id)?;
    let connections = profile.manager.list().await?;
    (profile.authority)()?;
    Ok(connections)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAttempt {
    attempt_id: String,
}
#[tauri::command]
pub async fn siwc_begin_login(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: Option<String>,
) -> Result<LoginAttempt, String> {
    let profile = state.profile(&app, &local_account_id)?;
    let attempt = profile.manager.begin_login(connection_id).await?;
    if let Err(error) = (profile.authority)() {
        let _ = profile.manager.cancel_login(&attempt.attempt_id);
        return Err(error);
    }
    if app
        .opener()
        .open_url(&attempt.authorization_url, None::<&str>)
        .is_err()
    {
        let _ = profile.manager.cancel_login(&attempt.attempt_id);
        return Err("siwc_browser_unavailable".into());
    }
    Ok(LoginAttempt {
        attempt_id: attempt.attempt_id,
    })
}
#[tauri::command]
pub async fn siwc_poll_login(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    attempt_id: String,
) -> Result<Value, String> {
    let profile = state.profile(&app, &local_account_id)?;
    let progress = profile.manager.poll_login(&attempt_id)?;
    if progress.status == cognia_subscription::siwc::SiwcLoginPhase::Complete {
        if let Some(connection) = &progress.connection {
            profile.responses.allow_connection(&connection.id);
        }
    }
    Ok(
        json!({"status":progress.status,"connection":progress.connection,"safeCode":progress.error,"retryConnectionId":progress.retry_connection_id}),
    )
}
#[tauri::command]
pub async fn siwc_cancel_login(
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    attempt_id: String,
) -> Result<(), String> {
    // Cleanup for an old scope is allowed, but cannot create/read a profile.
    let profile = state.0.profiles.lock().get(&local_account_id).cloned();
    if let Some(profile) = profile {
        let _ = profile.manager.cancel_login(&attempt_id);
    }
    Ok(())
}
#[tauri::command]
pub async fn siwc_refresh_connection(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
) -> Result<SiwcConnection, String> {
    let profile = state.profile(&app, &local_account_id)?;
    let _lease = profile.manager.acquire_access(&connection_id, true).await?;
    (profile.authority)()?;
    profile
        .manager
        .list()
        .await?
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "siwc_connection_missing".into())
}
#[tauri::command]
pub async fn siwc_sign_out(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
) -> Result<SiwcSignOutResult, String> {
    let profile = state.profile(&app, &local_account_id)?;
    let _gate = profile.execution_gate.lock().await;
    profile.responses.cancel_connection(&connection_id);
    state
        .stop_connection(&local_account_id, &connection_id)
        .await;
    (profile.authority)()?;
    profile.manager.sign_out(&connection_id).await
}
#[tauri::command]
pub async fn siwc_delete_connection(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
) -> Result<(), String> {
    let profile = state.profile(&app, &local_account_id)?;
    let _gate = profile.execution_gate.lock().await;
    profile.responses.cancel_connection(&connection_id);
    state
        .stop_connection(&local_account_id, &connection_id)
        .await;
    (profile.authority)()?;
    profile.manager.delete(&connection_id).await.map(|_| ())
}
#[tauri::command]
pub async fn siwc_list_models(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
) -> Result<Vec<Model>, String> {
    let profile = state.profile(&app, &local_account_id)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        profile.responses.models(&connection_id),
    )
    .await
    .map_err(|_| "siwc_request_timeout".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    local_account_id: String,
    connection_id: String,
    request_id: String,
    body: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    local_account_id: String,
    stream_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    local_account_id: String,
    request_id: Option<String>,
    stream_id: Option<String>,
}

pub async fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let state = app.state::<SiwcState>();
    match method {
        "siwc.responses.open" => {
            let input: Open =
                serde_json::from_value(params.clone()).map_err(|_| "siwc_invalid_request")?;
            let profile = state.profile(app, &input.local_account_id)?;
            serde_json::to_value(
                profile
                    .responses
                    .open(&input.connection_id, &input.request_id, &input.body)
                    .await?,
            )
            .map_err(|_| "siwc_invalid_response".into())
        }
        "siwc.responses.read" => {
            let input: Read =
                serde_json::from_value(params.clone()).map_err(|_| "siwc_invalid_request")?;
            let profile = state.profile(app, &input.local_account_id)?;
            serde_json::to_value(profile.responses.read(&input.stream_id).await?)
                .map_err(|_| "siwc_invalid_response".into())
        }
        "siwc.responses.cancel" => {
            let input: Cancel =
                serde_json::from_value(params.clone()).map_err(|_| "siwc_invalid_request")?;
            // Concurrent RPC dispatch may deliver cancel before the first
            // open publishes a hub. Record its UUID under this generation.
            let profile = match state.profile(app, &input.local_account_id) {
                Ok(profile) => Some(profile),
                Err(_) => state
                    .0
                    .profiles
                    .lock()
                    .get(&input.local_account_id)
                    .cloned(),
            };
            if let Some(profile) = profile {
                for id in [input.stream_id, input.request_id].into_iter().flatten() {
                    profile.responses.cancel(&id);
                }
            }
            Ok(Value::Null)
        }
        _ => Err("siwc_unknown_operation".into()),
    }
}
#[tauri::command]
pub async fn siwc_responses_open(
    app: AppHandle,
    local_account_id: String,
    connection_id: String,
    request_id: String,
    body: String,
) -> Result<ResponseHead, String> {
    let profile = app.state::<SiwcState>().profile(&app, &local_account_id)?;
    profile
        .responses
        .open(&connection_id, &request_id, &body)
        .await
}
#[tauri::command]
pub async fn siwc_responses_read(
    app: AppHandle,
    local_account_id: String,
    stream_id: String,
) -> Result<ResponseChunk, String> {
    let profile = app.state::<SiwcState>().profile(&app, &local_account_id)?;
    profile.responses.read(&stream_id).await
}
#[tauri::command]
pub async fn siwc_responses_cancel(
    app: AppHandle,
    local_account_id: String,
    request_id: Option<String>,
    stream_id: Option<String>,
) -> Result<(), String> {
    dispatch(
        &app,
        "siwc.responses.cancel",
        &json!({"localAccountId":local_account_id,"requestId":request_id,"streamId":stream_id}),
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn siwc_spawn_app_server(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
    config: app_server::Spawn,
) -> Result<String, String> {
    app_server::spawn(app, &state, &local_account_id, &connection_id, config).await
}
#[tauri::command]
pub async fn siwc_send_app_server(
    app: AppHandle,
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
    agent_id: String,
    message: String,
) -> Result<(), String> {
    app_server::send(
        &app,
        &state,
        &local_account_id,
        &connection_id,
        &agent_id,
        &message,
    )
    .await
}
#[tauri::command]
pub async fn siwc_stop_app_server(
    state: tauri::State<'_, SiwcState>,
    local_account_id: String,
    connection_id: String,
    agent_id: String,
) -> Result<(), String> {
    app_server::stop(&state, &local_account_id, &connection_id, &agent_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipc_rejects_oauth_headers_and_destinations() {
        let mut input = json!({"localAccountId":"fixture","connectionId":"id","requestId":"request","body":"{}"});
        assert!(serde_json::from_value::<Open>(input.clone()).is_ok());
        for key in ["url", "headers", "accessToken", "apiKey"] {
            input[key] = json!("synthetic");
            assert!(serde_json::from_value::<Open>(input.clone()).is_err());
            input.as_object_mut().unwrap().remove(key);
        }
    }
    #[test]
    fn unused_state_is_empty_and_invalidation_is_idempotent() {
        let state = SiwcState::default();
        state.invalidate();
        state.invalidate();
        assert!(state.0.profiles.lock().is_empty());
        assert!(state.0.processes.lock().is_empty());
    }
}
