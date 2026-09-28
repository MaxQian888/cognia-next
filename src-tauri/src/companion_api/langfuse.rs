//! Desktop command shells for the account-scoped Langfuse destination.
pub use cognia_sidecar::langfuse::*;

#[tauri::command]
// Stable renderer invoke fields; grouping them would break the IPC contract.
#[allow(clippy::too_many_arguments)]
pub async fn langfuse_credentials_set(
    app: tauri::AppHandle,
    enabled: bool,
    base_url: String,
    public_key: String,
    secret_key: Option<String>,
    environment: String,
    capture_model_content: bool,
    capture_tool_content: bool,
) -> Result<(), String> {
    credentials_set_for_account_async(
        current_account()?,
        enabled,
        base_url,
        public_key,
        secret_key,
        environment,
        capture_model_content,
        capture_tool_content,
    )
    .await?;
    use tauri::Manager as _;
    crate::claude::sidecar::restart_sidecar_for_config(
        app.state::<crate::claude::sidecar::SidecarState>()
            .inner()
            .clone(),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub fn langfuse_credentials_status() -> Result<LangfuseCredentialsStatus, String> {
    credentials_status_for_account(&current_account()?)
}

#[tauri::command]
pub async fn langfuse_credentials_clear(app: tauri::AppHandle) -> Result<(), String> {
    credentials_clear_for_account_async(current_account()?).await?;
    use tauri::Manager as _;
    crate::claude::sidecar::restart_sidecar_for_config(
        app.state::<crate::claude::sidecar::SidecarState>()
            .inner()
            .clone(),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn langfuse_connection_test() -> Result<LangfuseConnectionStatus, String> {
    connection_test_for_account(&current_account()?).await
}

#[tauri::command]
pub async fn langfuse_trace_ingest(
    batch: AgentTraceBatchV1,
) -> Result<LangfuseTraceIngestResult, String> {
    trace_ingest_for_account(&current_account()?, batch).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn sidecar_release_version_matches_the_app() {
        assert_eq!(cognia_sidecar::BUILD_VERSION, env!("CARGO_PKG_VERSION"));
    }
}
