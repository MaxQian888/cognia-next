use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fmt;

const ALGORITHM: &str = "argon2id-v1";
const SALT_LEN: usize = 16;
const OUTPUT_LEN: usize = 32;
const SALT_B64_LEN: usize = 22;
const HASH_B64_LEN: usize = 43;
const MEMORY_COST_KIB: u32 = 19_456;
const TIME_COST: u32 = 2;
const PARALLELISM: u32 = 1;
const MAX_PASSWORD_BYTES: usize = 4096;
/// Minimum length enforced only when MINTING a new verifier. The verify path
/// deliberately skips this so accounts created before the policy still unlock.
const MIN_PASSWORD_LENGTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPasswordKdfParams {
    pub memory_cost: u32,
    pub time_cost: u32,
    pub parallelism: u32,
    pub output_length: usize,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPasswordVerifier {
    pub algorithm: String,
    pub salt: String,
    pub hash: String,
    pub params: AccountPasswordKdfParams,
}

impl fmt::Debug for AccountPasswordVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccountPasswordVerifier")
            .field("algorithm", &self.algorithm)
            .field("salt", &"<redacted>")
            .field("hash", &"<redacted>")
            .field("params", &self.params)
            .finish()
    }
}

#[tauri::command]
pub fn account_password_create_verifier(
    password: String,
) -> Result<AccountPasswordVerifier, String> {
    let mut salt = [0_u8; SALT_LEN];
    rand::fill(&mut salt);
    create_password_verifier_with_salt(&password, &salt)
}

/// Verify a local account password and, on success, bind this host to the
/// account.
///
/// The bind lives here rather than on a separate command because this is the
/// only place the host ever sees proof that the caller holds both the password
/// and the verifier. See `companion_api::host_identity` for exactly what that
/// does and does not prove.
///
/// `account_id` is optional so the browser/web callers, which have no companion
/// host to bind, keep working unchanged.
#[tauri::command]
pub fn account_password_verify(
    password: String,
    verifier: AccountPasswordVerifier,
    account_id: Option<String>,
) -> Result<bool, String> {
    validate_password(&password)?;
    validate_verifier_metadata(&verifier)?;
    let salt = decode_base64_field("salt", &verifier.salt, SALT_B64_LEN, SALT_LEN)?;
    let expected = decode_base64_field("hash", &verifier.hash, HASH_B64_LEN, OUTPUT_LEN)?;
    let actual = derive_hash(&password, &salt, &verifier.params)?;
    let matched = constant_time_eq(&actual, &expected);

    if matched {
        if let Some(account_id) = account_id.as_deref() {
            bind_host_to_account(account_id, &verifier)?;
        }
    }
    Ok(matched)
}

/// Drop this host's in-process account binding. Called when an account locks or
/// the app switches away from it; the recorded tenant is left untouched.
#[tauri::command]
pub fn account_unbind_local() {
    crate::companion_api::host_identity::unbind_local_account();
}

/// Re-pin the host binding after a password rotation.
///
/// Rotating a password changes the verifier, so without this the new one would
/// be refused as a mismatch forever. Callers must already have verified the
/// *current* password.
#[tauri::command]
pub fn account_rebind_verifier(
    account_id: String,
    verifier: AccountPasswordVerifier,
) -> Result<(), String> {
    validate_verifier_metadata(&verifier)?;
    crate::companion_api::host_identity::rebind_verifier(
        &account_id,
        &verifier_digest_of(&verifier),
    )
    .map_err(|error| error.to_string())
}

