//! Durable ownership of verified OA callbacks before the HTTP success ACK.
//!
//! The encrypted secret store owns atomic replacement and reported write errors.
//! This module does not strengthen or certify its power-loss durability.
//! A distinct namespace keeps callback bodies out of credential enumeration.
//! The event bus is only a wakeup; exact-ID ACK follows durable JS admission.

use cognia_secrets::{
    host_secrets::{self, HostSecretKind, SecretDependency},
    secret_store,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE: &str = "com.cognia.connectors.wechat-oa-ingress";
const ADMITTED_SERVICE: &str = "com.cognia.connectors.wechat-oa-admitted";
const EPOCH_SERVICE: &str = "com.cognia.connectors.wechat-oa-credential-epoch";
const MAX_ENTRIES: usize = 256;
const MAX_QUEUE_BYTES: usize = 8 * 1024 * 1024;
const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
// Every read/modify/write uses the same lock, always before secret_store's lock.
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingWechatOaInbound {
    pub id: String,
    pub xml: String,
    pub received_at: u64,
    #[serde(default)]
    pub admitted: bool,
}

// The deduplication key is stable only while a callback remains pending.
// Every later admission receives a distinct ACK identity, including retries
// that arrive after JS accepted and ACKed the previous admission.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWechatOaInbound {
    #[serde(flatten)]
    pending: PendingWechatOaInbound,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivery_key: Option<String>,
}

/// Opaque proof of the exact credential generation used for verification.
/// No Debug implementation: the captured token must never enter a log.
#[derive(Clone)]
pub struct WechatOaVerification {
    token: String,
    encoding_aes_key: Option<String>,
    app_id: Option<String>,
    epoch: Option<String>,
    account: String,
}

impl WechatOaVerification {
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn encoding_aes_key(&self) -> Option<&str> {
        self.encoding_aes_key.as_deref()
    }

    pub fn app_id(&self) -> Option<&str> {
        self.app_id.as_deref()
    }
}

/// Capture all verification credentials and their persisted generation under
/// the same queue/index locks as every admission and credential revocation.
pub fn verification_credentials(adapter_id: &str) -> Result<Option<WechatOaVerification>, String> {
    let _guard = QUEUE_LOCK.lock();
    if super::keyring::get(adapter_id, "token")?.is_none() {
        return Ok(None);
    }
    with_verification_dependencies(adapter_id, || {
        let token = super::keyring::get(adapter_id, "token")?.ok_or("OA credentials changed")?;
        let account = account(adapter_id);
        let epoch = match secret_store::get(EPOCH_SERVICE, &account)? {
            Some(epoch) => Some(epoch),
            None => {
                // A legacy credential, or a replacement written during
                // index cleanup, must never use a reusable None epoch.
                let epoch = uuid::Uuid::new_v4().to_string();
                secret_store::set(EPOCH_SERVICE, &account, &epoch)?;
                Some(epoch)
            }
        };
        Ok(Some(WechatOaVerification {
            token,
            encoding_aes_key: super::keyring::get(adapter_id, "encodingAesKey")?,
            app_id: super::keyring::get(adapter_id, "appId")?,
            epoch,
            account,
        }))
    })
}

fn account(adapter_id: &str) -> String {
    hex::encode(Sha256::digest(adapter_id.as_bytes()))
}

fn credential_dependencies(adapter_id: &str) -> [SecretDependency; 2] {
    [SERVICE, EPOCH_SERVICE].map(|service| SecretDependency {
        service: service.to_string(),
        account: account(adapter_id),
        reset_on_write: service == EPOCH_SERVICE,
    })
}

fn with_verification_dependencies<T>(
    adapter_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let epoch_dependency = [SecretDependency {
        service: EPOCH_SERVICE.to_string(),
        account: account(adapter_id),
        reset_on_write: true,
    }];
    let aes_account = super::keyring::account_key(adapter_id, "encodingAesKey");
    let app_account = super::keyring::account_key(adapter_id, "appId");
    host_secrets::with_secret_dependency_group(
        HostSecretKind::Connector,
        &super::keyring::account_key(adapter_id, "token"),
        &credential_dependencies(adapter_id),
        &[
            (&aes_account, &epoch_dependency),
            (&app_account, &epoch_dependency),
        ],
        operation,
    )
}

fn read_queue(account: &str) -> Result<Vec<StoredWechatOaInbound>, String> {
    read_service_queue(SERVICE, account)
}

