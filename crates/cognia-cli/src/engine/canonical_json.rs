//! Character Pack signing bytes.
//!
//! The RFC 8785 canonicalizer itself lives in the `cognia-canonical-json` leaf
//! crate, shared with `cognia-environment` and driven by the same golden
//! fixture as `lib/plugin/character-pack/canonical-json.ts`. What stays here is
//! the pack-specific part: which wrapper keys the signature excludes.

use anyhow::{bail, Result};
use serde_json::{Map, Value};

use cognia_canonical_json::canonical_bytes;

/// Keys excluded from the signed payload of a `.cognia-pack.json`.
///
/// The signature covers the `pack` object alone. `schemaVersion` and
/// `signature` live on the file wrapper, which is what lets a v1 file be
/// rewritten as v2 without invalidating a valid signature. They are stripped
/// defensively here too, in case a malformed pack carries them inline.
const UNSIGNED_PACK_KEYS: [&str; 2] = ["schemaVersion", "signature"];

/// The exact bytes a Character Pack signature covers: the `pack` object,
/// canonicalized, with the wrapper-level keys stripped.
pub fn canonical_pack_bytes(pack: &Value) -> Result<Vec<u8>> {
    let Value::Object(map) = pack else {
        bail!("pack must be a JSON object");
    };
    let mut stripped = Map::with_capacity(map.len());
    for (key, child) in map {
        if UNSIGNED_PACK_KEYS.contains(&key.as_str()) {
            continue;
        }
        stripped.insert(key.clone(), child.clone());
    }
    Ok(canonical_bytes(&Value::Object(stripped))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_pack_bytes_strips_wrapper_keys() {
        let pack = serde_json::json!({
            "id": "demo",
            "schemaVersion": 2,
            "signature": { "algo": "ed25519", "pubKey": "p", "sig": "s" },
        });
        let bytes = canonical_pack_bytes(&pack).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "{\"id\":\"demo\"}");
    }

    #[test]
    fn canonical_pack_bytes_rejects_a_non_object_pack() {
        assert!(canonical_pack_bytes(&Value::String("nope".into())).is_err());
        assert!(canonical_pack_bytes(&Value::Array(vec![])).is_err());
    }

    #[test]
    fn stripping_wrapper_keys_leaves_the_rest_of_the_pack_untouched() {
        // The signature must survive a v1 → v2 rewrite, which is only true if
        // the schemaVersion is genuinely outside the signed bytes.
        let inner = serde_json::json!({ "id": "demo", "characters": [{ "localId": "a" }] });
        let Value::Object(base) = inner.clone() else {
            unreachable!()
        };
        let mut v1 = base.clone();
        v1.insert("schemaVersion".into(), Value::from(1));
        let mut v2 = base;
        v2.insert("schemaVersion".into(), Value::from(2));
        assert_eq!(
            canonical_pack_bytes(&Value::Object(v1)).unwrap(),
            canonical_pack_bytes(&Value::Object(v2)).unwrap()
        );
    }
}
