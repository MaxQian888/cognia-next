use serde_json::Value;

use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "host_state_snapshot",
    "host_state_submit",
    "host_state_status",
];

/// Bind HostState requests to the authenticated account, device and this Host.
/// The target id remains part of the closed protocol body and is revalidated by
/// the TS authority against its active RuntimeTargetContext.
///
/// The device id and its capability snapshot travel with the request because
/// `host_state_submit` carries a *batch* of intents whose authorization is
/// per-action: `draft.replace` needs only remote control, while
/// `transcript.truncate` needs session management. The command-level gate in
/// [`super::super::remote_execution::authorize_capability`] can only decide the
/// batch as a whole, so the TS authority re-checks each action against these
/// server-supplied grants and returns a per-action receipt.
pub(super) fn bind_authority(
    args: Value,
    state: &SharedState,
    account_id: Option<&str>,
    device_id: &str,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let account_id = account_id.ok_or_else(|| RpcError::forbidden("account scope is required"))?;
    let grants = caller_device_grants(account_id, device_id);
    bind_authority_values(args, account_id, opaque_host_id(state), device_id, grants)
}

/// The capabilities `device_id` currently holds in `account_id`. An unreadable
/// or absent SecurityStore yields an empty set, which fails every per-action
/// check closed rather than open.
fn caller_device_grants(account_id: &str, device_id: &str) -> Vec<String> {
    super::super::security_store::security_store()
        .and_then(|store| {
            store
                .capability_snapshot(account_id, device_id)
                .ok()
                .flatten()
        })
        .unwrap_or_default()
}

fn bind_authority_values(
    mut args: Value,
    account_id: &str,
    host_id: String,
    device_id: &str,
    grants: Vec<String>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let map = args
        .as_object_mut()
        .ok_or_else(|| RpcError::malformed("HostState request must be an object".to_string()))?;
    map.insert(
        "callerAccountId".to_string(),
        Value::String(account_id.to_string()),
    );
    map.insert("authoritativeHostId".to_string(), Value::String(host_id));
    map.insert(
        "callerDeviceId".to_string(),
        Value::String(device_id.to_string()),
    );
    map.insert(
        "callerDeviceGrants".to_string(),
        Value::Array(grants.into_iter().map(Value::String).collect()),
    );
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
                "callerDeviceId": "spoofed-device",
                "callerDeviceGrants": ["host.admin"],
                "runtimeTargetId": "target-a"
            }),
            "account-a",
            "host-a".to_string(),
            "device-a",
            vec!["workspace.write".to_string()],
        )
        .unwrap();

        assert_eq!(bound["callerAccountId"], "account-a");
        assert_eq!(bound["authoritativeHostId"], "host-a");
        assert_eq!(bound["callerDeviceId"], "device-a");
        assert_eq!(
            bound["callerDeviceGrants"],
            serde_json::json!(["workspace.write"])
        );
        assert_eq!(bound["runtimeTargetId"], "target-a");
    }

    /// An empty grant list must survive binding rather than being omitted: the
    /// TS authority distinguishes "no capabilities" from "field absent", and
    /// only the former fails every per-action check closed.
    #[test]
    fn authority_binding_emits_an_empty_grant_list_when_the_device_holds_none() {
        let bound = bind_authority_values(
            serde_json::json!({ "runtimeTargetId": "target-a" }),
            "account-a",
            "host-a".to_string(),
            "device-a",
            Vec::new(),
        )
        .unwrap();

        assert_eq!(bound["callerDeviceGrants"], serde_json::json!([]));
    }

    #[test]
    fn authority_binding_rejects_non_object_payloads() {
        let (status, Json(error)) = bind_authority_values(
            Value::Null,
            "account-a",
            "host-a".to_string(),
            "device-a",
            Vec::new(),
        )
        .unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "malformed_request");
    }
}
