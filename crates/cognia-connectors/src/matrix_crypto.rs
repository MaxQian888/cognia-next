use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use matrix_sdk_crypto::types::events::room::encrypted::EncryptedEvent;
use matrix_sdk_crypto::types::requests::AnyOutgoingRequest;
use matrix_sdk_crypto::{
    AttachmentDecryptor, AttachmentEncryptor, DecryptionSettings, EncryptionSettings,
    EncryptionSyncChanges, MediaEncryptionInfo, OlmMachine, TrustRequirement,
};
use matrix_sdk_sqlite::SqliteCryptoStore;
use parking_lot::Mutex;
use rand::{rngs::OsRng, RngCore};
use ruma::api::client::sync::sync_events::DeviceLists;
use ruma::api::IncomingResponse;
use ruma::events::{AnyMessageLikeEventContent, AnyToDeviceEvent, MessageLikeEventContent};
use ruma::serde::Raw;
use ruma::{DeviceId, OneTimeKeyAlgorithm, RoomId, TransactionId, UInt, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoInitRequest {
    pub adapter_id: String,
    pub user_id: String,
    pub device_id: String,
    pub store_dir: Option<String>,
    pub store_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoOutgoingRequest {
    pub request_id: String,
    pub kind: String,
    pub method: String,
    pub path: String,
    pub body: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoMarkSentRequest {
    pub adapter_id: String,
    pub request_id: String,
    pub kind: String,
    pub response: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoReceiveSyncRequest {
    pub adapter_id: String,
    #[serde(default)]
    pub to_device_events: Vec<Value>,
    #[serde(default)]
    pub changed_devices: Vec<String>,
    #[serde(default)]
    pub left_devices: Vec<String>,
    #[serde(default)]
    pub one_time_key_counts: HashMap<String, u64>,
    #[serde(default)]
    pub unused_fallback_keys: Vec<String>,
    pub next_batch_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoDecryptRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoDecryptResponse {
    pub event: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoEncryptRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub event_type: String,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoEncryptResponse {
    pub content: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoShareRoomKeyRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoTrackUsersRequest {
    pub adapter_id: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoMissingSessionsRequest {
    pub adapter_id: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoAttachmentEncryptRequest {
    pub bytes_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoAttachmentEncryptResponse {
    pub bytes_base64: String,
    pub info: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoAttachmentDecryptRequest {
    pub bytes_base64: String,
    pub info: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoAttachmentDecryptResponse {
    pub bytes_base64: String,
}

#[derive(Clone)]
struct MatrixCryptoSession {
    user_id: String,
    device_id: String,
    machine: OlmMachine,
}

static SESSIONS: OnceLock<Arc<Mutex<HashMap<String, MatrixCryptoSession>>>> = OnceLock::new();

fn sessions() -> &'static Arc<Mutex<HashMap<String, MatrixCryptoSession>>> {
    SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Serializes `matrix_crypto_init` calls. Inits happen once per adapter at boot,
/// so a single global async gate is cheap, and holding it across the
/// store-open/OlmMachine-build await closes the check-then-insert TOCTOU: a
/// concurrent double-invoke for the same adapter can no longer both open the
/// crypto store and race the final insert (last-write-wins device identity).
static INIT_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn init_lock() -> &'static tokio::sync::Mutex<()> {
    INIT_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn matrix_crypto_reset_for_test(adapter_id: &str) {
    // Remove ONLY the named adapter, not the whole process-global map — the
    // crypto tests run in parallel and share `SESSIONS`, so a wholesale clear
    // would wipe a sibling test's just-initialized session mid-run.
    sessions().lock().remove(adapter_id);
}

/// Passphrase used to encrypt the on-disk SqliteCryptoStore. The Olm device and
/// Megolm session keys must never be persisted in plaintext, so when the caller
/// doesn't supply one we derive a stable per-adapter+device passphrase from the
/// OS keyring (get-or-create a random secret), mirroring the attachment
/// master-key pattern.
fn crypto_store_passphrase(adapter_id: &str, device_id: &str) -> Result<String, String> {
    let account = format!("matrix-crypto-store-passphrase:{device_id}");
    if let Some(existing) = super::keyring::get(adapter_id, &account)? {
        return Ok(existing);
    }
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let passphrase = hex::encode(raw);
    super::keyring::set(adapter_id, &account, &passphrase)?;
    Ok(passphrase)
}

/// Sanitize a Matrix device id into a single safe path segment.
fn device_path_segment(device_id: &str) -> String {
    let seg: String = device_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if seg.is_empty() {
        "_".to_string()
    } else {
        seg
    }
}

fn default_store_dir(adapter_id: &str, device_id: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cognia")
        .join("connectors")
        .join("matrix")
        .join(adapter_id)
        // Scope by device so a token/device rotation opens a FRESH store instead
        // of loading the previous device's account (which the server no longer
        // recognizes → encrypt/decrypt breaks after restart).
        .join(device_path_segment(device_id))
        .join("crypto-store")
}

fn get_machine(adapter_id: &str) -> Result<OlmMachine, String> {
    sessions()
        .lock()
        .get(adapter_id)
        .map(|session| session.machine.clone())
        .ok_or_else(|| format!("Matrix crypto session is not initialized for adapter {adapter_id}"))
}

pub async fn matrix_crypto_init(req: MatrixCryptoInitRequest) -> Result<(), String> {
    if req.adapter_id.trim().is_empty() {
        return Err("adapterId is required".to_string());
    }
    if req.device_id.trim().is_empty() {
        return Err("deviceId is required".to_string());
    }
    let user_id = UserId::parse(&req.user_id).map_err(|err| format!("invalid userId: {err}"))?;
    let device_id: &DeviceId = req.device_id.as_str().into();

    // Serialize inits (see INIT_LOCK) so the existence check below and the final
    // insert are atomic w.r.t. any concurrent init for the same adapter.
    let _init_guard = init_lock().lock().await;

    {
        let guard = sessions().lock();
        if let Some(existing) = guard.get(&req.adapter_id) {
            if existing.user_id != req.user_id || existing.device_id != req.device_id {
                return Err(format!(
                    "adapter {} already has a different Matrix identity",
                    req.adapter_id
                ));
            }
            return Ok(());
        }
    }

    let machine = if cfg!(test) && req.store_dir.is_none() {
        OlmMachine::new(&user_id, device_id).await
    } else {
        let store_dir = req
            .store_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_store_dir(&req.adapter_id, &req.device_id));
        // Never persist the crypto store in plaintext: use the caller's
        // passphrase when provided, else a stable keyring-derived one.
        let passphrase = match req.store_passphrase.as_deref() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => crypto_store_passphrase(&req.adapter_id, &req.device_id)?,
        };
        let store = SqliteCryptoStore::open(store_dir, Some(passphrase.as_str()))
            .await
            .map_err(|err| format!("open Matrix crypto store failed: {err}"))?;
        OlmMachine::with_store(&user_id, device_id, store, None)
            .await
            .map_err(|err| format!("open Matrix OlmMachine failed: {err}"))?
    };

    sessions().lock().insert(
        req.adapter_id,
        MatrixCryptoSession {
            user_id: req.user_id,
            device_id: req.device_id,
            machine,
        },
    );
    Ok(())
}

pub async fn matrix_crypto_outgoing_requests(
    adapter_id: String,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&adapter_id)?;
    machine
        .outgoing_requests()
        .await
        .map_err(|err| format!("Matrix outgoing requests failed: {err}"))?
        .into_iter()
        .map(|req| outgoing_request_to_descriptor(req.request_id().to_string(), req.request()))
        .collect()
}

pub async fn matrix_crypto_update_tracked_users(
    req: MatrixCryptoTrackUsersRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let users = parse_user_ids(&req.user_ids)?;
    // Collect before awaiting: a `map(|u| u.as_ref())` closure held across the
    // await tickles rustc's "FnOnce is not general enough" HRTB bug inside the
    // tauri::command expansion.
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    machine
        .update_tracked_users(user_refs.into_iter())
        .await
        .map_err(|err| format!("Matrix update tracked users failed: {err}"))
}

pub async fn matrix_crypto_get_missing_sessions(
    req: MatrixCryptoMissingSessionsRequest,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&req.adapter_id)?;
    let users = parse_user_ids(&req.user_ids)?;
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    let Some((request_id, request)) = machine
        .get_missing_sessions(user_refs.into_iter())
        .await
        .map_err(|err| format!("Matrix missing sessions failed: {err}"))?
    else {
        return Ok(Vec::new());
    };

    let request = AnyOutgoingRequest::KeysClaim(request);
    Ok(vec![outgoing_request_to_descriptor(
        request_id.to_string(),
        &request,
    )?])
}

pub async fn matrix_crypto_share_room_key(
    req: MatrixCryptoShareRoomKeyRequest,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let users = parse_user_ids(&req.user_ids)?;
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    let requests = machine
        .share_room_key(
            &room_id,
            user_refs.into_iter(),
            EncryptionSettings::default(),
        )
        .await
        .map_err(|err| format!("Matrix share room key failed: {err}"))?;

    requests
        .into_iter()
        .map(|req| {
            let any = AnyOutgoingRequest::ToDeviceRequest((*req).clone());
            outgoing_request_to_descriptor(req.txn_id.to_string(), &any)
        })
        .collect()
}

pub async fn matrix_crypto_receive_sync_changes(
    req: MatrixCryptoReceiveSyncRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let to_device_events = req
        .to_device_events
        .into_iter()
        .map(raw_from_value::<AnyToDeviceEvent>)
        .collect::<Result<Vec<_>, _>>()?;
    let mut changed_devices = DeviceLists::new();
    changed_devices.changed = parse_user_ids(&req.changed_devices)?;
    changed_devices.left = parse_user_ids(&req.left_devices)?;
    let one_time_key_counts = parse_otk_counts(req.one_time_key_counts)?;
    let unused_fallback_keys = parse_otk_algorithms(req.unused_fallback_keys)?;
    let changes = EncryptionSyncChanges {
        to_device_events,
        changed_devices: &changed_devices,
        one_time_keys_counts: &one_time_key_counts,
        unused_fallback_keys: Some(&unused_fallback_keys),
        next_batch_token: req.next_batch_token,
    };

    machine
        .receive_sync_changes(changes, &untrusted_decryption_settings())
        .await
        .map(|_| ())
        .map_err(|err| format!("Matrix receive sync changes failed: {err}"))
}

pub async fn matrix_crypto_decrypt_event(
    req: MatrixCryptoDecryptRequest,
) -> Result<MatrixCryptoDecryptResponse, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let event = raw_from_value::<EncryptedEvent>(req.event)?;
    let decrypted = machine
        .decrypt_room_event(&event, &room_id, &untrusted_decryption_settings())
        .await
        .map_err(|err| format!("Matrix decrypt room event failed: {err}"))?;
    let event = serde_json::to_value(decrypted)
        .map_err(|err| format!("serialize Matrix decrypted event failed: {err}"))?;
    Ok(MatrixCryptoDecryptResponse { event })
}

pub async fn matrix_crypto_encrypt_event(
    req: MatrixCryptoEncryptRequest,
) -> Result<MatrixCryptoEncryptResponse, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let raw = raw_from_value::<AnyMessageLikeEventContent>(req.content)?;
    let encrypted = machine
        .encrypt_room_event_raw(&room_id, &req.event_type, &raw)
        .await
        .map_err(|err| format!("Matrix encrypt room event failed: {err}"))?;
    let content = serde_json::to_value(&encrypted.content)
        .map_err(|err| format!("serialize Matrix encrypted content failed: {err}"))?;
    Ok(MatrixCryptoEncryptResponse { content })
}

pub async fn matrix_crypto_mark_request_sent(
    req: MatrixCryptoMarkSentRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let txn_id: &TransactionId = req.request_id.as_str().into();

    match req.kind.as_str() {
        "toDevice" => {
            let response = ruma::api::client::to_device::send_event_to_device::v3::Response::new();
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark to-device sent failed: {err}"))
        }
        "roomMessage" => {
            let response: ruma::api::client::message::send_message_event::v3::Response =
                parse_matrix_response(req.response, "room-message")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark room-message sent failed: {err}"))
        }
        "keysUpload" => {
            let response: ruma::api::client::keys::upload_keys::v3::Response =
                parse_matrix_response(req.response, "keys-upload")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-upload sent failed: {err}"))
        }
        "keysQuery" => {
            let response: ruma::api::client::keys::get_keys::v3::Response =
                parse_matrix_response(req.response, "keys-query")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-query sent failed: {err}"))
        }
        "keysClaim" => {
            let response: ruma::api::client::keys::claim_keys::v3::Response =
                parse_matrix_response(req.response, "keys-claim")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-claim sent failed: {err}"))
        }
        "signatureUpload" => {
            let response: ruma::api::client::keys::upload_signatures::v3::Response =
                parse_matrix_response(req.response, "signature-upload")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark signature-upload sent failed: {err}"))
        }
        other => Err(format!("unsupported Matrix crypto request kind: {other}")),
    }
}

pub async fn matrix_crypto_encrypt_attachment(
    req: MatrixCryptoAttachmentEncryptRequest,
) -> Result<MatrixCryptoAttachmentEncryptResponse, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.bytes_base64)
        .map_err(|err| format!("invalid attachment base64: {err}"))?;
    let mut cursor = Cursor::new(bytes);
    let mut encryptor = AttachmentEncryptor::new(&mut cursor);
    let mut encrypted = Vec::new();
    encryptor
        .read_to_end(&mut encrypted)
        .map_err(|err| format!("Matrix attachment encryption failed: {err}"))?;
    let info = serde_json::to_value(encryptor.finish())
        .map_err(|err| format!("serialize Matrix attachment info failed: {err}"))?;
    Ok(MatrixCryptoAttachmentEncryptResponse {
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(encrypted),
        info,
    })
}

pub async fn matrix_crypto_decrypt_attachment(
    req: MatrixCryptoAttachmentDecryptRequest,
) -> Result<MatrixCryptoAttachmentDecryptResponse, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.bytes_base64)
        .map_err(|err| format!("invalid encrypted attachment base64: {err}"))?;
    let info: MediaEncryptionInfo = serde_json::from_value(req.info)
        .map_err(|err| format!("invalid Matrix attachment info: {err}"))?;
    let mut cursor = Cursor::new(bytes);
    let mut decryptor = AttachmentDecryptor::new(&mut cursor, info)
        .map_err(|err| format!("Matrix attachment decryptor init failed: {err}"))?;
    let mut decrypted = Vec::new();
    decryptor
        .read_to_end(&mut decrypted)
        .map_err(|err| format!("Matrix attachment decryption failed: {err}"))?;
    Ok(MatrixCryptoAttachmentDecryptResponse {
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(decrypted),
    })
}

fn outgoing_request_to_descriptor(
    request_id: String,
    request: &AnyOutgoingRequest,
) -> Result<MatrixCryptoOutgoingRequest, String> {
    match request {
        AnyOutgoingRequest::KeysUpload(req) => descriptor(
            request_id,
            "keysUpload",
            "POST",
            "/_matrix/client/v3/keys/upload",
            keys_upload_body(req),
        ),
        AnyOutgoingRequest::KeysQuery(req) => descriptor(
            request_id,
            "keysQuery",
            "POST",
            "/_matrix/client/v3/keys/query",
            Ok(json!({
                "timeout": req.timeout.map(|timeout| timeout.as_millis() as u64),
                "device_keys": req.device_keys,
            })),
        ),
        AnyOutgoingRequest::KeysClaim(req) => descriptor(
            request_id,
            "keysClaim",
            "POST",
            "/_matrix/client/v3/keys/claim",
            keys_claim_body(req),
        ),
        AnyOutgoingRequest::ToDeviceRequest(req) => descriptor(
            request_id,
            "toDevice",
            "PUT",
            &format!(
                "/_matrix/client/v3/sendToDevice/{}/{}",
                encode_path_segment(req.event_type.to_string().as_str()),
                encode_path_segment(req.txn_id.as_str())
            ),
            Ok(json!({ "messages": req.messages })),
        ),
        AnyOutgoingRequest::SignatureUpload(req) => descriptor(
            request_id,
            "signatureUpload",
            "POST",
            "/_matrix/client/v3/keys/signatures/upload",
            serde_json::to_value(&req.signed_keys),
        ),
        AnyOutgoingRequest::RoomMessage(req) => descriptor(
            request_id,
            "roomMessage",
            "PUT",
            &format!(
                "/_matrix/client/v3/rooms/{}/send/{}/{}",
                encode_path_segment(req.room_id.as_str()),
                encode_path_segment(req.content.event_type().to_string().as_str()),
                encode_path_segment(req.txn_id.as_str())
            ),
            serde_json::to_value(&req.content),
        ),
    }
}

fn descriptor(
    request_id: String,
    kind: &str,
    method: &str,
    path: &str,
    body: Result<Value, serde_json::Error>,
) -> Result<MatrixCryptoOutgoingRequest, String> {
    Ok(MatrixCryptoOutgoingRequest {
        request_id,
        kind: kind.to_string(),
        method: method.to_string(),
        path: path.to_string(),
        body: body.map_err(|err| format!("serialize Matrix crypto request failed: {err}"))?,
    })
}

fn keys_upload_body(
    req: &ruma::api::client::keys::upload_keys::v3::Request,
) -> Result<Value, serde_json::Error> {
    let mut body = Map::new();
    if let Some(device_keys) = &req.device_keys {
        body.insert("device_keys".to_string(), raw_to_value(device_keys)?);
    }
    if !req.one_time_keys.is_empty() {
        body.insert(
            "one_time_keys".to_string(),
            serde_json::to_value(&req.one_time_keys)?,
        );
    }
    if !req.fallback_keys.is_empty() {
        body.insert(
            "fallback_keys".to_string(),
            serde_json::to_value(&req.fallback_keys)?,
        );
    }
    Ok(Value::Object(body))
}

fn keys_claim_body(
    req: &ruma::api::client::keys::claim_keys::v3::Request,
) -> Result<Value, serde_json::Error> {
    Ok(json!({
        "timeout": req.timeout.map(|timeout| timeout.as_millis() as u64),
        "one_time_keys": req.one_time_keys,
    }))
}

fn parse_user_ids(values: &[String]) -> Result<Vec<ruma::OwnedUserId>, String> {
    values
        .iter()
        .map(|value| UserId::parse(value).map_err(|err| format!("invalid userId {value}: {err}")))
        .collect()
}

fn parse_otk_counts(
    counts: HashMap<String, u64>,
) -> Result<BTreeMap<OneTimeKeyAlgorithm, UInt>, String> {
    counts
        .into_iter()
        .map(|(key, value)| {
            let value = UInt::new(value).ok_or_else(|| {
                format!("one-time key count for {key} is outside Matrix UInt range")
            })?;
            Ok((OneTimeKeyAlgorithm::from(key), value))
        })
        .collect()
}

fn parse_otk_algorithms(values: Vec<String>) -> Result<Vec<OneTimeKeyAlgorithm>, String> {
    Ok(values.into_iter().map(OneTimeKeyAlgorithm::from).collect())
}

fn raw_from_value<T>(value: Value) -> Result<Raw<T>, String> {
    Raw::<Value>::from_json_string(value.to_string())
        .map(|raw| raw.cast_unchecked())
        .map_err(|err| format!("serialize Matrix raw JSON failed: {err}"))
}

fn raw_to_value<T>(raw: &Raw<T>) -> Result<Value, serde_json::Error> {
    serde_json::from_str(raw.json().get())
}

fn parse_matrix_response<T>(value: Value, label: &str) -> Result<T, String>
where
    T: IncomingResponse,
{
    let body = serde_json::to_vec(&value)
        .map_err(|err| format!("serialize Matrix {label} response failed: {err}"))?;
    let response = ruma::exports::http::Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(body)
        .map_err(|err| format!("build Matrix {label} HTTP response failed: {err}"))?;
    T::try_from_http_response(response)
        .map_err(|err| format!("invalid Matrix {label} response: {err}"))
}

fn untrusted_decryption_settings() -> DecryptionSettings {
    DecryptionSettings {
        sender_device_trust_requirement: TrustRequirement::Untrusted,
    }
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_request(adapter_id: &str) -> MatrixCryptoInitRequest {
        MatrixCryptoInitRequest {
            adapter_id: adapter_id.to_string(),
            user_id: "@alice:example.org".to_string(),
            device_id: "ALICEDEVICE".to_string(),
            store_dir: None,
            store_passphrase: None,
        }
    }

    #[tokio::test]
    async fn init_exposes_key_upload_outgoing_request() {
        matrix_crypto_reset_for_test("mx-red");

        matrix_crypto_init(init_request("mx-red")).await.unwrap();
        let requests = matrix_crypto_outgoing_requests("mx-red".to_string())
            .await
            .unwrap();

        let upload = requests
            .iter()
            .find(|req| req.kind == "keysUpload")
            .expect("OlmMachine init must expose a keysUpload request");

        assert_eq!(upload.method, "POST");
        assert_eq!(upload.path, "/_matrix/client/v3/keys/upload");
        assert!(upload.body.get("device_keys").is_some());
        assert!(!upload.request_id.is_empty());
    }

    #[tokio::test]
    async fn init_rejects_adapter_identity_mismatch() {
        matrix_crypto_reset_for_test("mx-same");

        matrix_crypto_init(init_request("mx-same")).await.unwrap();
        let mut changed = init_request("mx-same");
        changed.device_id = "OTHERDEVICE".to_string();

        let err = matrix_crypto_init(changed).await.unwrap_err();

        assert!(err.contains("different Matrix identity"));
    }

    #[tokio::test]
    async fn attachment_encrypt_decrypt_round_trips() {
        let encrypted = matrix_crypto_encrypt_attachment(MatrixCryptoAttachmentEncryptRequest {
            bytes_base64: "aGVsbG8tbWF0cml4".to_string(),
        })
        .await
        .unwrap();

        assert_ne!(encrypted.bytes_base64, "aGVsbG8tbWF0cml4");
        assert!(encrypted.info.get("key").is_some());
        assert!(encrypted.info.get("iv").is_some());
        assert!(encrypted.info.get("hashes").is_some());

        let decrypted = matrix_crypto_decrypt_attachment(MatrixCryptoAttachmentDecryptRequest {
            bytes_base64: encrypted.bytes_base64,
            info: encrypted.info,
        })
        .await
        .unwrap();

        assert_eq!(decrypted.bytes_base64, "aGVsbG8tbWF0cml4");
    }

    #[test]
    fn default_store_dir_is_scoped_by_adapter_and_device() {
        let a = default_store_dir("mx-1", "DEVA");
        let b = default_store_dir("mx-1", "DEVB");
        // A device/token rotation must NOT reuse the previous device's store.
        assert_ne!(a, b);
        let a_str = a.to_string_lossy();
        assert!(a_str.contains("mx-1"));
        assert!(a_str.contains("DEVA"));
        assert!(a.ends_with("crypto-store"));
    }

    #[test]
    fn device_path_segment_sanitizes_unsafe_chars() {
        assert_eq!(device_path_segment("ABC-1_2"), "ABC-1_2");
        assert_eq!(device_path_segment("a/b:c"), "a_b_c");
        assert_eq!(device_path_segment(""), "_");
    }

    #[tokio::test]
    async fn reset_for_test_removes_only_the_named_adapter() {
        matrix_crypto_reset_for_test("mx-keep");
        matrix_crypto_reset_for_test("mx-drop");
        matrix_crypto_init(init_request("mx-keep")).await.unwrap();
        matrix_crypto_init(init_request("mx-drop")).await.unwrap();

        // Resetting one adapter must leave the other's session intact.
        matrix_crypto_reset_for_test("mx-drop");
        assert!(matrix_crypto_outgoing_requests("mx-keep".to_string())
            .await
            .is_ok());
        assert!(get_machine("mx-drop").is_err());
    }
}
