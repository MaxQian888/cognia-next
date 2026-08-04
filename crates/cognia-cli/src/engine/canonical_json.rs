//! RFC 8785 (JSON Canonicalization Scheme) — the signing-side twin of
//! `lib/plugin/character-pack/canonical-json.ts`.
//!
//! A Character Pack signature is only meaningful if the signer and the verifier
//! agree, byte for byte, on what was signed. The host verifies bytes produced by
//! JavaScript; `cognia pack sign` produces them here. The two implementations
//! are driven by one shared fixture
//! (`lib/plugin/character-pack/__fixtures__/jcs-vectors.json`, pulled in below
//! with `include_str!`) so a divergence fails a test rather than a user's
//! import.
//!
//! # Why this is more code than the TypeScript side
//!
//! RFC 8785 defines number formatting *as* ECMAScript `Number::toString` and
//! string escaping as ES2019 well-formed `JSON.stringify`. JavaScript gets both
//! for free. Rust has to reimplement them:
//!
//!   * [`format_number`] implements ECMAScript's `Number::toString` decision
//!     tree (§6.1.6.1.20) on top of Rust's `{:e}`, which — like V8's underlying
//!     Grisu/Ryū — emits the *shortest* digit string that round-trips. That
//!     shared "shortest round-trip" guarantee is what makes the two agree; the
//!     only thing left to port is where the decimal point and exponent go.
//!   * [`escape_string`] emits the six short escapes, `\u00xx` (lowercase) for
//!     the remaining C0 controls, and passes everything else — including
//!     U+007F DEL and all non-ASCII — through literally.
//!
//! Object keys sort by **UTF-16 code unit** (§3.2.3), not by UTF-8 byte. The
//! two orders disagree above U+FFFF: `"😂"` (D83D DE02) sorts *before* `"דּ"`
//! (FB33) in UTF-16 but *after* it in UTF-8. The golden fixture pins this.

use anyhow::{bail, Result};
use serde_json::{Map, Value};

/// Keys excluded from the signed payload of a `.cognia-pack.json`.
///
/// The signature covers the `pack` object alone. `schemaVersion` and
/// `signature` live on the file wrapper, which is what lets a v1 file be
/// rewritten as v2 without invalidating a valid signature. They are stripped
/// defensively here too, in case a malformed pack carries them inline.
const UNSIGNED_PACK_KEYS: [&str; 2] = ["schemaVersion", "signature"];

/// RFC 8785 canonical JSON for an arbitrary value.
pub fn canonicalize(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// The UTF-8 bytes of [`canonicalize`] — what actually gets signed.
pub fn canonical_bytes(value: &Value) -> Result<Vec<u8>> {
    Ok(canonicalize(value)?.into_bytes())
}

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
    canonical_bytes(&Value::Object(stripped))
}

