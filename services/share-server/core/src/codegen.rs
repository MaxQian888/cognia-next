//! Share-code generation. The mapping from random bytes to a code is pure and
//! testable here; the CSPRNG that fills the bytes lives in the server crate
//! (`rand`), so this stays dependency-light and deterministic under test.

/// Length of a share code in characters. Matches `CODE_LENGTH` in the Worker.
pub const CODE_LENGTH: usize = 12;

/// The 62-character alphabet (A–Z, a–z, 0–9). 12 chars × log2(62) ≈ 71 bits of
/// entropy, identical to `CODE_ALPHABET` in the Worker.
pub const CODE_ALPHABET: &[u8; 62] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Map `CODE_LENGTH` random bytes to a code by indexing the alphabet with
/// `byte % 62` — the same reduction the Worker uses. The modulo bias is
/// negligible for an unguessable identifier (256 mod 62 spreads near-uniformly).
pub fn code_from_bytes(bytes: &[u8; CODE_LENGTH]) -> String {
    bytes
        .iter()
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_has_expected_length() {
        let code = code_from_bytes(&[0u8; CODE_LENGTH]);
        assert_eq!(code.chars().count(), CODE_LENGTH);
    }

    #[test]
    fn code_is_deterministic_for_given_bytes() {
        let bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        assert_eq!(code_from_bytes(&bytes), code_from_bytes(&bytes));
    }

    #[test]
    fn all_code_chars_are_in_the_alphabet() {
        // Walk every byte value through the generator and confirm the output
        // never escapes the alphabet.
        for base in 0u16..=255 {
            let b = base as u8;
            let code = code_from_bytes(&[b; CODE_LENGTH]);
            assert!(
                code.bytes().all(|c| CODE_ALPHABET.contains(&c)),
                "byte {b} produced out-of-alphabet code {code}"
            );
        }
    }

    #[test]
    fn distinct_byte_patterns_produce_distinct_codes() {
        let a = code_from_bytes(&[0u8; CODE_LENGTH]);
        let b = code_from_bytes(&[1u8; CODE_LENGTH]);
        assert_ne!(a, b);
    }

    #[test]
    fn alphabet_is_62_unique_chars() {
        let mut seen = std::collections::HashSet::new();
        for &c in CODE_ALPHABET.iter() {
            assert!(seen.insert(c), "duplicate char in alphabet: {}", c as char);
        }
        assert_eq!(seen.len(), 62);
    }
}
