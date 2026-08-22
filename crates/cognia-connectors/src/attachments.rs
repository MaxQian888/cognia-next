//! Encrypted on-disk attachment cache for platform connectors.
//!
//! Cache location: `<appData>/cognia/connectors/cache/`
//! Encryption: AES-256-GCM; master key stored in OS keyring
//!   (service `com.cognia.platforms`, account `attachment-master-key`),
//!   auto-generated with `rand::fill` on first call.
//!
//! Cache key: SHA-256 of `"<adapter_id>:<remote_ref>"` → hex filename with an
//! `.enc` extension.
//!
//! # Envelope format (the only format the runtime reads)
//!
//! Every cache file is a single self-describing envelope:
//!
//! ```text
//! offset  len  field
//! 0       8    MAGIC          b"COGNIAAT"
//! 8       1    VERSION        1
//! 9       12   meta nonce     AES-GCM nonce for the metadata record
//! 21      112  meta record    AES-GCM(96-byte metadata plaintext) + 16B tag
//! 133     12   payload nonce  AES-GCM nonce for the media bytes
//! 145     ..   payload        AES-GCM(media bytes) + 16B tag
//! ```
//!
//! The 96-byte metadata plaintext is fixed-width so `lastAccessedAt` can be
//! refreshed by rewriting only the 124-byte metadata region — a cache hit on a
//! 50 MiB attachment never re-encrypts the payload:
//!
//! ```text
//! 0    32  cache key      raw SHA-256 digest
//! 32   32  adapter hash   raw SHA-256 of the adapter id (zeroed = unknown)
//! 64   8   size bytes     u64 LE — the real decrypted length
//! 72   8   created at     u64 LE — epoch ms
//! 80   8   last access    u64 LE — epoch ms
//! 88   8   expires at     u64 LE — epoch ms, 0 = never
//! ```
//!
//! Both AES-GCM records are authenticated with the cache key hex as AAD, so a
//! file cannot be swapped between cache entries without failing decryption.
//!
//! # No plaintext at rest
//!
//! Earlier revisions wrote a decrypted copy of every attachment beside the
//! ciphertext so the webview could load it by path. Nothing ever read it (all
//! consumers go through [`read_attachment_base64`]), so the plaintext copy was
//! pure exposure and is gone: the `.enc` envelope is the only artifact this
//! module writes. [`migrate_legacy_cache`] reaps any plaintext left behind by
//! an older build on the first run after upgrade.

use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
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

/// Default time-to-live for a cached attachment: 7 days. Callers may override
/// per fetch; `0` means "never expires, LRU only".
pub const DEFAULT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

// --- Envelope layout --------------------------------------------------------

const MAGIC: &[u8; 8] = b"COGNIAAT";
const ENVELOPE_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;
const META_PLAIN_LEN: usize = 96;
const META_CT_LEN: usize = META_PLAIN_LEN + GCM_TAG_LEN;
const META_OFFSET: u64 = (MAGIC.len() + 1) as u64;
const META_REGION_LEN: usize = NONCE_LEN + META_CT_LEN;
const PAYLOAD_OFFSET: usize = META_OFFSET as usize + META_REGION_LEN;

/// Marker written once the one-time legacy-cache migration has completed. Its
/// presence is what lets the normal read path assume the current format.
const MIGRATION_MARKER: &str = ".envelope-v1-migrated";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Metadata describing one cached attachment. Returned by every command that
/// touches the cache so the TypeScript side never has to guess a size or
/// re-derive an expiry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// Hex SHA-256 of `"<adapter_id>:<remote_ref>"` — the cache file's stem
    /// and the handle every delete / evict command takes.
    pub cache_key: String,
    /// The original remote reference, echoed back for the TS side.
    pub remote_ref: String,
    /// Real decrypted length in bytes. Never a placeholder.
    pub size_bytes: u64,
    /// Epoch ms the entry was first written.
    pub created_at: u64,
    /// Epoch ms the entry was last read or re-served.
    pub last_accessed_at: u64,
    /// Epoch ms the entry expires; `None` means it only ages out via LRU.
    pub expires_at: Option<u64>,
    /// True when the bytes came from cache and no network fetch happened.
    pub cached: bool,
}

/// One entry in a cache listing — the input to renderer-side orphan sweeps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub cache_key: String,
    pub size_bytes: u64,
    pub created_at: u64,
    pub last_accessed_at: u64,
    pub expires_at: Option<u64>,
    /// Bytes the envelope occupies on disk, including header and tags.
    pub disk_bytes: u64,
}

/// Outcome of a batch delete / evict / prune. Callers persist `failed` into
/// the cleanup ledger and retry it rather than dropping the Dexie row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCleanupReport {
    /// Cache keys whose file is now gone (deleted, or already absent).
    pub deleted: Vec<String>,
    /// Bytes reclaimed on disk.
    pub freed_bytes: u64,
    /// Cache keys that could not be removed, with the reason.
    pub failed: Vec<AttachmentCleanupFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCleanupFailure {
    pub cache_key: String,
    pub error: String,
}

/// Result of the one-time migration off the pre-envelope layout.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    /// Plaintext (non-`.enc`) files reaped.
    pub plaintext_removed: usize,
    /// Legacy ciphertext files converted to the current envelope.
    pub converted: usize,
    /// Legacy files dropped because they were already past their derived TTL.
    pub expired_removed: usize,
    /// Files dropped because they could not be decrypted or related to an
    /// entry (corrupt, foreign key, truncated).
    pub unreadable_removed: usize,
    /// True when the migration had already run and this call was a no-op.
    pub already_migrated: bool,
}

// ---------------------------------------------------------------------------
// Public API — fetch / read
// ---------------------------------------------------------------------------

/// Fetch `source_url`, store it as an encrypted envelope under the cognia
/// cache dir, and return its [`AttachmentRef`].
///
/// A live cache entry short-circuits the network fetch and only refreshes
/// `lastAccessedAt`. An entry past its `expiresAt` is treated as a miss and
/// genuinely re-fetched — the TTL is enforced here, not guessed by the caller.
pub async fn fetch_attachment(
    adapter_id: String,
    remote_ref: String,
    source_url: String,
    headers: Option<HashMap<String, String>>,
    ttl_ms: Option<u64>,
) -> Result<AttachmentRef, String> {
    let cache_dir = resolve_cache_dir()?;
    fetch_attachment_into(
        &cache_dir,
        &adapter_id,
        remote_ref,
        &source_url,
        headers,
        MAX_ATTACHMENT_BYTES,
        ttl_ms,
    )
    .await
}

