//! The one command surface (ADR-0222 §7.5).
//!
//! The desktop's `#[tauri::command]` shells ([`crate::commands`]) and the
//! companion RPC family both call [`dispatch`], so a paired device, the
//! headless brain and the desktop WebView reach the same arms with the same
//! argument shapes. Who may call which command is decided before this point:
//! the companion RPC checks the command manifest (capability, step-up lease,
//! service scope), the desktop shells are reachable only from the app's own
//! WebView. `principal` is who the audit names: `owner` for the local user or
//! the brain, `device:<id>` for a paired device.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::collab::CollabHostInput;
use crate::error::{FileShareError, FileShareResult};
use crate::listener::ListenerConfigInput;
use crate::model::CreateGrantRequest;
use crate::mounts::SessionMountsInput;
use crate::policy::PolicyPush;
use crate::page::PageRequest;
use crate::service::{AuditQuery, FileShareService};
use crate::sftpgo::SftpgoConfigInput;

/// Every command, in manifest order.
pub const COMMANDS: &[&str] = &[
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
    "file_collab_host_set",
    "file_collab_host_status",
];

/// Commands only the host's own app (the desktop WebView or the headless
/// brain) may send: they carry the account, the mount tables and the policy,
/// which a paired device must never be able to forge.
pub const HOST_ONLY_COMMANDS: &[&str] = &[
    "file_share_activate",
    "file_space_sync",
    "file_share_policy_set",
];

/// Commands that change what the host exposes to the network — including
/// which collaboration server it answers members through; a paired device
/// needs a fresh admin lease for them.
pub const STEP_UP_COMMANDS: &[&str] = &[
    "file_share_listener_set",
    "file_share_sftpgo_set",
    "file_collab_host_set",
];

