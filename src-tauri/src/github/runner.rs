//! Desktop-local provisioning control plane. Execution stays on Companion.
use cognia_github_runner::{CreateRequest, Lease, Preflight, PreflightRequest};
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn github_runner_preflight(request: PreflightRequest) -> Preflight {
    cognia_github_runner::preflight(request).await
}

#[tauri::command]
pub async fn github_runner_create(
    app: tauri::AppHandle,
    request: CreateRequest,
) -> Result<Lease, String> {
    cognia_github_runner::create(&data_dir(&app)?, request).await
}

#[tauri::command]
pub async fn github_runner_list(app: tauri::AppHandle) -> Result<Vec<Lease>, String> {
    cognia_github_runner::list(&data_dir(&app)?).await
}

#[tauri::command]
pub async fn github_runner_refresh(app: tauri::AppHandle, id: String) -> Result<Lease, String> {
    cognia_github_runner::refresh(&data_dir(&app)?, &id).await
}

#[tauri::command]
pub async fn github_runner_cancel(app: tauri::AppHandle, id: String) -> Result<Lease, String> {
    cognia_github_runner::cancel(&data_dir(&app)?, &id).await
}

#[tauri::command]
pub async fn github_runner_pairing(app: tauri::AppHandle, id: String) -> Result<String, String> {
    cognia_github_runner::pairing(&data_dir(&app)?, &id).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn runner_control_is_registered_only_on_the_local_client() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol/companion-commands.json"))
                .unwrap();
        let commands = manifest["commands"].as_array().unwrap();
        for name in [
            "preflight",
            "create",
            "list",
            "refresh",
            "cancel",
            "pairing",
        ] {
            let name = format!("github_runner_{name}");
            let row = commands.iter().find(|row| row["name"] == name).unwrap();
            assert_eq!(row["target"], "client");
            assert_eq!(row["transports"], serde_json::json!(["internal"]));
        }
    }
}