/// Implementation of [`fetch_attachment`] with the cache directory and byte
/// cap injected — tests point this at a tempdir with a tiny cap.
#[allow(clippy::too_many_arguments)]
async fn fetch_attachment_into(
    cache_dir: &Path,
    adapter_id: &str,
    remote_ref: String,
    source_url: &str,
    headers: Option<HashMap<String, String>>,
    max_bytes: usize,
    ttl_ms: Option<u64>,
) -> Result<AttachmentRef, String> {
    fetch_attachment_into_with_transform(
        cache_dir, adapter_id, remote_ref, source_url, headers, max_bytes, ttl_ms, Ok,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn fetch_attachment_into_with_transform<F>(
    cache_dir: &Path,
    adapter_id: &str,
    remote_ref: String,
    source_url: &str,
    headers: Option<HashMap<String, String>>,
    max_bytes: usize,
    ttl_ms: Option<u64>,
    transform: F,
) -> Result<AttachmentRef, String>
where
    F: FnOnce(Vec<u8>) -> Result<Vec<u8>, String>,
{
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("create cache dir failed: {e}"))?;

    let cache_key = compute_cache_key(adapter_id, &remote_ref);
    let enc_path = cache_dir.join(format!("{cache_key}.enc"));
    let now = now_ms();

    // Cache hit — only when the entry is readable AND still live. An expired
    // or corrupt entry is removed so the fetch below rewrites it cleanly.
    if enc_path.exists() {
        match read_meta(&enc_path, &cache_key) {
            Ok(meta) if !meta.is_expired(now) => {
                let touched = touch_meta(&enc_path, &cache_key, meta, now)?;
                return Ok(touched.into_ref(remote_ref, true));
            }
            // Expired, or unreadable (corrupt / foreign key / legacy) — drop it
            // and fall through to a real fetch.
            _ => {
                let _ = std::fs::remove_file(&enc_path);
            }
        }
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
        // cached: a cached error body would shadow the real attachment until
        // its TTL lapsed.
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

    // Encrypted Matrix media is transformed here, before the shared at-rest
    // encryption/cache write. Plain fetches pass the identity transform.
    let bytes = transform(bytes)?;

    let ttl = ttl_ms.unwrap_or(DEFAULT_TTL_MS);
    let meta = AttachmentMeta {
        cache_key: hex_to_digest(&cache_key)?,
        adapter_hash: sha256_digest(adapter_id.as_bytes()),
        size_bytes: bytes.len() as u64,
        created_at: now,
        last_accessed_at: now,
        expires_at: if ttl > 0 { now.saturating_add(ttl) } else { 0 },
    };
    write_envelope(&enc_path, &cache_key, &meta, &bytes)?;

    Ok(meta.into_ref(remote_ref, false))
}

/// Fetch encrypted Matrix media through the shared bounded downloader, verify
/// and decrypt it, then write only plaintext through the existing encrypted
/// attachment-cache boundary.
pub async fn fetch_matrix_encrypted_attachment(
    req: super::types::MatrixEncryptedMediaFetchRequest,
) -> Result<AttachmentRef, String> {
    let cache_dir = resolve_cache_dir()?;
    let file = req.file;
    fetch_attachment_into_with_transform(
        &cache_dir,
        &req.adapter_id,
        req.remote_ref,
        &req.source_url,
        req.headers,
        MAX_ATTACHMENT_BYTES,
        None,
        move |bytes| super::matrix_crypto::decrypt_attachment_bytes(bytes, file),
    )
    .await
}

/// Read a previously cached attachment's plaintext bytes as base64.
///
/// Returns `Ok(None)` when the attachment is not cached, has expired, or its
/// plaintext exceeds `max_bytes` — the renderer uses the cap to skip inlining
/// large media. A successful read refreshes `lastAccessedAt`, which is what
/// makes the LRU in [`enforce_cache_budget`] a real LRU.
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
    let now = now_ms();
    let meta = match read_meta(&enc_path, &cache_key) {
        Ok(meta) => meta,
        // Corrupt or foreign entry — drop it rather than serving it.
        Err(_) => {
            let _ = std::fs::remove_file(&enc_path);
            return Ok(None);
        }
    };
    if meta.is_expired(now) {
        let _ = std::fs::remove_file(&enc_path);
        return Ok(None);
    }
    // Cheap rejection before decrypting a payload the caller will not inline.
    if meta.size_bytes > max_bytes {
        return Ok(None);
    }
    let plaintext = read_payload(&enc_path, &cache_key)?;
    touch_meta(&enc_path, &cache_key, meta, now)?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(plaintext),
    ))
}

// ---------------------------------------------------------------------------
// Public API — listing, prune, evict, budget
// ---------------------------------------------------------------------------

/// List every readable envelope in the cache. Unreadable files are skipped
/// (they are reaped by [`delete_expired`] / [`migrate_legacy_cache`]).
pub fn list_attachments() -> Result<Vec<AttachmentEntry>, String> {
    let cache_dir = resolve_cache_dir()?;
    list_attachments_in(&cache_dir)
}

fn list_attachments_in(cache_dir: &Path) -> Result<Vec<AttachmentEntry>, String> {
    let mut out = Vec::new();
    if !cache_dir.exists() {
        return Ok(out);
    }
    let entries =
        std::fs::read_dir(cache_dir).map_err(|e| format!("read cache dir failed: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(cache_key) = enc_cache_key(&path) else {
            continue;
        };
        let Ok(meta) = read_meta(&path, &cache_key) else {
            continue;
        };
        let disk_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push(AttachmentEntry {
            cache_key,
            size_bytes: meta.size_bytes,
            created_at: meta.created_at,
            last_accessed_at: meta.last_accessed_at,
            expires_at: meta.expires_at_opt(),
            disk_bytes,
        });
    }
    Ok(out)
}

