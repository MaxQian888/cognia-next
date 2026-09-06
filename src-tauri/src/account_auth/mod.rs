use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

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
const FAILURE_RESET_SECS: i64 = 30 * 60;
const INITIAL_BACKOFF_SECS: i64 = 30;
const MAX_BACKOFF_SECS: i64 = 15 * 60;

#[derive(Debug, Clone)]
struct ActiveAccountSecuritySession {
    account_id: String,
    verifier_digest: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordThrottleRecord {
    failures: u32,
    last_failure_at: i64,
    blocked_until: i64,
}

/// Rust-owned proof that one LocalProfile is currently unlocked.
///
/// The renderer can request an unlock, but every sensitive native command
/// reads the principal from this state rather than trusting an IPC account id.
pub struct AccountSecuritySession {
    active: parking_lot::RwLock<Option<ActiveAccountSecuritySession>>,
    throttle: parking_lot::Mutex<HashMap<String, PasswordThrottleRecord>>,
    throttle_path: Option<PathBuf>,
}

impl AccountSecuritySession {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let throttle_path = data_dir.map(|dir| dir.join("cognia").join("account-throttle.json"));
        let throttle = throttle_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            active: parking_lot::RwLock::new(None),
            throttle: parking_lot::Mutex::new(throttle),
            throttle_path,
        }
    }

    fn activate(&self, account_id: &str, verifier_digest: String) {
        *self.active.write() = Some(ActiveAccountSecuritySession {
            account_id: account_id.to_owned(),
            verifier_digest,
        });
    }

    fn clear(&self) {
        *self.active.write() = None;
    }

    fn require_active(&self) -> Result<ActiveAccountSecuritySession, String> {
        self.active
            .read()
            .clone()
            .ok_or_else(|| "the local account is locked".to_owned())
    }

    fn require_account(&self, account_id: &str) -> Result<ActiveAccountSecuritySession, String> {
        let active = self.require_active()?;
        if active.account_id != account_id {
            return Err("the requested account is not the unlocked account".into());
        }
        Ok(active)
    }

    fn assert_unlock_target(&self, account_id: &str) -> Result<(), String> {
        if self
            .active
            .read()
            .as_ref()
            .is_some_and(|active| active.account_id != account_id)
        {
            return Err(
                "the current account must be locked before another account can be unlocked".into(),
            );
        }
        Ok(())
    }

    fn before_password_attempt(&self, account_id: &str, now: i64) -> Result<(), String> {
        let mut throttle = self.throttle.lock();
        if throttle
            .get(account_id)
            .is_some_and(|record| now.saturating_sub(record.last_failure_at) >= FAILURE_RESET_SECS)
        {
            throttle.remove(account_id);
            self.persist_throttle(&throttle)?;
        }
        if let Some(record) = throttle.get(account_id) {
            if record.blocked_until > now {
                return Err(format!(
                    "too many password attempts; retry in {} seconds",
                    record.blocked_until - now
                ));
            }
        }
        Ok(())
    }

    fn record_password_failure(&self, account_id: &str, now: i64) -> Result<(), String> {
        let mut throttle = self.throttle.lock();
        let record = throttle.entry(account_id.to_owned()).or_default();
        if now.saturating_sub(record.last_failure_at) >= FAILURE_RESET_SECS {
            *record = PasswordThrottleRecord::default();
        }
        record.failures = record.failures.saturating_add(1);
        record.last_failure_at = now;
        if record.failures > 5 {
            let exponent = record.failures.saturating_sub(6).min(31);
            let delay = INITIAL_BACKOFF_SECS
                .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
                .min(MAX_BACKOFF_SECS);
            record.blocked_until = now.saturating_add(delay);
        }
        self.persist_throttle(&throttle)
    }

    fn record_password_success(&self, account_id: &str) -> Result<(), String> {
        let mut throttle = self.throttle.lock();
        throttle.remove(account_id);
        self.persist_throttle(&throttle)
    }

    /// Assert that `account_id` is the account currently unlocked.
    ///
    /// Stronger than [`Self::assert_unlock_target`], which only refuses a
    /// DIFFERENT account. Enrolling a quick-unlock method mints a new way into
    /// an account, so it requires that account to be open right now, not
    /// merely that no other one is.
    pub fn assert_unlocked_account(&self, account_id: &str) -> Result<(), String> {
        self.require_account(account_id).map(|_| ())
    }

    /// Throttle gate for a quick-unlock attempt.
    ///
    /// Shares the password throttle's storage and backoff, keyed separately so
    /// PIN guesses cannot exhaust the password's allowance or vice versa. The
    /// HARD attempt cap that makes a 20-bit secret defensible lives on the
    /// enrollment record in the renderer. This is the floor underneath it, so
    /// a caller that ignores the cap is still slowed rather than unbounded.
    pub fn before_quick_attempt(&self, throttle_key: &str) -> Result<(), String> {
        self.before_password_attempt(throttle_key, unix_time_secs())
    }

    /// Record a failed quick-unlock attempt.
    pub fn record_quick_failure(&self, throttle_key: &str) -> Result<(), String> {
        self.record_password_failure(throttle_key, unix_time_secs())
    }

    /// Record a successful quick-unlock attempt.
    pub fn record_quick_success(&self, throttle_key: &str) -> Result<(), String> {
        self.record_password_success(throttle_key)
    }

    /// Grant a quick unlock exactly the authority a password unlock grants.
    ///
    /// Takes the account's PASSWORD verifier, and binds the host with that
    /// digest rather than with anything derived from the quick credential.
    /// The companion host records which account plus verifier it serves, so a
    /// quick unlock that bound a different digest would read as a different
    /// credential and be refused as a binding mismatch. The password verifier
    /// is not secret material and is not checked here: it names the account,
    /// and the quick verifier is what was actually proven.
    pub fn activate_quick_unlock(
        &self,
        account_id: &str,
        password_verifier: &AccountPasswordVerifier,
        plugin_state: &cognia_plugin_runtime::PluginRuntimeState,
    ) -> Result<(), String> {
        self.assert_unlock_target(account_id)?;
        validate_verifier_metadata(password_verifier)?;
        bind_host_to_account(account_id, password_verifier)?;
        if let Err(error) = plugin_state.activate_account(account_id) {
            crate::companion_api::host_identity::unbind_local_account();
            return Err(error.to_string());
        }
        self.activate(account_id, verifier_digest_of(password_verifier));
        Ok(())
    }

    fn persist_throttle(
        &self,
        throttle: &HashMap<String, PasswordThrottleRecord>,
    ) -> Result<(), String> {
        let Some(path) = self.throttle_path.as_ref() else {
            return Ok(());
        };
        let parent = path
            .parent()
            .ok_or_else(|| "account throttle path has no parent".to_owned())?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create account security directory: {error}"))?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(throttle)
            .map_err(|error| format!("could not encode account throttle state: {error}"))?;
        std::fs::write(&temporary, bytes)
            .map_err(|error| format!("could not persist account throttle state: {error}"))?;
        std::fs::rename(&temporary, path)
            .map_err(|error| format!("could not commit account throttle state: {error}"))
    }
}

