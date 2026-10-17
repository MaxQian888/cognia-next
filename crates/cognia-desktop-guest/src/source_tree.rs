//! Canonical initial checkout proof, independent of Git's object hash format.
//! Hash raw content, never filtered checkout bytes. Generated top-level `.git`
//! metadata is not a source entry; callers must inspect it separately.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_SOURCE_FILES: usize = 100_000;
pub const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_SOURCE_PATH_BYTES: usize = 4096;
pub const MAX_SOURCE_METADATA_BYTES: usize = 32 * 1024 * 1024;
const DOMAIN: &[u8] = b"cognia-source-tree-v1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceTreeError {
    InvalidPath,
    DuplicatePath,
    PathConflict,
    UnsupportedMode,
    LimitExceeded,
}
impl std::fmt::Display for SourceTreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidPath => "invalid source path",
            Self::DuplicatePath => "duplicate source path",
            Self::PathConflict => "conflicting source paths",
            Self::UnsupportedMode => "unsupported source mode",
            Self::LimitExceeded => "source proof limit exceeded",
        })
    }
}
impl std::error::Error for SourceTreeError {}

/// Paths are raw relative Unix bytes. Length framing preserves non-UTF8 names
/// without lossy conversion, shell quoting, or newline-sensitive parsing.
pub fn validate_path(path: &[u8]) -> Result<(), SourceTreeError> {
    if path.is_empty()
        || path.len() > MAX_SOURCE_PATH_BYTES
        || path.contains(&0)
        || path.split(|byte| *byte == b'/').any(|part| {
            part.is_empty() || part == b"." || part == b".." || part.eq_ignore_ascii_case(b".git")
        })
    {
        return Err(SourceTreeError::InvalidPath);
    }
    Ok(())
}

/// Symlink blobs and gitlinks must fail before any guest parser is invoked.
pub fn git_executable(mode: &[u8], object_type: &[u8]) -> Result<bool, SourceTreeError> {
    match (mode, object_type) {
        (b"100644", b"blob") => Ok(false),
        (b"100755", b"blob") => Ok(true),
        _ => Err(SourceTreeError::UnsupportedMode),
    }
}

