//! Encrypted on-disk attachment cache for platform connectors.
//!
//! Cache location: `<appData>/cognia/connectors/cache/`
//! Encryption: AES-256-GCM; master key stored in OS keyring
//!   (service `com.cognia.platforms`, account `attachment-master-key`),
//!   auto-generated with `rand::random::<[u8; 32]>()` on first call.
//!
//! Cache key: SHA-256 of `"<adapter_id>:<remote_ref>"` → hex filename.
//!
//! `fetch_attachment` is idempotent: a cache hit short-circuits the remote
//! fetch, regardless of how old the file is (TTL / expiry is a future add).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// Absolute path to the locally cached (decrypted-on-read) copy.
    pub local_url: String,
    /// The original remote reference, echoed back for the TS side.
    pub remote_ref: String,
}

/// Fetch `source_url`, store encrypted on disk under the cognia cache dir,
/// and return an [`AttachmentRef`] pointing at the local path.
///
/// On a cache hit the fetch is skipped entirely.
pub async fn fetch_attachment(
    adapter_id: String,
    remote_ref: String,
    source_url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<AttachmentRef, String> {
    let cache_dir = resolve_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("create cache dir failed: {e}"))?;

    let cache_key = compute_cache_key(&adapter_id, &remote_ref);
    let enc_path = cache_dir.join(format!("{cache_key}.enc"));
    let raw_path = cache_dir.join(&cache_key);

    // Cache hit — decrypt and return.
    if enc_path.exists() {
        let plaintext = decrypt_file(&enc_path)?;
        std::fs::write(&raw_path, &plaintext).map_err(|e| format!("cache write failed: {e}"))?;
        return Ok(AttachmentRef {
            local_url: raw_path.to_string_lossy().to_string(),
            remote_ref,
        });
    }

    // Cache miss — fetch, encrypt, write.
    let client = reqwest::Client::new();
    let mut request = client.get(&source_url);
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    let bytes = request
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?
        // A non-2xx body (auth error page, rate-limit JSON …) must never be
        // cached: the cache is hit-first with no TTL, so a cached error body
        // would permanently shadow the real attachment.
        .error_for_status()
        .map_err(|e| format!("fetch failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("body read failed: {e}"))?;

    let ciphertext = encrypt_bytes(&bytes)?;
    std::fs::write(&enc_path, &ciphertext).map_err(|e| format!("cache write failed: {e}"))?;
    std::fs::write(&raw_path, &bytes).map_err(|e| format!("raw write failed: {e}"))?;

    Ok(AttachmentRef {
        local_url: raw_path.to_string_lossy().to_string(),
        remote_ref,
    })
}

/// Read a previously cached attachment's plaintext bytes as base64.
///
/// Decrypts the `.enc` copy (the canonical cache artifact) rather than
/// trusting the raw plaintext copy. Returns `Ok(None)` when the attachment is
/// not cached or its plaintext exceeds `max_bytes` — the renderer uses the cap
/// to skip inlining large media.
pub fn read_attachment_base64(
    adapter_id: &str,
    remote_ref: &str,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let cache_dir = resolve_cache_dir()?;
    let cache_key = compute_cache_key(adapter_id, remote_ref);
    let enc_path = cache_dir.join(format!("{cache_key}.enc"));
    if !enc_path.exists() {
        return Ok(None);
    }
    let plaintext = decrypt_file(&enc_path)?;
    if plaintext.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(plaintext),
    ))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn resolve_cache_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("cognia").join("connectors").join("cache"))
        .ok_or_else(|| "cannot resolve app data directory".to_string())
}

fn compute_cache_key(adapter_id: &str, remote_ref: &str) -> String {
    let mut h = Sha256::new();
    h.update(adapter_id.as_bytes());
    h.update(b":");
    h.update(remote_ref.as_bytes());
    hex::encode(h.finalize())
}

fn master_key() -> Result<[u8; 32], String> {
    const ACCOUNT: &str = "attachment-master-key";

    match super::keyring::get("", ACCOUNT)? {
        Some(hex_key) => {
            let bytes =
                hex::decode(&hex_key).map_err(|e| format!("invalid master key in keyring: {e}"))?;
            bytes
                .try_into()
                .map_err(|_| "master key must be 32 bytes".to_string())
        }
        None => {
            // Auto-generate on first use.
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            super::keyring::set("", ACCOUNT, &hex::encode(key))?;
            Ok(key)
        }
    }
}

