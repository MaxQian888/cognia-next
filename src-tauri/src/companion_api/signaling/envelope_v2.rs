//! End-to-end encryption, role signatures, and strict replay for signaling v2.
//!
//! The byte layout mirrors `lib/signaling/v2-crypto.ts`. The relay sees only
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
    EnvelopeKind, PeerRole, RoomDescriptorV2, SignalingEnvelopeV2, SubscribeProofV2,
};
use cognia_signaling_core::v2::{derive_room_id, encode_fields, PROTOCOL_VERSION_V2};

pub const V2_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
pub const SIGNALING_KEY_NAMESPACE: &str = "companion-signaling-v2";
const RETIRED_EPOCH_TTL_MS: i64 = V2_CLOCK_SKEW_MS * 2;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V2EnvelopeError {
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

impl fmt::Display for V2EnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBase64 => "invalid canonical base64url",
            Self::InvalidPublicKey => "invalid P-256 public key",
            Self::InvalidSignature => "ECDSA signature verification failed",
            Self::InvalidKey => "invalid signaling encryption key",
            Self::InvalidNonce => "signaling nonce mismatch",
            Self::InvalidEnvelope => "invalid signaling v2 envelope",
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

impl std::error::Error for V2EnvelopeError {}

pub struct V2Identity {
    signing_key: SigningKey,
}

impl V2Identity {
    pub fn generate() -> Self {
        Self {
            signing_key: SigningKey::generate(),
        }
    }

    pub fn from_private_bytes(bytes: &[u8]) -> Result<Self, V2EnvelopeError> {
        let signing_key = SigningKey::from_slice(bytes).map_err(|_| V2EnvelopeError::InvalidKey)?;
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

pub struct V2EphemeralKey {
    secret: EphemeralSecret,
    public_key: PublicKey,
}

impl V2EphemeralKey {
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
    ) -> Result<[u8; 32], V2EnvelopeError> {
        let peer = PublicKey::from_sec1_bytes(&decode_canonical(peer_public_key)?)
            .map_err(|_| V2EnvelopeError::InvalidPublicKey)?;
        let shared = self.secret.diffie_hellman(&peer);
        let salt = Sha256::digest(room_id.as_bytes());
        let info = format!("cognia-signaling-v2|{}|{}", sender_role.as_str(), epoch);
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes().as_slice());
        let mut key = [0u8; 32];
        hkdf.expand(info.as_bytes(), &mut key)
            .map_err(|_| V2EnvelopeError::InvalidKey)?;
        Ok(key)
    }
}

pub fn build_room_descriptor(
    room_nonce: String,
    desktop_signing_key: String,
    mobile_signing_key: String,
    not_after: i64,
) -> RoomDescriptorV2 {
    let mut descriptor = RoomDescriptorV2 {
        v: PROTOCOL_VERSION_V2,
        room_id: String::new(),
        room_nonce,
        desktop_signing_key,
        mobile_signing_key,
        not_after,
    };
    descriptor.room_id = derive_room_id(&descriptor);
    descriptor
}

pub fn build_subscribe_proof(
    descriptor: &RoomDescriptorV2,
    role: PeerRole,
    session_id: String,
    epoch: String,
    issued_at: i64,
    challenge: String,
    ephemeral: &V2EphemeralKey,
    identity: &V2Identity,
) -> SubscribeProofV2 {
    let mut proof = SubscribeProofV2 {
        v: PROTOCOL_VERSION_V2,
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
    identity: &V2Identity,
    encryption_key: &[u8; 32],
) -> Result<SignalingEnvelopeV2, V2EnvelopeError> {
    if seq == 0 {
        return Err(V2EnvelopeError::InvalidEnvelope);
    }
    let nonce_bytes = derive_nonce(epoch, sender_role, seq);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let mut envelope = SignalingEnvelopeV2 {
        v: PROTOCOL_VERSION_V2,
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
    let plaintext = serde_json::to_vec(body).map_err(|_| V2EnvelopeError::Json)?;
    let cipher =
        Aes256Gcm::new_from_slice(encryption_key).map_err(|_| V2EnvelopeError::InvalidKey)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| V2EnvelopeError::Encrypt)?;
    envelope.ciphertext = URL_SAFE_NO_PAD.encode(&ciphertext);
    let signature: Signature = identity
        .signing_key
        .sign(&signature_bytes(&envelope, &ciphertext));
    envelope.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    Ok(envelope)
}

pub fn verify_and_decrypt_envelope(
    envelope: &SignalingEnvelopeV2,
    expected_room_id: &str,
    expected_sender_role: PeerRole,
    signing_public_key: &str,
    encryption_key: &[u8; 32],
    now_ms: i64,
) -> Result<Value, V2EnvelopeError> {
    if envelope.v != PROTOCOL_VERSION_V2
        || envelope.seq == 0
        || envelope.session_id.is_empty()
        || envelope.epoch.is_empty()
    {
        return Err(V2EnvelopeError::InvalidEnvelope);
    }
    if envelope.room_id != expected_room_id {
        return Err(V2EnvelopeError::RoomMismatch);
    }
    if envelope.sender_role != expected_sender_role {
        return Err(V2EnvelopeError::RoleMismatch);
    }
    if envelope.issued_at.abs_diff(now_ms) > V2_CLOCK_SKEW_MS as u64 {
        return Err(V2EnvelopeError::ClockSkew);
    }
    let ciphertext = decode_canonical(&envelope.ciphertext)?;
    let signature = Signature::from_slice(&decode_canonical(&envelope.signature)?)
        .map_err(|_| V2EnvelopeError::InvalidSignature)?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&decode_canonical(signing_public_key)?)
        .map_err(|_| V2EnvelopeError::InvalidPublicKey)?;
    verifying_key
        .verify(&signature_bytes(envelope, &ciphertext), &signature)
        .map_err(|_| V2EnvelopeError::InvalidSignature)?;
    let nonce = decode_canonical(&envelope.nonce)?;
    let expected_nonce = derive_nonce(envelope.epoch.as_str(), envelope.sender_role, envelope.seq);
    if nonce != expected_nonce {
        return Err(V2EnvelopeError::InvalidNonce);
    }
    let cipher =
        Aes256Gcm::new_from_slice(encryption_key).map_err(|_| V2EnvelopeError::InvalidKey)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &header_bytes(envelope),
            },
        )
        .map_err(|_| V2EnvelopeError::Decrypt)?;
    serde_json::from_slice(&plaintext).map_err(|_| V2EnvelopeError::Json)
}

