//! Built-in [`GlyphResolver`] backed by a fragmented glyph-outline → unicode
//! database / map.
//!
//! The database is a directory of `%02x%02x.msgpack` shards. Each shard is a
//! stream of concatenated 2-element msgpack arrays `[hash, unicode]`:
//! * `hash` — a 16-byte `bin` (the first half of the glyph's 32-byte BLAKE3
//!   path hash; the shard filename is its first two bytes).
//! * `unicode` — a positive integer codepoint.
//!
//! To resolve a glyph we hash its outline segments exactly as the producer did
//! — little-endian `{i32 segment_type, f32 x, f32 y}` per segment, BLAKE3,
//! truncated to 16 bytes — load the matching shard, and look the key up.
//!
//! Not compiled for `wasm32` (no filesystem). Construct directly, or let
//! [`crate::LiteParse::new`] auto-wire one when `LITEPARSE_FONT_DB_DIR` is set.

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::glyph_resolver::GlyphResolver;

/// On-disk key width: first 16 bytes of the glyph's BLAKE3 path hash
/// (`PARSE_FONT_FRAGMENTED_HASH_SIZE` = `BLAKE3_OUT_LEN / 2`).
const KEY_LEN: usize = 16;

type ShardMap = HashMap<[u8; KEY_LEN], u32>;

/// Resolves buggy-font glyphs against an on-disk outline → unicode database.
pub struct FontDbResolver {
    dir: PathBuf,
    /// Shards loaded on demand and memoised by their 2-byte prefix. `None`
    /// records a shard that is absent or unreadable so we don't retry it per
    /// glyph (mirrors the C path treating a missing fragment as "no match").
    shards: RwLock<HashMap<u16, Option<Arc<ShardMap>>>>,
    debug: bool,
}

impl FontDbResolver {
    /// Create a resolver reading shards from `dir`. No I/O happens here; shards
    /// load lazily on first lookup, so an empty or missing directory simply
    /// yields no matches.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            shards: RwLock::new(HashMap::new()),
            debug: std::env::var("LITEPARSE_DEBUG_GLYPH").is_ok(),
        }
    }

    /// First 16 bytes of the BLAKE3 hash of the LE-packed outline segments.
    fn glyph_key(segments: &[(i32, f32, f32)]) -> [u8; KEY_LEN] {
        let mut hasher = blake3::Hasher::new();
        for &(seg_type, x, y) in segments {
            hasher.update(&seg_type.to_le_bytes());
            hasher.update(&x.to_le_bytes());
            hasher.update(&y.to_le_bytes());
        }
        let full = hasher.finalize();
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&full.as_bytes()[..KEY_LEN]);
        key
    }

    /// Return the shard for `prefix`, loading + memoising it on first use.
    fn shard(&self, prefix: u16) -> Option<Arc<ShardMap>> {
        if let Some(slot) = self.shards.read().ok()?.get(&prefix) {
            return slot.clone();
        }
        let loaded = self.load_shard(prefix).map(Arc::new);
        if let Ok(mut w) = self.shards.write() {
            // Another thread may have inserted while we loaded; keep theirs.
            return w.entry(prefix).or_insert(loaded).clone();
        }
        loaded
    }

    fn load_shard(&self, prefix: u16) -> Option<ShardMap> {
        let path = self
            .dir
            .join(format!("{:02x}{:02x}.msgpack", prefix >> 8, prefix & 0xff));
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => {
                if self.debug {
                    eprintln!("[glyph] font-db shard not found: {}", path.display());
                }
                return None;
            }
        };
        let mut rd = BufReader::new(file);
        let mut map = ShardMap::new();
        // Each record is a 2-array `[bin(16+), positive int]`. The stream ends
        // (or a malformed record appears) and `read_array_len` errors — stop.
        loop {
            match rmp::decode::read_array_len(&mut rd) {
                Ok(2) => {}
                _ => break,
            }
            let bin_len = match rmp::decode::read_bin_len(&mut rd) {
                Ok(n) => n as usize,
                Err(_) => break,
            };
            if bin_len < KEY_LEN {
                break;
            }
            let mut key = [0u8; KEY_LEN];
            if rd.read_exact(&mut key).is_err() {
                break;
            }
            // Consume any bytes beyond the 16-byte key (the C reader also keeps
            // only the first 16 of a `>= 16`-byte bin).
            if bin_len > KEY_LEN {
                let mut skip = vec![0u8; bin_len - KEY_LEN];
                if rd.read_exact(&mut skip).is_err() {
                    break;
                }
            }
            match rmp::decode::read_int::<u32, _>(&mut rd) {
                Ok(unicode) => {
                    map.insert(key, unicode);
                }
                Err(_) => break,
            }
        }
        if self.debug {
            eprintln!(
                "[glyph] font-db shard {:02x}{:02x}: {} entries",
                prefix >> 8,
                prefix & 0xff,
                map.len()
            );
        }
        Some(map)
    }
}

impl GlyphResolver for FontDbResolver {
    fn resolve(&self, segments: &[(i32, f32, f32)]) -> Option<String> {
        let unicode = self.resolve_codepoint(segments)?;
        let c = char::from_u32(unicode).filter(|c| !c.is_control())?;
        Some(match crate::glyph_names::presentation_form_expansion(c) {
            Some(s) => s.to_string(),
            None => c.to_string(),
        })
    }

    /// The recorded database value. A value of 0 is a recorded "unknown".
    fn resolve_codepoint(&self, segments: &[(i32, f32, f32)]) -> Option<u32> {
        let key = Self::glyph_key(segments);
        let prefix = u16::from(key[0]) << 8 | u16::from(key[1]);
        let unicode = *self.shard(prefix)?.get(&key)?;
        (unicode != 0).then_some(unicode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write `[bin(key), uint(unicode)]` records into the correct shard files
    /// under `dir`, matching the on-disk format `load_shard` reads.
    fn write_shards(dir: &std::path::Path, records: &[([u8; KEY_LEN], u32)]) {
        let mut by_prefix: HashMap<u16, Vec<u8>> = HashMap::new();
        for (key, unicode) in records {
            let prefix = u16::from(key[0]) << 8 | u16::from(key[1]);
            let buf = by_prefix.entry(prefix).or_default();
            rmp::encode::write_array_len(buf, 2).unwrap();
            rmp::encode::write_bin(buf, key).unwrap();
            rmp::encode::write_uint(buf, u64::from(*unicode)).unwrap();
        }
        for (prefix, buf) in by_prefix {
            let path = dir.join(format!("{:02x}{:02x}.msgpack", prefix >> 8, prefix & 0xff));
            std::fs::write(path, buf).unwrap();
        }
    }

    #[test]
    fn resolves_known_glyph_and_misses_unknown() {
        let segs = vec![(2i32, 1.0f32, 2.0f32), (0, 3.5, -1.0), (1, 0.0, 0.0)];
        let key = FontDbResolver::glyph_key(&segs);
        let dir = tempfile::tempdir().unwrap();
        write_shards(dir.path(), &[(key, 0x160)]); // U+0160 'Š'

        let resolver = FontDbResolver::new(dir.path());
        assert_eq!(resolver.resolve(&segs).as_deref(), Some("Š"));
        // A glyph whose hash isn't in the (loaded) shard → no match.
        assert_eq!(resolver.resolve(&[(2i32, 9.0f32, 9.0f32)]), None);
    }

    #[test]
    fn missing_directory_yields_no_match() {
        let resolver = FontDbResolver::new("/nonexistent/liteparse/font/db");
        assert_eq!(resolver.resolve(&[(2i32, 1.0f32, 2.0f32)]), None);
    }
}
