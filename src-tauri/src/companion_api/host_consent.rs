//! Host-side confirmation for admin leases.
//!
//! # Why this exists
//!
//! `host_admin_lease_issue` used to take the confirmation as an argument:
//! `confirmed: bool`, sent by the caller, checked by the host. The only TS
//! caller wrote `confirmed: true` unconditionally, `authorize_approval`
//! special-cased the command so its `approval: interactive` never met a real
//! gate, and `admin_lease::issue` rejected `false` — a check nothing could
//! fail. The manifest promised an interactive approval and the implementation
//! was self-attestation.
//!
//! The confirmation has to be obtained BY the host, not asserted TO it. That
//! is all this module does: it records that a device asked for a lease, lets a
//! human answer on the host's own terms, and hands the answer back exactly
//! once.
//!
//! # The approver is never the requester
//!
//! A paired device holding `host.admin` may answer someone else's request and
//! never its own — otherwise a single compromised device asks and approves in
//! one breath, which is the self-attestation this module exists to remove.
//! `owner` and `service` scopes are exempt: the desktop operator answering at
//! their own keyboard and the loopback CLI on the server are both outside the
//! device plane, and neither has a device to impersonate.
//!
//! On a deployment whose only paired device is the one asking, that leaves the
//! CLI as the sole approver. That is the intended shape, not a gap: the trust
//! root for a headless host is whoever can reach its console.
//!
//! # Codes
//!
//! Each request carries a short code so a human can approve it from a terminal
//! without copying a UUID. The code is not a secret — it identifies a request,
//! it does not authorize one. Answering still requires `host.admin` on the
//! device plane or console access on the host.

/// Event topic carrying an escalation ask and, later, its answer.
///
/// One channel rather than two: an approver surface needs the same row whether
/// it is being offered or being dismissed, and `state` on the payload already
/// says which. Catalogued in `event_channels::EVENT_CHANNELS`.
pub const CONSENT_CHANNEL: &str = "host-consent://requested";

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

/// How long an unanswered request stays answerable. Long enough to walk to
/// another device, short enough that a forgotten prompt cannot be approved
/// hours later against a request nobody remembers making.
const REQUEST_TTL_MS: u64 = 5 * 60 * 1000;

