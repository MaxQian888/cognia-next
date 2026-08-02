//! Loopback/operator maintenance endpoints used by the provider-neutral agent.

use axum::{extract::Json, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRequest {
    backup_id: String,
}

pub async fn backup_handler(Json(request): Json<BackupRequest>) -> impl IntoResponse {
    match coordinated_backup(request).await {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "code": "backup_failed", "message": error })),
        )
            .into_response(),
    }
}

async fn coordinated_backup(request: BackupRequest) -> Result<serde_json::Value, String> {
    let data_dir = std::env::var_os("COGNIA_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "COGNIA_DATA_DIR is required for online backup".to_string())?;
    let _write_pause = super::server::pause_writes().await?;
    let result = crate::headless::backup::create_backup(&data_dir, &request.backup_id).await?;
    serde_json::to_value(result).map_err(|error| format!("serialize backup result: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_request_rejects_unknown_fields() {
        assert!(serde_json::from_value::<BackupRequest>(json!({
            "backupId": "backup-1",
            "argv": ["sh", "-c", "unsafe"]
        }))
        .is_err());
    }
}
