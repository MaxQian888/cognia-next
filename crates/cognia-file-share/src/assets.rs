//! Reading Dexie-backed mounts (`/uploads`, `/artifacts`).
//!
//! Their bytes live in the WebView's or headless brain's IndexedDB, which this
//! crate cannot reach. The host injects an [`AssetReader`] that asks the
//! renderer or brain over the companion bridge (the
//! `companion://filespace-asset-request` event, answered on the session-media
//! channel), one bounded slice at a time, so a 500 MiB upload is never
//! buffered whole. Listing needs no slice: the entries arrive with
//! the mount table (pushed with `file_space_sync`, or pulled).

use std::sync::Arc;

use async_trait::async_trait;

/// Largest slice one read asks for: one share chunk, like
/// `fs_read_workspace_file_chunk`.
pub const MAX_ASSET_SLICE: usize = 4 * 1024 * 1024;

/// Reads a slice of one Dexie-backed file.
#[async_trait]
pub trait AssetReader: Send + Sync {
    /// Read up to `length` bytes of `source_id` in `mount_id` of
    /// `session_id`, starting at `offset`. A short result means the end.
    async fn read(
        &self,
        session_id: &str,
        mount_id: &str,
        source_id: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, String>;
}

/// The reader used before the host installs one: every read fails with a
/// reason the client can show.
pub struct UnavailableAssetReader;

#[async_trait]
impl AssetReader for UnavailableAssetReader {
    async fn read(
        &self,
        _session_id: &str,
        _mount_id: &str,
        _source_id: &str,
        _offset: u64,
        _length: usize,
    ) -> Result<Vec<u8>, String> {
        Err("the app that holds this conversation's uploads and artifacts is not connected".into())
    }
}

/// The shared handle type.
pub type SharedAssetReader = Arc<dyn AssetReader>;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    /// An in-memory reader keyed by source id.
    #[derive(Default)]
    pub(crate) struct MemoryAssets(pub HashMap<String, Vec<u8>>);

    #[async_trait]
    impl AssetReader for MemoryAssets {
        async fn read(
            &self,
            _session_id: &str,
            _mount_id: &str,
            source_id: &str,
            offset: u64,
            length: usize,
        ) -> Result<Vec<u8>, String> {
            let bytes = self.0.get(source_id).ok_or("missing")?;
            let start = (offset as usize).min(bytes.len());
            let end = (start + length.min(MAX_ASSET_SLICE)).min(bytes.len());
            Ok(bytes[start..end].to_vec())
        }
    }

    #[tokio::test]
    async fn the_default_reader_says_why_it_cannot_read() {
        let error = UnavailableAssetReader
            .read("s", "uploads", "m", 0, 10)
            .await
            .unwrap_err();
        assert!(error.contains("not connected"));
    }

    #[tokio::test]
    async fn the_memory_reader_slices() {
        let reader = MemoryAssets(HashMap::from([("m".to_string(), b"hello".to_vec())]));
        assert_eq!(reader.read("s", "u", "m", 1, 3).await.unwrap(), b"ell");
        assert_eq!(reader.read("s", "u", "m", 9, 3).await.unwrap(), b"");
    }
}