#[derive(Debug, Default)]
pub struct StrictReplayWindowV2 {
    current_epoch: Option<String>,
    last_seq: u64,
    retired_epochs: HashMap<String, i64>,
}

impl StrictReplayWindowV2 {
    pub fn observe(&mut self, epoch: &str, seq: u64, now_ms: i64) -> Result<(), V2EnvelopeError> {
        if epoch.is_empty() || seq == 0 {
            return Err(V2EnvelopeError::Replay);
        }
        self.retired_epochs
            .retain(|_, expires_at| *expires_at > now_ms);
        if self.retired_epochs.contains_key(epoch) {
            return Err(V2EnvelopeError::Replay);
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
            return Err(V2EnvelopeError::Replay);
        }
        self.last_seq = seq;
        Ok(())
    }
}

fn subscribe_bytes(proof: &SubscribeProofV2) -> Vec<u8> {
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

fn header_fields(envelope: &SignalingEnvelopeV2) -> Vec<Vec<u8>> {
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

fn header_bytes(envelope: &SignalingEnvelopeV2) -> Vec<u8> {
    let owned = header_fields(envelope);
    let borrowed: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    encode_fields(&borrowed)
}

fn signature_bytes(envelope: &SignalingEnvelopeV2, ciphertext: &[u8]) -> Vec<u8> {
    let mut owned = header_fields(envelope);
    owned.push(ciphertext.to_vec());
    let borrowed: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    encode_fields(&borrowed)
}

fn decode_canonical(value: &str) -> Result<Vec<u8>, V2EnvelopeError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| V2EnvelopeError::InvalidBase64)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(V2EnvelopeError::InvalidBase64);
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_signaling_core::v2::verify_subscribe_proof;
    use serde_json::json;

    #[test]
    fn independent_peers_derive_the_same_direction_key_and_round_trip() {
        let desktop = V2Identity::generate();
        let mobile = V2Identity::generate();
        let desktop_ephemeral = V2EphemeralKey::generate();
        let mobile_ephemeral = V2EphemeralKey::generate();
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
        let desktop = V2Identity::generate();
        let mobile = V2Identity::generate();
        let ephemeral = V2EphemeralKey::generate();
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
        let mut replay = StrictReplayWindowV2::default();
        replay.observe("epoch-a", 1, 1000).unwrap();
        assert_eq!(
            replay.observe("epoch-a", 1, 1001),
            Err(V2EnvelopeError::Replay)
        );
        replay.observe("epoch-a", 2, 1002).unwrap();
        replay.observe("epoch-b", 1, 1003).unwrap();
        assert_eq!(
            replay.observe("epoch-a", 3, 1004),
            Err(V2EnvelopeError::Replay)
        );
    }
}
