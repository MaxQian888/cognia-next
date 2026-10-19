//! The remote face of live file shares (ADR-0222 §7.5).
//!
//! The implementation is `cognia_file_share`; this module only maps its
//! command surface onto the RPC envelope. Whether a caller may run a command
//! was decided before dispatch reaches here: the command manifest's capability
//! and approval, the admin lease for the network-exposure settings and the
//! collaboration registration (`STEP_UP_COMMANDS`), and the service scope for the three commands that
//! carry the account, the mount tables and the policy (`target: service`). The
//! one decision left here is who the audit names: the brain acts for the
//! owner, a paired device for itself.

use super::*;

pub(super) use cognia_file_share::rpc::COMMANDS;

/// Which status a file-share refusal deserves.
fn status_of(code: &str) -> StatusCode {
    match code {
        "invalid_request" | "invalid_path" | "unknown_command" => StatusCode::BAD_REQUEST,
        "not_found" => StatusCode::NOT_FOUND,
        "file_share_unavailable" | "file_share_locked" | "secret_store_unavailable" => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        "provider_failed" | "collab_unreachable" => StatusCode::BAD_GATEWAY,
        "store_failed" | "credential_hash_failed" | "host_key_failed" => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
        // Policy refusals, inactive grants, unsynced or changed mounts, an
        // unconfigured provider, a port in use: the host understood and said
        // no, which is neither the caller's syntax nor a fault here.
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    }
}

fn to_rpc_error(error: cognia_file_share::FileShareError) -> (StatusCode, Json<RpcError>) {
    (status_of(error.code), Json(RpcError::new(error.code, error.message)))
}

/// The principal the audit names for this caller.
fn principal_for(device_id: &str, scope: Option<&str>) -> String {
    if scope == Some("service") {
        // The brain is the owner's own app on a headless host.
        cognia_file_share::audit::OWNER.to_string()
    } else {
        cognia_file_share::rpc::device_principal(device_id)
    }
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &dyn crate::rpc_host::RpcHost,
    device_id: &str,
    tenant_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let _ = (state, host, tenant_id);
    // `dispatch` already refused these to a device token through the
    // manifest's service target; checked again so the arm cannot be reached
    // around that table.
    if cognia_file_share::rpc::HOST_ONLY_COMMANDS.contains(&name) && scope != Some("service") {
        return Err(RpcError::forbidden(
            "this command requires the headless service token",
        ));
    }
    let service = cognia_file_share::service::require().map_err(to_rpc_error)?;
    cognia_file_share::rpc::dispatch(&service, name, args, &principal_for(device_id, scope))
        .await
        .map_err(to_rpc_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_refusal_reaches_the_status_its_situation_deserves() {
        assert_eq!(status_of("invalid_request"), StatusCode::BAD_REQUEST);
        assert_eq!(status_of("not_found"), StatusCode::NOT_FOUND);
        assert_eq!(status_of("file_share_locked"), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(status_of("provider_failed"), StatusCode::BAD_GATEWAY);
        assert_eq!(status_of("collab_unreachable"), StatusCode::BAD_GATEWAY);
        assert_eq!(status_of("collab_host_unregistered"), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(status_of("store_failed"), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(status_of("policy_exceeded"), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(status_of("mount_not_synced"), StatusCode::UNPROCESSABLE_ENTITY);
        let (status, Json(body)) = to_rpc_error(cognia_file_share::FileShareError::new(
            "ttl_exceeds_policy",
            "too long",
        ));
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body.code, "ttl_exceeds_policy");
    }

    #[test]
    fn the_brain_acts_for_the_owner_and_a_device_for_itself() {
        assert_eq!(principal_for("dev-1", Some("service")), "owner");
        assert_eq!(principal_for("dev-1", None), "device:dev-1");
        assert_eq!(principal_for("dev-1", Some("device")), "device:dev-1");
    }

    #[test]
    fn the_host_only_commands_are_service_scoped_in_the_manifest() {
        for name in cognia_file_share::rpc::HOST_ONLY_COMMANDS {
            assert!(
                super::super::is_service_only_command(name),
                "{name} must be `target: service` in the command manifest"
            );
        }
        for name in cognia_file_share::rpc::STEP_UP_COMMANDS {
            assert!(super::super::STEP_UP_COMMANDS.contains(name), "{name} needs an admin lease");
        }
        for name in COMMANDS {
            assert!(super::super::known_commands().contains(name), "{name} is not in the manifest");
        }
    }

    #[tokio::test]
    async fn a_device_cannot_reach_the_host_only_arms() {
        let state = super::super::tests::test_state();
        let host = crate::headless::HeadlessServices::stub_for_tests();
        for name in cognia_file_share::rpc::HOST_ONLY_COMMANDS {
            let error = dispatch(name, serde_json::json!({}), &state, &host, "dev-1", None, None)
                .await
                .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN, "{name}");
        }
    }
}
