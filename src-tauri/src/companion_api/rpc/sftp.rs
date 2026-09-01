//! File transfer over a synchronized SSH profile (ADR-0162).
//!
//! # Why these are RPC commands and not terminal frames
//!
//! Bulk transfer on the `/ws/terminal` binary plane would be cheaper to
//! register and would inherit exactly one capability, `terminal.open`, because
//! that is what the socket re-checks. Capability granularity, interactive
//! approval and the audit ledger would then all have to be reimplemented inside
//! a frame handler. `remote_execution.rs` already performs all four for an RPC,
//! so these are RPCs and the frame they eventually reach is refused on any
//! connection that is not local.
//!
//! # The authorization shape
//!
//! Every command here requires `ssh.files`, which is its own grant rather than
//! borrowed workspace vocabulary. `fs_*_workspace` can call itself
//! `workspace.write` because `authorize_workspace_root` confines it to a
//! registered directory. SFTP has no such confinement to offer: the paths are a
//! remote machine's absolute paths and that machine resolves its own symlinks.
//! Naming these `workspace.write` would report a scope they do not have.
//!
//! Reads and one-shot changes ride the grant with no further approval, exactly
//! as a shell does. A device that can open a terminal on that machine already
//! deletes files with `rm` and nothing prompts. What carries an interactive
//! approval is opening a *transfer*, because moving a whole file on or off the
//! machine is the operation whose start a person should consciously allow, and
//! it is the only one long enough that a prompt does not destroy the
//! interaction.
//!
//! The approval lands once, on `sftp_upload_open` / `sftp_download_open`. Those
//! mint a handle in [`TRANSFERS`] bound to the device, profile, path, direction
//! and declared size. The chunk commands present the handle and carry no
//! approval of their own, which is the only workable shape: the RPC body
//! ceiling makes a 100 MB upload some three thousand chunks, and an approval on
//! the chunk command would be three thousand prompts. That is not a security
//! control, it is a denial of service against the person being protected.

use super::*;

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

pub(super) const COMMANDS: &[&str] = &[
    "sftp_list_dir",
    "sftp_stat",
    "sftp_realpath",
    "sftp_create_dir",
    "sftp_rename_entry",
    "sftp_delete_entry",
    "sftp_download_open",
    "sftp_download_read_chunk",
    "sftp_download_close",
    "sftp_upload_open",
    "sftp_upload_write_chunk",
    "sftp_upload_commit",
    "sftp_upload_abort",
    "sftp_session_close",
];

/// How long a transfer handle survives without being used.
///
/// Sliding rather than absolute. The approval authorized moving one named file,
/// and while the transfer is actively progressing that is still the same
/// operation, so a wall-clock cap would fail a legitimate multi-gigabyte
/// transfer at an arbitrary line the user would simply re-approve. What the
/// window is actually for is an abandoned handle, and idleness is what tells
/// you one has been abandoned.
const TRANSFER_IDLE_TTL_MS: u64 = 30 * 60 * 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum TransferDirection {
    Download,
    Upload,
}

/// One approved transfer, as the host remembers it.
#[derive(Clone, Debug)]
pub(super) struct Transfer {
    /// The device that obtained the approval. A handle is useless to anybody
    /// else, so one phone cannot append bytes to another phone's upload even
    /// holding its identifier.
    device_id: String,
    profile_id: String,
    path: String,
    direction: TransferDirection,
    /// What the client said it was going to send. Only meaningful for an
    /// upload, where it is what the approval was granted for.
    declared_size: u64,
    /// The host's write head, which is the client's resume point.
    ///
    /// Held here rather than trusted from the request, because a client that
    /// believed it had written more than the server accepted would resume past
    /// a hole and produce a file that is the right length and wrong.
    write_head: u64,
    last_used_at: u64,
}

static TRANSFERS: Lazy<Mutex<HashMap<String, Transfer>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Drop handles nobody has touched for [`TRANSFER_IDLE_TTL_MS`].
///
/// Called on every mint and every lookup rather than from a timer, so the map
/// cannot outlive the process's interest in it and there is no task to own.
pub(super) fn reap_expired_transfers(now: u64) {
    TRANSFERS
        .lock()
        .retain(|_, transfer| now.saturating_sub(transfer.last_used_at) < TRANSFER_IDLE_TTL_MS);
}

