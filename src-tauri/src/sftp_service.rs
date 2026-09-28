//! Desktop command adapters for the shared SFTP dispatcher.
pub use cognia_terminal::sftp_service::*;
use serde_json::{json, Value};

pub async fn dispatch_sftp(
    app: Option<&tauri::AppHandle>,
    name: &str,
    args: &Value,
    device_id: &str,
) -> Result<Value, SftpFailure> {
    use tauri::Manager as _;
    let resource_dir = app.and_then(|app| app.path().resource_dir().ok());
    cognia_terminal::sftp_service::dispatch_sftp(resource_dir.as_deref(), name, args, device_id)
        .await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn desktop_dispatch_preserves_the_attribution_gate() {
        let error = super::dispatch_sftp(None, "sftp_list_dir", &serde_json::json!({}), "")
            .await
            .expect_err("missing device must fail before connecting");
        assert_eq!(error.code, "sftp_device_unidentified");
    }
}

/// The desktop renderer's door onto the same implementation.
///
/// `transport.call` resolves to `invoke` on the desktop, which only finds
/// commands registered in `generate_handler!`. Without these, the file browser
/// would work from a paired phone and fail on the machine the files are
/// actually reachable from, and it would fail at runtime rather than at build
/// time. `automation_consent_respond` is the established shape: a Tauri command
/// and an RPC arm over one implementation.
///
/// Each argument is declared twice on purpose: the Rust name is snake_case
/// because that is what Tauri converts a camelCase `invoke` argument into, and
/// the wire name is the camelCase key the shared implementation reads. One
/// TypeScript client therefore serves both faces without knowing which
/// transport it is on.
macro_rules! desktop_sftp_command {
    ($name:ident, $command:literal, [$($field:ident as $wire:literal : $ty:ty),* $(,)?]) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            $($field: $ty,)*
        ) -> Result<Value, String> {
            let args = json!({ $($wire: $field,)* });
            dispatch_sftp(Some(&app), $command, &args, LOCAL_DEVICE_ID)
                .await
                .map_err(|failure| failure.to_string())
        }
    };
}

desktop_sftp_command!(
    sftp_list_dir,
    "sftp_list_dir",
    [profile_id as "profileId": String, path as "path": String]
);
desktop_sftp_command!(
    sftp_stat,
    "sftp_stat",
    [profile_id as "profileId": String, path as "path": String]
);
desktop_sftp_command!(
    sftp_realpath,
    "sftp_realpath",
    [profile_id as "profileId": String, path as "path": String]
);
desktop_sftp_command!(
    sftp_create_dir,
    "sftp_create_dir",
    [profile_id as "profileId": String, path as "path": String]
);
desktop_sftp_command!(
    sftp_rename_entry,
    "sftp_rename_entry",
    [profile_id as "profileId": String, from as "from": String, to as "to": String]
);
desktop_sftp_command!(
    sftp_delete_entry,
    "sftp_delete_entry",
    [profile_id as "profileId": String, path as "path": String, is_dir as "isDir": bool]
);
desktop_sftp_command!(
    sftp_download_open,
    "sftp_download_open",
    [profile_id as "profileId": String, path as "path": String]
);
desktop_sftp_command!(
    sftp_download_read_chunk,
    "sftp_download_read_chunk",
    [transfer_id as "transferId": String, offset as "offset": u64]
);
desktop_sftp_command!(
    sftp_download_close,
    "sftp_download_close",
    [transfer_id as "transferId": String]
);
desktop_sftp_command!(
    sftp_upload_open,
    "sftp_upload_open",
    [profile_id as "profileId": String, path as "path": String, size as "size": u64]
);
desktop_sftp_command!(
    sftp_upload_write_chunk,
    "sftp_upload_write_chunk",
    [transfer_id as "transferId": String, data as "data": String]
);
desktop_sftp_command!(
    sftp_upload_commit,
    "sftp_upload_commit",
    [transfer_id as "transferId": String]
);
desktop_sftp_command!(
    sftp_upload_abort,
    "sftp_upload_abort",
    [transfer_id as "transferId": String]
);
desktop_sftp_command!(
    sftp_session_close,
    "sftp_session_close",
    [profile_id as "profileId": String]
);
