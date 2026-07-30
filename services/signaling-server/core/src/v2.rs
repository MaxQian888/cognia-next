//! Signaling v2 canonical encoding and admission verification.
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

use crate::proto::{PeerRole, RoomDescriptorV2, SubscribeProofV2};

pub const PROTOCOL_VERSION_V2: u8 = 2;
pub const SUBSCRIBE_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V2AdmissionError {
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

impl std::fmt::Display for V2AdmissionError {
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

impl std::error::Error for V2AdmissionError {}

pub fn encode_fields(fields: &[&[u8]]) -> Vec<u8> {
    let capacity = fields
        .iter()
        .map(|field| 4usize.saturating_add(field.len()))
        .sum();
    let mut output = Vec::with_capacity(capacity);
    for field in fields {
        let length = u32::try_from(field.len()).expect("v2 canonical field exceeds u32");
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(field);
    }
    output
}

pub fn room_descriptor_bytes(descriptor: &RoomDescriptorV2) -> Vec<u8> {
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

pub fn derive_room_id(descriptor: &RoomDescriptorV2) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(room_descriptor_bytes(descriptor)))
}

pub fn validate_room_descriptor(
    descriptor: &RoomDescriptorV2,
    now_ms: i64,
) -> Result<(), V2AdmissionError> {
    if descriptor.v != PROTOCOL_VERSION_V2 {
        return Err(V2AdmissionError::BadVersion);
    }
    decode_canonical(&descriptor.room_nonce)
        .filter(|bytes| bytes.len() == 16)
        .ok_or(V2AdmissionError::InvalidDescriptor)?;
    decode_public_key(&descriptor.desktop_signing_key)?;
    decode_public_key(&descriptor.mobile_signing_key)?;
    if descriptor.not_after < now_ms.saturating_sub(SUBSCRIBE_CLOCK_SKEW_MS) {
        return Err(V2AdmissionError::ExpiredDescriptor);
    }
    if derive_room_id(descriptor) != descriptor.room_id {
        return Err(V2AdmissionError::InvalidRoomId);
    }
    Ok(())
}

pub fn subscribe_proof_bytes(proof: &SubscribeProofV2) -> Vec<u8> {
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

pub fn verify_subscribe_proof(
    descriptor: &RoomDescriptorV2,
    proof: &SubscribeProofV2,
    expected_challenge: &str,
    now_ms: i64,
) -> Result<(), V2AdmissionError> {
    validate_room_descriptor(descriptor, now_ms)?;
    if proof.v != PROTOCOL_VERSION_V2 || proof.room_id != descriptor.room_id {
        return Err(V2AdmissionError::BadVersion);
    }
    if proof.challenge != expected_challenge {
        return Err(V2AdmissionError::InvalidChallenge);
    }
    if proof.session_id.is_empty() || proof.epoch.is_empty() {
        return Err(V2AdmissionError::InvalidSession);
    }
    if proof.issued_at.abs_diff(now_ms) > SUBSCRIBE_CLOCK_SKEW_MS as u64 {
        return Err(V2AdmissionError::ClockSkew);
    }
    // Validate the ephemeral ECDH key as a real SEC1 point even though the
    // relay never derives the shared secret.
    decode_public_key(&proof.ecdh_public_key)?;
    let signing_key = match proof.role {
        PeerRole::Desktop => &descriptor.desktop_signing_key,
        PeerRole::Mobile => &descriptor.mobile_signing_key,
    };
    let verifying_key = VerifyingKey::from_sec1_bytes(
        &decode_canonical(signing_key).ok_or(V2AdmissionError::InvalidPublicKey)?,
    )
    .map_err(|_| V2AdmissionError::InvalidPublicKey)?;
    let signature = Signature::from_slice(
        &decode_canonical(&proof.signature).ok_or(V2AdmissionError::InvalidSignature)?,
    )
    .map_err(|_| V2AdmissionError::InvalidSignature)?;
    verifying_key
        .verify(&subscribe_proof_bytes(proof), &signature)
        .map_err(|_| V2AdmissionError::InvalidSignature)
}

fn decode_public_key(encoded: &str) -> Result<PublicKey, V2AdmissionError> {
    PublicKey::from_sec1_bytes(
        &decode_canonical(encoded).ok_or(V2AdmissionError::InvalidPublicKey)?,
    )
    .map_err(|_| V2AdmissionError::InvalidPublicKey)
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
        URL_SAFE_NO_PAD.encode(signing.verifying_key().to_encoded_point(false).as_bytes())
    }

    fn descriptor(desktop: &SigningKey, mobile: &SigningKey) -> RoomDescriptorV2 {
        let mut descriptor = RoomDescriptorV2 {
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
            Err(V2AdmissionError::InvalidRoomId)
        );
    }

    #[test]
    fn room_id_matches_the_typescript_vector() {
        let mut descriptor = RoomDescriptorV2 {
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
        let mut proof = SubscribeProofV2 {
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
            Err(V2AdmissionError::InvalidSignature)
        );
        assert_eq!(
            verify_subscribe_proof(&descriptor, &proof, "challenge-2", 1_700_000_000_000,),
            Err(V2AdmissionError::InvalidChallenge)
        );
    }
}