/// Delete the given cache keys. Missing files count as deleted — the caller's
/// intent (the bytes must be gone) is satisfied either way, which keeps the
/// renderer's cleanup ledger from retrying forever on an already-clean entry.
pub fn delete_attachments(cache_keys: Vec<String>) -> Result<AttachmentCleanupReport, String> {
    let cache_dir = resolve_cache_dir()?;
    Ok(delete_attachments_in(&cache_dir, &cache_keys))
}

fn delete_attachments_in(cache_dir: &Path, cache_keys: &[String]) -> AttachmentCleanupReport {
    let mut report = AttachmentCleanupReport::default();
    for cache_key in cache_keys {
        if !is_valid_cache_key(cache_key) {
            report.failed.push(AttachmentCleanupFailure {
                cache_key: cache_key.clone(),
                error: "invalid cache key".to_string(),
            });
            continue;
        }
        let path = cache_dir.join(format!("{cache_key}.enc"));
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(&path) {
            Ok(()) => {
                report.deleted.push(cache_key.clone());
                report.freed_bytes = report.freed_bytes.saturating_add(size);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                report.deleted.push(cache_key.clone());
            }
            Err(e) => report.failed.push(AttachmentCleanupFailure {
                cache_key: cache_key.clone(),
                error: e.to_string(),
            }),
        }
    }
    report
}

/// Delete every entry belonging to `adapter_id`, matched on the adapter hash
/// baked into each envelope. Entries migrated from the legacy format carry a
/// zeroed adapter hash and are left to the renderer's key-driven prune.
pub fn evict_adapter_attachments(adapter_id: &str) -> Result<AttachmentCleanupReport, String> {
    let cache_dir = resolve_cache_dir()?;
    Ok(evict_adapter_attachments_in(&cache_dir, adapter_id))
}

fn evict_adapter_attachments_in(cache_dir: &Path, adapter_id: &str) -> AttachmentCleanupReport {
    let wanted = sha256_digest(adapter_id.as_bytes());
    let mut keys = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(cache_key) = enc_cache_key(&path) else {
                continue;
            };
            if let Ok(meta) = read_meta(&path, &cache_key) {
                if meta.adapter_hash == wanted {
                    keys.push(cache_key);
                }
            }
        }
    }
    delete_attachments_in(cache_dir, &keys)
}

/// Remove every entry whose `expiresAt` has passed, plus any file that no
/// longer parses as a current envelope.
pub fn delete_expired() -> Result<AttachmentCleanupReport, String> {
    let cache_dir = resolve_cache_dir()?;
    Ok(delete_expired_in(&cache_dir, now_ms()))
}

fn delete_expired_in(cache_dir: &Path, now: u64) -> AttachmentCleanupReport {
    let mut keys = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(cache_key) = enc_cache_key(&path) else {
                continue;
            };
            match read_meta(&path, &cache_key) {
                Ok(meta) if meta.is_expired(now) => keys.push(cache_key),
                Err(_) => keys.push(cache_key),
                _ => {}
            }
        }
    }
    delete_attachments_in(cache_dir, &keys)
}

/// Enforce a total-bytes ceiling over the cache, evicting genuinely
/// least-recently-*used* entries first. Expired entries go first regardless of
/// budget. Returns what was removed.
///
/// The budget is measured against real decrypted sizes read out of the
/// envelopes, so it cannot be defeated by a caller that omitted a size hint.
pub fn enforce_cache_budget(max_total_bytes: u64) -> Result<AttachmentCleanupReport, String> {
    let cache_dir = resolve_cache_dir()?;
    enforce_cache_budget_in(&cache_dir, max_total_bytes, now_ms())
}

fn enforce_cache_budget_in(
    cache_dir: &Path,
    max_total_bytes: u64,
    now: u64,
) -> Result<AttachmentCleanupReport, String> {
    let mut report = delete_expired_in(cache_dir, now);

    let mut entries = list_attachments_in(cache_dir)?;
    let mut total: u64 = entries.iter().map(|e| e.size_bytes).sum();
    if total <= max_total_bytes {
        return Ok(report);
    }

    // Oldest access first — the entry least recently used is evicted first.
    entries.sort_by_key(|e| (e.last_accessed_at, e.created_at));
    let mut victims = Vec::new();
    for entry in entries {
        if total <= max_total_bytes {
            break;
        }
        total = total.saturating_sub(entry.size_bytes);
        victims.push(entry.cache_key);
    }
    let evicted = delete_attachments_in(cache_dir, &victims);
    report.deleted.extend(evicted.deleted);
    report.freed_bytes = report.freed_bytes.saturating_add(evicted.freed_bytes);
    report.failed.extend(evicted.failed);
    Ok(report)
}

// ---------------------------------------------------------------------------
// Public API — one-time legacy migration
// ---------------------------------------------------------------------------

/// Convert a pre-envelope cache directory to the current format, exactly once.
///
/// Steps, in order:
///   1. Delete every plaintext (non-`.enc`) file an older build left behind.
///   2. For each legacy `.enc` file (raw `nonce || ciphertext`, no magic):
///      derive `createdAt` from the file's mtime, drop it if that puts it past
///      the default TTL, drop it if it cannot be decrypted, otherwise rewrite
///      it atomically as a current envelope with a zeroed adapter hash.
///   3. Write the completion marker so subsequent boots skip all of the above.
///
/// Called once at connector bootstrap.
pub fn migrate_legacy_cache() -> Result<LegacyMigrationReport, String> {
    let cache_dir = resolve_cache_dir()?;
    migrate_legacy_cache_in(&cache_dir, now_ms())
}

