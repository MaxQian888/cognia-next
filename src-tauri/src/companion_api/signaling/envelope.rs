//! End-to-end encryption, role signatures, and strict replay for signaling.
//!
//! The byte layout mirrors `lib/signaling/crypto.ts`. The relay sees only
//! authenticated metadata and AES-256-GCM ciphertext; it never receives SDP
//! or ICE plaintext.

use std::{collections::HashMap, fmt};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use p256::{
    ecdh::EphemeralSecret,
    ecdsa::{
        signature::{Signer, Verifier},
        Signature, SigningKey, VerifyingKey,
    },
    elliptic_curve::{sec1::ToSec1Point, Generate},
    PublicKey,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub use cognia_signaling_core::proto::{
    EnvelopeKind, PeerRole, RoomDescriptor, SignalingEnvelope, SubscribeProof,
};
use cognia_signaling_core::protocol::{derive_room_id, encode_fields, PROTOCOL_VERSION};

pub const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
pub const SIGNALING_KEY_NAMESPACE: &str = "companion-signaling";
/// Namespace used before the protocol-version suffix was dropped from these
/// names. Devices paired by an older build still have the Host's role private
/// key filed here; without a fallback every one of them would come back as
/// "signaling identity is missing from the host keyring" after an upgrade and
/// need a manual re-pair.
pub const LEGACY_SIGNALING_KEY_NAMESPACE: &str = "companion-signaling-v2";

/// Load a Host signaling identity, migrating a pre-rename entry forward.
///
/// The migration is best effort: if the rewrite fails we still return the key,
/// because a working WebRTC session matters more than tidy keychain bookkeeping
/// and the next call simply retries.
pub fn load_signaling_key(key_ref: &str) -> Result<Option<String>, String> {
    if let Some(key) = cognia_secrets::keyring_secrets::get(SIGNALING_KEY_NAMESPACE, key_ref)? {
        return Ok(Some(key));
    }
    let Some(legacy) =
        cognia_secrets::keyring_secrets::get(LEGACY_SIGNALING_KEY_NAMESPACE, key_ref)?
    else {
        return Ok(None);
    };
    if cognia_secrets::keyring_secrets::set(SIGNALING_KEY_NAMESPACE, key_ref, &legacy).is_ok() {
        let _ = cognia_secrets::keyring_secrets::clear(LEGACY_SIGNALING_KEY_NAMESPACE, key_ref);
    }
    Ok(Some(legacy))
}

/// Remove a Host signaling identity from both namespaces, so revoking a device
/// paired by an older build does not strand its key in the keychain forever.
pub fn clear_signaling_key(key_ref: &str) -> Result<(), String> {
    let current = cognia_secrets::keyring_secrets::clear(SIGNALING_KEY_NAMESPACE, key_ref);
    let legacy = cognia_secrets::keyring_secrets::clear(LEGACY_SIGNALING_KEY_NAMESPACE, key_ref);
    current.and(legacy)
}
const RETIRED_EPOCH_TTL_MS: i64 = CLOCK_SKEW_MS * 2;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    InvalidBase64,
    InvalidPublicKey,
    InvalidSignature,
    InvalidKey,
    InvalidNonce,
    InvalidEnvelope,
    RoomMismatch,
    RoleMismatch,
    ClockSkew,
    Encrypt,
    Decrypt,
    Json,
    Replay,
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBase64 => "invalid canonical base64url",
            Self::InvalidPublicKey => "invalid P-256 public key",
            Self::InvalidSignature => "ECDSA signature verification failed",
            Self::InvalidKey => "invalid signaling encryption key",
            Self::InvalidNonce => "signaling nonce mismatch",
            Self::InvalidEnvelope => "invalid signaling envelope",
            Self::RoomMismatch => "signaling room mismatch",
            Self::RoleMismatch => "signaling sender role mismatch",
            Self::ClockSkew => "signaling clock skew",
            Self::Encrypt => "signaling encryption failed",
            Self::Decrypt => "signaling ciphertext authentication failed",
            Self::Json => "signaling plaintext is not valid JSON",
            Self::Replay => "signaling envelope replayed",
        })
    }
}

impl std::error::Error for EnvelopeError {}

pub struct SignalingIdentity {
    signing_key: SigningKey,
}

impl SignalingIdentity {
    pub fn generate() -> Self {
        Self {
            signing_key: SigningKey::generate(),
        }
    }