fn unix_time_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

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
    app: tauri::AppHandle,
    security_session: tauri::State<'_, AccountSecuritySession>,
    password: String,
    verifier: AccountPasswordVerifier,
    account_id: Option<String>,
) -> Result<bool, String> {
    let plugin_state = app.state::<cognia_plugin_runtime::PluginRuntimeState>();
    account_password_verify_inner(
        password,
        verifier,
        account_id,
        Some(&plugin_state),
        Some(&security_session),
        unix_time_secs(),
    )
}

fn account_password_verify_inner(
    password: String,
    verifier: AccountPasswordVerifier,
    account_id: Option<String>,
    plugin_state: Option<&cognia_plugin_runtime::PluginRuntimeState>,
    security_session: Option<&AccountSecuritySession>,
    now: i64,
) -> Result<bool, String> {
    validate_password(&password)?;
    validate_verifier_metadata(&verifier)?;
    // Throttle EVERY attempt, not just the ones that name an account.
    // `account_id` is optional on the wire, so gating the backoff on it meant a
    // caller could simply omit it and get an unlimited, unthrottled oracle
    // against the very same verifier. When it is absent the verifier's own
    // digest is the stable stand-in key: it identifies the credential being
    // guessed just as well, and cannot be varied by the caller without
    // changing which verifier they are attacking.
    let throttle_key = match account_id.as_deref() {
        Some(account_id) => account_id.to_owned(),
        None => format!("verifier:{}", verifier_digest_of(&verifier)),
    };
    if let Some(security_session) = security_session {
        if let Some(account_id) = account_id.as_deref() {
            security_session.assert_unlock_target(account_id)?;
        }
        security_session.before_password_attempt(&throttle_key, now)?;
    }
    let salt = decode_base64_field("salt", &verifier.salt, SALT_B64_LEN, SALT_LEN)?;
    let expected = decode_base64_field("hash", &verifier.hash, HASH_B64_LEN, OUTPUT_LEN)?;
    let actual = derive_hash(&password, &salt, &verifier.params)?;
    let matched = constant_time_eq(&actual, &expected);

    if matched {
        // Persist the successful authentication outcome before exposing
        // any account-scoped native authority. If the throttle file cannot
        // be committed, fail while the host and plugin runtime are still
        // locked rather than leaving a partially activated session.
        if let Some(security_session) = security_session {
            security_session.record_password_success(&throttle_key)?;
        }
        if let Some(account_id) = account_id.as_deref() {
            bind_host_to_account(account_id, &verifier)?;
            if let Some(plugin_state) = plugin_state {
                if let Err(error) = plugin_state.activate_account(account_id) {
                    crate::companion_api::host_identity::unbind_local_account();
                    return Err(error.to_string());
                }
            }
            if let Some(security_session) = security_session {
                security_session.activate(account_id, verifier_digest_of(&verifier));
            }
        }
    } else if let Some(security_session) = security_session {
        security_session.record_password_failure(&throttle_key, now)?;
    }
    Ok(matched)
}