fn migrate_legacy_cache_in(cache_dir: &Path, now: u64) -> Result<LegacyMigrationReport, String> {
    let mut report = LegacyMigrationReport::default();
    if !cache_dir.exists() {
        return Ok(report);
    }
    let marker = cache_dir.join(MIGRATION_MARKER);
    if marker.exists() {
        report.already_migrated = true;
        return Ok(report);
    }

    let entries =
        std::fs::read_dir(cache_dir).map_err(|e| format!("read cache dir failed: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.file_name().is_some_and(|n| n == MIGRATION_MARKER) {
            continue;
        }
        let is_enc = path.extension().is_some_and(|ext| ext == "enc");
        if !is_enc {
            // Plaintext left by an older build — always reap.
            if std::fs::remove_file(&path).is_ok() {
                report.plaintext_removed += 1;
            }
            continue;
        }
        let Some(cache_key) = enc_cache_key(&path) else {
            // `.enc` file whose stem is not a cache key — cannot be related to
            // any entry.
            if std::fs::remove_file(&path).is_ok() {
                report.unreadable_removed += 1;
            }
            continue;
        };
        // Already current — nothing to do.
        if read_meta(&path, &cache_key).is_ok() {
            continue;
        }
        let created_at = file_mtime_ms(&path).unwrap_or(now);
        let expires_at = created_at.saturating_add(DEFAULT_TTL_MS);
        if expires_at <= now {
            if std::fs::remove_file(&path).is_ok() {
                report.expired_removed += 1;
            }
            continue;
        }
        match decrypt_legacy_file(&path) {
            Ok(plaintext) => {
                let meta = AttachmentMeta {
                    cache_key: hex_to_digest(&cache_key)?,
                    // Legacy files carry no adapter provenance; a zeroed hash
                    // marks them "unknown adapter" so hash-driven eviction
                    // skips them and key-driven prune still reaches them.
                    adapter_hash: [0u8; 32],
                    size_bytes: plaintext.len() as u64,
                    created_at,
                    last_accessed_at: created_at,
                    expires_at,
                };
                write_envelope(&path, &cache_key, &meta, &plaintext)?;
                report.converted += 1;
            }
            Err(_) => {
                if std::fs::remove_file(&path).is_ok() {
                    report.unreadable_removed += 1;
                }
            }
        }
    }

    std::fs::write(&marker, b"1").map_err(|e| format!("write migration marker failed: {e}"))?;
    Ok(report)
}

// ---------------------------------------------------------------------------
// Envelope internals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AttachmentMeta {
    cache_key: [u8; 32],
    adapter_hash: [u8; 32],
    size_bytes: u64,
    created_at: u64,
    last_accessed_at: u64,
    expires_at: u64,
}

impl AttachmentMeta {
    fn is_expired(&self, now: u64) -> bool {
        self.expires_at != 0 && self.expires_at <= now
    }

    fn expires_at_opt(&self) -> Option<u64> {
        (self.expires_at != 0).then_some(self.expires_at)
    }

    fn into_ref(self, remote_ref: String, cached: bool) -> AttachmentRef {
        AttachmentRef {
            cache_key: hex::encode(self.cache_key),
            remote_ref,
            size_bytes: self.size_bytes,
            created_at: self.created_at,
            last_accessed_at: self.last_accessed_at,
            expires_at: self.expires_at_opt(),
            cached,
        }
    }

    fn encode(&self) -> [u8; META_PLAIN_LEN] {
        let mut buf = [0u8; META_PLAIN_LEN];
        buf[0..32].copy_from_slice(&self.cache_key);
        buf[32..64].copy_from_slice(&self.adapter_hash);
        buf[64..72].copy_from_slice(&self.size_bytes.to_le_bytes());
        buf[72..80].copy_from_slice(&self.created_at.to_le_bytes());
        buf[80..88].copy_from_slice(&self.last_accessed_at.to_le_bytes());
        buf[88..96].copy_from_slice(&self.expires_at.to_le_bytes());
        buf
    }

    fn decode(buf: &[u8]) -> Result<Self, String> {
        if buf.len() != META_PLAIN_LEN {
            return Err("metadata record has the wrong length".to_string());
        }
        let mut cache_key = [0u8; 32];
        cache_key.copy_from_slice(&buf[0..32]);
        let mut adapter_hash = [0u8; 32];
        adapter_hash.copy_from_slice(&buf[32..64]);
        Ok(Self {
            cache_key,
            adapter_hash,
            size_bytes: u64_le(&buf[64..72]),
            created_at: u64_le(&buf[72..80]),
            last_accessed_at: u64_le(&buf[80..88]),
            expires_at: u64_le(&buf[88..96]),
        })
    }
}

fn u64_le(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(bytes);
    u64::from_le_bytes(buf)
}

/// Write a complete envelope atomically (temp file + rename) so a crash mid
/// write can never leave a half-readable cache entry.
fn write_envelope(
    path: &Path,
    cache_key_hex: &str,
    meta: &AttachmentMeta,
    payload: &[u8],
) -> Result<(), String> {
    let aad = cache_key_hex.as_bytes();
    let (meta_nonce, meta_ct) = encrypt_with_aad(&meta.encode(), aad)?;
    let (payload_nonce, payload_ct) = encrypt_with_aad(payload, aad)?;

    let mut out = Vec::with_capacity(PAYLOAD_OFFSET + payload_ct.len());
    out.extend_from_slice(MAGIC);
    out.push(ENVELOPE_VERSION);
    out.extend_from_slice(&meta_nonce);
    out.extend_from_slice(&meta_ct);
    out.extend_from_slice(&payload_nonce);
    out.extend_from_slice(&payload_ct);

    let tmp = path.with_extension("enc.tmp");
    std::fs::write(&tmp, &out).map_err(|e| format!("cache write failed: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cache commit failed: {e}")
    })
}

/// Read and authenticate only the metadata record — never touches the payload,
/// so listings and budget sweeps stay cheap on large attachments.
fn read_meta(path: &Path, cache_key_hex: &str) -> Result<AttachmentMeta, String> {
    let mut header = [0u8; PAYLOAD_OFFSET];
    read_exact_at(path, 0, &mut header)?;
    if &header[0..MAGIC.len()] != MAGIC {
        return Err("not a current attachment envelope".to_string());
    }
    if header[MAGIC.len()] != ENVELOPE_VERSION {
        return Err(format!(
            "unsupported envelope version {}",
            header[MAGIC.len()]
        ));
    }
    let meta_start = META_OFFSET as usize;
    let nonce = &header[meta_start..meta_start + NONCE_LEN];
    let ct = &header[meta_start + NONCE_LEN..meta_start + META_REGION_LEN];
    let plain = decrypt_with_aad(nonce, ct, cache_key_hex.as_bytes())?;
    let meta = AttachmentMeta::decode(&plain)?;
    // Bind the record to the file it was read from: a renamed / swapped file
    // fails here even though its own AEAD tag is valid.
    if hex::encode(meta.cache_key) != cache_key_hex {
        return Err("envelope cache key does not match its filename".to_string());
    }
    Ok(meta)
}