/// How long an approval waits to be collected. Deliberately brief: the
/// requester is retrying, and an approval that outlives the attempt it was
/// granted for is a lease waiting to be minted by the next attempt.
const APPROVAL_TTL_MS: u64 = 2 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentState {
    Pending,
    Approved,
    Denied,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequest {
    pub id: String,
    pub code: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub operations: Vec<String>,
    pub state: ConsentState,
    pub requested_at: u64,
    pub expires_at: u64,
}

static REQUESTS: Lazy<Mutex<HashMap<String, ConsentRequest>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Drop everything past its deadline. Approvals and pending requests expire on
/// different clocks, so this cannot be a single `expires_at` comparison.
fn sweep(map: &mut HashMap<String, ConsentRequest>, now: u64) {
    map.retain(|_, entry| entry.expires_at > now);
}

fn short_code() -> String {
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase()
}

fn same_operations(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut left: Vec<&String> = a.iter().collect();
    let mut right: Vec<&String> = b.iter().collect();
    left.sort();
    right.sort();
    left == right
}

/// Record that `device_id` wants a lease over `operations`, or return the
/// request it already has open.
///
/// Idempotent on purpose. The requester learns it needs consent by being
/// refused, so it retries — a settings dialog that re-mounts would otherwise
/// queue one prompt per paint, and the approver would face a list of identical
/// rows with different codes.
pub fn request(
    device_id: &str,
    account_id: Option<&str>,
    operations: Vec<String>,
) -> ConsentRequest {
    let now = now_ms();
    let mut map = REQUESTS.lock();
    sweep(&mut map, now);

    if let Some(existing) = map.values().find(|entry| {
        entry.state == ConsentState::Pending
            && entry.device_id == device_id
            && same_operations(&entry.operations, &operations)
    }) {
        return existing.clone();
    }

    let entry = ConsentRequest {
        id: Uuid::new_v4().to_string(),
        code: short_code(),
        device_id: device_id.to_string(),
        account_id: account_id.map(str::to_string),
        operations,
        state: ConsentState::Pending,
        requested_at: now,
        expires_at: now.saturating_add(REQUEST_TTL_MS),
    };
    map.insert(entry.id.clone(), entry.clone());
    entry
}

/// Every request still awaiting an answer.
pub fn pending() -> Vec<ConsentRequest> {
    let now = now_ms();
    let mut map = REQUESTS.lock();
    sweep(&mut map, now);
    let mut open: Vec<ConsentRequest> = map
        .values()
        .filter(|entry| entry.state == ConsentState::Pending)
        .cloned()
        .collect();
    open.sort_by_key(|entry| entry.requested_at);
    open
}

/// Who is answering, and whether they are allowed to answer at all.
pub enum Approver<'a> {
    /// A paired device, identified by its own device id.
    Device(&'a str),
    /// The desktop operator or the host's own console — outside the device
    /// plane, so the self-approval rule does not apply.
    Host,
}

/// Answer a request by id or by code.
pub fn resolve(
    id_or_code: &str,
    approve: bool,
    approver: Approver<'_>,
) -> Result<ConsentRequest, String> {
    let now = now_ms();
    let mut map = REQUESTS.lock();
    sweep(&mut map, now);

    let needle = id_or_code.trim();
    let key = map
        .values()
        .find(|entry| {
            entry.state == ConsentState::Pending
                && (entry.id == needle || entry.code.eq_ignore_ascii_case(needle))
        })
        .map(|entry| entry.id.clone())
        .ok_or_else(|| {
            "REMOTE_CONSENT_REQUIRED: no open approval request matches that code".to_string()
        })?;

    let entry = map.get_mut(&key).expect("looked up above");
    if let Approver::Device(approver_id) = approver {
        if approver_id == entry.device_id {
            return Err("REMOTE_SCOPE_DENIED: a device may not approve its own escalation".into());
        }
    }

    entry.state = if approve {
        ConsentState::Approved
    } else {
        ConsentState::Denied
    };
    // An answered request lives on its own, much shorter clock: an approval is
    // collected by the retry that follows it, not kept for the rest of the
    // original five minutes.
    entry.expires_at = now.saturating_add(APPROVAL_TTL_MS);
    Ok(entry.clone())
}

/// Consume an approval covering every one of `operations` for `device_id`.
///
/// Consuming rather than reading is what makes one confirmation buy one lease.
/// The lease itself then supplies the window (`admin_lease`), so the approval
/// has no reason to outlive the moment it is spent.
pub fn take_approved(device_id: &str, operations: &[String]) -> bool {
    let now = now_ms();
    let mut map = REQUESTS.lock();
    sweep(&mut map, now);

    let key = map.values().find_map(|entry| {
        (entry.state == ConsentState::Approved
            && entry.device_id == device_id
            && same_operations(&entry.operations, operations))
        .then(|| entry.id.clone())
    });

    match key {
        Some(id) => {
            map.remove(&id);
            true
        }
        None => false,
    }
}

/// Drop every record belonging to a device. Called when it unpairs or its
/// standing is revoked, so a pending ask cannot be answered for a device that
/// is no longer entitled to the answer.
pub fn forget_device(device_id: &str) {
    REQUESTS
        .lock()
        .retain(|_, entry| entry.device_id != device_id);
}

/// Desktop-local approver arms.
///
/// The renderer reaches commands through Tauri IPC, not through `_rpc`, so the
/// dispatch arms in `rpc/native_tools.rs` are invisible to it — the same trap
/// `host_admin_lease_issue` fell into, where a command existed on the protocol
/// face and no desktop surface could call it. Registering these means the
/// desktop operator can answer a paired device's escalation from their own
/// screen, which on a desktop host is the whole point.
///
/// Both answer as [`Approver::Host`]: the renderer runs on the host machine
/// behind its OS session, so it is not a device that could be impersonated and
/// the self-approval rule has nothing to protect it from.
#[tauri::command]
pub fn host_consent_pending() -> Vec<ConsentRequest> {
    pending()
}

#[tauri::command]
pub fn host_consent_respond(
    app: tauri::AppHandle,
    request_id: String,
    approve: bool,
) -> Result<ConsentRequest, String> {
    let answered = resolve(&request_id, approve, Approver::Host)?;
    use tauri::Emitter as _;
    // Same channel as the ask, so an approver surface on a paired device drops
    // the row it is still showing.
    let _ = app.emit(CONSENT_CHANNEL, &answered);
    Ok(answered)
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    REQUESTS.lock().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops() -> Vec<String> {
        vec![
            "connectors_keyring_get".into(),
            "connectors_keyring_set".into(),
        ]
    }

    #[test]
    fn a_request_is_not_an_approval() {
        reset_for_tests();
        request("phone-1", Some("acct"), ops());
        assert!(!take_approved("phone-1", &ops()));
    }

    #[test]
    fn approving_lets_exactly_one_lease_through() {
        reset_for_tests();
        let open = request("phone-1", Some("acct"), ops());
        resolve(&open.code, true, Approver::Host).expect("resolve");

        assert!(take_approved("phone-1", &ops()));
        // One confirmation buys one lease: the second attempt has to ask again.
        assert!(!take_approved("phone-1", &ops()));
    }

    #[test]
    fn a_retry_reuses_the_open_request_instead_of_queueing_another() {
        reset_for_tests();
        let first = request("phone-1", None, ops());
        let second = request("phone-1", None, ops());
        assert_eq!(first.id, second.id);
        assert_eq!(pending().len(), 1);
    }

    #[test]
    fn operations_are_compared_as_a_set_not_a_sequence() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.id, true, Approver::Host).expect("resolve");
        let reordered = vec![
            "connectors_keyring_set".to_string(),
            "connectors_keyring_get".to_string(),
        ];
        assert!(take_approved("phone-1", &reordered));
    }

    #[test]
    fn an_approval_does_not_cover_operations_it_did_not_name() {
        reset_for_tests();
        let open = request("phone-1", None, vec!["connectors_keyring_get".into()]);
        resolve(&open.id, true, Approver::Host).expect("resolve");
        assert!(!take_approved("phone-1", &ops()));
    }

    #[test]
    fn an_approval_belongs_to_the_device_that_asked() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.id, true, Approver::Host).expect("resolve");
        assert!(!take_approved("phone-2", &ops()));
    }

    #[test]
    fn a_device_cannot_approve_its_own_escalation() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        let err = resolve(&open.code, true, Approver::Device("phone-1")).expect_err("self-approve");
        assert!(err.starts_with("REMOTE_SCOPE_DENIED"), "{err}");
        assert!(!take_approved("phone-1", &ops()));
    }

    #[test]
    fn another_device_may_approve() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.code, true, Approver::Device("laptop-2")).expect("resolve");
        assert!(take_approved("phone-1", &ops()));
    }

    #[test]
    fn denying_leaves_nothing_to_collect() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.id, false, Approver::Host).expect("resolve");
        assert!(!take_approved("phone-1", &ops()));
        assert!(pending().is_empty());
    }

    #[test]
    fn an_answered_request_cannot_be_answered_again() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.id, false, Approver::Host).expect("first");
        // Without this a denial could be overturned by anyone who kept the code.
        assert!(resolve(&open.id, true, Approver::Host).is_err());
    }

    #[test]
    fn an_unknown_code_is_refused_rather_than_ignored() {
        reset_for_tests();
        let err = resolve("NOPE", true, Approver::Host).expect_err("unknown");
        assert!(err.starts_with("REMOTE_CONSENT_REQUIRED"), "{err}");
    }

    #[test]
    fn codes_match_case_insensitively_because_people_type_them() {
        reset_for_tests();
        let open = request("phone-1", None, ops());
        resolve(&open.code.to_lowercase(), true, Approver::Host).expect("resolve");
        assert!(take_approved("phone-1", &ops()));
    }

    #[test]
    fn forgetting_a_device_drops_its_open_asks() {
        reset_for_tests();
        request("phone-1", None, ops());
        request("phone-2", None, ops());
        forget_device("phone-1");
        let open = pending();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].device_id, "phone-2");
    }
}
