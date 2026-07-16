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
//!
//! # At-rest encryption caveat (honest scope)
//!
//! The `.enc` copy is the canonical at-rest artifact, but the webview needs a
//! plain `local_url` it can load, so a decrypted RAW copy (same filename, no
//! `.enc` extension) is written beside it on every fetch and cache hit.
//! Those plaintext copies therefore exist on disk **while the app runs** (and
//! across a crash). [`cleanup_raw_attachment_cache`] reaps them at connector
//! bootstrap (piggybacked on `connectors_reset_all_ws`), which bounds the
//! exposure window to a single app session — it does not eliminate it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use cognia_net::proxy_config;

/// Hard cap on a single attachment fetched into memory. Attachments are chat
/// media (images, voice notes, documents); 50 MiB bounds memory on
/// constrained devices while covering realistic payloads. Mirrors the
/// capped-streaming pattern in `media_upload.rs` (100 MiB there).
const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

/// Remote fetch timeout — same order as `media_upload.rs` (120 s for uploads);
/// 60 s is plenty for a 50 MiB download without letting a stalled connection
/// pin the task forever.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

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
    fetch_attachment_into(
        &cache_dir,
        &adapter_id,
        remote_ref,
        &source_url,
        headers,
        MAX_ATTACHMENT_BYTES,
    )
    .await
}

/// Implementation of [`fetch_attachment`] with the cache directory and byte
/// cap injected — tests point this at a tempdir with a tiny cap.
async fn fetch_attachment_into(
    cache_dir: &Path,
    adapter_id: &str,
    remote_ref: String,
    source_url: &str,
    headers: Option<HashMap<String, String>>,
    max_bytes: usize,
) -> Result<AttachmentRef, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("create cache dir failed: {e}"))?;

    let cache_key = compute_cache_key(adapter_id, &remote_ref);
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

    // Cache miss — fetch (proxy-aware, timed out, size-capped), encrypt, write.
    let client = build_client(source_url)?;
    let mut request = client.get(source_url);
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    let mut resp = request
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?
        // A non-2xx body (auth error page, rate-limit JSON …) must never be
        // cached: the cache is hit-first with no TTL, so a cached error body
        // would permanently shadow the real attachment.
        .error_for_status()
        .map_err(|e| format!("fetch failed: {e}"))?;

    // Reject early when the server advertises an oversized body.
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err(format!(
                "attachment is {len} bytes, exceeding the {max_bytes}-byte cap"
            ));
        }
    }
    // Stream with a hard cap so a missing / lying Content-Length can't buffer
    // an unbounded amount of memory (same pattern as media_upload.rs).
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("body read failed: {e}"))?
    {
        if bytes.len() + chunk.len() > max_bytes {
            return Err(format!("attachment exceeds the {max_bytes}-byte cap"));
        }
        bytes.extend_from_slice(&chunk);
    }

    let ciphertext = encrypt_bytes(&bytes)?;
    std::fs::write(&enc_path, &ciphertext).map_err(|e| format!("cache write failed: {e}"))?;
    std::fs::write(&raw_path, &bytes).map_err(|e| format!("raw write failed: {e}"))?;

    Ok(AttachmentRef {
        local_url: raw_path.to_string_lossy().to_string(),
        remote_ref,
    })
}

/// Proxy-aware HTTP client for attachment fetches — honours the user's proxy
/// config (including the bypass list) and applies [`FETCH_TIMEOUT`]. Mirrors
/// `media_upload::build_client`.
fn build_client(target_url: &str) -> Result<reqwest::Client, String> {
    let proxy_cfg = proxy_config::current();
    let mut builder = reqwest::Client::builder().timeout(FETCH_TIMEOUT);
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(target_url) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))
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
    let cache_dir = resolve_cache_dir()?;
    read_attachment_base64_from(&cache_dir, adapter_id, remote_ref, max_bytes)
}