fn read_service_queue(service: &str, account: &str) -> Result<Vec<StoredWechatOaInbound>, String> {
    let Some(saved) = secret_store::get(service, account)? else {
        return Ok(Vec::new());
    };
    if saved.len() > MAX_QUEUE_BYTES {
        return Err("OA ingress exceeds its storage budget".into());
    }
    let queue: Vec<StoredWechatOaInbound> =
        serde_json::from_str(&saved).map_err(|_| "OA ingress is unreadable".to_string())?;
    if queue.len() > MAX_ENTRIES {
        return Err("OA ingress exceeds its entry budget".into());
    }
    Ok(queue)
}

/// Accept only after the verified body is retained. Duplicate delivery keeps
/// the original row and is accepted even when the queue has reached its cap.
pub fn enqueue_verified(
    adapter_id: &str,
    xml: &str,
    verified: &WechatOaVerification,
) -> Result<PendingWechatOaInbound, String> {
    enqueue_verified_before_store(adapter_id, xml, verified, || {})
}

fn enqueue_verified_before_store(
    adapter_id: &str,
    xml: &str,
    verified: &WechatOaVerification,
    before_store: impl FnOnce(),
) -> Result<PendingWechatOaInbound, String> {
    let _guard = QUEUE_LOCK.lock();
    before_store();
    with_verification_dependencies(adapter_id, || {
        // Recheck inside the index lock: device revocation bypasses the
        // keyring wrapper and must not slip between this guard and write.
        let account = account(adapter_id);
        if account != verified.account
            || secret_store::get(EPOCH_SERVICE, &account)? != verified.epoch
            || super::keyring::get(adapter_id, "token")?.as_deref() != Some(verified.token())
            || super::keyring::get(adapter_id, "encodingAesKey")? != verified.encoding_aes_key
            || super::keyring::get(adapter_id, "appId")? != verified.app_id
        {
            return Err("OA credentials changed".into());
        }
        enqueue_locked(adapter_id, xml, verified.epoch.as_deref())
    })
}

#[cfg(test)]
pub(crate) fn enqueue(adapter_id: &str, xml: &str) -> Result<PendingWechatOaInbound, String> {
    let _guard = QUEUE_LOCK.lock();
    if super::keyring::get(adapter_id, "token")?.is_none() {
        secret_store::set(
            host_secrets::CONNECTOR_SERVICE,
            &super::keyring::account_key(adapter_id, "token"),
            "test-fixture",
        )?;
    }
    enqueue_locked(adapter_id, xml, None)
}

fn enqueue_locked(
    adapter_id: &str,
    xml: &str,
    epoch: Option<&str>,
) -> Result<PendingWechatOaInbound, String> {
    let account = account(adapter_id);
    let mut queue = read_queue(&account)?;
    let admitted = read_service_queue(ADMITTED_SERVICE, &account)?;
    let delivery_key = match epoch {
        Some(epoch) => {
            let mut digest = Sha256::new();
            digest.update(epoch.as_bytes());
            digest.update([0]);
            digest.update(xml.as_bytes());
            hex::encode(digest.finalize())
        }
        None => hex::encode(Sha256::digest(xml.as_bytes())),
    };
    if let Some(existing) = queue
        .iter()
        .chain(admitted.iter())
        .find(|row| row.delivery_key.as_deref().unwrap_or(&row.pending.id) == delivery_key)
    {
        return Ok(existing.pending.clone());
    }
    if queue.len() + admitted.len() >= MAX_ENTRIES || xml.len() > MAX_XML_BYTES {
        return Err("OA ingress is full".into());
    }
    let row = PendingWechatOaInbound {
        id: uuid::Uuid::new_v4().to_string(),
        xml: xml.to_string(),
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        admitted: false,
    };
    queue.push(StoredWechatOaInbound {
        pending: row.clone(),
        delivery_key: Some(delivery_key),
    });
    let saved = serde_json::to_string(&queue).map_err(|_| "OA ingress encoding failed")?;
    // Reserve the one-byte array overhead of splitting pending/admitted
    // storage during handoff, so a full accepted queue is still claimable.
    let admitted_bytes = if admitted.is_empty() {
        0
    } else {
        serde_json::to_string(&admitted)
            .map_err(|_| "OA ingress encoding failed")?
            .len()
    };
    if saved.len() + admitted_bytes + 1 > MAX_QUEUE_BYTES {
        return Err("OA ingress is full".into());
    }
    // secret_store rolls its cache back when its atomic file write fails.
    secret_store::set(SERVICE, &account, &saved)?;
    Ok(row)
}