fn mint_transfer(
    device_id: &str,
    profile_id: &str,
    path: &str,
    direction: TransferDirection,
    declared_size: u64,
    write_head: u64,
) -> String {
    let now = now_ms();
    reap_expired_transfers(now);
    let id = uuid::Uuid::new_v4().to_string();
    TRANSFERS.lock().insert(
        id.clone(),
        Transfer {
            device_id: device_id.to_string(),
            profile_id: profile_id.to_string(),
            path: path.to_string(),
            direction,
            declared_size,
            write_head,
            last_used_at: now,
        },
    );
    id
}

/// The transfer behind `transfer_id`, if it belongs to this device and runs in
/// this direction.
///
/// The three failure modes answer identically on purpose. "No such handle",
/// "that handle is somebody else's" and "that handle is an upload and you asked
/// to read" are all `transfer_not_found`, because distinguishing them would let
/// a caller enumerate other devices' live transfers by trying identifiers.
pub(super) fn claim_transfer(
    transfer_id: &str,
    device_id: &str,
    direction: TransferDirection,
) -> Option<Transfer> {
    let now = now_ms();
    reap_expired_transfers(now);
    let mut guard = TRANSFERS.lock();
    let transfer = guard.get_mut(transfer_id)?;
    if transfer.device_id != device_id || transfer.direction != direction {
        return None;
    }
    transfer.last_used_at = now;
    Some(transfer.clone())
}

/// Record the host's new write head for an upload.
fn advance_write_head(transfer_id: &str, write_head: u64) {
    if let Some(transfer) = TRANSFERS.lock().get_mut(transfer_id) {
        transfer.write_head = write_head;
        transfer.last_used_at = now_ms();
    }
}

fn release_transfer(transfer_id: &str, device_id: &str) -> bool {
    let mut guard = TRANSFERS.lock();
    match guard.get(transfer_id) {
        Some(transfer) if transfer.device_id == device_id => {
            guard.remove(transfer_id);
            true
        }
        _ => false,
    }
}

fn transfer_not_found() -> (StatusCode, Json<RpcError>) {
    (
        StatusCode::NOT_FOUND,
        Json(RpcError::new(
            "transfer_not_found",
            "no such transfer is open for this device",
        )),
    )
}

/// Turn one SFTP snapshot into an RPC result.
///
/// A `failed` snapshot is the remote machine's answer, not a fault in this
/// process, so it keeps the machine's own words and its own code. The renderer
/// classifies both: `classifyFileTreeFailure` reads the message text, because
/// an SFTP server already says "Permission denied" or "No such file", and the
/// code is the belt to that's braces for a server that phrases things its own
/// way.
fn snapshot_result(snapshot: Value) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let kind = snapshot.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "failed" {
        return Ok(snapshot);
    }
    let code = snapshot
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("sftp_operation_failed")
        .to_string();
    let message = snapshot
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the SFTP operation failed")
        .to_string();
    let status = match code.as_str() {
        "sftp_invalid_request" => StatusCode::BAD_REQUEST,
        "sftp_connect_failed" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    Err((status, Json(RpcError::new(code, message))))
}

/// Pull one field out of a snapshot, and say so when the host answered with a
/// shape this build does not know.
///
/// The snapshots are a tagged union on the host socket, and that tag is an
/// implementation detail of frame 27. Unwrapping here keeps it out of the RPC
/// contract, so the published response shape is what the command means rather
/// than how this process happens to ask for it.
fn field(snapshot: &Value, key: &str) -> Result<Value, (StatusCode, Json<RpcError>)> {
    snapshot.get(key).cloned().ok_or_else(|| {
        RpcError::internal(format!(
            "terminal host answered without a `{key}` field: {snapshot}"
        ))
    })
}

/// Whether this host can reach a terminal host at all.
///
/// Distinct from the capability check above it. "You may not do this" and "this
/// host has no terminal service to do it with" are different answers and a
/// client renders them differently.
async fn sftp_call(
    host: &super::super::dispatch_host::DispatchHost,
    payload: Value,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let snapshot = host
        .terminal_host_sftp(payload)
        .await
        .map_err(RpcError::internal)?;
    snapshot_result(snapshot)
}

