//! Fail-closed policy core for opt-in macOS Locked Use.
//!
//! Native installation, XPC transport, the guardian windows, and the
//! Authorization Plugin are deliberately thin edges around this state machine.
//! They cannot mint authority: every unlock and action must present an
//! Ed25519-signed lease plus the authenticated tool-turn facts checked here.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::input_monitor::{InputMonitor, SafetyInputSubscription};

pub const LOCKED_USE_PROTOCOL_VERSION: u32 = 1;
pub const MAX_UNLOCK_LEASE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSenderIdentity {
    pub team_id: String,
    pub bundle_id: String,
    pub code_requirement: String,
    pub audit_token_digest: String,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnlockLeaseClaims {
    pub lease_id: String,
    pub device_id: String,
    pub account_id: String,
    pub task_id: String,
    pub turn_id: String,
    pub allowed_bundle_ids: Vec<String>,
    pub nonce: String,
    pub protocol_version: u32,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignedUnlockLease {
    pub claims: UnlockLeaseClaims,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedToolTurn {
    pub device_id: String,
    pub account_id: String,
    pub task_id: String,
    pub turn_id: String,
    pub active: bool,
    pub remote_control_granted: bool,
    pub locked_use_granted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LockedUseState {
    Disabled,
    Ready,
    Active,
    LatchedUntilManualUnlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelockCause {
    PhysicalInput,
    RemoteDisconnect,
    GuardianCrash,
    ServiceCrash,
    LeaseExpired,
    DisplayProtectionFailure,
    TaskCancelled,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum LockedUseError {
    #[error("Locked Use is disabled or not installed")]
    NotReady,
    #[error("automatic unlock is latched off until manual unlock")]
    Latched,
    #[error("native sender identity did not match the signed installation")]
    SenderMismatch,
    #[error("native protocol version mismatch")]
    ProtocolMismatch,
    #[error("unlock lease signature is invalid")]
    InvalidSignature,
    #[error("unlock lease is expired or outside the 30 second limit")]
    InvalidLifetime,
    #[error("unlock lease nonce was already used")]
    ReplayedNonce,
    #[error("request is not bound to the active authenticated tool turn")]
    TurnMismatch,
    #[error("device does not hold both remote-control and Locked Use grants")]
    DeviceNotGranted,
    #[error("lease requested an application not persistently approved while unlocked")]
    ApplicationNotApproved,
    #[error("action target is outside the lease allow-list")]
    TargetOutsideLease,
    #[error("action confirmation digest did not match")]
    ConfirmationMismatch,
}

#[derive(Debug, Clone)]
struct ActiveLease {
    claims: UnlockLeaseClaims,
}

pub struct LockedUseController {
    state: LockedUseState,
    expected_sender: NativeSenderIdentity,
    lease_key: VerifyingKey,
    approved_bundle_ids: HashSet<String>,
    used_nonces: HashSet<String>,
    active: Option<ActiveLease>,
}

pub struct LockedUseSafetyMonitor {
    input_monitor: InputMonitor,
    subscription: Option<SafetyInputSubscription>,
    task: tokio::task::JoinHandle<()>,
}

impl LockedUseSafetyMonitor {
    pub fn start(
        input_monitor: InputMonitor,
        controller: Arc<Mutex<LockedUseController>>,
        on_relock: Arc<dyn Fn(RelockCause) + Send + Sync>,
    ) -> Result<Self, String> {
        let subscription = input_monitor.subscribe_safety()?;
        Ok(Self::from_subscription(
            input_monitor,
            subscription,
            controller,
            on_relock,
        ))
    }

    fn from_subscription(
        input_monitor: InputMonitor,
        mut subscription: SafetyInputSubscription,
        controller: Arc<Mutex<LockedUseController>>,
        on_relock: Arc<dyn Fn(RelockCause) + Send + Sync>,
    ) -> Self {
        let mut receiver = subscription.take_receiver();
        let task = tokio::spawn(async move {
            loop {
                let wait = {
                    let controller = controller.lock();
                    controller
                        .active
                        .as_ref()
                        .map(|active| {
                            Duration::from_millis(
                                active
                                    .claims
                                    .expires_at_ms
                                    .saturating_sub(unix_time_ms())
                                    .max(0) as u64,
                            )
                        })
                        .unwrap_or(MAX_UNLOCK_LEASE)
                };
                let cause = tokio::select! {
                    input = receiver.recv() => {
                        Some(if input.is_some() {
                            RelockCause::PhysicalInput
                        } else {
                            RelockCause::DisplayProtectionFailure
                        })
                    }
                    _ = tokio::time::sleep(wait) => {
                        let expired = controller
                            .lock()
                            .active
                            .as_ref()
                            .is_some_and(|active| active.claims.expires_at_ms <= unix_time_ms());
                        expired.then_some(RelockCause::LeaseExpired)
                    }
                };
                let Some(cause) = cause else {
                    continue;
                };
                let should_relock = {
                    let mut controller = controller.lock();
                    if controller.state() != LockedUseState::Active {
                        false
                    } else {
                        controller.relock_and_latch(cause);
                        true
                    }
                };
                if should_relock {
                    on_relock(cause);
                    break;
                }
            }
        });
        Self {
            input_monitor,
            subscription: Some(subscription),
            task,
        }
    }
}

impl Drop for LockedUseSafetyMonitor {
    fn drop(&mut self) {
        self.task.abort();
        self.subscription.take();
        self.input_monitor.stop_if_idle();
    }
}

impl LockedUseController {
    pub fn disabled(expected_sender: NativeSenderIdentity, lease_key: VerifyingKey) -> Self {
        Self {
            state: LockedUseState::Disabled,
            expected_sender,
            lease_key,
            approved_bundle_ids: HashSet::new(),
            used_nonces: HashSet::new(),
            active: None,
        }
    }

    pub fn state(&self) -> LockedUseState {
        self.state
    }

    /// Called only after the privileged installer returns a verified,
    /// administrator-authorized installation receipt.
    pub fn enable_from_verified_install(&mut self, receipt_verified: bool) {
        self.state = if receipt_verified {
            LockedUseState::Ready
        } else {
            LockedUseState::Disabled
        };
        self.active = None;
    }

    pub fn disable(&mut self) {
        self.state = LockedUseState::Disabled;
        self.active = None;
    }

    /// Persistent approvals may only be edited while macOS is already
    /// unlocked. The native settings edge supplies that OS-observed fact.
    pub fn set_persistent_approvals(
        &mut self,
        mac_is_unlocked: bool,
        bundle_ids: impl IntoIterator<Item = String>,
    ) -> Result<(), LockedUseError> {
        if !mac_is_unlocked || self.state == LockedUseState::Active {
            return Err(LockedUseError::ApplicationNotApproved);
        }
        self.approved_bundle_ids = bundle_ids.into_iter().collect();
        Ok(())
    }

    pub fn begin_unlock(
        &mut self,
        sender: &NativeSenderIdentity,
        lease: SignedUnlockLease,
        turn: &AuthenticatedToolTurn,
        now_ms: i64,
    ) -> Result<(), LockedUseError> {
        match self.state {
            LockedUseState::Disabled => return Err(LockedUseError::NotReady),
            LockedUseState::LatchedUntilManualUnlock => return Err(LockedUseError::Latched),
            LockedUseState::Ready | LockedUseState::Active => {}
        }
        self.validate_sender(sender)?;
        self.validate_lease(&lease, turn, now_ms)?;
        self.used_nonces.insert(lease.claims.nonce.clone());
        self.active = Some(ActiveLease {
            claims: lease.claims,
        });
        self.state = LockedUseState::Active;
        Ok(())
    }

    pub fn authorize_action(
        &mut self,
        bundle_id: &str,
        action_digest: &str,
        approved_action_digest: Option<&str>,
        now_ms: i64,
    ) -> Result<(), LockedUseError> {
        let Some(active) = self.active.as_ref() else {
            return Err(LockedUseError::NotReady);
        };
        if now_ms > active.claims.expires_at_ms {
            self.relock_and_latch(RelockCause::LeaseExpired);
            return Err(LockedUseError::InvalidLifetime);
        }
        if !active
            .claims
            .allowed_bundle_ids
            .iter()
            .any(|allowed| allowed == bundle_id)
        {
            return Err(LockedUseError::TargetOutsideLease);
        }
        if let Some(approved) = approved_action_digest {
            if approved != action_digest {
                return Err(LockedUseError::ConfirmationMismatch);
            }
        }
        Ok(())
    }

    pub fn relock_and_latch(&mut self, _cause: RelockCause) {
        self.active = None;
        self.state = LockedUseState::LatchedUntilManualUnlock;
    }

    pub fn manual_unlock_observed(&mut self) {
        if self.state == LockedUseState::LatchedUntilManualUnlock {
            self.state = LockedUseState::Ready;
        }
        self.active = None;
    }

    fn validate_sender(&self, sender: &NativeSenderIdentity) -> Result<(), LockedUseError> {
        if sender.protocol_version != LOCKED_USE_PROTOCOL_VERSION {
            return Err(LockedUseError::ProtocolMismatch);
        }
        if sender != &self.expected_sender {
            return Err(LockedUseError::SenderMismatch);
        }
        Ok(())
    }

    fn validate_lease(
        &self,
        lease: &SignedUnlockLease,
        turn: &AuthenticatedToolTurn,
        now_ms: i64,
    ) -> Result<(), LockedUseError> {
        if lease.claims.protocol_version != LOCKED_USE_PROTOCOL_VERSION {
            return Err(LockedUseError::ProtocolMismatch);
        }
        if self.used_nonces.contains(&lease.claims.nonce) {
            return Err(LockedUseError::ReplayedNonce);
        }
        let lifetime = lease
            .claims
            .expires_at_ms
            .saturating_sub(lease.claims.issued_at_ms);
        if lifetime <= 0
            || lifetime > MAX_UNLOCK_LEASE.as_millis() as i64
            || now_ms < lease.claims.issued_at_ms
            || now_ms > lease.claims.expires_at_ms
        {
            return Err(LockedUseError::InvalidLifetime);
        }
        if !turn.active
            || !turn.remote_control_granted
            || !turn.locked_use_granted
            || lease.claims.device_id != turn.device_id
        {
            return Err(LockedUseError::DeviceNotGranted);
        }
        if lease.claims.account_id != turn.account_id
            || lease.claims.task_id != turn.task_id
            || lease.claims.turn_id != turn.turn_id
        {
            return Err(LockedUseError::TurnMismatch);
        }
        if lease.claims.allowed_bundle_ids.is_empty()
            || lease
                .claims
                .allowed_bundle_ids
                .iter()
                .any(|bundle| !self.approved_bundle_ids.contains(bundle))
        {
            return Err(LockedUseError::ApplicationNotApproved);
        }
        let signature_bytes = STANDARD_NO_PAD
            .decode(&lease.signature)
            .map_err(|_| LockedUseError::InvalidSignature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| LockedUseError::InvalidSignature)?;
        let message =
            serde_json::to_vec(&lease.claims).map_err(|_| LockedUseError::InvalidSignature)?;
        self.lease_key
            .verify(&message, &signature)
            .map_err(|_| LockedUseError::InvalidSignature)
    }
}

pub fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixture() -> (
        LockedUseController,
        SigningKey,
        NativeSenderIdentity,
        AuthenticatedToolTurn,
    ) {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let sender = NativeSenderIdentity {
            team_id: "TEAM123".into(),
            bundle_id: "com.cognia.computer-use.service".into(),
            code_requirement: "anchor apple generic and certificate leaf[subject.OU] = TEAM123"
                .into(),
            audit_token_digest: "audit-token-digest".into(),
            protocol_version: LOCKED_USE_PROTOCOL_VERSION,
        };
        let turn = AuthenticatedToolTurn {
            device_id: "device-1".into(),
            account_id: "account-1".into(),
            task_id: "task-1".into(),
            turn_id: "turn-1".into(),
            active: true,
            remote_control_granted: true,
            locked_use_granted: true,
        };
        let mut controller = LockedUseController::disabled(sender.clone(), signing.verifying_key());
        controller.enable_from_verified_install(true);
        controller
            .set_persistent_approvals(true, ["com.apple.Notes".into()])
            .unwrap();
        (controller, signing, sender, turn)
    }

    fn signed_lease(signing: &SigningKey, now: i64) -> SignedUnlockLease {
        let claims = UnlockLeaseClaims {
            lease_id: "lease-1".into(),
            device_id: "device-1".into(),
            account_id: "account-1".into(),
            task_id: "task-1".into(),
            turn_id: "turn-1".into(),
            allowed_bundle_ids: vec!["com.apple.Notes".into()],
            nonce: "nonce-1".into(),
            protocol_version: LOCKED_USE_PROTOCOL_VERSION,
            issued_at_ms: now,
            expires_at_ms: now + 30_000,
        };
        let message = serde_json::to_vec(&claims).unwrap();
        SignedUnlockLease {
            claims,
            signature: STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes()),
        }
    }

    #[test]
    fn signed_active_turn_can_unlock_only_preapproved_apps() {
        let (mut controller, signing, sender, turn) = fixture();
        controller
            .begin_unlock(&sender, signed_lease(&signing, 100), &turn, 100)
            .unwrap();
        assert_eq!(controller.state(), LockedUseState::Active);
        controller
            .authorize_action("com.apple.Notes", "digest", Some("digest"), 101)
            .unwrap();
        assert_eq!(
            controller.authorize_action("com.apple.Terminal", "digest", None, 101),
            Err(LockedUseError::TargetOutsideLease)
        );
    }

    #[test]
    fn lease_replay_and_ungranted_device_fail_closed() {
        let (mut controller, signing, sender, mut turn) = fixture();
        let lease = signed_lease(&signing, 100);
        controller
            .begin_unlock(&sender, lease.clone(), &turn, 100)
            .unwrap();
        controller.manual_unlock_observed();
        assert_eq!(
            controller.begin_unlock(&sender, lease, &turn, 100),
            Err(LockedUseError::ReplayedNonce)
        );

        let mut second = signed_lease(&signing, 200);
        second.claims.nonce = "nonce-2".into();
        let message = serde_json::to_vec(&second.claims).unwrap();
        second.signature = STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes());
        turn.locked_use_granted = false;
        assert_eq!(
            controller.begin_unlock(&sender, second, &turn, 200),
            Err(LockedUseError::DeviceNotGranted)
        );
    }

    #[test]
    fn disabling_does_not_make_a_used_nonce_replayable() {
        let (mut controller, signing, sender, turn) = fixture();
        let lease = signed_lease(&signing, 100);
        controller
            .begin_unlock(&sender, lease.clone(), &turn, 100)
            .unwrap();
        controller.disable();
        controller.enable_from_verified_install(true);
        assert_eq!(
            controller.begin_unlock(&sender, lease, &turn, 100),
            Err(LockedUseError::ReplayedNonce)
        );
    }

    #[test]
    fn physical_input_relocks_and_latches_automatic_unlock() {
        let (mut controller, signing, sender, turn) = fixture();
        controller
            .begin_unlock(&sender, signed_lease(&signing, 100), &turn, 100)
            .unwrap();
        controller.relock_and_latch(RelockCause::PhysicalInput);
        assert_eq!(controller.state(), LockedUseState::LatchedUntilManualUnlock);
        let mut renewal = signed_lease(&signing, 200);
        renewal.claims.nonce = "nonce-renew".into();
        let message = serde_json::to_vec(&renewal.claims).unwrap();
        renewal.signature = STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes());
        assert_eq!(
            controller.begin_unlock(&sender, renewal, &turn, 200),
            Err(LockedUseError::Latched)
        );
        controller.manual_unlock_observed();
        assert_eq!(controller.state(), LockedUseState::Ready);
    }

    #[test]
    fn tampered_sender_signature_lifetime_and_action_digest_are_refused() {
        let (mut controller, signing, sender, turn) = fixture();
        let mut wrong_sender = sender.clone();
        wrong_sender.team_id = "ATTACKER".into();
        assert_eq!(
            controller.begin_unlock(&wrong_sender, signed_lease(&signing, 100), &turn, 100),
            Err(LockedUseError::SenderMismatch)
        );

        let mut too_long = signed_lease(&signing, 100);
        too_long.claims.expires_at_ms = 130_001;
        let message = serde_json::to_vec(&too_long.claims).unwrap();
        too_long.signature = STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes());
        assert_eq!(
            controller.begin_unlock(&sender, too_long, &turn, 100),
            Err(LockedUseError::InvalidLifetime)
        );

        controller
            .begin_unlock(&sender, signed_lease(&signing, 200), &turn, 200)
            .unwrap();
        assert_eq!(
            controller.authorize_action("com.apple.Notes", "actual", Some("other"), 201),
            Err(LockedUseError::ConfirmationMismatch)
        );
    }

    #[tokio::test]
    async fn shared_physical_input_monitor_relocks_and_latches() {
        use crate::automation::input_monitor::{InputButton, InputEvent, InputMonitor};

        let (mut unlocked, signing, sender, turn) = fixture();
        let now = unix_time_ms();
        unlocked
            .begin_unlock(&sender, signed_lease(&signing, now), &turn, now)
            .unwrap();
        let controller = Arc::new(Mutex::new(unlocked));
        let input_monitor = InputMonitor::default();
        let subscription = input_monitor.subscribe_safety_for_test();
        let callback_fired = Arc::new(tokio::sync::Notify::new());
        let callback_signal = callback_fired.clone();
        let _guard = LockedUseSafetyMonitor::from_subscription(
            input_monitor.clone(),
            subscription,
            controller.clone(),
            Arc::new(move |cause| {
                assert_eq!(cause, RelockCause::PhysicalInput);
                callback_signal.notify_one();
            }),
        );

        input_monitor.inject_for_test(InputEvent::MouseDown {
            x: 10,
            y: 20,
            button: InputButton::Left,
            ts_ms: 101,
        });
        tokio::time::timeout(Duration::from_secs(1), callback_fired.notified())
            .await
            .expect("physical-input relock callback timed out");
        assert_eq!(
            controller.lock().state(),
            LockedUseState::LatchedUntilManualUnlock
        );
    }

    #[tokio::test]
    async fn safety_monitor_relocks_when_the_lease_expires_without_an_action() {
        let (mut unlocked, signing, sender, turn) = fixture();
        let now = unix_time_ms();
        let mut lease = signed_lease(&signing, now);
        lease.claims.expires_at_ms = now + 20;
        let message = serde_json::to_vec(&lease.claims).unwrap();
        lease.signature = STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes());
        unlocked.begin_unlock(&sender, lease, &turn, now).unwrap();

        let controller = Arc::new(Mutex::new(unlocked));
        let input_monitor = InputMonitor::default();
        let subscription = input_monitor.subscribe_safety_for_test();
        let callback_fired = Arc::new(tokio::sync::Notify::new());
        let callback_signal = callback_fired.clone();
        let _guard = LockedUseSafetyMonitor::from_subscription(
            input_monitor,
            subscription,
            controller.clone(),
            Arc::new(move |cause| {
                assert_eq!(cause, RelockCause::LeaseExpired);
                callback_signal.notify_one();
            }),
        );

        tokio::time::timeout(Duration::from_secs(1), callback_fired.notified())
            .await
            .expect("lease-expiry relock callback timed out");
        assert_eq!(
            controller.lock().state(),
            LockedUseState::LatchedUntilManualUnlock
        );
    }
}