pub fn list(adapter_id: &str) -> Result<Vec<PendingWechatOaInbound>, String> {
    let _guard = QUEUE_LOCK.lock();
    let account = account(adapter_id);
    let mut admitted: Vec<_> = read_service_queue(ADMITTED_SERVICE, &account)?
        .into_iter()
        .map(|mut row| {
            row.pending.admitted = true;
            row.pending
        })
        .collect();
    if super::keyring::get(adapter_id, "token")?.is_some() {
        let pending = with_verification_dependencies(adapter_id, || read_queue(&account))?;
        admitted.extend(pending.into_iter().map(|row| row.pending));
    }
    admitted.sort_by_key(|row| row.received_at);
    Ok(admitted)
}

/// Transfer one exact pending admission to durable JS handoff ownership.
/// Idempotence is scoped to the admission ID, never the XML/delivery hash.
/// Revocation removes only unclaimed callbacks; this accepted handoff is
/// replayable until its JS journal admission is durably ACKed.
pub fn claim(adapter_id: &str, id: &str) -> Result<bool, String> {
    claim_before_store(adapter_id, id, || {})
}

fn claim_before_store(
    adapter_id: &str,
    id: &str,
    before_store: impl FnOnce(),
) -> Result<bool, String> {
    let _guard = QUEUE_LOCK.lock();
    before_store();
    let account = account(adapter_id);
    let mut admitted = read_service_queue(ADMITTED_SERVICE, &account)?;
    if admitted.iter().any(|row| row.pending.id == id) {
        return Ok(true);
    }
    if super::keyring::get(adapter_id, "token")?.is_none() {
        return Ok(false);
    }
    with_verification_dependencies(adapter_id, || {
        let mut pending = read_queue(&account)?;
        let Some(position) = pending.iter().position(|row| row.pending.id == id) else {
            return Ok(false);
        };
        let mut row = pending.remove(position);
        row.pending.admitted = true;
        admitted.push(row);
        persist_queue_pair(&account, &pending, &admitted)?;
        Ok(true)
    })
}

/// Remove one accepted occurrence from the latest queue, never a stale list.
pub fn acknowledge(adapter_id: &str, id: &str) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock();
    let account = account(adapter_id);
    if super::keyring::get(adapter_id, "token")?.is_none() {
        // Admitted work no longer depends on credential lifetime. Never
        // touch an orphan pending queue without its credential/index lock.
        let mut admitted = read_service_queue(ADMITTED_SERVICE, &account)?;
        let before = admitted.len();
        admitted.retain(|row| row.pending.id != id);
        if before != admitted.len() {
            let saved = encode_queue(&admitted)?;
            secret_store::apply_batch(&[queue_mutation(
                ADMITTED_SERVICE,
                &account,
                saved.as_deref(),
            )])?;
        }
        return Ok(());
    }
    with_verification_dependencies(adapter_id, || {
        let mut pending = read_queue(&account)?;
        let mut admitted = read_service_queue(ADMITTED_SERVICE, &account)?;
        let before = pending.len() + admitted.len();
        pending.retain(|row| row.pending.id != id);
        admitted.retain(|row| row.pending.id != id);
        if before != pending.len() + admitted.len() {
            persist_queue_pair(&account, &pending, &admitted)?;
        }
        Ok(())
    })
}

fn encode_queue(queue: &[StoredWechatOaInbound]) -> Result<Option<String>, String> {
    if queue.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(queue)
        .map(Some)
        .map_err(|_| "OA ingress encoding failed".into())
}

fn queue_mutation<'a>(
    service: &'a str,
    account: &'a str,
    saved: Option<&'a str>,
) -> secret_store::SecretMutation<'a> {
    match saved {
        Some(value) => secret_store::SecretMutation::Set {
            service,
            account,
            value,
        },
        None => secret_store::SecretMutation::Delete { service, account },
    }
}

