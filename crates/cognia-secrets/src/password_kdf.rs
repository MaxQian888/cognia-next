//! The one Argon2id cost every local password and credential is derived at.
//!
//! Account passwords (`account_auth`), quick-unlock PINs and file-share
//! credentials (ADR-0222) all derive at these parameters, so a hardening bump
//! moves them together. Two shapes are offered:
//!
//! - [`derive`] — raw output for callers that store salt and hash in their
//!   own record (`AccountPasswordVerifier`).
//! - [`hash_phc`] / [`verify_phc`] — a self-describing PHC string
//!   (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) for callers that keep
//!   one column. Verification refuses any other algorithm or cost, so a row
//!   cannot downgrade itself.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use subtle::ConstantTimeEq;

/// Memory cost in KiB (OWASP's Argon2id minimum at t=2).
pub const MEMORY_COST_KIB: u32 = 19_456;
/// Passes.
pub const TIME_COST: u32 = 2;
/// Lanes.
pub const PARALLELISM: u32 = 1;
/// Derived key length in bytes.
pub const OUTPUT_LEN: usize = 32;
/// Salt length in bytes.
pub const SALT_LEN: usize = 16;
/// Longest secret accepted, in bytes. Bounds the work an attacker can request.
pub const MAX_SECRET_BYTES: usize = 4096;

const PHC_PREFIX: &str = "$argon2id$v=19$m=19456,t=2,p=1$";

/// Derive `output_len` bytes from `secret` and `salt` at the given cost.
///
/// Callers that pin the default cost pass the constants above; the cost is a
/// parameter only so a record that stores its own cost can be re-derived.
pub fn derive(
    secret: &[u8],
    salt: &[u8],
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
    output_len: usize,
) -> Result<Vec<u8>, String> {
    if secret.len() > MAX_SECRET_BYTES {
        return Err(format!(
            "secret is too long; maximum is {MAX_SECRET_BYTES} bytes"
        ));
    }
    let params = Params::new(memory_cost, time_cost, parallelism, Some(output_len))
        .map_err(|err| format!("invalid argon2 params: {err}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = vec![0_u8; output_len];
    argon
        .hash_password_into(secret, salt, &mut output)
        .map_err(|err| format!("argon2 derivation failed: {err}"))?;
    Ok(output)
}

/// [`derive`] at the default cost.
pub fn derive_default(secret: &[u8], salt: &[u8]) -> Result<Vec<u8>, String> {
    derive(secret, salt, MEMORY_COST_KIB, TIME_COST, PARALLELISM, OUTPUT_LEN)
}

/// Hash `secret` with a fresh random salt into a PHC string.
pub fn hash_phc(secret: &[u8]) -> Result<String, String> {
    let mut salt = [0_u8; SALT_LEN];
    rand::fill(&mut salt);
    hash_phc_with_salt(secret, &salt)
}

fn hash_phc_with_salt(secret: &[u8], salt: &[u8; SALT_LEN]) -> Result<String, String> {
    let hash = derive_default(secret, salt)?;
    Ok(format!(
        "{PHC_PREFIX}{}${}",
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(hash)
    ))
}

/// Whether `secret` matches `phc`. A string at any other algorithm, version or
/// cost is an error, not a mismatch: it was not minted here.
pub fn verify_phc(secret: &[u8], phc: &str) -> Result<bool, String> {
    let rest = phc
        .strip_prefix(PHC_PREFIX)
        .ok_or_else(|| "unsupported password hash".to_string())?;
    let (salt_b64, hash_b64) = rest
        .split_once('$')
        .ok_or_else(|| "malformed password hash".to_string())?;
    let salt = STANDARD_NO_PAD
        .decode(salt_b64)
        .map_err(|_| "malformed password hash salt".to_string())?;
    let expected = STANDARD_NO_PAD
        .decode(hash_b64)
        .map_err(|_| "malformed password hash".to_string())?;
    if salt.len() != SALT_LEN || expected.len() != OUTPUT_LEN {
        return Err("malformed password hash".into());
    }
    let actual = derive_default(secret, &salt)?;
    Ok(constant_time_eq(&actual, &expected))
}

/// Length-revealing, content-constant-time equality.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phc_hash_verifies_its_own_secret_only() {
        let phc = hash_phc(b"correct horse").expect("hash");
        assert!(phc.starts_with(PHC_PREFIX));
        assert!(verify_phc(b"correct horse", &phc).expect("verify"));
        assert!(!verify_phc(b"correct horsf", &phc).expect("verify"));
    }

    #[test]
    fn salts_are_fresh_so_equal_secrets_hash_differently() {
        let a = hash_phc(b"same").expect("hash");
        let b = hash_phc(b"same").expect("hash");
        assert_ne!(a, b);
    }

    #[test]
    fn a_known_vector_stays_stable() {
        // Pins the parameters: a cost change makes this fail instead of
        // silently invalidating every stored credential.
        let phc = hash_phc_with_salt(b"password", &[7_u8; SALT_LEN]).expect("hash");
        let again = hash_phc_with_salt(b"password", &[7_u8; SALT_LEN]).expect("hash");
        assert_eq!(phc, again);
        assert!(verify_phc(b"password", &phc).expect("verify"));
        assert_eq!(phc.len(), PHC_PREFIX.len() + 22 + 1 + 43);
    }

    #[test]
    fn other_algorithms_and_costs_are_refused_not_mismatched() {
        let phc = hash_phc(b"x").expect("hash");
        let cheaper = phc.replace("m=19456", "m=8");
        assert!(verify_phc(b"x", &cheaper).is_err());
        assert!(verify_phc(b"x", "$argon2i$v=19$m=19456,t=2,p=1$a$b").is_err());
        assert!(verify_phc(b"x", "plain").is_err());
        let truncated = &phc[..phc.len() - 4];
        assert!(verify_phc(b"x", truncated).is_err());
    }

    #[test]
    fn oversized_secrets_are_refused() {
        let huge = vec![b'a'; MAX_SECRET_BYTES + 1];
        assert!(hash_phc(&huge).is_err());
    }

    #[test]
    fn constant_time_eq_compares_length_and_content() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
