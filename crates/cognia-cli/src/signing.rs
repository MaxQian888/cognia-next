//! Ed25519 signing + verification primitives.
//!
//! Pure helper layer used by `cmd_sign` and `cmd_verify`. We sign the
//! raw bundle bytes (matching the host's `plugin_verify_detached_signature`
//! command) so the same `.sig` file works regardless of whether the
//! receiving host knows the plugin id yet.

#[cfg(test)]
use anyhow::bail;
use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SIGNATURE_LENGTH};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::{b64_decode, b64_encode};

pub struct Keypair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
}

impl Keypair {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key: VerifyingKey = (&signing_key).into();
        Self {
            signing_key,
            verifying_key,
        }
    }

    pub fn from_private_base64(s: &str) -> Result<Self> {
        let bytes = b64_decode(s)?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("private key must be 32 bytes (got {})", bytes.len()))?;
        let signing_key = SigningKey::from_bytes(&arr);
        let verifying_key: VerifyingKey = (&signing_key).into();
        Ok(Self {
            signing_key,
            verifying_key,
        })
    }

    pub fn public_base64(&self) -> String {
        b64_encode(&self.verifying_key.to_bytes())
    }

    pub fn private_base64(&self) -> String {
        b64_encode(&self.signing_key.to_bytes())
    }

    pub fn fingerprint_hex(&self) -> String {
        fingerprint(&self.verifying_key.to_bytes())
    }
}

pub fn fingerprint(public_key_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key_bytes);
    hex::encode(hasher.finalize())
}

pub fn sign_bundle(signing_key: &SigningKey, bundle: &[u8]) -> String {
    let sig: Signature = signing_key.sign(bundle);
    b64_encode(&sig.to_bytes())
}

pub fn verify_bundle(public_key_base64: &str, bundle: &[u8], signature_base64: &str) -> Result<()> {
    let pk_bytes = b64_decode(public_key_base64)?;
    let pk: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("public key must be 32 bytes (got {})", pk_bytes.len()))?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk).map_err(|e| anyhow!("invalid public key: {e}"))?;
    let sig_bytes = b64_decode(signature_base64)?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = sig_bytes.as_slice().try_into().map_err(|_| {
        anyhow!(
            "signature must be {SIGNATURE_LENGTH} bytes (got {})",
            sig_bytes.len()
        )
    })?;
    let signature = Signature::from_bytes(&sig_arr);
    verifying_key
        .verify(bundle, &signature)
        .map_err(|e| anyhow!("signature verification failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
#[allow(dead_code)]
fn assert_signature_length(decoded: &[u8]) -> Result<()> {
    if decoded.len() != SIGNATURE_LENGTH {
        bail!(
            "signature must be {} bytes (got {})",
            SIGNATURE_LENGTH,
            decoded.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_sign_then_verify() {
        let kp = Keypair::generate();
        let bundle = b"hello";
        let sig = sign_bundle(&kp.signing_key, bundle);
        verify_bundle(&kp.public_base64(), bundle, &sig).unwrap();
    }

    #[test]
    fn verify_fails_on_tampered_bundle() {
        let kp = Keypair::generate();
        let sig = sign_bundle(&kp.signing_key, b"original");
        assert!(verify_bundle(&kp.public_base64(), b"tampered", &sig).is_err());
    }

    #[test]
    fn private_base64_round_trips() {
        let kp = Keypair::generate();
        let exported = kp.private_base64();
        let restored = Keypair::from_private_base64(&exported).unwrap();
        assert_eq!(restored.public_base64(), kp.public_base64());
    }

    #[test]
    fn fingerprint_is_sha256_of_public_key() {
        let kp = Keypair::generate();
        let computed = fingerprint(&kp.verifying_key.to_bytes());
        assert_eq!(computed, kp.fingerprint_hex());
        assert_eq!(computed.len(), 64);
    }

    #[test]
    fn private_key_decode_rejects_wrong_length() {
        let bad = b64_encode(&[0u8; 10]);
        assert!(Keypair::from_private_base64(&bad).is_err());
    }
}