fn persist_queue_pair(
    account: &str,
    pending: &[StoredWechatOaInbound],
    admitted: &[StoredWechatOaInbound],
) -> Result<(), String> {
    let pending_json = encode_queue(pending)?;
    let admitted_json = encode_queue(admitted)?;
    if pending.len() + admitted.len() > MAX_ENTRIES
        || pending_json.as_ref().map_or(0, String::len)
            + admitted_json.as_ref().map_or(0, String::len)
            > MAX_QUEUE_BYTES
    {
        return Err("OA ingress is full".into());
    }
    secret_store::apply_batch(&[
        queue_mutation(SERVICE, account, pending_json.as_deref()),
        queue_mutation(ADMITTED_SERVICE, account, admitted_json.as_deref()),
    ])
}

/// Explicit credential deletion clears retained callbacks. Runtime stop and
/// unregister never call this, so a normal restart retains unACKed work.
pub(crate) fn delete_token_and_clear(
    adapter_id: &str,
    delete_token: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock();
    advance_epoch(adapter_id)?;
    delete_token()?;
    secret_store::delete(SERVICE, &account(adapter_id))
}

/// Advance before mutating any verification credential. If that write fails,
/// old captures stay invalidated while fresh captures use the surviving values.
pub(crate) fn replace_token(
    adapter_id: &str,
    write_token: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock();
    advance_epoch(adapter_id)?;
    write_token()
}