/// Drop this host's in-process account binding. Called when an account locks or
/// the app switches away from it; the recorded tenant is left untouched.
#[tauri::command]
pub async fn account_unbind_local(
    app: tauri::AppHandle,
    security_session: tauri::State<'_, AccountSecuritySession>,
) -> Result<(), String> {
    security_session.clear();
    crate::companion_api::host_identity::unbind_local_account();
    let plugin_state = app.state::<cognia_plugin_runtime::PluginRuntimeState>();
    let python_state = app.state::<cognia_plugin_runtime::python::PythonRuntimeState>();
    let wasm_state = app.state::<cognia_plugin_runtime::wasm::WasmPluginState>();
    let vscode_state = app.state::<cognia_plugin_runtime::vscode::VscodeExtensionState>();
    cognia_plugin_runtime::teardown_account_runtimes(
        &plugin_state,
        &python_state,
        &wasm_state,
        &vscode_state,
    )
    .await
    .map_err(|error| error.to_string())
}

/// Re-authenticate and rotate the native verifier pin as one sensitive command.
///
/// `new_verifier` is accepted for compensating rollback: the renderer can
/// restore the exact old registry value if its IndexedDB commit fails. It is
/// still recomputed against `new_password` here before the host trusts it.
#[tauri::command]
pub fn account_password_rotate(
    security_session: tauri::State<'_, AccountSecuritySession>,
    account_id: String,
    current_password: String,
    current_verifier: AccountPasswordVerifier,
    new_password: String,
    new_verifier: Option<AccountPasswordVerifier>,
) -> Result<AccountPasswordVerifier, String> {
    account_password_rotate_inner(
        &security_session,
        account_id,
        current_password,
        current_verifier,
        new_password,
        new_verifier,
        unix_time_secs(),
    )
}

fn account_password_rotate_inner(
    security_session: &AccountSecuritySession,
    account_id: String,
    current_password: String,
    current_verifier: AccountPasswordVerifier,
    new_password: String,
    new_verifier: Option<AccountPasswordVerifier>,
    now: i64,
) -> Result<AccountPasswordVerifier, String> {
    let active = security_session.require_account(&account_id)?;
    if active.verifier_digest != verifier_digest_of(&current_verifier) {
        return Err("the current verifier does not match the unlocked session".into());
    }
    security_session.before_password_attempt(&account_id, now)?;
    if !verify_password_material(&current_password, &current_verifier)? {
        security_session.record_password_failure(&account_id, now)?;
        return Err("current password is invalid".into());
    }
    let verifier = match new_verifier {
        Some(verifier) => {
            if !verify_password_material(&new_password, &verifier)? {
                return Err("new verifier does not match the new password".into());
            }
            verifier
        }
        None => account_password_create_verifier(new_password)?,
    };
    rebind_host_verifier(&account_id, &verifier)?;
    security_session.record_password_success(&account_id)?;
    security_session.activate(&account_id, verifier_digest_of(&verifier));
    Ok(verifier)
}