/// Guard shared by every arm.
///
/// `ssh.files` is checked by `remote_execution::authorize_capability` from the
/// command manifest before dispatch reaches here, so this adds the one thing
/// the manifest cannot express: an empty device id is what an unauthenticated
/// or malformed context carries, and a transfer handle bound to `""` would be
/// bound to every such caller at once.
fn require_attributable_device(device_id: &str) -> Result<(), (StatusCode, Json<RpcError>)> {
    if device_id.trim().is_empty() {
        return Err(RpcError::forbidden(
            "file transfer requires an identified device",
        ));
    }
    Ok(())
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
    require_attributable_device(device_id)?;
    let chunk_bytes = crate::terminal_host_bridge::SFTP_CHUNK_BYTES;

    match name {
        "sftp_list_dir" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "listDir",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "entries": field(&snapshot, "entries")? }))
        }
        "sftp_stat" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "stat",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "entry": field(&snapshot, "entry")? }))
        }
        "sftp_realpath" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "realpath",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "path": field(&snapshot, "path")? }))
        }
        "sftp_create_dir" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            sftp_call(
                host,
                json!({
                    "kind": "createDir",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "ok": true }))
        }
        "sftp_rename_entry" => {
            let profile_id: String = required(&args, "profileId")?;
            let from: String = required(&args, "from")?;
            let to: String = required(&args, "to")?;
            sftp_call(
                host,
                json!({
                    "kind": "rename",
                    "profileId": profile_id,
                    "from": from,
                    "to": to,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "ok": true }))
        }
        "sftp_delete_entry" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            // Which one the user clicked is already known to the interface, and
            // a `stat` here would let the answer change between the decision
            // and the removal.
            let is_dir: bool = optional(&args, "isDir")?.unwrap_or(false);
            sftp_call(
                host,
                json!({
                    "kind": "remove",
                    "profileId": profile_id,
                    "path": path,
                    "isDir": is_dir,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({ "ok": true }))
        }

        // ── Download ───────────────────────────────────────────────────────
        "sftp_download_open" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            // Stat first, and let a failure here be the failure the caller
            // sees. A handle minted for a path that does not exist would turn
            // "no such file" into a download that reads zero bytes and reports
            // success.
            let entry = sftp_call(
                host,
                json!({
                    "kind": "stat",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            let size = entry
                .get("entry")
                .and_then(|entry| entry.get("size"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let transfer_id = mint_transfer(
                device_id,
                &profile_id,
                &path,
                TransferDirection::Download,
                size,
                0,
            );
            Ok(json!({
                "transferId": transfer_id,
                "size": size,
                "chunkBytes": chunk_bytes,
            }))
        }
        "sftp_download_read_chunk" => {
            let transfer_id: String = required(&args, "transferId")?;
            let offset: u64 = required(&args, "offset")?;
            let Some(transfer) =
                claim_transfer(&transfer_id, device_id, TransferDirection::Download)
            else {
                return Err(transfer_not_found());
            };
            // The length is the host's, not the caller's. A client asking for
            // more than a frame can carry would be refused by the host anyway,
            // and letting it ask for less would leave the interface guessing
            // why its transfer was slow.
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "readChunk",
                    "profileId": transfer.profile_id,
                    "path": transfer.path,
                    "offset": offset,
                    "length": chunk_bytes,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            Ok(json!({
                "data": field(&snapshot, "data")?,
                "eof": field(&snapshot, "eof")?,
            }))
        }
        "sftp_download_close" => {
            let transfer_id: String = required(&args, "transferId")?;
            // Closing a handle that has already expired is success, not an
            // error: the client's intent, that nothing of this transfer
            // survives, is satisfied either way.
            release_transfer(&transfer_id, device_id);
            Ok(json!({ "closed": true }))
        }

        // ── Upload ─────────────────────────────────────────────────────────
        "sftp_upload_open" => {
            let profile_id: String = required(&args, "profileId")?;
            let path: String = required(&args, "path")?;
            let size: u64 = required(&args, "size")?;
            // Resume from what is already on the machine rather than from what
            // the client remembers. A stat that fails because the file does not
            // exist yet is the ordinary case, so it starts at zero rather than
            // refusing.
            let write_head = match sftp_call(
                host,
                json!({
                    "kind": "stat",
                    "profileId": profile_id,
                    "path": path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await
            {
                Ok(entry) => entry
                    .get("entry")
                    .and_then(|entry| entry.get("size"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                Err(_) => 0,
            };
            let transfer_id = mint_transfer(
                device_id,
                &profile_id,
                &path,
                TransferDirection::Upload,
                size,
                write_head,
            );
            Ok(json!({
                "transferId": transfer_id,
                "chunkBytes": chunk_bytes,
                "writeHead": write_head,
            }))
        }
        "sftp_upload_write_chunk" => {
            let transfer_id: String = required(&args, "transferId")?;
            let data: String = required(&args, "data")?;
            let Some(transfer) = claim_transfer(&transfer_id, device_id, TransferDirection::Upload)
            else {
                return Err(transfer_not_found());
            };
            // The offset is the host's write head, never the request's. A
            // client that resumed from its own arithmetic could otherwise write
            // past a hole and produce a file of the right length and the wrong
            // contents.
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "writeChunk",
                    "profileId": transfer.profile_id,
                    "path": transfer.path,
                    "offset": transfer.write_head,
                    "data": data,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            let write_head = snapshot
                .get("writeHead")
                .and_then(Value::as_u64)
                .unwrap_or(transfer.write_head);
            advance_write_head(&transfer_id, write_head);
            Ok(json!({ "writeHead": write_head }))
        }
        "sftp_upload_commit" => {
            let transfer_id: String = required(&args, "transferId")?;
            let Some(transfer) = claim_transfer(&transfer_id, device_id, TransferDirection::Upload)
            else {
                return Err(transfer_not_found());
            };
            // Ask the machine how large the file actually is rather than
            // reporting the write head. They agree unless something else on
            // that machine also wrote the file, and in that case the client
            // deserves to be told the truth about what is there.
            let entry = sftp_call(
                host,
                json!({
                    "kind": "stat",
                    "profileId": transfer.profile_id,
                    "path": transfer.path,
                    "onBehalfOfDevice": device_id,
                }),
            )
            .await?;
            let size = entry
                .get("entry")
                .and_then(|entry| entry.get("size"))
                .and_then(Value::as_u64)
                .unwrap_or(transfer.write_head);
            release_transfer(&transfer_id, device_id);
            Ok(json!({
                "path": transfer.path,
                "size": size,
                "declaredSize": transfer.declared_size,
                "complete": size >= transfer.declared_size,
            }))
        }
        "sftp_upload_abort" => {
            let transfer_id: String = required(&args, "transferId")?;
            // The partial file is left where it is, deliberately. Removing it
            // would be a delete the caller never asked for, and the bytes are
            // what a later resume starts from.
            release_transfer(&transfer_id, device_id);
            Ok(json!({ "aborted": true }))
        }

        "sftp_session_close" => {
            let profile_id: String = required(&args, "profileId")?;
            let snapshot = sftp_call(
                host,
                json!({
                    "kind": "closeProfile",
                    "profileId": profile_id,
                }),
            )
            .await?;
            Ok(json!({ "closed": field(&snapshot, "closed")? }))
        }

        unknown => Err(RpcError::unknown_command(unknown)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The handle map is process-global, which is what makes it a registry
    /// rather than a per-request value. Two tests reaping it with different
    /// notions of "now" on two threads would delete each other's handles, so
    /// the tests that touch it run one at a time.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn exclusive() -> parking_lot::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock();
        TRANSFERS.lock().clear();
        guard
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    /// A handle belongs to the device that obtained the approval.
    ///
    /// ADR-0162 makes this a decision rather than an accident: the approval was
    /// given for one device to move one file, and a handle that any paired
    /// device could present would make the approval meaningless the moment an
    /// identifier leaked into a log.
    #[test]
    fn a_handle_is_useless_to_another_device() {
        let _exclusive = exclusive();
        let id = mint_transfer(
            "phone-a",
            "production",
            "/srv/app.tar",
            TransferDirection::Upload,
            1024,
            0,
        );
        assert!(claim_transfer(&id, "phone-a", TransferDirection::Upload).is_some());
        assert!(claim_transfer(&id, "phone-b", TransferDirection::Upload).is_none());
    }

    /// An upload handle cannot be read from, and a download handle cannot be
    /// written to. Both answer as though the handle does not exist, so trying
    /// identifiers reveals nothing about other transfers.
    #[test]
    fn a_handle_only_works_in_the_direction_it_was_approved_for() {
        let _exclusive = exclusive();
        let download = mint_transfer(
            "phone-a",
            "production",
            "/var/log/app.log",
            TransferDirection::Download,
            4096,
            0,
        );
        assert!(claim_transfer(&download, "phone-a", TransferDirection::Upload).is_none());
        assert!(claim_transfer(&download, "phone-a", TransferDirection::Download).is_some());
    }

    /// The write head is the host's, and it is what a resume starts from.
    #[test]
    fn the_write_head_is_recorded_on_the_host_side_of_the_handle() {
        let _exclusive = exclusive();
        let id = mint_transfer(
            "phone-a",
            "production",
            "/srv/app.tar",
            TransferDirection::Upload,
            8192,
            0,
        );
        advance_write_head(&id, 4096);
        let transfer = claim_transfer(&id, "phone-a", TransferDirection::Upload).unwrap();
        assert_eq!(transfer.write_head, 4096);
    }

    /// An abandoned handle expires. A handle that is still being used does not,
    /// however long the transfer runs, because idleness is the thing the window
    /// is measuring.
    #[test]
    fn an_idle_handle_expires_and_an_active_one_does_not() {
        let _exclusive = exclusive();
        let id = mint_transfer(
            "phone-a",
            "production",
            "/srv/big.iso",
            TransferDirection::Upload,
            1 << 30,
            0,
        );
        reap_expired_transfers(now_ms() + TRANSFER_IDLE_TTL_MS - 1);
        assert!(claim_transfer(&id, "phone-a", TransferDirection::Upload).is_some());
        reap_expired_transfers(now_ms() + TRANSFER_IDLE_TTL_MS + 1);
        assert!(claim_transfer(&id, "phone-a", TransferDirection::Upload).is_none());
    }

    /// Only the owning device can release a handle, for the same reason only it
    /// can use one.
    #[test]
    fn another_device_cannot_release_a_handle() {
        let _exclusive = exclusive();
        let id = mint_transfer(
            "phone-a",
            "production",
            "/srv/app.tar",
            TransferDirection::Download,
            10,
            0,
        );
        assert!(!release_transfer(&id, "phone-b"));
        assert!(release_transfer(&id, "phone-a"));
        assert!(claim_transfer(&id, "phone-a", TransferDirection::Download).is_none());
    }

    /// A remote refusal keeps the machine's own words and its own code, and it
    /// is not reported as a fault in this process.
    #[test]
    fn a_remote_refusal_is_not_an_internal_error() {
        let (status, body) = snapshot_result(json!({
            "kind": "failed",
            "code": "sftp_operation_failed",
            "message": "Permission denied",
        }))
        .unwrap_err();
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body.code, "sftp_operation_failed");
        assert_eq!(body.message, "Permission denied");
    }

    /// A profile that was never synchronized is the caller's mistake, and a
    /// machine that cannot be reached is not.
    #[test]
    fn the_two_refusals_that_are_not_the_remote_machine_saying_no() {
        let (status, _) = snapshot_result(json!({
            "kind": "failed",
            "code": "sftp_invalid_request",
            "message": "no SSH profile named ghost is synchronized on this host",
        }))
        .unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _) = snapshot_result(json!({
            "kind": "failed",
            "code": "sftp_connect_failed",
            "message": "connection refused",
        }))
        .unwrap_err();
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn a_successful_snapshot_passes_through_untouched() {
        let snapshot = json!({ "kind": "entries", "entries": [] });
        assert_eq!(snapshot_result(snapshot.clone()).unwrap(), snapshot);
    }

    /// The authorization shape ADR-0162 decided, pinned against the manifest.
    ///
    /// Three things could each silently undo it: a command that borrows
    /// `workspace.write` and so reports a confinement SFTP cannot enforce, an
    /// approval added to a chunk command and so a prompt per 32 KiB, and an
    /// approval dropped from an `_open` and so a transfer nobody consciously
    /// allowed. Reading the manifest here catches all three.
    #[test]
    fn the_family_is_authorized_the_way_the_record_says_it_is() {
        use crate::companion_api::command_manifest::{
            descriptor, CommandApproval, CommandTarget, CommandTransport,
        };

        for name in COMMANDS {
            let command =
                descriptor(name).unwrap_or_else(|| panic!("{name} is not in the manifest"));
            assert_eq!(
                command.capability, "ssh.files",
                "{name} borrows a capability that reports a scope it does not have"
            );
            assert_eq!(command.target, CommandTarget::Execution, "{name}");
            for transport in [
                CommandTransport::Http,
                CommandTransport::Websocket,
                CommandTransport::Webrtc,
            ] {
                assert!(
                    command.transports.contains(&transport),
                    "{name} is unreachable over {transport:?}"
                );
            }
            let expects_approval = matches!(*name, "sftp_upload_open" | "sftp_download_open");
            assert_eq!(
                command.approval == CommandApproval::Interactive,
                expects_approval,
                "{name} has the wrong approval: a chunk command that prompts is \
                 thousands of prompts, and an open that does not is a transfer \
                 nobody allowed"
            );
        }
    }

    /// An unattributable caller is refused before a handle can be minted.
    ///
    /// An empty device id is what a malformed context carries, and a handle
    /// bound to it would be bound to every such caller at once.
    #[test]
    fn an_unidentified_device_cannot_open_a_transfer() {
        assert!(require_attributable_device("   ").is_err());
        assert!(require_attributable_device("phone-a").is_ok());
    }
}
