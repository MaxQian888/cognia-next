//! Canonical signaling encoding and admission verification.
//!
//! This module is intentionally WASM-safe so both the Axum service and the
//! Cloudflare Durable Object execute exactly the same room-id and ECDSA
//! checks. It never handles private keys or plaintext signaling payloads.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    PublicKey,
};
use sha2::{Digest, Sha256};

use crate::proto::{PeerRole, RoomDescriptor, SubscribeProof};

pub const PROTOCOL_VERSION: u8 = 2;
pub const SUBSCRIBE_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    BadVersion,
    InvalidRoomId,
    InvalidDescriptor,
    ExpiredDescriptor,
    InvalidChallenge,
    ClockSkew,
    InvalidSession,
    InvalidPublicKey,
    InvalidSignature,
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::BadVersion => "unsupported signaling protocol version",
            Self::InvalidRoomId => "room descriptor id mismatch",
            Self::InvalidDescriptor => "invalid room descriptor",
            Self::ExpiredDescriptor => "room descriptor expired",
            Self::InvalidChallenge => "subscription challenge mismatch",
            Self::ClockSkew => "subscription timestamp outside allowed clock window",
            Self::InvalidSession => "invalid subscription session",
            Self::InvalidPublicKey => "invalid P-256 public key",
            Self::InvalidSignature => "subscription signature verification failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for AdmissionError {}

pub fn encode_fields(fields: &[&[u8]]) -> Vec<u8> {
    let capacity = fields
        .iter()
        .map(|field| 4usize.saturating_add(field.len()))
        .sum();
    let mut output = Vec::with_capacity(capacity);
    for field in fields {
        let length = u32::try_from(field.len()).expect("canonical field exceeds u32");
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(field);
    }
    output
}

pub fn room_descriptor_bytes(descriptor: &RoomDescriptor) -> Vec<u8> {
    let version = descriptor.v.to_string();
    let not_after = descriptor.not_after.to_string();
    encode_fields(&[
        version.as_bytes(),
        descriptor.room_nonce.as_bytes(),
        descriptor.desktop_signing_key.as_bytes(),
        descriptor.mobile_signing_key.as_bytes(),
        not_after.as_bytes(),
    ])
}

pub fn derive_room_id(descriptor: &RoomDescriptor) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(room_descriptor_bytes(descriptor)))
}

pub fn validate_room_descriptor(
    descriptor: &RoomDescriptor,
    now_ms: i64,
) -> Result<(), AdmissionError> {
    if descriptor.v != PROTOCOL_VERSION {
        return Err(AdmissionError::BadVersion);
    }
    decode_canonical(&descriptor.room_nonce)
        .filter(|bytes| bytes.len() == 16)
        .ok_or(AdmissionError::InvalidDescriptor)?;
    decode_public_key(&descriptor.desktop_signing_key)?;
    decode_public_key(&descriptor.mobile_signing_key)?;
    if descriptor.not_after < now_ms.saturating_sub(SUBSCRIBE_CLOCK_SKEW_MS) {
        return Err(AdmissionError::ExpiredDescriptor);
    }
    if derive_room_id(descriptor) != descriptor.room_id {
        return Err(AdmissionError::InvalidRoomId);
    }
    Ok(())
}

