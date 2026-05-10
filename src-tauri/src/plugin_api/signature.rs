//! Plugin signing and verification (Batch 3c).
//!
//! Uses `ed25519-dalek` (Cargo.toml line ~93) for keypair generation,
//! signing, and verification. The digest input ordering is `(plugin_id ||
//! ":" || version || ":" || file_bytes)` and is computed in a single
//! helper consumed by both `plugin_create_signature` and
//! `plugin_verify_signature` so the two paths cannot drift.
//!
//! TS-side contract: `lib/plugin/security/signature.ts:15-23` expects
//! `{ algorithm: "ed25519", signature, publicKey, signedAt, expiresAt? }`.

use std::fs;

use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SIGNATURE_LENGTH};
use rand::RngCore;
use sha2::{Digest, Sha256};
use serde::Serialize;

use super::{PluginError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeypairPayload {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignaturePayload {
    pub algorithm: String,
    pub signature: String,
    pub public_key: String,
    pub signed_at: String,
}

fn compute_digest(plugin_id: &str, version: &str, file_bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(plugin_id.as_bytes());
    hasher.update(b":");
    hasher.update(version.as_bytes());
    hasher.update(b":");
    hasher.update(file_bytes);
    hasher.finalize().into()
}

#[tauri::command]
pub async fn plugin_generate_keypair() -> Result<KeypairPayload> {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key: VerifyingKey = (&signing_key).into();
    Ok(KeypairPayload {
        public_key: hex::encode(verifying_key.to_bytes()),
        private_key: hex::encode(signing_key.to_bytes()),
    })
}

#[tauri::command]
pub async fn plugin_create_signature(
    plugin_id: String,
    version: String,
    private_key_hex: String,
    artifact_path: String,
) -> Result<SignaturePayload> {
    let sk_bytes = hex::decode(&private_key_hex)
        .map_err(|e| PluginError::Crypto(format!("private key hex decode: {e}")))?;
    let sk_arr: [u8; 32] = sk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto("private key must be 32 bytes".into()))?;
    let signing_key = SigningKey::from_bytes(&sk_arr);
    let bytes = fs::read(&artifact_path)?;
    let digest = compute_digest(&plugin_id, &version, &bytes);
    let signature: Signature = signing_key.sign(&digest);
    let verifying_key: VerifyingKey = (&signing_key).into();
    Ok(SignaturePayload {
        algorithm: "ed25519".into(),
        signature: hex::encode(signature.to_bytes()),
        public_key: hex::encode(verifying_key.to_bytes()),
        signed_at: Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn plugin_verify_signature(
    plugin_id: String,
    version: String,
    artifact_path: String,
    signature_hex: String,
    public_key_hex: String,
) -> Result<bool> {
    let pk_bytes = hex::decode(&public_key_hex)
        .map_err(|e| PluginError::Crypto(format!("public key hex decode: {e}")))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto("public key must be 32 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| PluginError::Crypto(format!("invalid public key: {e}")))?;
    let sig_bytes = hex::decode(&signature_hex)
        .map_err(|e| PluginError::Crypto(format!("signature hex decode: {e}")))?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto(format!("signature must be {SIGNATURE_LENGTH} bytes")))?;
    let signature = Signature::from_bytes(&sig_arr);
    let bytes = fs::read(&artifact_path)?;
    let digest = compute_digest(&plugin_id, &version, &bytes);
    Ok(verifying_key.verify(&digest, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_artifact(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    #[tokio::test]
    async fn round_trip_create_then_verify_succeeds() {
        let kp = plugin_generate_keypair().await.unwrap();
        let f = write_artifact(b"hello world");
        let sig = plugin_create_signature(
            "demo".into(),
            "1.0.0".into(),
            kp.private_key.clone(),
            f.path().to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        let ok = plugin_verify_signature(
            "demo".into(),
            "1.0.0".into(),
            f.path().to_string_lossy().into_owned(),
            sig.signature.clone(),
            kp.public_key.clone(),
        )
        .await
        .unwrap();
        assert!(ok);
    }

    #[tokio::test]
    async fn version_mismatch_fails_verification() {
        let kp = plugin_generate_keypair().await.unwrap();
        let f = write_artifact(b"abc");
        let sig = plugin_create_signature(
            "demo".into(),
            "1.0.0".into(),
            kp.private_key.clone(),
            f.path().to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        let ok = plugin_verify_signature(
            "demo".into(),
            "2.0.0".into(),
            f.path().to_string_lossy().into_owned(),
            sig.signature,
            kp.public_key,
        )
        .await
        .unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn artifact_tamper_fails_verification() {
        let kp = plugin_generate_keypair().await.unwrap();
        let f1 = write_artifact(b"original");
        let sig = plugin_create_signature(
            "demo".into(),
            "1.0.0".into(),
            kp.private_key.clone(),
            f1.path().to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        let f2 = write_artifact(b"tampered");
        let ok = plugin_verify_signature(
            "demo".into(),
            "1.0.0".into(),
            f2.path().to_string_lossy().into_owned(),
            sig.signature,
            kp.public_key,
        )
        .await
        .unwrap();
        assert!(!ok);
    }

    #[test]
    fn digest_is_deterministic_and_collision_resistant() {
        let a = compute_digest("p", "1.0.0", b"x");
        let b = compute_digest("p", "1.0.0", b"x");
        let c = compute_digest("p", "1.0.0", b"y");
        let d = compute_digest("q", "1.0.0", b"x");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }
}
