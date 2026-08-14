use serde_json::Value;

use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "host_state_snapshot",
    "host_state_submit",
    "host_state_status",
];

/// Bind HostState requests to the authenticated account and this Host. The
/// target id remains part of the closed protocol body and is revalidated by
/// the TS authority against its active RuntimeTargetContext.
pub(super) fn bind_authority(
    args: Value,
    state: &SharedState,
    account_id: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let account_id = account_id.ok_or_else(|| RpcError::forbidden("account scope is required"))?;
    bind_authority_values(args, account_id, opaque_host_id(state))
}

fn bind_authority_values(
    mut args: Value,
    account_id: &str,
    host_id: String,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let map = args
        .as_object_mut()
        .ok_or_else(|| RpcError::malformed("HostState request must be an object".to_string()))?;
    map.insert(
        "callerAccountId".to_string(),
        Value::String(account_id.to_string()),
    );
    map.insert("authoritativeHostId".to_string(), Value::String(host_id));
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_family_is_closed() {
        assert_eq!(
            COMMANDS,
            &[
                "host_state_snapshot",
                "host_state_submit",
                "host_state_status"
            ]
        );
    }

    #[test]
    fn authority_binding_overwrites_spoofed_identity() {
        let bound = bind_authority_values(
            serde_json::json!({
                "callerAccountId": "spoofed-account",
                "authoritativeHostId": "spoofed-host",
                "runtimeTargetId": "target-a"
            }),
            "account-a",
            "host-a".to_string(),
        )
        .unwrap();

        assert_eq!(bound["callerAccountId"], "account-a");
        assert_eq!(bound["authoritativeHostId"], "host-a");
        assert_eq!(bound["runtimeTargetId"], "target-a");
    }

    #[test]
    fn authority_binding_rejects_non_object_payloads() {
        let (status, Json(error)) =
            bind_authority_values(Value::Null, "account-a", "host-a".to_string()).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "malformed_request");
    }
}