pub fn subscribe_proof_bytes(proof: &SubscribeProof) -> Vec<u8> {
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

/// Admission: the relay checks a subscription it just received, so the proof
/// must be fresh in both directions and answer this socket's challenge.
pub fn verify_subscribe_proof(
    descriptor: &RoomDescriptor,
    proof: &SubscribeProof,
    expected_challenge: &str,
    now_ms: i64,
) -> Result<(), AdmissionError> {
    verify_proof(descriptor, proof, now_ms, Freshness::Admission(expected_challenge))
}

/// A peer's proof as the relay forwards it in a room snapshot.
///
/// That is the proof the peer subscribed with, so its age is how long the
/// peer has been in the room: a Host that sat in its room for an hour hands
/// every phone that joins an hour-old proof. Freshness is the relay's to check
/// at admission; holding the forwarded proof to the admission window refused
/// every such join. An old proof is not a replay risk: its ECDH key is that
/// session's own, and nobody else holds the private half. A proof from the
/// future and an expired room are still refused, and the signature, room and
/// session binding are checked exactly as at admission. The challenge was the
/// relay's private one for that peer's socket; it stays signature-bound but
/// only the relay can compare it.
pub fn verify_peer_session_proof(
    descriptor: &RoomDescriptor,
    proof: &SubscribeProof,
    now_ms: i64,
) -> Result<(), AdmissionError> {
    verify_proof(descriptor, proof, now_ms, Freshness::Peer)
}

#[derive(Clone, Copy)]
enum Freshness<'a> {
    /// Carries the challenge this socket was issued.
    Admission(&'a str),
    Peer,
}

fn verify_proof(
    descriptor: &RoomDescriptor,
    proof: &SubscribeProof,
    now_ms: i64,
    freshness: Freshness<'_>,
) -> Result<(), AdmissionError> {
    validate_room_descriptor(descriptor, now_ms)?;
    if proof.v != PROTOCOL_VERSION || proof.room_id != descriptor.room_id {
        return Err(AdmissionError::BadVersion);
    }
    if let Freshness::Admission(expected_challenge) = freshness {
        if proof.challenge != expected_challenge {
            return Err(AdmissionError::InvalidChallenge);
        }
    }
    if proof.session_id.is_empty() || proof.epoch.is_empty() {
        return Err(AdmissionError::InvalidSession);
    }
    let stale = match freshness {
        Freshness::Admission(_) => proof.issued_at.abs_diff(now_ms) > SUBSCRIBE_CLOCK_SKEW_MS as u64,
        Freshness::Peer => proof.issued_at.saturating_sub(now_ms) > SUBSCRIBE_CLOCK_SKEW_MS,
    };
    if stale {
        return Err(AdmissionError::ClockSkew);
    }
    // Validate the ephemeral ECDH key as a real SEC1 point even though the
    // relay never derives the shared secret.
    decode_public_key(&proof.ecdh_public_key)?;
    let signing_key = match proof.role {
        PeerRole::Desktop => &descriptor.desktop_signing_key,
        PeerRole::Mobile => &descriptor.mobile_signing_key,
    };
    let verifying_key = VerifyingKey::from_sec1_bytes(
        &decode_canonical(signing_key).ok_or(AdmissionError::InvalidPublicKey)?,
    )
    .map_err(|_| AdmissionError::InvalidPublicKey)?;
    let signature = Signature::from_slice(
        &decode_canonical(&proof.signature).ok_or(AdmissionError::InvalidSignature)?,
    )
    .map_err(|_| AdmissionError::InvalidSignature)?;
    verifying_key
        .verify(&subscribe_proof_bytes(proof), &signature)
        .map_err(|_| AdmissionError::InvalidSignature)
}

fn decode_public_key(encoded: &str) -> Result<PublicKey, AdmissionError> {
    PublicKey::from_sec1_bytes(&decode_canonical(encoded).ok_or(AdmissionError::InvalidPublicKey)?)
        .map_err(|_| AdmissionError::InvalidPublicKey)
}

fn decode_canonical(value: &str) -> Option<Vec<u8>> {
    let decoded = URL_SAFE_NO_PAD.decode(value.as_bytes()).ok()?;
    (URL_SAFE_NO_PAD.encode(&decoded) == value).then_some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn public_key(signing: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(signing.verifying_key().to_sec1_point(false).as_bytes())
    }

    fn descriptor(desktop: &SigningKey, mobile: &SigningKey) -> RoomDescriptor {
        let mut descriptor = RoomDescriptor {
            v: 2,
            room_id: String::new(),
            room_nonce: "AAECAwQFBgcICQoLDA0ODw".to_string(),
            desktop_signing_key: public_key(desktop),
            mobile_signing_key: public_key(mobile),
            not_after: 1_800_000_000_000,
        };
        descriptor.room_id = derive_room_id(&descriptor);
        descriptor
    }

    #[test]
    fn room_id_is_self_certifying_and_canonical() {
        let desktop = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mobile = SigningKey::from_slice(&[2u8; 32]).unwrap();
        let descriptor = descriptor(&desktop, &mobile);
        assert_eq!(descriptor.room_id.len(), 43);
        validate_room_descriptor(&descriptor, 1_700_000_000_000).unwrap();

        let mut tampered = descriptor.clone();
        tampered.mobile_signing_key = public_key(&desktop);
        assert_eq!(
            validate_room_descriptor(&tampered, 1_700_000_000_000),
            Err(AdmissionError::InvalidRoomId)
        );
    }

    #[test]
    fn room_id_matches_the_typescript_vector() {
        let mut descriptor = RoomDescriptor {
            v: 2,
            room_id: String::new(),
            room_nonce: "AAECAwQFBgcICQoLDA0ODw".into(),
            desktop_signing_key:
                "BG_wO5SSQc4drdQ1GeaWDgqFtBppoFwygQOqK84VlMoWPE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo"
                    .into(),
            mobile_signing_key:
                "BFUPRxAD89-Xw99QaseX9nIfsaH7e49vg9IkSYplyI4kE2CT1wEuUJpzcVy9CwCjzA_0tcAbP_oZarH7MnA2uOY"
                    .into(),
            not_after: 1_800_000_000_000,
        };
        descriptor.room_id = derive_room_id(&descriptor);
        assert_eq!(
            descriptor.room_id,
            "Yqb8u27ftwZjP7sGIEESUSotgIEBjEBkPNAj5hLk_ic"
        );
        validate_room_descriptor(&descriptor, 1_700_000_000_000).unwrap();
    }

    #[test]
    fn subscription_binds_every_session_field_and_challenge() {
        let desktop = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mobile = SigningKey::from_slice(&[2u8; 32]).unwrap();
        let ephemeral = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let descriptor = descriptor(&desktop, &mobile);
        let mut proof = SubscribeProof {
            v: 2,
            room_id: descriptor.room_id.clone(),
            role: PeerRole::Mobile,
            session_id: "session-1".into(),
            epoch: "epoch-1".into(),
            issued_at: 1_700_000_000_000,
            challenge: "challenge-1".into(),
            ecdh_public_key: public_key(&ephemeral),
            signature: String::new(),
        };
        let signature: Signature = mobile.sign(&subscribe_proof_bytes(&proof));
        proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        verify_subscribe_proof(&descriptor, &proof, "challenge-1", 1_700_000_000_000).unwrap();

        let mut tampered = proof.clone();
        tampered.epoch = "epoch-2".into();
        assert_eq!(
            verify_subscribe_proof(&descriptor, &tampered, "challenge-1", 1_700_000_000_000,),
            Err(AdmissionError::InvalidSignature)
        );
        assert_eq!(
            verify_subscribe_proof(&descriptor, &proof, "challenge-2", 1_700_000_000_000,),
            Err(AdmissionError::InvalidChallenge)
        );
    }

    #[test]
    fn a_forwarded_peer_proof_may_be_old_but_not_from_the_future() {
        let desktop = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mobile = SigningKey::from_slice(&[2u8; 32]).unwrap();
        let ephemeral = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let descriptor = descriptor(&desktop, &mobile);
        let subscribed_at = 1_700_000_000_000;
        let mut proof = SubscribeProof {
            v: 2,
            room_id: descriptor.room_id.clone(),
            role: PeerRole::Desktop,
            session_id: "session-1".into(),
            epoch: "epoch-1".into(),
            issued_at: subscribed_at,
            challenge: "relay-private".into(),
            ecdh_public_key: public_key(&ephemeral),
            signature: String::new(),
        };
        let signature: Signature = desktop.sign(&subscribe_proof_bytes(&proof));
        proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let an_hour_later = subscribed_at + 60 * 60 * 1000;

        // An hour in the room must not make the Host unjoinable...
        verify_peer_session_proof(&descriptor, &proof, an_hour_later).unwrap();
        // ...while the relay still refuses the same age at admission.
        assert_eq!(
            verify_subscribe_proof(&descriptor, &proof, "relay-private", an_hour_later),
            Err(AdmissionError::ClockSkew)
        );
        assert_eq!(
            verify_peer_session_proof(&descriptor, &proof, subscribed_at - 10 * 60 * 1000),
            Err(AdmissionError::ClockSkew)
        );
        assert_eq!(
            verify_peer_session_proof(&descriptor, &proof, 1_800_000_000_000 + 10 * 60 * 1000),
            Err(AdmissionError::ExpiredDescriptor)
        );
        let mut tampered = proof.clone();
        tampered.issued_at += 1;
        assert_eq!(
            verify_peer_session_proof(&descriptor, &tampered, an_hour_later),
            Err(AdmissionError::InvalidSignature)
        );
    }
}
