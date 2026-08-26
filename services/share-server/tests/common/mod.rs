//! Shared test harness: boot a real server on an ephemeral port against a
//! throwaway SQLite file, and hand back its base URL.
//!
// Each integration-test binary includes this module but uses only a subset of
// the helpers, so suppress the resulting per-crate dead-code warnings.
#![allow(dead_code)]

use cognia_share_server::{serve_for_test, Config};
use tempfile::TempDir;

/// The bearer secret `Config::for_test` configures.
pub const SECRET: &str = "test-secret";

/// Boot a server with a default test config (generous rate limits, no origin
/// allowlist) against a fresh temp DB. The returned [`TempDir`] must be kept
/// alive for the duration of the test — dropping it deletes the database.
pub async fn start() -> (String, TempDir) {
    start_with(|_| {}).await
}

/// Like [`start`] but lets the caller tweak the [`Config`] (e.g. tighten the
/// rate limit or shrink the body cap) before the server boots.
pub async fn start_with(mutate: impl FnOnce(&mut Config)) -> (String, TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("shares.sqlite");
    let mut config = Config::for_test(db_path.to_string_lossy().to_string());
    mutate(&mut config);
    let (addr, _handle) = serve_for_test(config).await.expect("server boots");
    (format!("http://{addr}"), dir)
}

/// A minimal valid envelope body for `POST /v1/share`.
pub fn valid_envelope() -> serde_json::Value {
    serde_json::json!({
        "v": 1,
        "alg": "AES-GCM",
        "iv": "AAAAAAAAAAAAAAAA",
        "ciphertext": "Y2lwaGVydGV4dA==",
        "checksum": "deadbeef"
    })
}

/// Mint a grant the test server will accept, for `org_id`.
///
/// The service never mints one in production — it only verifies — so the
/// primitives live here, in the test harness, rather than in the crate.
pub fn grant_for(org_id: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;

    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
        + 300;
    let claims = format!(r#"{{"userId":"usr_ada","orgId":"{org_id}","expiresAt":{expires_at}}}"#);
    let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let mut mac =
        Hmac::<Sha256>::new_from_slice(b"0123456789abcdef0123456789abcdef").expect("key length");
    mac.update(payload.as_bytes());
    format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}