/// Record which person this profile belongs to, after a completed sign-in.
///
/// ADR-0149 §9. Deliberately a separate command from the unlock path: an unlock
/// proves a profile, a sign-in asserts a person, and the renderer supplies the
/// user id — so it must never travel on the verifier-pin path.
///
/// A host with no security database (no companion server has ever run here) is
/// a normal desktop state, so it is reported as success with nothing recorded,
/// exactly as `bind_host_to_account` treats it.
#[tauri::command]
pub fn account_bind_person(
    account_id: String,
    user_id: String,
    org_id: Option<String>,
) -> Result<(), String> {
    use crate::companion_api::host_identity::{bind_person, HostIdentityError};

    match bind_person(&account_id, &user_id, org_id.as_deref()) {
        Ok(()) => Ok(()),
        Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Forget the person on this profile (sign-out). The profile binding and every
/// device paired to it survive.
#[tauri::command]
pub fn account_unbind_person(account_id: String) -> Result<(), String> {
    use crate::companion_api::host_identity::{unbind_person, HostIdentityError};

    match unbind_person(&account_id) {
        Ok(()) => Ok(()),
        Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Read the person recorded for this profile, so the renderer can detect a
/// disagreement between its own binding and the host's.
#[tauri::command]
pub fn account_person(
    account_id: String,
) -> Result<Option<crate::companion_api::host_identity::HostPerson>, String> {
    use crate::companion_api::host_identity::{person, HostIdentityError};

    match person(&account_id) {
        Ok(found) => Ok(Some(found)),
        // No security database, or a profile this host has never seen unlocked:
        // both mean "nothing recorded", which is an answer, not a failure.
        Err(HostIdentityError::StoreUnavailable) | Err(HostIdentityError::Unbound) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn bind_host_to_account(
    account_id: &str,
    verifier: &AccountPasswordVerifier,
) -> Result<(), String> {
    use crate::companion_api::host_identity::{bind_local_account, HostIdentityError};

    match bind_local_account(account_id, &verifier_digest_of(verifier)) {
        Ok(_) => Ok(()),
        // A host with no security database (no companion server has ever run
        // here) is a normal desktop state, not an unlock failure.
        Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error @ HostIdentityError::BindingMismatch) => Err(error.to_string()),
        Err(error) => {
            log::warn!("host account binding failed: {error}");
            Ok(())
        }
    }
}

fn verifier_digest_of(verifier: &AccountPasswordVerifier) -> String {
    crate::companion_api::host_identity::verifier_digest(
        &verifier.algorithm,
        &verifier.salt,
        &verifier.hash,
    )
}

fn create_password_verifier_with_salt(
    password: &str,
    salt: &[u8],
) -> Result<AccountPasswordVerifier, String> {
    validate_password(password)?;
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err(format!(
            "password must be at least {MIN_PASSWORD_LENGTH} characters"
        ));
    }
    if salt.len() != SALT_LEN {
        return Err("password verifier salt length is invalid".into());
    }
    let params = default_params();
    let hash = derive_hash(password, salt, &params)?;
    Ok(AccountPasswordVerifier {
        algorithm: ALGORITHM.into(),
        salt: STANDARD_NO_PAD.encode(salt),
        hash: STANDARD_NO_PAD.encode(hash),
        params,
    })
}

fn default_params() -> AccountPasswordKdfParams {
    AccountPasswordKdfParams {
        memory_cost: MEMORY_COST_KIB,
        time_cost: TIME_COST,
        parallelism: PARALLELISM,
        output_length: OUTPUT_LEN,
    }
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("password is required".into());
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!(
            "password is too long; maximum is {MAX_PASSWORD_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_verifier_metadata(verifier: &AccountPasswordVerifier) -> Result<(), String> {
    if verifier.algorithm != ALGORITHM {
        return reject_verifier("unsupported password verifier algorithm");
    }
    if verifier.params != default_params() {
        return reject_verifier("unsupported password verifier params");
    }
    Ok(())
}

fn decode_base64_field(
    field: &str,
    value: &str,
    encoded_len: usize,
    decoded_len: usize,
) -> Result<Vec<u8>, String> {
    if value.len() != encoded_len {
        return reject_verifier(&format!("invalid password verifier {field} length"));
    }
    let decoded = match STANDARD_NO_PAD.decode(value.as_bytes()) {
        Ok(decoded) => decoded,
        Err(_) => return reject_verifier(&format!("invalid password verifier {field}")),
    };
    if decoded.len() != decoded_len {
        return reject_verifier(&format!("invalid password verifier {field} length"));
    }
    Ok(decoded)
}

fn derive_hash(
    password: &str,
    salt: &[u8],
    params: &AccountPasswordKdfParams,
) -> Result<Vec<u8>, String> {
    validate_kdf_params(params)?;
    let argon_params = Params::new(
        params.memory_cost,
        params.time_cost,
        params.parallelism,
        Some(params.output_length),
    )
    .map_err(|err| format!("invalid password verifier params: {err}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut output = vec![0_u8; params.output_length];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut output)
        .map_err(|err| format!("password verifier derivation failed: {err}"))?;
    Ok(output)
}

fn validate_kdf_params(params: &AccountPasswordKdfParams) -> Result<(), String> {
    if params != &default_params() {
        return reject_verifier("unsupported password verifier params");
    }
    Ok(())
}

fn reject_verifier<T>(reason: &str) -> Result<T, String> {
    log::warn!("account password verifier rejected: {reason}");
    Err(verifier_error(reason))
}

fn verifier_error(reason: &str) -> String {
    reason.to_string()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_verifies_argon2id_password_verifiers() {
        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();

        assert_eq!(verifier.algorithm, "argon2id-v1");
        assert_eq!(verifier.params.memory_cost, 19_456);
        assert_eq!(verifier.params.time_cost, 2);
        assert_eq!(verifier.params.parallelism, 1);
        assert_eq!(verifier.params.output_length, 32);
        assert!(account_password_verify("correct horse".into(), verifier.clone(), None).unwrap());
        assert!(!account_password_verify("wrong horse".into(), verifier, None).unwrap());
    }

    #[test]
    fn rejects_empty_passwords() {
        assert!(account_password_create_verifier("  ".into())
            .unwrap_err()
            .contains("password"));

        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        assert!(account_password_verify("".into(), verifier, None)
            .unwrap_err()
            .contains("password"));
    }

    #[test]
    fn rejects_overlong_passwords_before_derivation() {
        let password = "a".repeat(4097);
        assert!(account_password_create_verifier(password.clone())
            .unwrap_err()
            .contains("too long"));

        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        assert!(account_password_verify(password, verifier, None)
            .unwrap_err()
            .contains("too long"));
    }

    #[test]
    fn enforces_minimum_length_on_create_but_not_on_verify() {
        // Minting a verifier below the minimum length is rejected.
        let err = create_password_verifier_with_salt("short", &[7_u8; 16]).unwrap_err();
        assert!(err.contains("at least"));

        // The verify path never enforces the minimum: a short password is a
        // normal (wrong) input, not an error, so pre-policy accounts unlock.
        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        assert!(!account_password_verify("short".into(), verifier, None).unwrap());
    }

    #[test]
    fn rejects_malformed_verifier_payloads() {
        let mut verifier =
            create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();

        verifier.hash = "not base64".into();

        assert!(
            account_password_verify("correct horse".into(), verifier, None)
                .unwrap_err()
                .contains("hash")
        );
    }

    #[test]
    fn rejects_tampered_verifier_params_before_derivation() {
        let mut verifier =
            create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        verifier.params.memory_cost = MEMORY_COST_KIB / 2;

        assert!(
            account_password_verify("correct horse".into(), verifier, None)
                .unwrap_err()
                .contains("params")
        );
    }

    #[test]
    fn rejects_oversized_verifier_output_length_before_allocation() {
        let mut verifier =
            create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        verifier.params.output_length = OUTPUT_LEN * 1024;

        assert!(
            account_password_verify("correct horse".into(), verifier, None)
                .unwrap_err()
                .contains("params")
        );
    }

    #[test]
    fn rejects_verifiers_with_invalid_binary_lengths() {
        let mut short_salt =
            create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        short_salt.salt = STANDARD_NO_PAD.encode([7_u8; 8]);

        assert!(
            account_password_verify("correct horse".into(), short_salt, None)
                .unwrap_err()
                .contains("salt")
        );

        let mut short_hash =
            create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        short_hash.hash = STANDARD_NO_PAD.encode([9_u8; 8]);

        assert!(
            account_password_verify("correct horse".into(), short_hash, None)
                .unwrap_err()
                .contains("hash")
        );
    }

    #[test]
    fn a_successful_verify_binds_the_host_to_the_account() {
        use crate::companion_api::host_identity::{current, unbind_local_account};
        use crate::companion_api::security_store::{
            install_security_store, test_guard, SecurityStore,
        };

        let _guard = test_guard();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        unbind_local_account();

        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();

        // A wrong password must not bind anything.
        assert!(!account_password_verify(
            "wrong horse".into(),
            verifier.clone(),
            Some("acct_one".into())
        )
        .unwrap());
        assert_eq!(
            current().unwrap().local_account_namespace,
            crate::companion_api::security_store::LOCAL_NAMESPACE_UNBOUND
        );

        // The right one does.
        assert!(account_password_verify(
            "correct horse".into(),
            verifier.clone(),
            Some("acct_one".into())
        )
        .unwrap());
        assert_eq!(current().unwrap().local_account_namespace, "acct_one");

        // A different verifier for the same account is refused outright, rather
        // than reported as a failed password — the caller needs to be able to
        // tell "wrong password" from "this is not that account".
        let forged = create_password_verifier_with_salt("correct horse", &[9_u8; 16]).unwrap();
        assert!(
            account_password_verify("correct horse".into(), forged, Some("acct_one".into()))
                .is_err()
        );

        unbind_local_account();
    }

    #[test]
    fn a_password_rotation_re_pins_the_binding() {
        use crate::companion_api::host_identity::unbind_local_account;
        use crate::companion_api::security_store::{
            install_security_store, test_guard, SecurityStore,
        };

        let _guard = test_guard();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        unbind_local_account();

        let first = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        account_password_verify("correct horse".into(), first, Some("acct_one".into())).unwrap();

        let rotated = create_password_verifier_with_salt("battery staple", &[8_u8; 16]).unwrap();
        // Without the rebind the new verifier would be refused forever.
        account_rebind_verifier("acct_one".into(), rotated.clone()).unwrap();
        assert!(
            account_password_verify("battery staple".into(), rotated, Some("acct_one".into()))
                .unwrap()
        );

        unbind_local_account();
    }

    #[test]
    fn verifying_without_an_account_id_never_binds() {
        use crate::companion_api::host_identity::{current, unbind_local_account};
        use crate::companion_api::security_store::{
            install_security_store, test_guard, SecurityStore, LOCAL_NAMESPACE_UNBOUND,
        };

        let _guard = test_guard();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        unbind_local_account();

        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        assert!(account_password_verify("correct horse".into(), verifier, None).unwrap());
        assert_eq!(
            current().unwrap().local_account_namespace,
            LOCAL_NAMESPACE_UNBOUND
        );
    }

    #[test]
    fn verifier_debug_output_redacts_secret_material() {
        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();

        let rendered = format!("{verifier:?}");

        assert!(rendered.contains("AccountPasswordVerifier"));
        assert!(!rendered.contains(&verifier.salt));
        assert!(!rendered.contains(&verifier.hash));
    }
}