/// Decrypt the payload region.
fn read_payload(path: &Path, cache_key_hex: &str) -> Result<Vec<u8>, String> {
    let data = std::fs::read(path).map_err(|e| format!("read enc file failed: {e}"))?;
    if data.len() < PAYLOAD_OFFSET + NONCE_LEN {
        return Err("attachment envelope is truncated".to_string());
    }
    let nonce = &data[PAYLOAD_OFFSET..PAYLOAD_OFFSET + NONCE_LEN];
    let ct = &data[PAYLOAD_OFFSET + NONCE_LEN..];
    decrypt_with_aad(nonce, ct, cache_key_hex.as_bytes())
}

/// Refresh `lastAccessedAt` by rewriting only the fixed-width metadata region.
fn touch_meta(
    path: &Path,
    cache_key_hex: &str,
    mut meta: AttachmentMeta,
    now: u64,
) -> Result<AttachmentMeta, String> {
    meta.last_accessed_at = now;
    let (nonce, ct) = encrypt_with_aad(&meta.encode(), cache_key_hex.as_bytes())?;
    let mut region = Vec::with_capacity(META_REGION_LEN);
    region.extend_from_slice(&nonce);
    region.extend_from_slice(&ct);
    debug_assert_eq!(region.len(), META_REGION_LEN);

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("open cache file failed: {e}"))?;
    file.seek(SeekFrom::Start(META_OFFSET))
        .map_err(|e| format!("seek cache file failed: {e}"))?;
    file.write_all(&region)
        .map_err(|e| format!("touch cache file failed: {e}"))?;
    Ok(meta)
}

fn read_exact_at(path: &Path, offset: u64, buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("open cache file failed: {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek cache file failed: {e}"))?;
    file.read_exact(buf)
        .map_err(|e| format!("attachment envelope is truncated: {e}"))
}

/// Cache key for a `<64 hex>.enc` path, or `None` for anything else.
fn enc_cache_key(path: &Path) -> Option<String> {
    if !path.is_file() || path.extension()? != "enc" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?.to_string();
    is_valid_cache_key(&stem).then_some(stem)
}

fn is_valid_cache_key(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn hex_to_digest(hex_key: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_key).map_err(|e| format!("invalid cache key: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| "cache key must be 32 bytes".to_string())
}

fn sha256_digest(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Crypto helpers
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

/// Process-wide memo of the cache master key.
///
/// Two reasons this is not resolved per call. Correctness: first use
/// auto-generates the key, so two threads racing a cold keyring would each
/// generate one, store both, and leave every file written by the loser
/// undecryptable. Cost: `cipher()` runs for every metadata read, so a cache
/// listing would otherwise perform one keyring round-trip per file.
static MASTER_KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();

fn master_key() -> Result<[u8; 32], String> {
    if let Some(key) = MASTER_KEY.get() {
        return Ok(*key);
    }
    // `OnceLock::get_or_init` cannot host a fallible initializer, so the
    // first-resolution path is serialized explicitly.
    static INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = INIT_LOCK
        .lock()
        .map_err(|_| "master key lock poisoned".to_string())?;
    if let Some(key) = MASTER_KEY.get() {
        return Ok(*key);
    }
    let key = load_or_create_master_key()?;
    let _ = MASTER_KEY.set(key);
    Ok(key)
}

fn load_or_create_master_key() -> Result<[u8; 32], String> {
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
            rand::fill(&mut key);
            super::keyring::set("", ACCOUNT, &hex::encode(key))?;
            Ok(key)
        }
    }
}

fn cipher() -> Result<Aes256Gcm, String> {
    let key_bytes = master_key()?;
    let key = Key::<Aes256Gcm>::from(key_bytes);
    Ok(Aes256Gcm::new(&key))
}

/// Encrypt with the cache key bound in as additional authenticated data.
fn encrypt_with_aad(data: &[u8], aad: &[u8]) -> Result<([u8; NONCE_LEN], Vec<u8>), String> {
    let cipher = cipher()?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: data, aad })
        .map_err(|e| format!("encrypt failed: {e}"))?;
    Ok((nonce_bytes, ciphertext))
}

fn decrypt_with_aad(nonce_bytes: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = cipher()?;
    let nonce = Nonce::try_from(nonce_bytes)
        .map_err(|_| "encrypted record nonce has invalid length".to_string())?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|e| format!("decrypt failed: {e}"))
}

/// Decrypt a pre-envelope file: `nonce(12) || ciphertext`, no AAD. Only the
/// one-time migration calls this.
fn decrypt_legacy_file(path: &Path) -> Result<Vec<u8>, String> {
    let data = std::fs::read(path).map_err(|e| format!("read enc file failed: {e}"))?;
    if data.len() < NONCE_LEN {
        return Err("legacy encrypted file too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let cipher = cipher()?;
    let nonce = Nonce::try_from(nonce_bytes)
        .map_err(|_| "legacy file nonce has invalid length".to_string())?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))
}