    pub fn from_private_bytes(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        let signing_key = SigningKey::from_slice(bytes).map_err(|_| EnvelopeError::InvalidKey)?;
        Ok(Self { signing_key })
    }

    pub fn private_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes().into()
    }

    pub fn public_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(
            self.signing_key
                .verifying_key()
                .to_sec1_point(false)
                .as_bytes(),
        )
    }
}

pub struct EphemeralKey {
    secret: EphemeralSecret,
    public_key: PublicKey,
}

impl EphemeralKey {
    pub fn generate() -> Self {
        let secret = EphemeralSecret::generate();
        let public_key = PublicKey::from(&secret);
        Self { secret, public_key }
    }

    pub fn public_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public_key.to_sec1_point(false).as_bytes())
    }

    pub fn derive_direction_key(
        &self,
        peer_public_key: &str,
        room_id: &str,
        sender_role: PeerRole,
        epoch: &str,
    ) -> Result<[u8; 32], EnvelopeError> {
        let peer = PublicKey::from_sec1_bytes(&decode_canonical(peer_public_key)?)
            .map_err(|_| EnvelopeError::InvalidPublicKey)?;
        let shared = self.secret.diffie_hellman(&peer);
        let salt = Sha256::digest(room_id.as_bytes());
        // Keep the v2 HKDF namespace stable across the terminology cleanup.
        // Existing peers derive the same room-direction key and can therefore
        // continue a session while canonical route/label aliases roll out.
        let info = format!("cognia-signaling-v2|{}|{}", sender_role.as_str(), epoch);
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes().as_slice());
        let mut key = [0u8; 32];
        hkdf.expand(info.as_bytes(), &mut key)
            .map_err(|_| EnvelopeError::InvalidKey)?;
        Ok(key)
    }
}

pub fn build_room_descriptor(
    room_nonce: String,
    desktop_signing_key: String,
    mobile_signing_key: String,
    not_after: i64,
) -> RoomDescriptor {
    let mut descriptor = RoomDescriptor {
        v: PROTOCOL_VERSION,
        room_id: String::new(),
        room_nonce,
        desktop_signing_key,
        mobile_signing_key,
        not_after,
    };
    descriptor.room_id = derive_room_id(&descriptor);
    descriptor
}

// The proof signs each protocol field independently; keeping them explicit
// prevents an unsigned field from being hidden in a partially signed bundle.
#[allow(clippy::too_many_arguments)]
pub fn build_subscribe_proof(
    descriptor: &RoomDescriptor,
    role: PeerRole,
    session_id: String,
    epoch: String,
    issued_at: i64,
    challenge: String,
    ephemeral: &EphemeralKey,
    identity: &SignalingIdentity,
) -> SubscribeProof {
    let mut proof = SubscribeProof {
        v: PROTOCOL_VERSION,
        room_id: descriptor.room_id.clone(),
        role,
        session_id,
        epoch,
        issued_at,
        challenge,
        ecdh_public_key: ephemeral.public_key_base64(),
        signature: String::new(),
    };
    let signature: Signature = identity.signing_key.sign(&subscribe_bytes(&proof));
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    proof
}

#[allow(clippy::too_many_arguments)]
pub fn build_envelope(
    room_id: &str,
    sender_role: PeerRole,
    session_id: &str,
    epoch: &str,
    seq: u64,
    issued_at: i64,
    kind: EnvelopeKind,
    body: &Value,
    identity: &SignalingIdentity,
    encryption_key: &[u8; 32],
) -> Result<SignalingEnvelope, EnvelopeError> {
    if seq == 0 {
        return Err(EnvelopeError::InvalidEnvelope);
    }
    let nonce_bytes = derive_nonce(epoch, sender_role, seq);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let mut envelope = SignalingEnvelope {
        v: PROTOCOL_VERSION,
        room_id: room_id.to_string(),
        sender_role,
        session_id: session_id.to_string(),
        epoch: epoch.to_string(),
        seq,
        issued_at,
        kind,
        nonce,
        ciphertext: String::new(),
        signature: String::new(),
    };
    let aad = header_bytes(&envelope);
    let plaintext = serde_json::to_vec(body).map_err(|_| EnvelopeError::Json)?;
    let cipher =
        Aes256Gcm::new_from_slice(encryption_key).map_err(|_| EnvelopeError::InvalidKey)?;
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| EnvelopeError::Encrypt)?;
    envelope.ciphertext = URL_SAFE_NO_PAD.encode(&ciphertext);
    let signature: Signature = identity
        .signing_key
        .sign(&signature_bytes(&envelope, &ciphertext));
    envelope.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    Ok(envelope)
}

