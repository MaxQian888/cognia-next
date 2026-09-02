//! Desktop quick unlock: PIN and pattern, verified in Rust against a pepper
//! that lives in the OS keyring.
//!
//! # Why this is not the browser design
//!
//! The Browser Vault wraps a master key, so a quick method there produces a
//! second wrap of that key. The desktop host has no such key: it VERIFIES a
//! password and, on success, binds the host and activates the plugin runtime.
//! Copying the browser's wrap shape here would have meant inventing a master
//! key for it to wrap, which is a much larger change than adding a way to
//! unlock. So a desktop quick method is a second VERIFIER, checked the same
//! way the password is, granting exactly the same authority and nothing more.
//!
//! # The pepper is the whole security argument
//!
//! A six-digit PIN is about 20 bits. Argon2id at these parameters costs tens
//! of milliseconds, so a verifier an attacker can read is a verifier they can
//! enumerate over a long lunch. The verifier alone is therefore never enough:
//! the hash covers the PIN AND 32 random bytes held in the OS keyring, which a
//! copied application-data directory does not contain and which the renderer
//! never sees. Without the keyring entry the stored verifier is not attackable
//! at all.
//!
//! # What is deliberately absent
//!
//! There is no path here that mints a quick verifier without the account
//! password having just been proven, no path that unbinds or rotates the
//! password, and no path that recovers an account. A quick method is a
//! convenience layered on the password, and the attempt cap that makes a
//! 20-bit secret defensible is enforced by the caller on the enrollment record
//! in addition to the throttle below.

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fmt;
use tauri::Manager as _;

use crate::account_auth::{
    AccountPasswordKdfParams, AccountPasswordVerifier, AccountSecuritySession,
};

/// Keyring namespace holding one pepper per account.
const PEPPER_NAMESPACE: &str = "account-quick-unlock";
const PEPPER_LEN: usize = 32;
const SALT_LEN: usize = 16;
const OUTPUT_LEN: usize = 32;
const ALGORITHM: &str = "argon2id-quick-v1";
/// Bounds on the canonical secret. Generous, because it is method-prefixed
/// text rather than raw digits, but bounded so a hostile caller cannot ask for
/// an unbounded hash.
const MAX_SECRET_BYTES: usize = 1024;

/// The methods this module will mint a verifier for.
///
/// `passkey` is absent on purpose. A passkey secret comes from an
/// authenticator and already has full entropy, so it needs no pepper and no
/// Rust involvement.
const SUPPORTED_METHODS: [&str; 2] = ["pin", "pattern"];

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickUnlockVerifier {
    pub algorithm: String,
    pub method: String,
    pub salt: String,
    pub hash: String,
    pub params: AccountPasswordKdfParams,
}

impl fmt::Debug for QuickUnlockVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print the salt or hash. A quick verifier plus the keyring
        // pepper is enough to enumerate a PIN, so neither half belongs in a
        // log line or a crash report.
        f.debug_struct("QuickUnlockVerifier")
            .field("algorithm", &self.algorithm)
            .field("method", &self.method)
            .field("salt", &"<redacted>")
            .field("hash", &"<redacted>")
            .field("params", &self.params)
            .finish()
    }
}

fn validate_method(method: &str) -> Result<(), String> {
    if SUPPORTED_METHODS.contains(&method) {
        return Ok(());
    }
    Err(format!("unsupported quick unlock method: {method}"))
}

fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("quick unlock secret is required".into());
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err("quick unlock secret is too long".into());
    }
    Ok(())
}

/// Fetch, or mint, this account's keyring pepper.
///
/// Minting on first use rather than at account creation keeps the keyring
/// clean for the many users who never enroll a quick method.
fn pepper_for(account_id: &str) -> Result<Vec<u8>, String> {
    if let Some(existing) = crate::keyring_secrets::get(PEPPER_NAMESPACE, account_id)? {
        let decoded = STANDARD_NO_PAD
            .decode(existing.as_bytes())
            .map_err(|_| "stored quick unlock pepper is malformed".to_owned())?;
        if decoded.len() == PEPPER_LEN {
            return Ok(decoded);
        }
        // A pepper of the wrong length cannot have produced any verifier this
        // build wrote. Replacing it is safer than trusting it, and the caller
        // will simply be told the PIN no longer matches.
    }
    let mut pepper = vec![0_u8; PEPPER_LEN];
    rand::fill(&mut pepper[..]);
    crate::keyring_secrets::set(
        PEPPER_NAMESPACE,
        account_id,
        &STANDARD_NO_PAD.encode(&pepper),
    )?;
    Ok(pepper)
}

