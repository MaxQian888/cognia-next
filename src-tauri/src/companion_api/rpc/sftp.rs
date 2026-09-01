//! The remote face of file transfer over a synchronized SSH profile (ADR-0162).
//!
//! The implementation lives in [`crate::sftp_service`], which the desktop
//! reaches through its own `#[tauri::command]` wrappers. This module is only
//! the mapping between that implementation and the RPC envelope: everything
//! that decides *whether* a paired device may do this has already happened by
//! the time dispatch arrives here. `remote_execution::authorize_capability`
//! checked `ssh.files` against the command manifest, `authorize_approval` took
//! the interactive lease on the two opens, and `audit::record_async` wrote the
//! row.

use super::*;

pub(super) use crate::sftp_service::COMMANDS;

/// Which status an SFTP failure deserves.
///
/// Three answers, because they are three different situations and a client
/// renders them differently. A malformed request or an unsynchronized profile
/// is the caller's mistake. A machine that could not be dialled is a gateway
/// failure and worth retrying. Everything else is the remote machine having
/// been reached and having said no, which is neither.
fn to_rpc_error(failure: crate::sftp_service::SftpFailure) -> (StatusCode, Json<RpcError>) {
    let status = match failure.code.as_str() {
        "sftp_invalid_request" | "unknown_command" => StatusCode::BAD_REQUEST,
        "sftp_connect_failed" => StatusCode::BAD_GATEWAY,
        "sftp_host_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "sftp_device_unidentified" => StatusCode::FORBIDDEN,
        "transfer_not_found" => StatusCode::NOT_FOUND,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (status, Json(RpcError::new(failure.code, failure.message)))
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let _ = (state, account_id, scope);
    // A headless host has no `AppHandle`, and the bridge does not need one:
    // it reaches or starts the terminal host from the endpoint on disk.
    let app = match host {
        super::super::dispatch_host::DispatchHost::Tauri(app) => Some(app),
        super::super::dispatch_host::DispatchHost::Headless(_) => None,
    };
    crate::sftp_service::dispatch_sftp(app, name, &args, device_id)
        .await
        .map_err(to_rpc_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every failure code the service can produce maps onto a status, and the
    /// mapping distinguishes the three situations a client renders differently.
    ///
    /// A single catch-all here would have turned "you sent nonsense", "the
    /// machine is unreachable" and "the machine refused you" into one answer,
    /// which is the difference between a retry, a reconnect and a stop.
    #[test]
    fn each_failure_reaches_the_status_its_situation_deserves() {
        use crate::sftp_service::SftpFailure;

        let status_of = |code: &str| to_rpc_error(SftpFailure::new(code, "why")).0;
        assert_eq!(status_of("sftp_invalid_request"), StatusCode::BAD_REQUEST);
        assert_eq!(status_of("unknown_command"), StatusCode::BAD_REQUEST);
        assert_eq!(status_of("sftp_connect_failed"), StatusCode::BAD_GATEWAY);
        assert_eq!(
            status_of("sftp_host_unavailable"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(status_of("sftp_device_unidentified"), StatusCode::FORBIDDEN);
        assert_eq!(status_of("transfer_not_found"), StatusCode::NOT_FOUND);
        // A remote refusal is the machine's answer, not a fault here.
        assert_eq!(
            status_of("sftp_operation_failed"),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn the_message_survives_the_mapping() {
        use crate::sftp_service::SftpFailure;

        // `classifyFileTreeFailure` reads this text, because an SFTP server
        // already says "Permission denied" in words the renderer can classify.
        let (_, body) = to_rpc_error(SftpFailure::new(
            "sftp_operation_failed",
            "Permission denied",
        ));
        assert_eq!(body.message, "Permission denied");
        assert_eq!(body.code, "sftp_operation_failed");
    }
}