/// Implementation of [`read_attachment_base64`] with the cache directory
/// injected for testability.
fn read_attachment_base64_from(
    cache_dir: &Path,
    adapter_id: &str,
    remote_ref: &str,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

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

/// Remove every RAW (non-`.enc`) plaintext file from the attachment cache
/// directory, returning how many were deleted.
///
/// Rationale: the raw decrypted copies exist only so the webview gets a
/// loadable `local_url`; they are rewritten on demand by `fetch_attachment`
/// (cache hits re-materialize them from the `.enc` copy), so deleting them is
/// always safe. Called once at connector bootstrap — see the module header
/// for the remaining exposure window.
pub fn cleanup_raw_attachment_cache() -> Result<usize, String> {
    let cache_dir = resolve_cache_dir()?;
    cleanup_raw_files_in(&cache_dir)
        .map_err(|e| format!("cleanup raw attachment cache failed: {e}"))
}

/// Directory-injected core of [`cleanup_raw_attachment_cache`].
fn cleanup_raw_files_in(dir: &Path) -> std::io::Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if !path.is_file() {
            continue;
        }
        let is_enc = path.extension().is_some_and(|ext| ext == "enc");
        if !is_enc {
            std::fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
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
        let original = b"hello attachment world";
        let enc = encrypt_bytes(original).unwrap();
        assert_ne!(enc.as_slice(), original.as_slice());

        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), &enc).unwrap();
        let dec = decrypt_file(tmp.path()).unwrap();
        assert_eq!(dec, original);
    }

    /// Convenience wrapper: fetch into `dir` with the default cap.
    async fn fetch_into(
        dir: &Path,
        remote_ref: &str,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<AttachmentRef, String> {
        fetch_attachment_into(
            dir,
            "test-adapter",
            remote_ref.to_string(),
            url,
            headers,
            MAX_ATTACHMENT_BYTES,
        )
        .await
    }

    #[tokio::test]
    async fn fetch_caches_and_hits_on_second_call() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/img.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![1u8, 2, 3, 4]))
            .expect(1) // Must be fetched exactly once (second call is cache hit).
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/img.png", mock_server.uri());

        let ref1 = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert_eq!(ref1.remote_ref, unique_ref);
        assert!(!ref1.local_url.is_empty());

        // Second call — mock expects only 1 hit, so this must be a cache hit.
        let ref2 = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert_eq!(ref2.local_url, ref1.local_url);

        // Verify the mock was only contacted once.
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn fetch_rejects_non_2xx_and_does_not_cache_error_body() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/forbidden.png"))
            .respond_with(ResponseTemplate::new(403).set_body_string("token expired"))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-err-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/forbidden.png", mock_server.uri());

        let result = fetch_into(dir.path(), &unique_ref, &url, None).await;
        assert!(result.is_err(), "non-2xx must be an error, got {result:?}");

        // Nothing may have landed in the cache — a later fetch with a fixed
        // token must go back to the network, not read the cached error body.
        let cache_key = compute_cache_key("test-adapter", &unique_ref);
        assert!(!dir.path().join(format!("{cache_key}.enc")).exists());
        assert!(!dir.path().join(&cache_key).exists());
    }

    #[tokio::test]
    async fn fetch_rejects_body_exceeding_cap_and_caches_nothing() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0u8; 64]))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-big-{}", uuid::Uuid::new_v4());
        let url = format!("{}/big.bin", mock_server.uri());

        // Cap of 16 bytes < 64-byte body → rejected, either via the advertised
        // Content-Length or the streaming cap.
        let err = fetch_attachment_into(
            dir.path(),
            "test-adapter",
            unique_ref.clone(),
            &url,
            None,
            16,
        )
        .await
        .unwrap_err();
        assert!(err.contains("cap"), "got: {err}");

        let cache_key = compute_cache_key("test-adapter", &unique_ref);
        assert!(!dir.path().join(format!("{cache_key}.enc")).exists());
        assert!(!dir.path().join(&cache_key).exists());
    }

    #[tokio::test]
    async fn read_attachment_base64_round_trips_and_caps_size() {
        use base64::Engine as _;

        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/read.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![5u8, 6, 7, 8]))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-read-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/read.png", mock_server.uri());
        fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();

        // Missing ref → None.
        assert_eq!(
            read_attachment_base64_from(dir.path(), "test-adapter", "never-fetched", 1024).unwrap(),
            None
        );
        // Cached and under cap → decrypted bytes.
        let b64 = read_attachment_base64_from(dir.path(), "test-adapter", &unique_ref, 1024)
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
            read_attachment_base64_from(dir.path(), "test-adapter", &unique_ref, 3).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn fetch_sends_optional_headers() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth.png"))
            .and(header("authorization", "Bearer tok"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![9u8, 8, 7]))
            .expect(1)
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-auth-img-{}", uuid::Uuid::new_v4());
        let url = format!("{}/auth.png", mock_server.uri());
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer tok".to_string());

        let fetched = fetch_into(dir.path(), &unique_ref, &url, Some(headers))
            .await
            .unwrap();
        assert_eq!(fetched.remote_ref, unique_ref);
        mock_server.verify().await;
    }

    #[test]
    fn cleanup_removes_raw_files_but_keeps_enc_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("aabbcc"), b"raw plaintext").unwrap();
        std::fs::write(dir.path().join("ddeeff"), b"more plaintext").unwrap();
        std::fs::write(dir.path().join("aabbcc.enc"), b"ciphertext").unwrap();
        // Subdirectories are left alone.
        std::fs::create_dir(dir.path().join("subdir")).unwrap();

        let removed = cleanup_raw_files_in(dir.path()).unwrap();
        assert_eq!(removed, 2);
        assert!(!dir.path().join("aabbcc").exists());
        assert!(!dir.path().join("ddeeff").exists());
        assert!(dir.path().join("aabbcc.enc").exists());
        assert!(dir.path().join("subdir").exists());
    }

    #[test]
    fn cleanup_on_missing_dir_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(cleanup_raw_files_in(&missing).unwrap(), 0);
    }

    #[tokio::test]
    async fn cache_hit_rematerializes_raw_copy_after_cleanup() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/re.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![42u8, 43]))
            .expect(1)
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-re-{}", uuid::Uuid::new_v4());
        let url = format!("{}/re.png", mock_server.uri());
        let fetched = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();

        cleanup_raw_files_in(dir.path()).unwrap();
        assert!(!std::path::Path::new(&fetched.local_url).exists());

        // Cache hit (no second network fetch) restores the raw copy.
        let again = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert_eq!(again.local_url, fetched.local_url);
        assert_eq!(
            std::fs::read(&again.local_url).unwrap(),
            vec![42u8, 43],
            "raw copy must be re-materialized from the .enc artifact"
        );
        mock_server.verify().await;
    }
}