/// Proxy-aware HTTP client for attachment fetches — honours the user's proxy
/// config (including the bypass list) and applies [`FETCH_TIMEOUT`]. Mirrors
/// `media_upload::build_client`.
fn build_client(target_url: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder().timeout(FETCH_TIMEOUT);
    let (builder, _) = proxy_config::apply_reqwest_policy(builder, target_url)
        .map_err(|error| error.to_string())?;
    builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// The proxy policy is a process-global that `build_client` requires.
    /// Every networked test initializes it through this `Once` so the suite
    /// does not depend on which test happens to run first.
    fn init_proxy() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        });
    }

    /// Encrypt the pre-envelope way (`nonce || ciphertext`, no AAD) so the
    /// migration tests can build genuine legacy files.
    fn legacy_encrypt(data: &[u8]) -> Vec<u8> {
        let cipher = cipher().unwrap();
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::fill(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = cipher.encrypt(&nonce, data).unwrap();
        let mut out = nonce_bytes.to_vec();
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Convenience wrapper: fetch into `dir` with the default cap and TTL.
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
            None,
        )
        .await
    }

    fn write_test_envelope(
        dir: &Path,
        adapter_id: &str,
        remote_ref: &str,
        payload: &[u8],
        created_at: u64,
        last_accessed_at: u64,
        expires_at: u64,
    ) -> String {
        let cache_key = compute_cache_key(adapter_id, remote_ref);
        let meta = AttachmentMeta {
            cache_key: hex_to_digest(&cache_key).unwrap(),
            adapter_hash: sha256_digest(adapter_id.as_bytes()),
            size_bytes: payload.len() as u64,
            created_at,
            last_accessed_at,
            expires_at,
        };
        write_envelope(
            &dir.join(format!("{cache_key}.enc")),
            &cache_key,
            &meta,
            payload,
        )
        .unwrap();
        cache_key
    }

    // --- key + envelope primitives -----------------------------------------

    #[test]
    fn cache_key_is_stable_hex() {
        let k1 = compute_cache_key("tg-personal", "file/BQACAgIA123");
        let k2 = compute_cache_key("tg-personal", "file/BQACAgIA123");
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 64);
        assert!(k1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Cross-language fixture, asserted identically by `computeCacheKey` in
    /// `lib/connectors/attachment-fetcher.test.ts`. The renderer derives keys
    /// independently to delete and reconcile blobs, so the two derivations
    /// have to agree byte for byte.
    #[test]
    fn cache_key_matches_the_renderer_derivation() {
        assert_eq!(
            compute_cache_key("adp_1", "rref"),
            "e89e5b68b3255334b1eb6dd2ab877cf27823a5b504c9831ae379d76b82e113b6"
        );
    }

    #[test]
    fn envelope_round_trips_metadata_and_payload() {
        let dir = tempfile::tempdir().unwrap();
        let cache_key =
            write_test_envelope(dir.path(), "a1", "r1", b"hello envelope", 100, 200, 300);
        let path = dir.path().join(format!("{cache_key}.enc"));

        let meta = read_meta(&path, &cache_key).unwrap();
        assert_eq!(meta.size_bytes, 14);
        assert_eq!(meta.created_at, 100);
        assert_eq!(meta.last_accessed_at, 200);
        assert_eq!(meta.expires_at, 300);
        assert_eq!(meta.adapter_hash, sha256_digest(b"a1"));
        assert_eq!(read_payload(&path, &cache_key).unwrap(), b"hello envelope");
    }

    #[test]
    fn envelope_is_bound_to_its_filename() {
        let dir = tempfile::tempdir().unwrap();
        let cache_key = write_test_envelope(dir.path(), "a1", "r1", b"secret", 1, 1, 0);
        let other_key = compute_cache_key("a2", "r2");

        // Renaming one entry over another's key must not authenticate: the AAD
        // and the embedded cache key both disagree with the new filename.
        let renamed = dir.path().join(format!("{other_key}.enc"));
        std::fs::rename(dir.path().join(format!("{cache_key}.enc")), &renamed).unwrap();
        assert!(read_meta(&renamed, &other_key).is_err());
    }

    #[test]
    fn touch_meta_updates_access_time_without_rewriting_payload() {
        let dir = tempfile::tempdir().unwrap();
        let payload = vec![7u8; 4096];
        let cache_key = write_test_envelope(dir.path(), "a1", "r1", &payload, 100, 100, 0);
        let path = dir.path().join(format!("{cache_key}.enc"));
        let before_len = std::fs::metadata(&path).unwrap().len();

        let meta = read_meta(&path, &cache_key).unwrap();
        touch_meta(&path, &cache_key, meta, 999).unwrap();

        assert_eq!(std::fs::metadata(&path).unwrap().len(), before_len);
        assert_eq!(read_meta(&path, &cache_key).unwrap().last_accessed_at, 999);
        assert_eq!(read_payload(&path, &cache_key).unwrap(), payload);
    }

    // --- fetch path ---------------------------------------------------------

    #[tokio::test]
    async fn fetch_caches_and_hits_on_second_call() {
        init_proxy();
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
        assert!(!ref1.cached);
        // The real byte count reaches the caller — no placeholder zero.
        assert_eq!(ref1.size_bytes, 4);
        assert!(ref1.expires_at.is_some());

        let ref2 = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert!(ref2.cached);
        assert_eq!(ref2.cache_key, ref1.cache_key);
        assert_eq!(ref2.size_bytes, 4);

        mock_server.verify().await;
    }

    #[tokio::test]
    async fn fetch_never_writes_plaintext_to_disk() {
        init_proxy();
        let mock_server = MockServer::start().await;
        let secret = b"top secret attachment body";
        Mock::given(method("GET"))
            .and(path("/secret.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(secret.to_vec()))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-secret-{}", uuid::Uuid::new_v4());
        let url = format!("{}/secret.bin", mock_server.uri());
        fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        // …and again, to cover the cache-hit path that used to re-materialize
        // a decrypted copy.
        fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();

        for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
            let path = entry.path();
            assert_eq!(
                path.extension().and_then(|e| e.to_str()),
                Some("enc"),
                "only .enc envelopes may exist, found {path:?}"
            );
            let raw = std::fs::read(&path).unwrap();
            assert!(
                !raw.windows(secret.len()).any(|w| w == secret),
                "plaintext leaked into {path:?}"
            );
        }
    }

    #[tokio::test]
    async fn expired_entry_is_refetched_from_the_network() {
        init_proxy();
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ttl.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![9u8, 9]))
            .expect(1) // The expired entry must cause exactly one real fetch.
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-ttl-{}", uuid::Uuid::new_v4());
        // Seed an entry that expired an hour ago.
        let stale = now_ms() - 3_600_000;
        write_test_envelope(
            dir.path(),
            "test-adapter",
            &unique_ref,
            b"stale bytes",
            stale,
            stale,
            stale + 1,
        );

        let url = format!("{}/ttl.png", mock_server.uri());
        let fetched = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert!(
            !fetched.cached,
            "expired entry must not be served from cache"
        );
        assert_eq!(fetched.size_bytes, 2);
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn cache_hit_refreshes_last_accessed_at() {
        init_proxy();
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/lru.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![1u8]))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-lru-{}", uuid::Uuid::new_v4());
        let old = now_ms() - 60_000;
        let cache_key = write_test_envelope(
            dir.path(),
            "test-adapter",
            &unique_ref,
            b"x",
            old,
            old,
            now_ms() + 600_000,
        );

        let url = format!("{}/lru.png", mock_server.uri());
        let hit = fetch_into(dir.path(), &unique_ref, &url, None)
            .await
            .unwrap();
        assert!(hit.cached);
        assert!(
            hit.last_accessed_at > old,
            "cache hit must refresh lastAccessedAt"
        );
        let path = dir.path().join(format!("{cache_key}.enc"));
        assert!(read_meta(&path, &cache_key).unwrap().last_accessed_at > old);
    }

    #[tokio::test]
    async fn fetch_rejects_non_2xx_and_does_not_cache_error_body() {
        init_proxy();
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

        let cache_key = compute_cache_key("test-adapter", &unique_ref);
        assert!(!dir.path().join(format!("{cache_key}.enc")).exists());
        assert!(!dir.path().join(&cache_key).exists());
    }

    #[tokio::test]
    async fn fetch_rejects_body_exceeding_cap_and_caches_nothing() {
        init_proxy();
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0u8; 64]))
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let unique_ref = format!("test-big-{}", uuid::Uuid::new_v4());
        let url = format!("{}/big.bin", mock_server.uri());

        let err = fetch_attachment_into(
            dir.path(),
            "test-adapter",
            unique_ref.clone(),
            &url,
            None,
            16,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("cap"), "got: {err}");

        let cache_key = compute_cache_key("test-adapter", &unique_ref);
        assert!(!dir.path().join(format!("{cache_key}.enc")).exists());
    }

    #[tokio::test]
    async fn fetch_sends_optional_headers() {
        init_proxy();
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

    #[tokio::test]
    async fn matrix_encrypted_fetch_decrypts_before_at_rest_cache_encryption() {
        init_proxy();
        let (encrypted, mut file) =
            super::super::matrix_crypto::encrypt_attachment_bytes(b"matrix secret".to_vec())
                .unwrap();
        file.as_object_mut().unwrap().insert(
            "url".to_string(),
            serde_json::Value::String("mxc://example.org/encrypted".to_string()),
        );
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/encrypted"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(encrypted))
            .mount(&mock_server)
            .await;
        let dir = tempfile::tempdir().unwrap();

        let result = fetch_attachment_into_with_transform(
            dir.path(),
            "mx-1",
            "mxc://example.org/encrypted".to_string(),
            &format!("{}/encrypted", mock_server.uri()),
            None,
            MAX_ATTACHMENT_BYTES,
            None,
            move |bytes| super::super::matrix_crypto::decrypt_attachment_bytes(bytes, file),
        )
        .await
        .unwrap();

        // Only the decrypted-then-re-encrypted envelope lands on disk.
        assert_eq!(result.size_bytes, b"matrix secret".len() as u64);
        let stored =
            read_attachment_base64_from(dir.path(), "mx-1", "mxc://example.org/encrypted", 1024)
                .unwrap()
                .unwrap();
        use base64::Engine as _;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(stored)
                .unwrap(),
            b"matrix secret"
        );
    }

    // --- read path ----------------------------------------------------------

    #[tokio::test]
    async fn read_attachment_base64_round_trips_and_caps_size() {
        init_proxy();
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

        assert_eq!(
            read_attachment_base64_from(dir.path(), "test-adapter", "never-fetched", 1024).unwrap(),
            None
        );
        let b64 = read_attachment_base64_from(dir.path(), "test-adapter", &unique_ref, 1024)
            .unwrap()
            .expect("cached attachment must be readable");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
            vec![5u8, 6, 7, 8]
        );
        assert_eq!(
            read_attachment_base64_from(dir.path(), "test-adapter", &unique_ref, 3).unwrap(),
            None
        );
    }

    #[test]
    fn read_drops_and_refuses_an_expired_entry() {
        let dir = tempfile::tempdir().unwrap();
        let stale = now_ms() - 10_000;
        let cache_key =
            write_test_envelope(dir.path(), "a1", "r1", b"stale", stale, stale, stale + 1);

        assert_eq!(
            read_attachment_base64_from(dir.path(), "a1", "r1", 1024).unwrap(),
            None
        );
        assert!(
            !dir.path().join(format!("{cache_key}.enc")).exists(),
            "an expired entry must be reaped on read"
        );
    }

    // --- prune / evict / budget --------------------------------------------

    #[test]
    fn delete_attachments_reports_missing_as_deleted_and_rejects_bad_keys() {
        let dir = tempfile::tempdir().unwrap();
        let key = write_test_envelope(dir.path(), "a1", "r1", b"payload", 1, 1, 0);

        let report = delete_attachments_in(
            dir.path(),
            &[
                key.clone(),
                compute_cache_key("a1", "never-written"),
                "../../etc/passwd".to_string(),
            ],
        );
        assert!(report.deleted.contains(&key));
        assert_eq!(report.deleted.len(), 2, "absent files count as deleted");
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].error, "invalid cache key");
        assert!(report.freed_bytes > 0);
        assert!(!dir.path().join(format!("{key}.enc")).exists());
    }

    #[test]
    fn evict_adapter_attachments_only_removes_that_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let mine = write_test_envelope(dir.path(), "adapter-a", "r1", b"a", 1, 1, 0);
        let theirs = write_test_envelope(dir.path(), "adapter-b", "r1", b"b", 1, 1, 0);

        let report = evict_adapter_attachments_in(dir.path(), "adapter-a");
        assert_eq!(report.deleted, vec![mine.clone()]);
        assert!(!dir.path().join(format!("{mine}.enc")).exists());
        assert!(dir.path().join(format!("{theirs}.enc")).exists());
    }

    #[test]
    fn delete_expired_removes_lapsed_and_corrupt_entries_only() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_000_000u64;
        let live = write_test_envelope(dir.path(), "a", "live", b"x", 1, 1, now + 10_000);
        let never = write_test_envelope(dir.path(), "a", "never", b"x", 1, 1, 0);
        let lapsed = write_test_envelope(dir.path(), "a", "lapsed", b"x", 1, 1, now - 1);
        let corrupt = compute_cache_key("a", "corrupt");
        std::fs::write(dir.path().join(format!("{corrupt}.enc")), b"garbage").unwrap();

        let report = delete_expired_in(dir.path(), now);
        assert!(report.deleted.contains(&lapsed));
        assert!(report.deleted.contains(&corrupt));
        assert!(dir.path().join(format!("{live}.enc")).exists());
        assert!(dir.path().join(format!("{never}.enc")).exists());
    }

    #[test]
    fn budget_evicts_least_recently_used_first_using_real_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let now = 10_000_000u64;
        // 1 KiB each. Access times ascending: "old" is the least recent.
        let old = write_test_envelope(dir.path(), "a", "old", &vec![1u8; 1024], 1, 100, 0);
        let mid = write_test_envelope(dir.path(), "a", "mid", &vec![2u8; 1024], 1, 200, 0);
        let new = write_test_envelope(dir.path(), "a", "new", &vec![3u8; 1024], 1, 300, 0);

        // Budget fits two of the three entries.
        let report = enforce_cache_budget_in(dir.path(), 2048, now).unwrap();
        assert_eq!(report.deleted, vec![old.clone()]);
        assert!(!dir.path().join(format!("{old}.enc")).exists());
        assert!(dir.path().join(format!("{mid}.enc")).exists());
        assert!(dir.path().join(format!("{new}.enc")).exists());
    }

    #[test]
    fn budget_under_cap_evicts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let key = write_test_envelope(dir.path(), "a", "r", &vec![1u8; 512], 1, 1, 0);
        let report = enforce_cache_budget_in(dir.path(), 1_000_000, 10_000).unwrap();
        assert!(report.deleted.is_empty());
        assert!(dir.path().join(format!("{key}.enc")).exists());
    }

    #[test]
    fn listing_skips_unreadable_files_and_reports_real_sizes() {
        let dir = tempfile::tempdir().unwrap();
        write_test_envelope(dir.path(), "a", "r1", &vec![0u8; 300], 5, 6, 7);
        std::fs::write(dir.path().join("not-a-cache-key.enc"), b"junk").unwrap();
        std::fs::write(dir.path().join("plain-file"), b"junk").unwrap();

        let entries = list_attachments_in(dir.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size_bytes, 300);
        assert_eq!(entries[0].created_at, 5);
        assert_eq!(entries[0].last_accessed_at, 6);
        assert_eq!(entries[0].expires_at, Some(7));
        assert!(entries[0].disk_bytes > entries[0].size_bytes);
    }

    // --- one-time legacy migration -----------------------------------------

    #[test]
    fn migration_reaps_plaintext_converts_legacy_and_marks_completion() {
        let dir = tempfile::tempdir().unwrap();
        let now = now_ms();

        // Plaintext left by an older build.
        std::fs::write(dir.path().join("aabbcc"), b"raw plaintext").unwrap();
        // A genuine legacy ciphertext for a real cache key.
        let legacy_key = compute_cache_key("a1", "legacy-ref");
        std::fs::write(
            dir.path().join(format!("{legacy_key}.enc")),
            legacy_encrypt(b"legacy payload"),
        )
        .unwrap();
        // A `.enc` file that is not a cache key at all.
        std::fs::write(dir.path().join("garbage.enc"), b"nope").unwrap();
        // A current envelope that must be left untouched.
        let current = write_test_envelope(dir.path(), "a2", "r2", b"current", 1, 2, 0);

        let report = migrate_legacy_cache_in(dir.path(), now).unwrap();
        assert!(!report.already_migrated);
        assert_eq!(report.plaintext_removed, 1);
        assert_eq!(report.converted, 1);
        assert_eq!(report.unreadable_removed, 1);

        assert!(!dir.path().join("aabbcc").exists());
        assert!(!dir.path().join("garbage.enc").exists());
        assert!(dir.path().join(format!("{current}.enc")).exists());

        // The converted entry is now readable through the normal path.
        let path = dir.path().join(format!("{legacy_key}.enc"));
        let meta = read_meta(&path, &legacy_key).unwrap();
        assert_eq!(meta.size_bytes, b"legacy payload".len() as u64);
        assert_eq!(
            meta.adapter_hash, [0u8; 32],
            "legacy entries carry no adapter provenance"
        );
        assert_eq!(read_payload(&path, &legacy_key).unwrap(), b"legacy payload");

        // Marker written; a second run is a no-op.
        let again = migrate_legacy_cache_in(dir.path(), now).unwrap();
        assert!(again.already_migrated);
        assert_eq!(again.converted, 0);
    }

    #[test]
    fn migration_drops_legacy_files_past_their_derived_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_key = compute_cache_key("a1", "old-ref");
        let path = dir.path().join(format!("{legacy_key}.enc"));
        std::fs::write(&path, legacy_encrypt(b"ancient")).unwrap();

        // The file's mtime is "now", so a clock far past mtime + TTL expires it.
        let far_future = file_mtime_ms(&path).unwrap() + DEFAULT_TTL_MS + 1;
        let report = migrate_legacy_cache_in(dir.path(), far_future).unwrap();
        assert_eq!(report.expired_removed, 1);
        assert_eq!(report.converted, 0);
        assert!(!path.exists());
    }

    #[test]
    fn migration_drops_undecryptable_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        let key = compute_cache_key("a1", "corrupt-ref");
        let path = dir.path().join(format!("{key}.enc"));
        // Right shape, wrong key material — decryption must fail.
        let mut junk = vec![0u8; NONCE_LEN];
        junk.extend_from_slice(&[9u8; 64]);
        std::fs::write(&path, junk).unwrap();

        let report = migrate_legacy_cache_in(dir.path(), now_ms()).unwrap();
        assert_eq!(report.unreadable_removed, 1);
        assert!(!path.exists());
    }

    #[test]
    fn migration_on_missing_dir_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        let report = migrate_legacy_cache_in(&missing, now_ms()).unwrap();
        assert_eq!(report.converted, 0);
        assert!(!report.already_migrated);
    }
}