pub fn verify_and_decrypt_envelope(
    envelope: &SignalingEnvelope,
    expected_room_id: &str,
    expected_sender_role: PeerRole,
    signing_public_key: &str,
    encryption_key: &[u8; 32],
    now_ms: i64,
) -> Result<Value, EnvelopeError> {
    if envelope.v != PROTOCOL_VERSION
        || envelope.seq == 0
        || envelope.session_id.is_empty()
        || envelope.epoch.is_empty()
    {
        return Err(EnvelopeError::InvalidEnvelope);
    }
    if envelope.room_id != expected_room_id {
        return Err(EnvelopeError::RoomMismatch);
    }
    if envelope.sender_role != expected_sender_role {
        return Err(EnvelopeError::RoleMismatch);
    }
    if envelope.issued_at.abs_diff(now_ms) > CLOCK_SKEW_MS as u64 {
        return Err(EnvelopeError::ClockSkew);
    }
    let ciphertext = decode_canonical(&envelope.ciphertext)?;
    let signature = Signature::from_slice(&decode_canonical(&envelope.signature)?)
        .map_err(|_| EnvelopeError::InvalidSignature)?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&decode_canonical(signing_public_key)?)
        .map_err(|_| EnvelopeError::InvalidPublicKey)?;
    verifying_key
        .verify(&signature_bytes(envelope, &ciphertext), &signature)
        .map_err(|_| EnvelopeError::InvalidSignature)?;
    let nonce = decode_canonical(&envelope.nonce)?;
    let expected_nonce = derive_nonce(envelope.epoch.as_str(), envelope.sender_role, envelope.seq);
    if nonce != expected_nonce {
        return Err(EnvelopeError::InvalidNonce);
    }
    let cipher =
        Aes256Gcm::new_from_slice(encryption_key).map_err(|_| EnvelopeError::InvalidKey)?;
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| EnvelopeError::InvalidNonce)?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: &header_bytes(envelope),
            },
        )
        .map_err(|_| EnvelopeError::Decrypt)?;
    serde_json::from_slice(&plaintext).map_err(|_| EnvelopeError::Json)
}

#[derive(Debug, Default)]
pub struct StrictReplayWindow {
    current_epoch: Option<String>,
    last_seq: u64,
    retired_epochs: HashMap<String, i64>,
}

impl StrictReplayWindow {
    pub fn observe(&mut self, epoch: &str, seq: u64, now_ms: i64) -> Result<(), EnvelopeError> {
        if epoch.is_empty() || seq == 0 {
            return Err(EnvelopeError::Replay);
        }
        self.retired_epochs
            .retain(|_, expires_at| *expires_at > now_ms);
        if self.retired_epochs.contains_key(epoch) {
            return Err(EnvelopeError::Replay);
        }
        if self.current_epoch.as_deref() != Some(epoch) {
            if let Some(previous) = self.current_epoch.replace(epoch.to_string()) {
                self.retired_epochs
                    .insert(previous, now_ms.saturating_add(RETIRED_EPOCH_TTL_MS));
            }
            self.last_seq = seq;
            return Ok(());
        }
        if seq <= self.last_seq {
            return Err(EnvelopeError::Replay);
        }
        self.last_seq = seq;
        Ok(())
    }
}

fn subscribe_bytes(proof: &SubscribeProof) -> Vec<u8> {
    let version = proof.v.to_string();
    let issued_at = proof.issued_at.to_string();
    encode_fields(&[
        version.as_bytes(),
        proof.room_id.as_bytes(),
        proof.role.as_str().as_bytes(),
        proof.session_id.as_bytes(),
        proof.epoch.as_bytes(),
        issued_at.as_bytes(),
        proof.challenge.as_bytes(),
        proof.ecdh_public_key.as_bytes(),
    ])
}

fn derive_nonce(epoch: &str, sender_role: PeerRole, seq: u64) -> [u8; 12] {
    let sequence = seq.to_string();
    let digest = Sha256::digest(encode_fields(&[
        epoch.as_bytes(),
        sender_role.as_str().as_bytes(),
        sequence.as_bytes(),
    ]));
    digest[..12]
        .try_into()
        .expect("SHA-256 has at least 12 bytes")
}

