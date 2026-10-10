//! Encrypted file blobs carried by a share — ADR-0222 §3.
//!
//! A share's envelope may name files (a manifest inside the ciphertext). Their
//! bytes travel separately as *blobs*: each file is cut into fixed-size chunks
//! that the client encrypts with a per-file key derived from the share key, so
//! the server stores ciphertext chunks it can neither read nor attribute to a
//! name. What the server does reason about is size and shape, and those rules
//! live here so the axum server and the Cloudflare Worker enforce the same
//! limits (`share-constants.json` pins both).

/// Plaintext bytes in every chunk but the last.
pub const BLOB_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// AES-GCM tag appended to each encrypted chunk.
pub const BLOB_CHUNK_OVERHEAD_BYTES: u64 = 16;
/// Largest plaintext file one blob may carry.
pub const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;
/// Largest ciphertext total all of one share's blobs may store.
pub const MAX_SHARE_BLOB_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Most blobs (files) one share may carry.
pub const MAX_BLOBS_PER_SHARE: u64 = 200;
/// How long a read ticket stays valid after the envelope read that issued it.
pub const READ_TICKET_TTL_SECONDS: u64 = 3600;
/// Random bytes in a blob id; the wire form is unpadded base64url.
pub const BLOB_ID_BYTES: usize = 16;

/// Largest ciphertext a single uploaded chunk may be.
pub const fn max_chunk_ciphertext_bytes() -> u64 {
    BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD_BYTES
}

/// Most chunks one blob may have: `ceil(MAX_BLOB_BYTES / BLOB_CHUNK_BYTES)`.
pub const fn max_chunks_per_blob() -> u64 {
    MAX_BLOB_BYTES.div_ceil(BLOB_CHUNK_BYTES)
}

/// Length of a blob id on the wire (unpadded base64url of [`BLOB_ID_BYTES`]).
pub const fn blob_id_length() -> usize {
    (BLOB_ID_BYTES * 4).div_ceil(3)
}