/// Drop an account's pepper, making every quick verifier it minted useless.
///
/// Called when the account is deleted and when the last quick method is
/// removed.
pub fn clear_pepper(account_id: &str) -> Result<(), String> {
    crate::keyring_secrets::clear(PEPPER_NAMESPACE, account_id)
}

/// Hash input: the method-prefixed secret followed by the pepper.
///
/// Appended rather than folded into the salt, because the salt is stored in
/// the clear next to the hash and peppering there would put the one value the
/// scheme depends on straight onto disk.
fn derive(secret: &str, pepper: &[u8], salt: &[u8]) -> Result<Vec<u8>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};

    let params = crate::account_auth::default_kdf_params();
    let argon_params = Params::new(
        params.memory_cost,
        params.time_cost,
        params.parallelism,
        Some(params.output_length),
    )
    .map_err(|err| format!("invalid quick unlock params: {err}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);

    let mut input = Vec::with_capacity(secret.len() + pepper.len());
    input.extend_from_slice(secret.as_bytes());
    input.extend_from_slice(pepper);

    let mut output = vec![0_u8; params.output_length];
    let result = argon
        .hash_password_into(&input, salt, &mut output)
        .map_err(|err| format!("quick unlock derivation failed: {err}"));
    // Wipe the combined input before returning either way: it holds the
    // pepper, which must not linger in a reused allocation.
    input.iter_mut().for_each(|byte| *byte = 0);
    result?;
    Ok(output)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Mint a quick-unlock verifier.
///
/// The caller must already have proven the account password. This command does
/// not re-check it, because on the desktop host the password is verified by
/// `account_password_verify`, which binds the session, and requiring an
/// unlocked session here is exactly what that binding represents.
#[tauri::command]
pub fn account_quick_unlock_create_verifier(
    security_session: tauri::State<'_, AccountSecuritySession>,
    account_id: String,
    method: String,
    secret: String,
) -> Result<QuickUnlockVerifier, String> {
    validate_method(&method)?;
    validate_secret(&secret)?;
    // Enrolling a new way into an account is an account-scoped act, so it
    // requires the account it names to be the one currently unlocked.
    security_session.assert_unlocked_account(&account_id)?;

    let pepper = pepper_for(&account_id)?;
    let mut salt = [0_u8; SALT_LEN];
    rand::fill(&mut salt);
    let hash = derive(&secret, &pepper, &salt)?;

    Ok(QuickUnlockVerifier {
        algorithm: ALGORITHM.into(),
        method,
        salt: STANDARD_NO_PAD.encode(salt),
        hash: STANDARD_NO_PAD.encode(hash),
        params: crate::account_auth::default_kdf_params(),
    })
}

/// Verify a quick-unlock secret.
///
/// Returns a plain boolean, exactly like the password path, and leaves the
/// attempt cap to the caller's enrollment record. The throttle below still
/// applies, so a caller that ignores the cap is slowed rather than unbounded.
///
/// `password_verifier` is neither checked nor secret. It is what the companion
/// host binding is keyed on, so a quick unlock has to present the same one a
/// password unlock would, or the host would read it as a different credential.
#[tauri::command]
pub fn account_quick_unlock_verify(
    app: tauri::AppHandle,
    security_session: tauri::State<'_, AccountSecuritySession>,
    account_id: String,
    verifier: QuickUnlockVerifier,
    password_verifier: AccountPasswordVerifier,
    secret: String,
) -> Result<bool, String> {
    validate_method(&verifier.method)?;
    validate_secret(&secret)?;
    if verifier.algorithm != ALGORITHM {
        return Err("unsupported quick unlock verifier".into());
    }

    let throttle_key = format!("quick:{account_id}:{}", verifier.method);
    security_session.before_quick_attempt(&throttle_key)?;

    let pepper = pepper_for(&account_id)?;
    let salt = STANDARD_NO_PAD
        .decode(verifier.salt.as_bytes())
        .map_err(|_| "quick unlock verifier salt is malformed".to_owned())?;
    let expected = STANDARD_NO_PAD
        .decode(verifier.hash.as_bytes())
        .map_err(|_| "quick unlock verifier hash is malformed".to_owned())?;
    if salt.len() != SALT_LEN || expected.len() != OUTPUT_LEN {
        return Err("quick unlock verifier is malformed".into());
    }

    let actual = derive(&secret, &pepper, &salt)?;
    let matched = constant_time_eq(&actual, &expected);

    if matched {
        security_session.record_quick_success(&throttle_key)?;
        // Same authority as a password unlock, and no more. Binding here is
        // what makes a quick unlock a real unlock rather than a UI gesture.
        let plugin_state = app.state::<cognia_plugin_runtime::PluginRuntimeState>();
        security_session.activate_quick_unlock(&account_id, &password_verifier, &plugin_state)?;
    } else {
        security_session.record_quick_failure(&throttle_key)?;
    }
    Ok(matched)
}

/// Forget an account's pepper. Every verifier it minted stops matching.
#[tauri::command]
pub fn account_quick_unlock_clear(
    security_session: tauri::State<'_, AccountSecuritySession>,
    account_id: String,
) -> Result<(), String> {
    security_session.assert_unlocked_account(&account_id)?;
    clear_pepper(&account_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_unsupported_method() {
        assert!(validate_method("pin").is_ok());
        assert!(validate_method("pattern").is_ok());
        // Passkey secrets have full entropy and never reach this module.
        assert!(validate_method("passkey").is_err());
        assert!(validate_method("").is_err());
    }

    #[test]
    fn rejects_an_empty_or_oversized_secret() {
        assert!(validate_secret("pin:428193").is_ok());
        assert!(validate_secret("").is_err());
        assert!(validate_secret(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
    }

    #[test]
    fn derives_the_same_hash_for_the_same_inputs() {
        let pepper = [7_u8; PEPPER_LEN];
        let salt = [3_u8; SALT_LEN];
        let a = derive("pin:428193", &pepper, &salt).expect("derive");
        let b = derive("pin:428193", &pepper, &salt).expect("derive");
        assert_eq!(a, b);
        assert_eq!(a.len(), OUTPUT_LEN);
    }

    #[test]
    fn a_different_secret_derives_a_different_hash() {
        let pepper = [7_u8; PEPPER_LEN];
        let salt = [3_u8; SALT_LEN];
        let a = derive("pin:428193", &pepper, &salt).expect("derive");
        let b = derive("pin:428194", &pepper, &salt).expect("derive");
        assert_ne!(a, b);
    }

    #[test]
    fn a_different_pepper_derives_a_different_hash() {
        // The property the whole design rests on. A verifier copied to another
        // machine cannot be attacked there, because the pepper stayed behind
        // in the original keyring.
        let salt = [3_u8; SALT_LEN];
        let a = derive("pin:428193", &[7_u8; PEPPER_LEN], &salt).expect("derive");
        let b = derive("pin:428193", &[8_u8; PEPPER_LEN], &salt).expect("derive");
        assert_ne!(a, b);
    }

    #[test]
    fn a_different_salt_derives_a_different_hash() {
        let pepper = [7_u8; PEPPER_LEN];
        let a = derive("pin:428193", &pepper, &[3_u8; SALT_LEN]).expect("derive");
        let b = derive("pin:428193", &pepper, &[4_u8; SALT_LEN]).expect("derive");
        assert_ne!(a, b);
    }

    #[test]
    fn method_prefixes_keep_the_secret_spaces_apart() {
        // A pattern that serialised to the same digits as a PIN must not
        // satisfy the PIN's verifier.
        let pepper = [7_u8; PEPPER_LEN];
        let salt = [3_u8; SALT_LEN];
        let pin = derive("pin:123456", &pepper, &salt).expect("derive");
        let pattern = derive("pattern:123456", &pepper, &salt).expect("derive");
        assert_ne!(pin, pattern);
    }

    #[test]
    fn constant_time_eq_compares_contents_and_length() {
        assert!(constant_time_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!constant_time_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!constant_time_eq(&[1, 2, 3], &[1, 2]));
        assert!(constant_time_eq(&[], &[]));
    }

    #[test]
    fn debug_never_prints_the_credential_material() {
        // A verifier plus the pepper is enough to enumerate a PIN, so neither
        // half may reach a log line or a crash report.
        let verifier = QuickUnlockVerifier {
            algorithm: ALGORITHM.into(),
            method: "pin".into(),
            salt: "c2VjcmV0LXNhbHQ".into(),
            hash: "c2VjcmV0LWhhc2g".into(),
            params: crate::account_auth::default_kdf_params(),
        };
        let rendered = format!("{verifier:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("c2VjcmV0LXNhbHQ"));
        assert!(!rendered.contains("c2VjcmV0LWhhc2g"));
    }
}