fn header_fields(envelope: &SignalingEnvelope) -> Vec<Vec<u8>> {
    vec![
        envelope.v.to_string().into_bytes(),
        envelope.room_id.as_bytes().to_vec(),
        envelope.sender_role.as_str().as_bytes().to_vec(),
        envelope.session_id.as_bytes().to_vec(),
        envelope.epoch.as_bytes().to_vec(),
        envelope.seq.to_string().into_bytes(),
        envelope.issued_at.to_string().into_bytes(),
        serde_json::to_string(&envelope.kind)
            .expect("envelope kind serializes")
            .trim_matches('"')
            .as_bytes()
            .to_vec(),
        envelope.nonce.as_bytes().to_vec(),
    ]
}

fn header_bytes(envelope: &SignalingEnvelope) -> Vec<u8> {
    let owned = header_fields(envelope);
    let borrowed: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    encode_fields(&borrowed)
}

fn signature_bytes(envelope: &SignalingEnvelope, ciphertext: &[u8]) -> Vec<u8> {
    let mut owned = header_fields(envelope);
    owned.push(ciphertext.to_vec());
    let borrowed: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    encode_fields(&borrowed)
}

fn decode_canonical(value: &str) -> Result<Vec<u8>, EnvelopeError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| EnvelopeError::InvalidBase64)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(EnvelopeError::InvalidBase64);
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_signaling_core::protocol::verify_subscribe_proof;
    use serde_json::json;

    #[test]
    fn independent_peers_derive_the_same_direction_key_and_round_trip() {
        let desktop = SignalingIdentity::generate();
        let mobile = SignalingIdentity::generate();
        let desktop_ephemeral = EphemeralKey::generate();
        let mobile_ephemeral = EphemeralKey::generate();
        let descriptor = build_room_descriptor(
            "AAECAwQFBgcICQoLDA0ODw".into(),
            desktop.public_key_base64(),
            mobile.public_key_base64(),
            1_800_000_000_000,
        );
        let mobile_key = mobile_ephemeral
            .derive_direction_key(
                &desktop_ephemeral.public_key_base64(),
                &descriptor.room_id,
                PeerRole::Mobile,
                "epoch-1",
            )
            .unwrap();
        let desktop_key = desktop_ephemeral
            .derive_direction_key(
                &mobile_ephemeral.public_key_base64(),
                &descriptor.room_id,
                PeerRole::Mobile,
                "epoch-1",
            )
            .unwrap();
        assert_eq!(mobile_key, desktop_key);

        let envelope = build_envelope(
            &descriptor.room_id,
            PeerRole::Mobile,
            "session-1",
            "epoch-1",
            1,
            1_700_000_000_000,
            EnvelopeKind::RtcOffer,
            &json!({"sdp": "v=0\r\nprivate"}),
            &mobile,
            &mobile_key,
        )
        .unwrap();
        assert!(!serde_json::to_string(&envelope)
            .unwrap()
            .contains("private"));
        assert_eq!(
            verify_and_decrypt_envelope(
                &envelope,
                &descriptor.room_id,
                PeerRole::Mobile,
                &mobile.public_key_base64(),
                &desktop_key,
                1_700_000_000_000,
            )
            .unwrap(),
            json!({"sdp": "v=0\r\nprivate"})
        );
    }

    #[test]
    fn subscription_proof_is_accepted_by_shared_relay_validator() {
        let desktop = SignalingIdentity::generate();
        let mobile = SignalingIdentity::generate();
        let ephemeral = EphemeralKey::generate();
        let descriptor = build_room_descriptor(
            "AAECAwQFBgcICQoLDA0ODw".into(),
            desktop.public_key_base64(),
            mobile.public_key_base64(),
            1_800_000_000_000,
        );
        let proof = build_subscribe_proof(
            &descriptor,
            PeerRole::Mobile,
            "session-1".into(),
            "epoch-1".into(),
            1_700_000_000_000,
            "challenge-1".into(),
            &ephemeral,
            &mobile,
        );
        verify_subscribe_proof(&descriptor, &proof, "challenge-1", 1_700_000_000_000).unwrap();
    }

    #[test]
    fn replay_window_retires_old_epochs_and_requires_increasing_sequences() {
        let mut replay = StrictReplayWindow::default();
        replay.observe("epoch-a", 1, 1000).unwrap();
        assert_eq!(
            replay.observe("epoch-a", 1, 1001),
            Err(EnvelopeError::Replay)
        );
        replay.observe("epoch-a", 2, 1002).unwrap();
        replay.observe("epoch-b", 1, 1003).unwrap();
        assert_eq!(
            replay.observe("epoch-a", 3, 1004),
            Err(EnvelopeError::Replay)
        );
    }
}
