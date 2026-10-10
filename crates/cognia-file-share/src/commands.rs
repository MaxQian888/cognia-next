//! The desktop's `#[tauri::command]` shells (ADR-0222 §7.5).
//!
//! Each shell takes the same argument names as its companion RPC arm in
//! [`crate::rpc`], so `lib/filespace/grants-client.ts` sends one payload shape
//! over either transport. The shells are reachable only from the app's own
//! WebView, so every change is attributed to the local owner. Errors cross as
//! the `{ code, message, retryable }` envelope `parseInvokeError` decodes, with
//! the same codes the companion RPC answers with.

use cognia_core::command_error::CommandError;

use crate::audit::OWNER;
use crate::error::FileShareError;
use crate::listener::{ListenerConfigInput, ListenerStatus};
use crate::model::{CreateGrantRequest, CreatedGrant, GrantView, IssuedCredential};
use crate::mounts::SessionMountsInput;
use crate::policy::{PolicyPush, PolicySnapshot};
use crate::page::{paging_error, Page, PageRequest};
use crate::service::{self, AuditQuery, FileShareStatus, SyncReport};
use crate::sftpgo::{SftpgoConfigInput, SftpgoStatus};
use crate::store::AuditRow;

/// The shells registered in `src-tauri/src/lib.rs`, named once so a test can
/// pin them to the RPC surface.
pub const SHELLS: &[&str] = &[
    "file_share_activate",
    "file_space_sync",
    "file_share_policy_set",
    "file_share_status",
    "file_grant_create",
    "file_grant_list",
    "file_grant_revoke",
    "file_grant_suspend",
    "file_grant_resume",
    "file_credential_rotate",
    "file_audit_list",
    "file_share_listener_set",
    "file_share_sftpgo_set",
];

fn wire(error: FileShareError) -> CommandError {
    // A provider that did not answer may answer the next attempt; every other
    // refusal is the host's considered answer.
    if error.code == "provider_failed" {
        CommandError::retryable(error.code, error.message)
    } else {
        CommandError::new(error.code, error.message)
    }
}

#[tauri::command]
pub async fn file_share_activate(account_id: Option<String>) -> Result<FileShareStatus, CommandError> {
    let service = service::require().map_err(wire)?;
    service.activate(account_id).await.map_err(wire)
}

#[tauri::command]
pub async fn file_space_sync(sessions: Vec<SessionMountsInput>) -> Result<SyncReport, CommandError> {
    let service = service::require().map_err(wire)?;
    service.sync(sessions).await.map_err(wire)
}

#[tauri::command]
pub async fn file_share_policy_set(push: PolicyPush) -> Result<PolicySnapshot, CommandError> {
    let service = service::require().map_err(wire)?;
    service.set_policy(push).await.map_err(wire)
}

#[tauri::command]
pub async fn file_share_status() -> Result<FileShareStatus, CommandError> {
    let service = service::require().map_err(wire)?;
    Ok(service.status().await)
}

#[tauri::command]
pub async fn file_grant_create(request: CreateGrantRequest) -> Result<CreatedGrant, CommandError> {
    let service = service::require().map_err(wire)?;
    service.create_grant(request, OWNER).await.map_err(wire)
}

#[tauri::command]
pub async fn file_grant_list(
    session_id: Option<String>,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<Page<GrantView>, CommandError> {
    let service = service::require().map_err(wire)?;
    let page = PageRequest::from_parts(page_size, page_token.as_deref())
        .map_err(|error| wire(paging_error(error)))?;
    service.list_grants(session_id.as_deref(), &page).map_err(wire)
}

#[tauri::command]
pub async fn file_grant_revoke(grant_id: String) -> Result<GrantView, CommandError> {
    let service = service::require().map_err(wire)?;
    service.revoke_grant(&grant_id, OWNER).await.map_err(wire)
}

#[tauri::command]
pub async fn file_grant_suspend(grant_id: String) -> Result<GrantView, CommandError> {
    let service = service::require().map_err(wire)?;
    service.suspend_grant(&grant_id, OWNER).await.map_err(wire)
}

#[tauri::command]
pub async fn file_grant_resume(grant_id: String) -> Result<GrantView, CommandError> {
    let service = service::require().map_err(wire)?;
    service.resume_grant(&grant_id, OWNER).await.map_err(wire)
}

#[tauri::command]
pub async fn file_credential_rotate(credential_id: String) -> Result<IssuedCredential, CommandError> {
    let service = service::require().map_err(wire)?;
    service.rotate_credential(&credential_id, OWNER).await.map_err(wire)
}

#[tauri::command]
pub async fn file_audit_list(
    session_id: Option<String>,
    grant_id: Option<String>,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<Page<AuditRow>, CommandError> {
    let service = service::require().map_err(wire)?;
    let page = PageRequest::from_parts(page_size, page_token.as_deref())
        .map_err(|error| wire(paging_error(error)))?;
    service
        .audit(&AuditQuery { session_id, grant_id }, &page)
        .map_err(wire)
}

#[tauri::command]
pub async fn file_share_listener_set(config: ListenerConfigInput) -> Result<ListenerStatus, CommandError> {
    let service = service::require().map_err(wire)?;
    service.set_listener(config).await.map_err(wire)
}

#[tauri::command]
pub async fn file_share_sftpgo_set(config: Option<SftpgoConfigInput>) -> Result<SftpgoStatus, CommandError> {
    let service = service::require().map_err(wire)?;
    service.set_sftpgo(config).await.map_err(wire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shell_is_an_rpc_command_and_back() {
        assert_eq!(SHELLS, crate::rpc::COMMANDS);
    }

    #[test]
    fn errors_cross_as_the_structured_envelope() {
        let refused = wire(FileShareError::new("policy_exceeded", "too long"));
        assert_eq!(refused.code, "policy_exceeded");
        assert_eq!(refused.message, "too long");
        assert!(!refused.retryable);
        assert!(wire(FileShareError::new("provider_failed", "timeout")).retryable);
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({ "code": "policy_exceeded", "message": "too long", "retryable": false })
        );
    }

    #[tokio::test]
    async fn the_shells_refuse_until_the_host_installs_the_service() {
        // No test in this binary installs the process-wide service.
        if service::get().is_none() {
            let error = file_share_status().await.unwrap_err();
            assert_eq!(error.code, "file_share_unavailable");
        }
    }
}