/// Whether `value` is a well-formed blob id. Blob ids become path segments
/// and storage keys, so nothing but the exact base64url shape is accepted.
pub fn is_valid_blob_id(value: &str) -> bool {
    value.len() == blob_id_length()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Whether `value` is a well-formed share code that may name storage. Codes
/// are minted by the server, so anything outside its alphabet was not.
pub fn is_storage_safe_code(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Parse a chunk index from a path segment, refusing anything past the last
/// chunk a blob may have, leading zeros, and signs.
pub fn parse_chunk_index(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 1 && value.starts_with('0') {
        return None;
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let index = value.parse::<u64>().ok()?;
    (index < max_chunks_per_blob()).then_some(index)
}

/// Why a commit does not match what was uploaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitError {
    /// The declared chunk count is zero or above [`max_chunks_per_blob`].
    BadChunkCount,
    /// The uploaded chunks are not exactly `0..chunk_count`.
    MissingChunks,
    /// The uploaded bytes do not sum to the declared total.
    SizeMismatch,
    /// A chunk other than the last is not full-size, or a chunk is empty.
    BadChunkShape,
}

/// Check that the chunks uploaded for a blob are exactly what the commit
/// declares. `chunks` holds `(index, ciphertext_len)` in any order.
///
/// Every chunk but the last must be a full encrypted chunk: the client cuts
/// files at [`BLOB_CHUNK_BYTES`], so a short middle chunk means a broken or
/// hostile upload, and refusing it here keeps a reader from stitching a file
/// whose offsets do not line up.
pub fn validate_commit(
    chunk_count: u64,
    total_bytes: u64,
    chunks: &[(u64, u64)],
) -> Result<(), CommitError> {
    if chunk_count == 0 || chunk_count > max_chunks_per_blob() {
        return Err(CommitError::BadChunkCount);
    }
    if chunks.len() as u64 != chunk_count {
        return Err(CommitError::MissingChunks);
    }
    let mut sorted = chunks.to_vec();
    sorted.sort_unstable_by_key(|(index, _)| *index);
    let mut sum = 0u64;
    for (position, (index, len)) in sorted.iter().enumerate() {
        if *index != position as u64 {
            return Err(CommitError::MissingChunks);
        }
        let last = position as u64 == chunk_count - 1;
        if *len <= BLOB_CHUNK_OVERHEAD_BYTES || *len > max_chunk_ciphertext_bytes() {
            return Err(CommitError::BadChunkShape);
        }
        if !last && *len != max_chunk_ciphertext_bytes() {
            return Err(CommitError::BadChunkShape);
        }
        sum += len;
    }
    if sum != total_bytes {
        return Err(CommitError::SizeMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_consistent() {
        assert_eq!(max_chunks_per_blob(), 128);
        assert_eq!(max_chunk_ciphertext_bytes(), 4 * 1024 * 1024 + 16);
        assert_eq!(blob_id_length(), 22);
    }

    #[test]
    fn blob_ids_are_exact_base64url() {
        assert!(is_valid_blob_id("AAAAAAAAAAAAAAAAAAAA-_"));
        assert!(!is_valid_blob_id("AAAAAAAAAAAAAAAAAAAA-"));
        assert!(!is_valid_blob_id("AAAAAAAAAAAAAAAAAAAA/_"));
        assert!(!is_valid_blob_id("../AAAAAAAAAAAAAAAAAAA"));
        assert!(!is_valid_blob_id(""));
    }

    #[test]
    fn storage_safe_codes_are_alphanumeric() {
        assert!(is_storage_safe_code("Abc123XYZ789"));
        assert!(!is_storage_safe_code("abc/def"));
        assert!(!is_storage_safe_code(".."));
        assert!(!is_storage_safe_code(""));
        assert!(!is_storage_safe_code(&"a".repeat(65)));
    }

    #[test]
    fn chunk_indexes_are_canonical_and_bounded() {
        assert_eq!(parse_chunk_index("0"), Some(0));
        assert_eq!(parse_chunk_index("127"), Some(127));
        assert_eq!(parse_chunk_index("128"), None);
        assert_eq!(parse_chunk_index("01"), None);
        assert_eq!(parse_chunk_index("-1"), None);
        assert_eq!(parse_chunk_index("+1"), None);
        assert_eq!(parse_chunk_index(""), None);
        assert_eq!(parse_chunk_index("99999999999999999999999"), None);
    }

    #[test]
    fn commit_accepts_full_chunks_and_a_short_last_one() {
        let full = max_chunk_ciphertext_bytes();
        let chunks = [(1, 116), (0, full)];
        assert_eq!(validate_commit(2, full + 116, &chunks), Ok(()));
        assert_eq!(validate_commit(1, 17, &[(0, 17)]), Ok(()));
    }

    #[test]
    fn commit_refuses_gaps_wrong_totals_and_short_middles() {
        let full = max_chunk_ciphertext_bytes();
        assert_eq!(validate_commit(0, 0, &[]), Err(CommitError::BadChunkCount));
        assert_eq!(
            validate_commit(129, 0, &[]),
            Err(CommitError::BadChunkCount)
        );
        assert_eq!(
            validate_commit(2, full, &[(0, full)]),
            Err(CommitError::MissingChunks)
        );
        assert_eq!(
            validate_commit(2, full + 20, &[(0, full), (2, 20)]),
            Err(CommitError::MissingChunks)
        );
        assert_eq!(
            validate_commit(2, 40, &[(0, 20), (1, 20)]),
            Err(CommitError::BadChunkShape)
        );
        assert_eq!(
            validate_commit(1, 16, &[(0, 16)]),
            Err(CommitError::BadChunkShape)
        );
        assert_eq!(
            validate_commit(1, 99, &[(0, 20)]),
            Err(CommitError::SizeMismatch)
        );
    }
}