/// Commands that read without changing anything.
pub const READ_ONLY_COMMANDS: &[&str] = &[
    "file_share_status",
    "file_grant_list",
    "file_audit_list",
    "file_collab_host_status",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateArgs {
    #[serde(rename = "accountId")]
    local_account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncArgs {
    sessions: Vec<SessionMountsInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyArgs {
    push: PolicyPush,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    request: CreateGrantRequest,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    session_id: Option<String>,
}

/// The paging half of a list command's arguments. The legacy spellings
/// (`limit`, `before`, …) are refused by name.
fn page_of(args: &Value) -> FileShareResult<PageRequest> {
    PageRequest::from_args(args).map_err(crate::page::paging_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantArgs {
    grant_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialArgs {
    credential_id: String,
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenerArgs {
    config: ListenerConfigInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpgoArgs {
    config: Option<SftpgoConfigInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollabHostArgs {
    session_id: String,
    host: Option<CollabHostInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArgs {
    session_id: String,
}

fn parse<T: DeserializeOwned>(args: Value) -> FileShareResult<T> {
    // Unknown envelope fields (an admin lease, an idempotency key) are the
    // transport's, not ours, so they are ignored rather than refused.
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    serde_json::from_value(args).map_err(|error| FileShareError::invalid(error.to_string()))
}

fn to_value<T: serde::Serialize>(value: T) -> FileShareResult<Value> {
    serde_json::to_value(value).map_err(FileShareError::store)
}

/// Run one command.
pub async fn dispatch(
    service: &Arc<FileShareService>,
    name: &str,
    args: Value,
    principal: &str,
) -> FileShareResult<Value> {
    match name {
        "file_share_activate" => {
            let args: ActivateArgs = parse(args)?;
            to_value(service.activate(args.local_account_id).await?)
        }
        "file_space_sync" => {
            let args: SyncArgs = parse(args)?;
            to_value(service.sync(args.sessions).await?)
        }
        "file_share_policy_set" => {
            let args: PolicyArgs = parse(args)?;
            to_value(service.set_policy(args.push).await?)
        }
        "file_share_status" => to_value(service.status().await),
        "file_grant_create" => {
            let args: CreateArgs = parse(args)?;
            to_value(service.create_grant(args.request, principal).await?)
        }
        "file_grant_list" => {
            let page = page_of(&args)?;
            let args: ListArgs = parse(args)?;
            to_value(service.list_grants(args.session_id.as_deref(), &page)?)
        }
        "file_grant_revoke" => {
            let args: GrantArgs = parse(args)?;
            to_value(service.revoke_grant(&args.grant_id, principal).await?)
        }
        "file_grant_suspend" => {
            let args: GrantArgs = parse(args)?;
            to_value(service.suspend_grant(&args.grant_id, principal).await?)
        }
        "file_grant_resume" => {
            let args: GrantArgs = parse(args)?;
            to_value(service.resume_grant(&args.grant_id, principal).await?)
        }
        "file_credential_rotate" => {
            let args: CredentialArgs = parse(args)?;
            to_value(service.rotate_credential(&args.credential_id, principal).await?)
        }
        "file_audit_list" => {
            let page = page_of(&args)?;
            let query: AuditQuery = parse(args)?;
            to_value(service.audit(&query, &page)?)
        }
        "file_share_listener_set" => {
            let args: ListenerArgs = parse(args)?;
            to_value(service.set_listener(args.config).await?)
        }
        "file_share_sftpgo_set" => {
            let args: SftpgoArgs = parse(args)?;
            to_value(service.set_sftpgo(args.config).await?)
        }
        "file_collab_host_set" => {
            let args: CollabHostArgs = parse(args)?;
            to_value(service.set_collab_host(&args.session_id, args.host, principal).await?)
        }
        "file_collab_host_status" => {
            let args: SessionArgs = parse(args)?;
            to_value(service.collab_host_status(&args.session_id).await?)
        }
        other => Err(FileShareError::new(
            "unknown_command",
            format!("{other} is not a file-share command"),
        )),
    }
}

/// The principal the audit names for a paired device.
pub fn device_principal(device_id: &str) -> String {
    format!("device:{device_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Permission;
    use crate::policy::PolicySnapshot;
    use serde_json::json;

    fn service() -> (Arc<FileShareService>, tempfile::TempDir) {
        crate::service::tests::service_with(vec![Permission::Read], vec![])
    }

    #[test]
    fn activation_reads_the_established_local_profile_wire_key() {
        let args: ActivateArgs = serde_json::from_value(json!({ "accountId": "acct_a" })).unwrap();
        assert_eq!(args.local_account_id.as_deref(), Some("acct_a"));
        let locked: ActivateArgs = serde_json::from_value(json!({ "accountId": null })).unwrap();
        assert!(locked.local_account_id.is_none());
    }

    #[test]
    fn the_lists_are_subsets_of_the_commands() {
        for list in [HOST_ONLY_COMMANDS, STEP_UP_COMMANDS, READ_ONLY_COMMANDS] {
            for name in list {
                assert!(COMMANDS.contains(name), "{name} is not a command");
            }
        }
        for name in READ_ONLY_COMMANDS {
            assert!(!STEP_UP_COMMANDS.contains(name));
            assert!(!HOST_ONLY_COMMANDS.contains(name));
        }
    }

    #[tokio::test]
    async fn unknown_commands_and_bad_arguments_carry_their_codes() {
        let (service, _dir) = service();
        let error = dispatch(&service, "file_nope", Value::Null, "owner")
            .await
            .unwrap_err();
        assert_eq!(error.code, "unknown_command");
        let error = dispatch(&service, "file_grant_revoke", json!({}), "owner")
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
        let error = dispatch(&service, "file_grant_revoke", json!({ "grantId": "fg_none" }), "owner")
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found");
    }

    #[tokio::test]
    async fn grants_round_trip_through_the_wire_shapes() {
        let (service, _dir) = service();
        let created = dispatch(
            &service,
            "file_grant_create",
            json!({
                "request": {
                    "sessionId": "s1",
                    "paths": ["/workspace/src"],
                    "permissions": ["read", "download"],
                    "protocols": ["webdav"],
                    "expiresInSeconds": 3600,
                    "label": "review",
                },
                // A transport field the arm must ignore.
                "adminLease": "ignored",
            }),
            "device:phone",
        )
        .await
        .unwrap();
        let grant_id = created["grant"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["credentials"].as_array().unwrap().len(), 1);
        assert!(created["credentials"][0]["password"].as_str().unwrap().len() >= 32);

        let listed = dispatch(&service, "file_grant_list", json!({ "sessionId": "s1" }), "owner")
            .await
            .unwrap();
        assert!(listed.get("nextPageToken").is_none());
        let ids: Vec<&str> = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view["grant"]["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&grant_id.as_str()));
        // A listing never carries a secret.
        assert!(!listed.to_string().contains("password"));

        let suspended = dispatch(&service, "file_grant_suspend", json!({ "grantId": grant_id }), "owner")
            .await
            .unwrap();
        assert_eq!(suspended["grant"]["status"], "suspended");
        let resumed = dispatch(&service, "file_grant_resume", json!({ "grantId": grant_id }), "owner")
            .await
            .unwrap();
        assert_eq!(resumed["grant"]["status"], "active");

        let credential_id = created["credentials"][0]["credential"]["id"].as_str().unwrap();
        let rotated = dispatch(
            &service,
            "file_credential_rotate",
            json!({ "credentialId": credential_id }),
            "owner",
        )
        .await
        .unwrap();
        assert_ne!(rotated["password"], created["credentials"][0]["password"]);

        let revoked = dispatch(&service, "file_grant_revoke", json!({ "grantId": grant_id }), "owner")
            .await
            .unwrap();
        assert_eq!(revoked["grant"]["status"], "revoked");

        let audit = dispatch(&service, "file_audit_list", json!({ "grantId": grant_id }), "owner")
            .await
            .unwrap();
        let first = dispatch(
            &service,
            "file_audit_list",
            json!({ "grantId": grant_id, "pageSize": 1 }),
            "owner",
        )
        .await
        .unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        let token = first["nextPageToken"].as_str().expect("more rows").to_string();
        let second = dispatch(
            &service,
            "file_audit_list",
            json!({ "grantId": grant_id, "pageSize": 1, "pageToken": token }),
            "owner",
        )
        .await
        .unwrap();
        assert!(second["items"][0]["id"].as_i64() < first["items"][0]["id"].as_i64());
        let refused = dispatch(&service, "file_grant_list", json!({ "pageToken": token }), "owner")
            .await
            .unwrap_err();
        assert_eq!(refused.code, "invalid_request");
        let legacy = dispatch(&service, "file_audit_list", json!({ "limit": 5 }), "owner")
            .await
            .unwrap_err();
        assert!(legacy.message.contains("limit"), "{}", legacy.message);
        let principals: Vec<&str> = audit["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["principal"].as_str())
            .collect();
        assert!(principals.contains(&"device:phone"));
        assert!(principals.contains(&"owner"));
    }

    #[tokio::test]
    async fn the_policy_push_bumps_the_revision() {
        let (service, _dir) = service();
        let before = service.status().await.policy.revision;
        let next = dispatch(
            &service,
            "file_share_policy_set",
            json!({ "push": { "policy": PolicySnapshot::default().fields } }),
            "owner",
        )
        .await
        .unwrap();
        assert!(next["revision"].as_i64().unwrap() > before);
        let status = dispatch(&service, "file_share_status", Value::Null, "owner")
            .await
            .unwrap();
        assert_eq!(status["policy"]["revision"], next["revision"]);
    }

    #[tokio::test]
    async fn the_collab_host_commands_take_their_wire_shapes() {
        let (service, _dir) = service();
        let status = dispatch(
            &service,
            "file_collab_host_status",
            json!({ "sessionId": "s1" }),
            "owner",
        )
        .await
        .unwrap();
        assert_eq!(status["registration"], Value::Null);
        assert_eq!(status["running"], false);
        // Clearing what was never registered is a no-op answer, not an error.
        let cleared = dispatch(
            &service,
            "file_collab_host_set",
            json!({ "sessionId": "s1", "host": null }),
            "owner",
        )
        .await
        .unwrap();
        assert_eq!(cleared["sessionId"], "s1");
        let refused = dispatch(
            &service,
            "file_collab_host_set",
            json!({
                "sessionId": "s1",
                "host": {
                    "orgId": "org_1",
                    "collabSessionId": "ses_1",
                    "serverUrl": "http://collab.example",
                    "hostLabel": "Mac",
                    "hostToken": "fht_x",
                },
            }),
            "owner",
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "invalid_request");
        assert!(STEP_UP_COMMANDS.contains(&"file_collab_host_set"));
        assert!(READ_ONLY_COMMANDS.contains(&"file_collab_host_status"));
    }

    #[test]
    fn devices_are_named_in_the_audit() {
        assert_eq!(device_principal("abc"), "device:abc");
    }
}