fn encrypt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let key_bytes = master_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|e| format!("encrypt failed: {e}"))?;

    // Prepend nonce so we can reconstruct it on decrypt.
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_file(path: &Path) -> Result<Vec<u8>, String> {
    let data = std::fs::read(path).map_err(|e| format!("read enc file failed: {e}"))?;
    if data.len() < 12 {
        return Err("encrypted file too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let key_bytes = master_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn keyring_available() -> bool {
        crate::keyring_available()
    }

    #[test]
    fn cache_key_is_stable_hex() {
        let k1 = compute_cache_key("tg-personal", "file/BQACAgIA123");
        let k2 = compute_cache_key("tg-personal", "file/BQACAgIA123");
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 64);
        assert!(k1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        if !keyring_available() {
            return;
        }
        let original = b"hello attachment world";
        let enc = encrypt_bytes(original).unwrap();
        assert_ne!(enc.as_slice(), original.as_slice());

        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), &enc).unwrap();
        let dec = decrypt_file(tmp.path()).unwrap();
        assert_eq!(dec, original);
    }

    #[tokio::test]
    async fn fetch_caches_and_hits_on_second_call() {
        if !keyring_available() {
            return;
        }

        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/img.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![1u8, 2, 3, 4]))
            .expect(1) // Must be fetched exactly once (second call is cache hit).
            .mount(&mock_server)
            .await;

        // For deterministic isolation, use a unique remote_ref per test run.
        let unique_ref = format!("test-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/img.png", mock_server.uri());

        let ref1 = fetch_attachment("test-adapter".into(), unique_ref.clone(), url.clone(), None)
            .await
            .unwrap();
        assert_eq!(ref1.remote_ref, unique_ref);
        assert!(!ref1.local_url.is_empty());

        // Second call — mock expects only 1 hit, so this must be a cache hit.
        let ref2 = fetch_attachment("test-adapter".into(), unique_ref.clone(), url.clone(), None)
            .await
            .unwrap();
        assert_eq!(ref2.local_url, ref1.local_url);

        // Verify the mock was only contacted once.
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn fetch_rejects_non_2xx_and_does_not_cache_error_body() {
        if !keyring_available() {
            return;
        }

        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/forbidden.png"))
            .respond_with(ResponseTemplate::new(403).set_body_string("token expired"))
            .mount(&mock_server)
            .await;

        let unique_ref = format!("test-err-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/forbidden.png", mock_server.uri());

        let result = fetch_attachment("test-adapter".into(), unique_ref.clone(), url, None).await;
        assert!(result.is_err(), "non-2xx must be an error, got {result:?}");

        // Nothing may have landed in the cache — a later fetch with a fixed
        // token must go back to the network, not read the cached error body.
        let cache_dir = resolve_cache_dir().unwrap();
        let cache_key = compute_cache_key("test-adapter", &unique_ref);
        assert!(!cache_dir.join(format!("{cache_key}.enc")).exists());
        assert!(!cache_dir.join(&cache_key).exists());
    }

    #[tokio::test]
    async fn read_attachment_base64_round_trips_and_caps_size() {
        use base64::Engine as _;

        if !keyring_available() {
            return;
        }

        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/read.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![5u8, 6, 7, 8]))
            .mount(&mock_server)
            .await;

        let unique_ref = format!("test-read-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/read.png", mock_server.uri());
        fetch_attachment("test-adapter".into(), unique_ref.clone(), url, None)
            .await
            .unwrap();

        // Missing ref → None.
        assert_eq!(
            read_attachment_base64("test-adapter", "never-fetched", 1024).unwrap(),
            None
        );
        // Cached and under cap → decrypted bytes.
        let b64 = read_attachment_base64("test-adapter", &unique_ref, 1024)
            .unwrap()
            .expect("cached attachment must be readable");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
            vec![5u8, 6, 7, 8]
        );
        // Over cap → None.
        assert_eq!(
            read_attachment_base64("test-adapter", &unique_ref, 3).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn fetch_sends_optional_headers() {
        if !keyring_available() {
            return;
        }

        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth.png"))
            .and(header("authorization", "Bearer tok"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![9u8, 8, 7]))
            .expect(1)
            .mount(&mock_server)
            .await;

        let unique_ref = format!("test-auth-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/auth.png", mock_server.uri());
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer tok".to_string());

        let fetched = fetch_attachment(
            "test-adapter".into(),
            unique_ref.clone(),
            url,
            Some(headers),
        )
        .await
        .unwrap();
        assert_eq!(fetched.remote_ref, unique_ref);
        mock_server.verify().await;
    }
}