fn advance_epoch(adapter_id: &str) -> Result<(), String> {
    secret_store::set(
        EPOCH_SERVICE,
        &account(adapter_id),
        &uuid::Uuid::new_v4().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claimed_admission_survives_revocation_until_its_exact_ack() {
        let adapter = "oa-inbox-claimed-revoke";
        super::super::keyring::set(adapter, "token", "token").unwrap();
        let verified = verification_credentials(adapter).unwrap().unwrap();
        let mut claimed = enqueue_verified(adapter, "<xml>claimed</xml>", &verified).unwrap();
        let unclaimed = enqueue_verified(adapter, "<xml>unclaimed</xml>", &verified).unwrap();
        assert!(claim(adapter, &claimed.id).unwrap());
        claimed.admitted = true;
        super::super::keyring::delete(adapter, "token").unwrap();
        assert_eq!(list(adapter).unwrap(), vec![claimed.clone()]);
        assert!(claim(adapter, &claimed.id).unwrap());
        assert!(!claim(adapter, &unclaimed.id).unwrap());
        acknowledge(adapter, &claimed.id).unwrap();
        assert!(list(adapter).unwrap().is_empty());
    }

    #[test]
    fn failed_claim_and_ack_keep_the_exact_durable_owner_retryable() {
        let adapter = "oa-inbox-claim-failures";
        super::super::keyring::set(adapter, "token", "token").unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        let mut row = enqueue_verified(adapter, "<xml>retryable</xml>", &captured).unwrap();
        secret_store::fail_next_mutation_for_test(ADMITTED_SERVICE, &account(adapter));
        assert!(claim(adapter, &row.id).is_err());
        assert_eq!(list(adapter).unwrap(), vec![row.clone()]);
        assert!(read_service_queue(ADMITTED_SERVICE, &account(adapter))
            .unwrap()
            .is_empty());
        assert!(claim(adapter, &row.id).unwrap());
        row.admitted = true;
        assert!(read_queue(&account(adapter)).unwrap().is_empty());
        assert_eq!(enqueue_verified(adapter, &row.xml, &captured).unwrap(), row);
        super::super::keyring::delete(adapter, "token").unwrap();
        secret_store::fail_next_mutation_for_test(ADMITTED_SERVICE, &account(adapter));
        assert!(acknowledge(adapter, &row.id).is_err());
        assert_eq!(list(adapter).unwrap(), vec![row.clone()]);
        acknowledge(adapter, &row.id).unwrap();
        assert!(list(adapter).unwrap().is_empty());
    }

    #[test]
    fn revocation_before_claim_prevents_handoff_but_cannot_revoke_claimed_work() {
        let adapter = "oa-inbox-claim-revocation-race";
        super::super::keyring::set_with_writer(
            adapter,
            "token",
            "token",
            Some(host_secrets::SecretWriter {
                device_id: "oa-claim-revoke-device".into(),
                label: None,
            }),
            1,
        )
        .unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        let mut accepted = enqueue_verified(adapter, "<xml>accepted</xml>", &captured).unwrap();
        let pending = enqueue_verified(adapter, "<xml>pending</xml>", &captured).unwrap();
        assert!(claim(adapter, &accepted.id).unwrap());
        accepted.admitted = true;
        let (ready, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let claiming = std::thread::spawn(move || {
            claim_before_store(adapter, &pending.id, || {
                ready.send(()).unwrap();
                resume.recv().unwrap();
            })
        });
        waiting.recv().unwrap();
        host_secrets::forget_device("oa-claim-revoke-device").unwrap();
        release.send(()).unwrap();
        assert!(!claiming.join().unwrap().unwrap());
        assert_eq!(list(adapter).unwrap(), vec![accepted]);
    }

    #[test]
    fn a_full_queue_can_transfer_ownership_without_accepting_more_work() {
        let adapter = "oa-inbox-full-claim";
        for index in 0..MAX_ENTRIES {
            enqueue(adapter, &format!("<xml>{index}</xml>")).unwrap();
        }
        let pending = list(adapter).unwrap();
        assert!(claim(adapter, &pending[0].id).unwrap());
        assert_eq!(list(adapter).unwrap().len(), MAX_ENTRIES);
        assert!(enqueue(adapter, "<xml>overflow</xml>").is_err());
        assert_eq!(enqueue(adapter, &pending[0].xml).unwrap().id, pending[0].id);
        assert!(!claim("oa-inbox-other-claim", &pending[0].id).unwrap());
    }

    #[test]
    fn stale_ack_cannot_remove_a_reaccepted_identical_delivery() {
        let adapter = "oa-inbox-stale-replay-ack";
        super::super::keyring::set(adapter, "token", "token").unwrap();
        let verified = verification_credentials(adapter).unwrap().unwrap();
        let first = enqueue_verified(adapter, "<xml>replayed</xml>", &verified).unwrap();
        acknowledge(adapter, &first.id).unwrap();
        let replay = enqueue_verified(adapter, "<xml>replayed</xml>", &verified).unwrap();
        acknowledge(adapter, &first.id).unwrap();
        assert_eq!(list(adapter).unwrap(), vec![replay]);
    }

    #[test]
    fn replacing_a_verification_key_fences_captured_callbacks() {
        for credential in ["encodingAesKey", "appId"] {
            let adapter = format!("oa-inbox-captured-{credential}");
            super::super::keyring::set(&adapter, "token", "token").unwrap();
            super::super::keyring::set(&adapter, credential, "old").unwrap();
            let verified = verification_credentials(&adapter).unwrap().unwrap();
            super::super::keyring::set(&adapter, credential, "new").unwrap();
            assert!(enqueue_verified(&adapter, "<xml>obsolete</xml>", &verified).is_err());
        }
    }

    #[test]
    fn host_verification_key_aba_invalidates_old_captures_without_dropping_accepted_work() {
        for credential in ["encodingAesKey", "appId"] {
            let adapter = format!("oa-inbox-host-key-aba-{credential}");
            let name = super::super::keyring::account_key(&adapter, credential);
            super::super::keyring::set(&adapter, "token", "token").unwrap();
            super::super::keyring::set(&adapter, credential, "old").unwrap();
            let verified = verification_credentials(&adapter).unwrap().unwrap();
            let retained = enqueue_verified(&adapter, "<xml>accepted</xml>", &verified).unwrap();
            host_secrets::set(HostSecretKind::Connector, &name, "new", None, 1).unwrap();
            host_secrets::set(HostSecretKind::Connector, &name, "old", None, 2).unwrap();
            assert!(enqueue_verified(&adapter, "<xml>obsolete</xml>", &verified).is_err());
            let fresh = verification_credentials(&adapter).unwrap().unwrap();
            assert!(fresh.epoch != verified.epoch);
            assert_eq!(list(&adapter).unwrap(), vec![retained]);
        }
    }

    #[test]
    fn device_revocation_of_an_optional_verification_key_fences_waiting_admission() {
        let adapter = "oa-inbox-revoked-optional-key";
        let name = super::super::keyring::account_key(adapter, "encodingAesKey");
        super::super::keyring::set(adapter, "token", "token").unwrap();
        host_secrets::set(
            HostSecretKind::Connector,
            &name,
            "old-key",
            Some(host_secrets::SecretWriter {
                device_id: "oa-optional-key-device".into(),
                label: None,
            }),
            1,
        )
        .unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        let retained = enqueue_verified(adapter, "<xml>accepted</xml>", &captured).unwrap();
        let (ready, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let admission = std::thread::spawn(move || {
            enqueue_verified_before_store(adapter, "<xml>obsolete</xml>", &captured, || {
                ready.send(()).unwrap();
                resume.recv().unwrap();
            })
        });
        waiting.recv().unwrap();
        host_secrets::forget_device("oa-optional-key-device").unwrap();
        release.send(()).unwrap();
        assert!(admission.join().unwrap().is_err());
        assert_eq!(list(adapter).unwrap(), vec![retained]);
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        assert_eq!(fresh.encoding_aes_key(), None);
    }

    #[test]
    fn optional_verification_credential_create_delete_aba_invalidates_capture() {
        let adapter = "oa-inbox-missing-appid-aba";
        let name = super::super::keyring::account_key(adapter, "appId");
        super::super::keyring::set(adapter, "token", "token").unwrap();
        let verified = verification_credentials(adapter).unwrap().unwrap();
        assert_eq!(verified.app_id(), None);
        host_secrets::set(HostSecretKind::Connector, &name, "temporary", None, 1).unwrap();
        host_secrets::delete(HostSecretKind::Connector, &name).unwrap();
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &verified).is_err());
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        enqueue_verified(adapter, "<xml>fresh</xml>", &fresh).unwrap();
    }

    #[test]
    fn legacy_pending_rows_keep_their_ack_id_and_duplicate_identity() {
        let adapter = "oa-inbox-legacy-stored-row";
        let xml = "<xml>legacy</xml>";
        let id = hex::encode(Sha256::digest(xml.as_bytes()));
        let legacy = PendingWechatOaInbound {
            id: id.clone(),
            xml: xml.into(),
            received_at: 7,
            admitted: false,
        };
        secret_store::set(
            SERVICE,
            &account(adapter),
            &serde_json::to_string(&vec![legacy.clone()]).unwrap(),
        )
        .unwrap();
        assert_eq!(enqueue(adapter, xml).unwrap(), legacy);
        let additional = enqueue(adapter, "<xml>additional</xml>").unwrap();
        acknowledge(adapter, &id).unwrap();
        assert_eq!(list(adapter).unwrap(), vec![additional]);
    }

    #[test]
    fn partial_credential_cleanup_does_not_expose_or_ack_retained_callbacks() {
        let adapter = "oa-inbox-partial-credential-cleanup";
        super::super::keyring::set(adapter, "token", "token").unwrap();
        let verified = verification_credentials(adapter).unwrap().unwrap();
        let retained = enqueue_verified(adapter, "<xml>accepted</xml>", &verified).unwrap();
        // Simulate failure/crash after deleting the credential but before
        // dependent cleanup. Do not erase accepted bodies just by listing.
        secret_store::delete(
            host_secrets::CONNECTOR_SERVICE,
            &super::super::keyring::account_key(adapter, "token"),
        )
        .unwrap();
        assert!(list(adapter).unwrap().is_empty());
        acknowledge(adapter, &retained.id).unwrap();
        assert_eq!(read_queue(&account(adapter)).unwrap()[0].pending, retained);
    }

    #[test]
    fn delayed_note_deleted_preserves_replacement_credentials_and_fresh_queue() {
        let adapter = "oa-inbox-delayed-cleanup";
        super::super::keyring::set(adapter, "token", "old").unwrap();
        let old = verification_credentials(adapter).unwrap().unwrap();
        enqueue_verified(adapter, "<xml>old</xml>", &old).unwrap();
        super::super::keyring::delete(adapter, "token").unwrap();
        // The RPC's note_deleted is delayed until after a replacement was
        // written and a fresh callback gained durable ownership.
        super::super::keyring::set(adapter, "token", "new").unwrap();
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        let pending = enqueue_verified(adapter, "<xml>fresh</xml>", &fresh).unwrap();
        host_secrets::note_deleted(
            HostSecretKind::Connector,
            &super::super::keyring::account_key(adapter, "token"),
        )
        .unwrap();
        assert_eq!(list(adapter).unwrap(), vec![pending]);
        assert_eq!(
            super::super::keyring::get(adapter, "token")
                .unwrap()
                .as_deref(),
            Some("new")
        );
        assert_eq!(
            secret_store::get(EPOCH_SERVICE, &account(adapter)).unwrap(),
            fresh.epoch
        );
    }

    #[test]
    fn direct_host_secret_replacements_fence_the_same_token_aba() {
        let adapter = "oa-inbox-direct-host-aba";
        let name = super::super::keyring::account_key(adapter, "token");
        super::super::keyring::set(adapter, "token", "old").unwrap();
        let old = verification_credentials(adapter).unwrap().unwrap();
        let retained =
            enqueue_verified(adapter, "<xml>accepted before rotation</xml>", &old).unwrap();
        host_secrets::set(HostSecretKind::Connector, &name, "new", None, 1).unwrap();
        host_secrets::set(HostSecretKind::Connector, &name, "old", None, 2).unwrap();
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &old).is_err());
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        assert_ne!(old.epoch, fresh.epoch);
        host_secrets::note_written(HostSecretKind::Connector, &name, None, 3).unwrap();
        assert_eq!(
            secret_store::get(EPOCH_SERVICE, &account(adapter)).unwrap(),
            fresh.epoch
        );
        let new = enqueue_verified(adapter, "<xml>fresh</xml>", &fresh).unwrap();
        assert_eq!(list(adapter).unwrap(), vec![retained, new]);
    }

    #[test]
    fn device_revocation_clears_only_its_credential_owned_oa_state() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let adapter = "oa-inbox-device-owned";
        let other = "oa-inbox-other-device";
        for (adapter, device) in [(adapter, "oa-device-revoke"), (other, "oa-device-keep")] {
            super::super::keyring::set(adapter, "token", "token").unwrap();
            host_secrets::note_written(
                HostSecretKind::Connector,
                &super::super::keyring::account_key(adapter, "token"),
                Some(SecretWriter {
                    device_id: device.to_string(),
                    label: None,
                }),
                1,
            )
            .unwrap();
            let verified = verification_credentials(adapter).unwrap().unwrap();
            enqueue_verified(adapter, "<xml>pending</xml>", &verified).unwrap();
        }
        host_secrets::forget_device("oa-device-revoke").unwrap();
        assert!(list(adapter).unwrap().is_empty());
        assert_eq!(
            secret_store::get(EPOCH_SERVICE, &account(adapter)).unwrap(),
            None
        );
        assert_eq!(list(other).unwrap().len(), 1);
        assert!(secret_store::get(EPOCH_SERVICE, &account(other))
            .unwrap()
            .is_some());
    }

    #[test]
    fn device_revocation_while_admission_waits_does_not_recreate_the_queue() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let adapter = "oa-inbox-revoke-waiting";
        super::super::keyring::set(adapter, "token", "token").unwrap();
        host_secrets::note_written(
            HostSecretKind::Connector,
            &super::super::keyring::account_key(adapter, "token"),
            Some(SecretWriter {
                device_id: "oa-device-waiting".to_string(),
                label: None,
            }),
            1,
        )
        .unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        let (ready, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let admission = std::thread::spawn(move || {
            enqueue_verified_before_store(adapter, "<xml>obsolete</xml>", &captured, || {
                ready.send(()).unwrap();
                resume.recv().unwrap();
            })
        });
        waiting.recv().unwrap();
        host_secrets::forget_device("oa-device-waiting").unwrap();
        release.send(()).unwrap();
        assert!(admission.join().unwrap().is_err());
        assert!(list(adapter).unwrap().is_empty());
    }

    #[test]
    fn old_capture_is_rejected_after_delete_and_restore_of_the_same_token() {
        let adapter = "oa-inbox-same-token-aba";
        super::super::keyring::set(adapter, "token", "same").unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        let old = enqueue_verified(adapter, "<xml>same</xml>", &captured).unwrap();
        super::super::keyring::delete(adapter, "token").unwrap();
        super::super::keyring::set(adapter, "token", "same").unwrap();
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &captured).is_err());
        assert!(list(adapter).unwrap().is_empty());
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        assert_eq!(
            secret_store::get(EPOCH_SERVICE, &account(adapter)).unwrap(),
            fresh.epoch
        );
        let current = enqueue_verified(adapter, "<xml>same</xml>", &fresh).unwrap();
        assert_ne!(old.id, current.id);
        acknowledge(adapter, &old.id).unwrap();
        assert_eq!(list(adapter).unwrap(), vec![current]);
    }

    #[test]
    fn replacing_with_the_same_token_also_fences_an_old_capture() {
        let adapter = "oa-inbox-same-value-set";
        super::super::keyring::set(adapter, "token", "same").unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        super::super::keyring::set(adapter, "token", "same").unwrap();
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &captured).is_err());
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        enqueue_verified(adapter, "<xml>new</xml>", &fresh).unwrap();
    }

    #[test]
    fn failed_token_write_invalidates_the_old_capture_but_allows_a_fresh_one() {
        let adapter = "oa-inbox-token-write-failure";
        super::super::keyring::set(adapter, "token", "surviving").unwrap();
        let captured = verification_credentials(adapter).unwrap().unwrap();
        assert!(replace_token(adapter, || Err("injected write failure".into())).is_err());
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &captured).is_err());
        let fresh = verification_credentials(adapter).unwrap().unwrap();
        assert_eq!(fresh.token(), "surviving");
        enqueue_verified(adapter, "<xml>new</xml>", &fresh).unwrap();
    }

    #[test]
    fn stale_verified_token_cannot_recreate_pending_work_after_rotation() {
        let adapter = "oa-inbox-token-rotation";
        super::super::keyring::set(adapter, "token", "old").unwrap();
        let old = verification_credentials(adapter).unwrap().unwrap();
        enqueue_verified(adapter, "<xml>old</xml>", &old).unwrap();
        super::super::keyring::delete(adapter, "token").unwrap();
        super::super::keyring::set(adapter, "token", "new").unwrap();
        assert!(enqueue_verified(adapter, "<xml>obsolete</xml>", &old).is_err());
        assert!(list(adapter).unwrap().is_empty());
        let new = verification_credentials(adapter).unwrap().unwrap();
        enqueue_verified(adapter, "<xml>new</xml>", &new).unwrap();
        assert_eq!(list(adapter).unwrap()[0].xml, "<xml>new</xml>");
    }

    #[test]
    fn restores_pending_rows_and_acknowledges_only_the_exact_scoped_id() {
        let first = enqueue("oa-inbox-restore", "<xml>first</xml>").unwrap();
        let other = enqueue("oa-inbox-restore", "<xml>other</xml>").unwrap();
        assert_eq!(enqueue("oa-inbox-restore", &first.xml).unwrap(), first);
        acknowledge("oa-inbox-another", &first.id).unwrap();
        assert_eq!(
            list("oa-inbox-restore").unwrap(),
            vec![first.clone(), other.clone()]
        );
        acknowledge("oa-inbox-restore", &first.id).unwrap();
        acknowledge("oa-inbox-restore", &first.id).unwrap();
        assert_eq!(list("oa-inbox-restore").unwrap(), vec![other.clone()]);
        acknowledge("oa-inbox-restore", &other.id).unwrap();
        assert!(list("oa-inbox-restore").unwrap().is_empty());
        assert!(secret_store::get(SERVICE, &account("oa-inbox-restore"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn full_queue_rejects_new_work_but_still_accepts_its_duplicate() {
        let adapter = "oa-inbox-full";
        for index in 0..MAX_ENTRIES {
            enqueue(adapter, &format!("<xml>{index}</xml>")).unwrap();
        }
        assert!(enqueue(adapter, "<xml>overflow</xml>").is_err());
        assert!(enqueue(adapter, "<xml>0</xml>").is_ok());
        assert_eq!(list(adapter).unwrap().len(), MAX_ENTRIES);
    }

    #[test]
    fn invalid_or_oversized_storage_is_preserved_and_never_acknowledged() {
        let adapter = "oa-inbox-unreadable";
        let key = account(adapter);
        secret_store::set(SERVICE, &key, "corrupt").unwrap();
        assert!(enqueue(adapter, "<xml>retry</xml>").is_err());
        assert!(acknowledge(adapter, "anything").is_err());
        assert_eq!(
            secret_store::get(SERVICE, &key).unwrap().as_deref(),
            Some("corrupt")
        );
        assert!(enqueue("oa-inbox-large", &"x".repeat(MAX_XML_BYTES + 1)).is_err());
        assert!(list("oa-inbox-large").unwrap().is_empty());
    }

    #[test]
    fn concurrent_acceptance_and_ack_do_not_overwrite_other_deliveries() {
        let adapter = "oa-inbox-concurrent";
        let initial = enqueue(adapter, "<xml>initial</xml>").unwrap();
        let threads: Vec<_> = (0..24)
            .map(|index| {
                let initial_id = initial.id.clone();
                std::thread::spawn(move || {
                    enqueue(adapter, &format!("<xml>{index}</xml>")).unwrap();
                    acknowledge(adapter, &initial_id).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let pending = list(adapter).unwrap();
        assert_eq!(pending.len(), 24);
        assert!(pending.iter().all(|row| row.id != initial.id));
    }
}