/// Record which person this profile belongs to, after a verified Logto sign-in.
///
/// ADR-0149 §9. Deliberately a separate command from the unlock path: an unlock
/// proves a profile, a sign-in asserts a person, and the renderer supplies the
/// user id — so it must never travel on the verifier-pin path.
///
/// A host with no security database (no companion server has ever run here) is
/// a normal desktop state, so it is reported as success with nothing recorded,
/// exactly as `bind_host_to_account` treats it.
#[tauri::command]
pub async fn account_bind_person(
    security_session: tauri::State<'_, AccountSecuritySession>,
    access_token: String,
    user_id: String,
    org_id: Option<String>,
) -> Result<(), String> {
    use crate::companion_api::host_identity::{
        adopt_unowned_devices, bind_person, HostIdentityError,
    };

    let active = security_session.require_active()?;
    // The trust anchor is HOST configuration, never an IPC argument.
    //
    // Taking `issuer`/`audience` from the renderer let the caller pick which
    // key set validated its own token: point `issuer` at an attacker-controlled
    // OIDC discovery endpoint, mint a token there, and it verified. The
    // `expected_user_id`/`expected_org_id` comparison below could not catch it
    // either, because those ids were derived from the SAME caller-supplied
    // issuer, so the check compared an attacker's value against itself. It was
    // also an SSRF primitive: the host fetched any URL named over IPC.
    //
    // `from_env()` reads COGNIA_LOGTO_ISSUER / COGNIA_LOGTO_AUDIENCE and is
    // `None` on a host with no identity provider configured — an unconfigured
    // host must refuse to bind a person, not accept one on the caller's word.
    let verifier = crate::companion_api::oidc::OidcAuthenticator::from_env().ok_or_else(|| {
        "this host is not configured for Logto sign-in (COGNIA_LOGTO_ISSUER / \
         COGNIA_LOGTO_AUDIENCE are unset)"
            .to_owned()
    })?;
    let issuer = verifier.issuer().to_owned();
    let claims = verifier
        .authenticate(&access_token)
        .await
        .map_err(|error| format!("Logto access token was rejected: {error}"))?;
    let expected_user_id = derive_identity_id("usr_", "user", &issuer, &claims.sub);
    let expected_org_id = claims
        .organization_id
        .as_deref()
        .map(|organization| derive_identity_id("org_", "org", &issuer, organization));
    if user_id != expected_user_id || org_id != expected_org_id {
        return Err("the requested person does not match the verified Logto token".into());
    }

    match bind_person(&active.account_id, &user_id, org_id.as_deref()) {
        Ok(()) => {
            // ADR-0149 §5 step one: the devices on this profile that nobody has
            // claimed belong to whoever just proved they hold it. Best-effort —
            // a failure here leaves the binding standing, because the person is
            // the fact that matters and the attribution can be redone.
            adopt_unowned_devices(&active.account_id)
                .map(|_| ())
                .map_err(|error| {
                    format!("person bound but device adoption must be retried: {error}")
                })
        }
        Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Forget the person on this profile (sign-out). The profile binding and every
/// device paired to it survive.
#[tauri::command]
pub fn account_unbind_person(
    security_session: tauri::State<'_, AccountSecuritySession>,
) -> Result<(), String> {
    use crate::companion_api::host_identity::{unbind_person, HostIdentityError};

    let active = security_session.require_active()?;
    match unbind_person(&active.account_id) {
        Ok(()) => Ok(()),
        Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Read the person recorded for this profile, so the renderer can detect a
/// disagreement between its own binding and the host's.
#[tauri::command]
pub fn account_person(
    security_session: tauri::State<'_, AccountSecuritySession>,
) -> Result<Option<crate::companion_api::host_identity::HostPerson>, String> {
    use crate::companion_api::host_identity::{person, HostIdentityError};

    let active = security_session.require_active()?;
    match person(&active.account_id) {
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

fn rebind_host_verifier(
    account_id: &str,
    verifier: &AccountPasswordVerifier,
) -> Result<(), String> {
    use crate::companion_api::host_identity::{rebind_verifier, HostIdentityError};

    match rebind_verifier(account_id, &verifier_digest_of(verifier)) {
        Ok(()) | Err(HostIdentityError::StoreUnavailable) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn verify_password_material(
    password: &str,
    verifier: &AccountPasswordVerifier,
) -> Result<bool, String> {
    validate_password(password)?;
    validate_verifier_metadata(verifier)?;
    let salt = decode_base64_field("salt", &verifier.salt, SALT_B64_LEN, SALT_LEN)?;
    let expected = decode_base64_field("hash", &verifier.hash, HASH_B64_LEN, OUTPUT_LEN)?;
    let actual = derive_hash(password, &salt, &verifier.params)?;
    Ok(constant_time_eq(&actual, &expected))
}

fn verifier_digest_of(verifier: &AccountPasswordVerifier) -> String {
    crate::companion_api::host_identity::verifier_digest(
        &verifier.algorithm,
        &verifier.salt,
        &verifier.hash,
    )
}

fn derive_identity_id(prefix: &str, kind: &str, issuer: &str, subject: &str) -> String {
    let digest = sha2::Sha256::digest(format!("{kind}\n{issuer}\n{subject}").as_bytes());
    format!("{prefix}{}", hex::encode(digest)[..24].to_owned())
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

/// The Argon2id cost every account credential is derived at.
///
/// Public so `account_quick_unlock` derives at the same cost. One definition
/// means a future hardening bump cannot move the password and leave the PIN
/// behind.
pub fn default_kdf_params() -> AccountPasswordKdfParams {
    default_params()
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

    fn account_password_verify(
        password: String,
        verifier: AccountPasswordVerifier,
        account_id: Option<String>,
    ) -> Result<bool, String> {
        account_password_verify_inner(password, verifier, account_id, None, None, 0)
    }

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

        let session = AccountSecuritySession::new(None);
        let first = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();
        account_password_verify_inner(
            "correct horse".into(),
            first.clone(),
            Some("acct_one".into()),
            None,
            Some(&session),
            1,
        )
        .unwrap();

        let rotated = create_password_verifier_with_salt("battery staple", &[8_u8; 16]).unwrap();
        let rotated = account_password_rotate_inner(
            &session,
            "acct_one".into(),
            "correct horse".into(),
            first,
            "battery staple".into(),
            Some(rotated),
            2,
        )
        .unwrap();
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

    /// Omitting the optional `account_id` must not buy an unthrottled oracle.
    ///
    /// The backoff used to be gated on `account_id` being present, so a caller
    /// could drop one field and guess against the same Argon2id verifier
    /// forever. Without an account id the verifier's own digest is the key.
    #[test]
    fn password_attempts_are_throttled_even_without_an_account_id() {
        let dir = tempfile::tempdir().unwrap();
        let session = AccountSecuritySession::new(Some(dir.path().to_path_buf()));
        let verifier = create_password_verifier_with_salt("correct horse", &[7_u8; 16]).unwrap();

        for attempt in 1..=6 {
            assert!(!account_password_verify_inner(
                "wrong password".into(),
                verifier.clone(),
                None,
                None,
                Some(&session),
                attempt,
            )
            .unwrap());
        }

        // The 7th attempt is refused before any derivation runs — and the
        // CORRECT password is refused too, which is what a real lockout means.
        let blocked = account_password_verify_inner(
            "correct horse".into(),
            verifier.clone(),
            None,
            None,
            Some(&session),
            6,
        )
        .unwrap_err();
        assert!(blocked.contains("too many password attempts"), "{blocked}");

        // A different verifier is a different credential, so it is unaffected.
        let other = create_password_verifier_with_salt("other secret", &[9_u8; 16]).unwrap();
        assert!(account_password_verify_inner(
            "other secret".into(),
            other,
            None,
            None,
            Some(&session),
            6
        )
        .unwrap());
    }

    #[test]
    fn password_backoff_is_persistent_and_resets_after_thirty_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let session = AccountSecuritySession::new(Some(dir.path().to_path_buf()));
        for failure in 1..=5 {
            session
                .before_password_attempt("acct_one", failure)
                .unwrap();
            session
                .record_password_failure("acct_one", failure)
                .unwrap();
        }
        session.before_password_attempt("acct_one", 6).unwrap();
        session.record_password_failure("acct_one", 6).unwrap();
        assert!(session
            .before_password_attempt("acct_one", 6)
            .unwrap_err()
            .contains("30 seconds"));

        let reloaded = AccountSecuritySession::new(Some(dir.path().to_path_buf()));
        assert!(reloaded.before_password_attempt("acct_one", 20).is_err());
        reloaded
            .before_password_attempt("acct_one", 6 + FAILURE_RESET_SECS)
            .unwrap();
    }

    #[test]
    fn an_active_security_session_cannot_be_retargeted_by_ipc_input() {
        let session = AccountSecuritySession::new(None);
        session.activate("acct_one", "digest".into());
        assert_eq!(
            session.require_account("acct_one").unwrap().account_id,
            "acct_one"
        );
        assert!(session.require_account("acct_two").is_err());
        assert!(session.assert_unlock_target("acct_one").is_ok());
        assert!(session
            .assert_unlock_target("acct_two")
            .unwrap_err()
            .contains("must be locked"));
        session.clear();
        assert!(session.require_active().unwrap_err().contains("locked"));
    }

    #[test]
    fn native_logto_identity_derivation_matches_the_renderer_contract() {
        assert_eq!(
            derive_identity_id("usr_", "user", "https://logto.test/oidc", "subject-1"),
            "usr_d066005448858a8ba6bb2f96"
        );
        assert_eq!(
            derive_identity_id("org_", "org", "https://logto.test/oidc", "tenant-1"),
            "org_b6f56214a98891636d36e8c5"
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
