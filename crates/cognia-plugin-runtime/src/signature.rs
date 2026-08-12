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
use serde::Serialize;
use sha2::{Digest, Sha256};

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
    rand::fill(&mut seed);
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

/// SHA-256 fingerprint of a base64-encoded Ed25519 public key. Returned
/// as a lowercase hex digest so the UI can show "ed25519:9f3a:...:" style
/// identities to the user during first-install trust-on-first-use.
#[tauri::command]
pub async fn plugin_public_key_fingerprint(public_key_base64: String) -> Result<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_base64.as_bytes())
        .map_err(|e| PluginError::Crypto(format!("public key base64 decode: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

/// Verify a detached Ed25519 signature over the raw bundle bytes. Used by
/// the WASM plugin install flow when the bundle ships with `<bundle>.sig`
/// and a manifest-pinned base64 public key. Unlike `plugin_verify_signature`
/// (which signs the `<id>:<ver>:<bytes>` digest), this is a direct
/// `verify_strict` over the bundle so the same `.sig` works regardless of
/// whether the host knows the plugin id yet.
#[tauri::command]
pub async fn plugin_verify_detached_signature(
    artifact_path: String,
    signature_base64: String,
    public_key_base64: String,
) -> Result<bool> {
    // Parse BEFORE reading the file, preserving the existing behaviour where a
    // malformed key or signature errors without touching the filesystem.
    let (verifying_key, signature) = parse_ed25519_detached(&signature_base64, &public_key_base64)?;
    let bytes = fs::read(&artifact_path)?;
    Ok(verifying_key.verify_strict(&bytes, &signature).is_ok())
}

/// Decode a base64 Ed25519 public key + detached signature.
///
/// Split out from verification so callers can validate inputs before doing any
/// I/O, and so the byte-oriented path below shares exactly one decoder with the
/// file-oriented command.
pub fn parse_ed25519_detached(
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(VerifyingKey, Signature)> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_bytes = b64
        .decode(public_key_base64.as_bytes())
        .map_err(|e| PluginError::Crypto(format!("public key base64 decode: {e}")))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto("public key must be 32 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| PluginError::Crypto(format!("invalid public key: {e}")))?;
    let sig_bytes = b64
        .decode(signature_base64.as_bytes())
        .map_err(|e| PluginError::Crypto(format!("signature base64 decode: {e}")))?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto(format!("signature must be {SIGNATURE_LENGTH} bytes")))?;
    Ok((verifying_key, Signature::from_bytes(&sig_arr)))
}

/// Verify a detached Ed25519 signature over arbitrary bytes.
///
/// Pure: no filesystem, no Tauri. Input-shape problems are `Err`; a
/// cryptographically invalid signature is `Ok(false)`. Uses `verify_strict`,
/// which rejects small-order public keys.
pub fn verify_detached_signature_bytes(
    payload: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<bool> {
    let (verifying_key, signature) = parse_ed25519_detached(signature_base64, public_key_base64)?;
    Ok(verifying_key.verify_strict(payload, &signature).is_ok())
}

/// Host ceiling on a canonical pack payload. A caller-supplied limit may only
/// LOWER this — never raise it.
pub const MAX_PACK_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// The verdict for one Character Pack signature check.
///
/// Every recoverable failure comes back as `Ok(verdict { verified: false })`
/// rather than `Err`, so the TypeScript side has exactly one branch and cannot
/// confuse a host error with an invalid signature — a distinction that matters
/// because one of those must never be downgraded to "unsigned".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSignatureVerdict {
    pub request_id: String,
    pub verified: bool,
    pub pack_id: String,
    pub pack_version: String,
    /// sha256 hex of the raw public-key bytes — same scheme as
    /// `plugin_public_key_fingerprint`. Empty when the key was unusable.
    pub fingerprint: String,
    pub payload_bytes: u64,
    /// `None` on success. Stable machine codes on failure:
    /// `payload-too-large` | `bad-public-key` | `bad-signature-encoding` |
    /// `signature-mismatch`.
    pub reason: Option<String>,
}

/// Verify a detached Ed25519 signature over an in-memory canonical payload.
///
/// `payload` is the RFC 8785 canonical JSON of the pack object only. The host
/// canonicalises it (`lib/plugin/character-pack/canonical-json.ts`) so the bytes
/// verified are the bytes registered — that equality is the whole point of
/// taking a payload here rather than a file path.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_verify_pack_signature(
    request_id: String,
    pack_id: String,
    pack_version: String,
    payload: String,
    max_payload_bytes: Option<u64>,
    signature_base64: String,
    public_key_base64: String,
) -> Result<PackSignatureVerdict> {
    let payload_bytes = payload.len() as u64;
    let mut verdict = PackSignatureVerdict {
        request_id,
        verified: false,
        pack_id,
        pack_version,
        fingerprint: String::new(),
        payload_bytes,
        reason: None,
    };

    // The caller may tighten the bound but never loosen it.
    let limit = max_payload_bytes
        .unwrap_or(MAX_PACK_PAYLOAD_BYTES)
        .min(MAX_PACK_PAYLOAD_BYTES);
    if payload_bytes > limit {
        verdict.reason = Some("payload-too-large".into());
        return Ok(verdict);
    }

    let (verifying_key, signature) =
        match parse_ed25519_detached(&signature_base64, &public_key_base64) {
            Ok(parsed) => parsed,
            Err(err) => {
                verdict.reason = Some(
                    if err.to_string().contains("signature") {
                        "bad-signature-encoding"
                    } else {
                        "bad-public-key"
                    }
                    .into(),
                );
                return Ok(verdict);
            }
        };

    verdict.fingerprint = hex::encode(Sha256::digest(verifying_key.to_bytes()));

    if verifying_key
        .verify_strict(payload.as_bytes(), &signature)
        .is_ok()
    {
        verdict.verified = true;
    } else {
        verdict.reason = Some("signature-mismatch".into());
    }
    Ok(verdict)
}

/// Verify an Ed25519 signature over the `<id>:<ver>:<bytes>` digest for an
/// in-memory artifact. Pure (no filesystem) so the marketplace install path can
/// verify the bytes it already holds without writing them to a temp file first.
/// Shared with `plugin_verify_signature` so the two cannot drift.
pub(crate) fn verify_artifact_signature_bytes(
    plugin_id: &str,
    version: &str,
    bytes: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<bool> {
    let pk_bytes = hex::decode(public_key_hex)
        .map_err(|e| PluginError::Crypto(format!("public key hex decode: {e}")))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto("public key must be 32 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| PluginError::Crypto(format!("invalid public key: {e}")))?;
    let sig_bytes = hex::decode(signature_hex)
        .map_err(|e| PluginError::Crypto(format!("signature hex decode: {e}")))?;
    let sig_arr: [u8; SIGNATURE_LENGTH] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::Crypto(format!("signature must be {SIGNATURE_LENGTH} bytes")))?;
    let signature = Signature::from_bytes(&sig_arr);
    let digest = compute_digest(plugin_id, version, bytes);
    Ok(verifying_key.verify(&digest, &signature).is_ok())
}

#[tauri::command]
pub async fn plugin_verify_signature(
    plugin_id: String,
    version: String,
    artifact_path: String,
    signature_hex: String,
    public_key_hex: String,
) -> Result<bool> {
    let bytes = fs::read(&artifact_path)?;
    verify_artifact_signature_bytes(
        &plugin_id,
        &version,
        &bytes,
        &signature_hex,
        &public_key_hex,
    )
}

#[cfg(test)]
mod tests {
    // ---- Character Pack payload verification (v0.2 trust chain) ----

    fn sign_canonical(payload: &str) -> (String, String) {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut seed = [7u8; 32];
        seed[0] = 42;
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key: VerifyingKey = (&signing_key).into();
        let sig = signing_key.sign(payload.as_bytes());
        (
            b64.encode(sig.to_bytes()),
            b64.encode(verifying_key.to_bytes()),
        )
    }

    #[tokio::test]
    async fn pack_signature_verifies_canonical_bytes() {
        let payload = r#"{"id":"demo.pack","name":"Demo"}"#;
        let (sig, pk) = sign_canonical(payload);
        let v = plugin_verify_pack_signature(
            "req-1".into(),
            "demo.pack".into(),
            "1.0.0".into(),
            payload.into(),
            None,
            sig,
            pk,
        )
        .await
        .unwrap();

        assert!(v.verified);
        assert!(v.reason.is_none());
        assert_eq!(v.request_id, "req-1");
        assert_eq!(v.payload_bytes, payload.len() as u64);
        assert_eq!(v.fingerprint.len(), 64, "sha256 hex");
    }

    #[tokio::test]
    async fn a_one_byte_payload_mutation_fails_verification() {
        let payload = r#"{"id":"demo.pack","name":"Demo"}"#;
        let (sig, pk) = sign_canonical(payload);
        let tampered = r#"{"id":"demo.pack","name":"demo"}"#;
        let v = plugin_verify_pack_signature(
            "req".into(),
            "demo.pack".into(),
            "1.0.0".into(),
            tampered.into(),
            None,
            sig,
            pk,
        )
        .await
        .unwrap();

        assert!(!v.verified);
        assert_eq!(v.reason.as_deref(), Some("signature-mismatch"));
        // The fingerprint is still reported: the KEY was fine, the bytes were not.
        assert_eq!(v.fingerprint.len(), 64);
    }

    #[tokio::test]
    async fn oversize_payload_is_rejected_before_any_crypto() {
        let payload = "x".repeat(64);
        let (sig, pk) = sign_canonical(&payload);
        let v = plugin_verify_pack_signature(
            "req".into(),
            "p".into(),
            "1.0.0".into(),
            payload,
            Some(10),
            sig,
            pk,
        )
        .await
        .unwrap();

        assert!(!v.verified);
        assert_eq!(v.reason.as_deref(), Some("payload-too-large"));
        assert!(v.fingerprint.is_empty(), "the key is never parsed");
    }

    #[tokio::test]
    async fn a_caller_cannot_raise_the_host_payload_ceiling() {
        // Passing u64::MAX must clamp to MAX_PACK_PAYLOAD_BYTES, not disable it.
        let payload = "x".repeat((MAX_PACK_PAYLOAD_BYTES + 1) as usize);
        let (sig, pk) = sign_canonical("unrelated");
        let v = plugin_verify_pack_signature(
            "req".into(),
            "p".into(),
            "1.0.0".into(),
            payload,
            Some(u64::MAX),
            sig,
            pk,
        )
        .await
        .unwrap();

        assert_eq!(v.reason.as_deref(), Some("payload-too-large"));
    }

    #[tokio::test]
    async fn malformed_key_and_signature_report_distinct_reasons() {
        let payload = "{}";
        let (sig, pk) = sign_canonical(payload);

        let bad_key = plugin_verify_pack_signature(
            "req".into(),
            "p".into(),
            "1.0.0".into(),
            payload.into(),
            None,
            sig.clone(),
            "not-base64!!".into(),
        )
        .await
        .unwrap();
        assert!(!bad_key.verified);
        assert_eq!(bad_key.reason.as_deref(), Some("bad-public-key"));

        let bad_sig = plugin_verify_pack_signature(
            "req".into(),
            "p".into(),
            "1.0.0".into(),
            payload.into(),
            None,
            "not-base64!!".into(),
            pk,
        )
        .await
        .unwrap();
        assert!(!bad_sig.verified);
        assert_eq!(bad_sig.reason.as_deref(), Some("bad-signature-encoding"));
    }

    #[tokio::test]
    async fn recoverable_failures_are_ok_not_err() {
        // The TS side must have exactly one branch: a host error and an invalid
        // signature must never look the same, because only one of them may ever
        // be downgraded to "unsigned".
        let v = plugin_verify_pack_signature(
            "req".into(),
            "p".into(),
            "1.0.0".into(),
            "{}".into(),
            None,
            "AAAA".into(),
            "AAAA".into(),
        )
        .await;
        assert!(v.is_ok(), "shape problems must not surface as Err");
        assert!(!v.unwrap().verified);
    }

    #[test]
    fn verify_detached_signature_bytes_is_pure_and_strict() {
        let payload = b"canonical bytes";
        let (sig, pk) = sign_canonical("canonical bytes");
        assert!(verify_detached_signature_bytes(payload, &sig, &pk).unwrap());
        assert!(!verify_detached_signature_bytes(b"other bytes", &sig, &pk).unwrap());
        assert!(verify_detached_signature_bytes(payload, "!!", &pk).is_err());
    }

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

    #[tokio::test]
    async fn detached_signature_round_trip() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;

        // Generate keypair (hex-encoded; convert to base64 for the new API).
        let kp = plugin_generate_keypair().await.unwrap();
        let sk_bytes = hex::decode(&kp.private_key).unwrap();
        let sk_arr: [u8; 32] = sk_bytes.as_slice().try_into().unwrap();
        let signing_key = SigningKey::from_bytes(&sk_arr);
        let verifying_key: VerifyingKey = (&signing_key).into();
        let pk_b64 = b64.encode(verifying_key.to_bytes());

        // Write a fixture bundle and sign its raw bytes (detached, no prefix).
        let bundle = write_artifact(b"--- fake wasm bundle ---");
        let raw = std::fs::read(bundle.path()).unwrap();
        let sig: Signature = signing_key.sign(&raw);
        let sig_b64 = b64.encode(sig.to_bytes());

        let ok = plugin_verify_detached_signature(
            bundle.path().to_string_lossy().into_owned(),
            sig_b64.clone(),
            pk_b64.clone(),
        )
        .await
        .unwrap();
        assert!(ok);

        // Tamper with bundle → verification must fail.
        let tampered = write_artifact(b"--- fake wasm bundle (tampered) ---");
        let bad = plugin_verify_detached_signature(
            tampered.path().to_string_lossy().into_owned(),
            sig_b64,
            pk_b64,
        )
        .await
        .unwrap();
        assert!(!bad);
    }

    #[tokio::test]
    async fn public_key_fingerprint_is_stable_per_key() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let pk_a = b64.encode([1u8; 32]);
        let pk_b = b64.encode([2u8; 32]);
        let fp_a1 = plugin_public_key_fingerprint(pk_a.clone()).await.unwrap();
        let fp_a2 = plugin_public_key_fingerprint(pk_a).await.unwrap();
        let fp_b = plugin_public_key_fingerprint(pk_b).await.unwrap();
        assert_eq!(fp_a1, fp_a2);
        assert_ne!(fp_a1, fp_b);
        assert_eq!(fp_a1.len(), 64); // sha256 hex = 32 bytes × 2 chars
    }

    #[tokio::test]
    async fn detached_signature_rejects_malformed_inputs() {
        let bundle = write_artifact(b"x");
        let path = bundle.path().to_string_lossy().into_owned();
        let bad_pk =
            plugin_verify_detached_signature(path.clone(), "AA==".into(), "not_base64!!!".into())
                .await;
        assert!(bad_pk.is_err());
        let wrong_len_pk =
            plugin_verify_detached_signature(path, "AA==".into(), "QUE=".into()).await;
        assert!(wrong_len_pk.is_err());
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