fn write_value(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            // Every JSON number is an IEEE-754 double on the JavaScript side —
            // `JSON.parse` has no other numeric type. Widening `u64`/`i64` here
            // mirrors that, including the precision loss above 2^53, because
            // the signed bytes are defined by what the host produced.
            let Some(as_f64) = number.as_f64() else {
                bail!("number {number} cannot be represented as a double");
            };
            out.push_str(&format_number(as_f64)?);
        }
        Value::String(s) => escape_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                // Array order is semantic; RFC 8785 never reorders it.
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                escape_string(key, out);
                out.push(':');
                write_value(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// ES2019 well-formed `JSON.stringify` string escaping (RFC 8785 §3.2.2.2).
fn escape_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Only the C0 range is escaped numerically. U+007F (DEL) and every
            // non-ASCII scalar stay literal — escaping them would still be
            // *valid* JSON but would not be the *canonical* JSON.
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `Number::toString(x, 10)` for a finite double (RFC 8785 §3.2.2.3).
///
/// Rust's `{:e}` yields the shortest round-tripping digit string `s` and a
/// scientific exponent; in the spec's terms `k = s.len()` and `n = exponent + 1`
/// (so that `s × 10^(n-k) == x`). Everything below is the spec's placement
/// decision tree over that pair.
fn format_number(x: f64) -> Result<String> {
    if !x.is_finite() {
        bail!("non-finite number cannot be canonicalized");
    }
    // Covers both +0 and -0: RFC 8785 requires negative zero to serialize as
    // "0", and `-0.0 == 0.0` is true in IEEE-754.
    if x == 0.0 {
        return Ok("0".to_string());
    }
    if x < 0.0 {
        return Ok(format!("-{}", format_number(-x)?));
    }

    let scientific = format!("{x:e}");
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        bail!("unexpected float formatting for {x}: {scientific}");
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse()?;
    let k = digits.len() as i32;
    let n = exponent + 1;

    Ok(if k <= n && n <= 21 {
        // Integer with (n - k) trailing zeros: 1e2 → "100".
        let mut s = digits;
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        // Decimal point inside the digits: 1.005e2 → "100.5".
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        // Leading "0." plus (-n) zeros: 1e-1 → "0.1".
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else if k == 1 {
        // Single digit, exponential: 1e21 → "1e+21".
        format!("{}e{}", digits, signed_exponent(n - 1))
    } else {
        // Multi-digit, exponential: 1.7976931348623157e308.
        format!(
            "{}.{}e{}",
            &digits[..1],
            &digits[1..],
            signed_exponent(n - 1)
        )
    })
}

/// ECMAScript always writes an explicit sign on an exponent: `e+21`, `e-7`.
fn signed_exponent(exponent: i32) -> String {
    if exponent >= 0 {
        format!("+{exponent}")
    } else {
        format!("-{}", -exponent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The single source of truth for JCS behaviour, shared with the Jest suite
    /// at `lib/plugin/character-pack/canonical-json.test.ts`. If this path ever
    /// breaks, do NOT copy the file into the crate — one fixture driving both
    /// languages is the entire point.
    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../lib/plugin/character-pack/__fixtures__/jcs-vectors.json"
    ));

    #[derive(serde::Deserialize)]
    struct VectorFile {
        vectors: Vec<Vector>,
    }

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        input: Value,
        expected: String,
    }

    #[test]
    fn golden_vectors_match_the_javascript_side() {
        let parsed: VectorFile = serde_json::from_str(VECTORS).expect("fixture parses");
        assert!(
            parsed.vectors.len() >= 20,
            "fixture shrank — vectors are load-bearing, not decoration"
        );
        for vector in parsed.vectors {
            let actual = canonicalize(&vector.input).expect(&vector.name);
            assert_eq!(actual, vector.expected, "vector `{}`", vector.name);
        }
    }

    #[test]
    fn keys_sort_by_utf16_code_unit_not_utf8_byte() {
        // U+1F602 encodes as D83D DE02 (UTF-16) / F0 9F 98 82 (UTF-8);
        // U+FB33 as FB33 / EF AC B3. The two orderings disagree, and RFC 8785
        // §3.2.3 mandates the UTF-16 one.
        let value: Value = serde_json::json!({ "\u{FB33}": 1, "\u{1F602}": 2 });
        assert_eq!(
            canonicalize(&value).unwrap(),
            "{\"\u{1F602}\":2,\"\u{FB33}\":1}"
        );
        // Guard the negative: a UTF-8 byte sort would have produced this.
        assert_ne!(
            canonicalize(&value).unwrap(),
            "{\"\u{FB33}\":1,\"\u{1F602}\":2}"
        );
    }

    #[test]
    fn number_formatting_covers_every_branch_of_the_spec_tree() {
        // k <= n <= 21 (integers, with and without trailing zeros)
        assert_eq!(format_number(1.0).unwrap(), "1");
        assert_eq!(format_number(100.0).unwrap(), "100");
        assert_eq!(
            format_number(9007199254740992.0).unwrap(),
            "9007199254740992"
        );
        // 0 < n <= 21 (decimal point inside the digits)
        assert_eq!(format_number(100.5).unwrap(), "100.5");
        assert_eq!(format_number(1.1).unwrap(), "1.1");
        // -6 < n <= 0 (leading zeros)
        assert_eq!(format_number(0.1).unwrap(), "0.1");
        assert_eq!(format_number(1e-6).unwrap(), "0.000001");
        // exponential, k == 1
        assert_eq!(format_number(1e21).unwrap(), "1e+21");
        assert_eq!(format_number(1e-7).unwrap(), "1e-7");
        assert_eq!(format_number(5e-324).unwrap(), "5e-324");
        // exponential, k > 1
        assert_eq!(
            format_number(1.7976931348623157e308).unwrap(),
            "1.7976931348623157e+308"
        );
    }

    #[test]
    fn zero_and_negative_zero_both_serialize_as_zero() {
        assert_eq!(format_number(0.0).unwrap(), "0");
        assert_eq!(format_number(-0.0).unwrap(), "0");
        assert_eq!(format_number(-1.0).unwrap(), "-1");
        assert_eq!(format_number(-0.5).unwrap(), "-0.5");
    }

    #[test]
    fn non_finite_numbers_are_rejected() {
        assert!(format_number(f64::NAN).is_err());
        assert!(format_number(f64::INFINITY).is_err());
        assert!(format_number(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn del_and_non_ascii_stay_literal_while_c0_is_escaped() {
        let mut out = String::new();
        escape_string("\u{7f}\u{1f}中", &mut out);
        assert_eq!(out, "\"\u{7f}\\u001f中\"");
    }

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

    #[test]
    fn duplicate_and_nested_structures_round_trip_stably() {
        let value: Value =
            serde_json::from_str(r#"{"z":{"y":[1,{"x":2,"w":3}]},"a":null}"#).unwrap();
        let once = canonicalize(&value).unwrap();
        let twice = canonicalize(&serde_json::from_str::<Value>(&once).unwrap()).unwrap();
        assert_eq!(once, twice, "canonicalization must be idempotent");
        assert_eq!(once, r#"{"a":null,"z":{"y":[1,{"w":3,"x":2}]}}"#);
    }
}