#[derive(Clone, Debug)]
pub struct SourceTreeEntry {
    pub path: Vec<u8>,
    pub executable: bool,
    pub bytes: u64,
    pub content_sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceTreeProof {
    pub source_tree_sha256: String,
    pub source_file_count: u64,
    pub source_bytes: u64,
}

#[derive(Default)]
pub struct SourceTreeBuilder {
    entries: BTreeMap<Vec<u8>, SourceTreeEntry>,
    bytes: u64,
    metadata_bytes: usize,
}

impl SourceTreeBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, entry: SourceTreeEntry) -> Result<(), SourceTreeError> {
        validate_path(&entry.path)?;
        if self.entries.contains_key(&entry.path) {
            return Err(SourceTreeError::DuplicatePath);
        }
        let bytes = self
            .bytes
            .checked_add(entry.bytes)
            .ok_or(SourceTreeError::LimitExceeded)?;
        // Account for both owned path copies and the fixed per-entry encoding.
        let metadata = self
            .metadata_bytes
            .checked_add(entry.path.len() * 2 + 45)
            .ok_or(SourceTreeError::LimitExceeded)?;
        if self.entries.len() >= MAX_SOURCE_FILES
            || bytes > MAX_SOURCE_BYTES
            || metadata > MAX_SOURCE_METADATA_BYTES
        {
            return Err(SourceTreeError::LimitExceeded);
        }
        self.bytes = bytes;
        self.metadata_bytes = metadata;
        self.entries.insert(entry.path.clone(), entry);
        Ok(())
    }

    pub fn finish(self) -> Result<SourceTreeProof, SourceTreeError> {
        let count = self.entries.len() as u64;
        let mut digest = Sha256::new();
        digest.update(DOMAIN);
        digest.update(count.to_be_bytes());
        digest.update(self.bytes.to_be_bytes());
        for entry in self.entries.values() {
            if entry.path.iter().enumerate().any(|(index, byte)| {
                *byte == b'/' && self.entries.contains_key(&entry.path[..index])
            }) {
                return Err(SourceTreeError::PathConflict);
            }
            digest.update((entry.path.len() as u32).to_be_bytes());
            digest.update(&entry.path);
            digest.update([u8::from(entry.executable)]);
            digest.update(entry.bytes.to_be_bytes());
            digest.update(entry.content_sha256);
        }
        Ok(SourceTreeProof {
            source_tree_sha256: hex::encode(digest.finalize()),
            source_file_count: count,
            source_bytes: self.bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &[u8], executable: bool, contents: &[u8]) -> SourceTreeEntry {
        SourceTreeEntry {
            path: path.to_vec(),
            executable,
            bytes: contents.len() as u64,
            content_sha256: Sha256::digest(contents).into(),
        }
    }

    fn proof(entries: Vec<SourceTreeEntry>) -> SourceTreeProof {
        let mut builder = SourceTreeBuilder::new();
        for entry in entries {
            builder.push(entry).unwrap();
        }
        builder.finish().unwrap()
    }

    #[test]
    fn canonical_digest_is_order_independent_and_binds_mode_and_contents() {
        let a = entry(b"a.txt", false, b"hello\n");
        let z = entry(b"bin/z", true, b"#!/bin/sh\n");
        let original = proof(vec![z.clone(), a.clone()]);
        assert_eq!(original, proof(vec![a.clone(), z.clone()]));
        assert_eq!(original.source_file_count, 2);
        assert_eq!(original.source_bytes, 16);
        assert_eq!(
            original.source_tree_sha256,
            "791ce32a22dfc4ea5b0aafa7c04ed8a759689fccf1853e1c2ff540cebfc5576c"
        );
        assert_ne!(
            original,
            proof(vec![a.clone(), entry(b"bin/z", false, b"#!/bin/sh\n")])
        );
        assert_ne!(original, proof(vec![entry(b"a.txt", false, b"jello\n"), z]));
    }

    #[test]
    fn raw_paths_do_not_collapse_through_utf8_or_newline_conversion() {
        assert_ne!(
            proof(vec![entry(b"\xff", false, b"x")]),
            proof(vec![entry(b"\xfe", false, b"x")])
        );
        assert_ne!(
            proof(vec![entry(b"a\nb", false, b"x")]),
            proof(vec![entry(b"a/b", false, b"x")])
        );
    }

    #[test]
    fn duplicates_traversal_metadata_and_file_directory_conflicts_are_refused() {
        for path in [
            b"".as_slice(),
            b"/a",
            b"a/",
            b"a//b",
            b"../a",
            b"a/./b",
            b"a\0b",
            b".git/config",
            b"nested/.GiT/HEAD",
        ] {
            assert_eq!(validate_path(path), Err(SourceTreeError::InvalidPath));
        }
        let mut builder = SourceTreeBuilder::new();
        builder.push(entry(b"a", false, b"x")).unwrap();
        assert_eq!(
            builder.push(entry(b"a", true, b"y")),
            Err(SourceTreeError::DuplicatePath)
        );
        builder.push(entry(b"a-b", false, b"x")).unwrap();
        builder.push(entry(b"a/b", false, b"x")).unwrap();
        assert_eq!(builder.finish(), Err(SourceTreeError::PathConflict));
    }

    #[test]
    fn symlinks_gitlinks_and_oversize_content_are_refused() {
        assert_eq!(
            validate_path(&vec![b'a'; MAX_SOURCE_PATH_BYTES + 1]),
            Err(SourceTreeError::InvalidPath)
        );
        assert_eq!(
            git_executable(b"120000", b"blob"),
            Err(SourceTreeError::UnsupportedMode)
        );
        assert_eq!(
            git_executable(b"160000", b"commit"),
            Err(SourceTreeError::UnsupportedMode)
        );
        assert_eq!(
            git_executable(b"100644", b"tree"),
            Err(SourceTreeError::UnsupportedMode)
        );
        let mut oversized = entry(b"a", false, b"");
        oversized.bytes = MAX_SOURCE_BYTES + 1;
        assert_eq!(
            SourceTreeBuilder::new().push(oversized),
            Err(SourceTreeError::LimitExceeded)
        );
        let mut builder = SourceTreeBuilder::new();
        let mut full = entry(b"full", false, b"");
        full.bytes = MAX_SOURCE_BYTES;
        builder.push(full).unwrap();
        assert_eq!(
            builder.push(entry(b"extra", false, b"x")),
            Err(SourceTreeError::LimitExceeded)
        );
    }
}
