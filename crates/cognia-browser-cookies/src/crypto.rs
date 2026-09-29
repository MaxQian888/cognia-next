//! Chromium's value encryption (`os_crypt`) on each desktop OS.
//!
//! | OS | Key | Cipher |
//! | --- | --- | --- |
//! | macOS | PBKDF2-HMAC-SHA1(Keychain Safe Storage passphrase, `saltysalt`, 1003) | `v10` AES-128-CBC, IV sixteen `0x20` |
//! | Linux | `v10`: PBKDF2(`peanuts`, `saltysalt`, 1); `v11`: PBKDF2(Secret Service password, `saltysalt`, 1) | AES-128-CBC, same IV |
//! | Windows | `Local State` `os_crypt.encrypted_key`, base64, `DPAPI` prefix, DPAPI-unwrapped | `v10`/`v11` AES-256-GCM, 12-byte nonce |
//!
//! `v20` values (Windows App-Bound Encryption) are never decrypted; callers
//! count them. The OS secret sources sit behind [`OsSecrets`] so every branch
//! is testable on any OS.

use std::fmt;
use std::path::Path;

use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::browsers::{Browser, Os};
use crate::ImportError;

/// Where each OS keeps a Chromium browser's key material.
pub trait OsSecrets {
    /// macOS: the Keychain generic password `(service, account)`.
    fn keychain_password(&self, service: &str, account: &str) -> Result<String, ImportError>;
    /// Windows: `CryptUnprotectData` for the current user.
    fn dpapi_unprotect(&self, data: &[u8]) -> Result<Vec<u8>, ImportError>;
    /// Linux: the Secret Service password stored for `application`, if any.
    fn secret_service_password(&self, application: &str) -> Result<Option<String>, ImportError>;
}

/// A Chromium profile's value key.
#[derive(Clone, PartialEq, Eq)]
pub enum ChromiumKey {
    /// macOS and Linux: AES-128-CBC keys for the `v10` and `v11` prefixes.
    Cbc {
        v10: [u8; 16],
        v11: Option<[u8; 16]>,
    },
    /// Windows: the AES-256-GCM key for `v10`/`v11`.
    Gcm([u8; 32]),
}

impl fmt::Debug for ChromiumKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cbc { v11, .. } => write!(f, "ChromiumKey::Cbc {{ v11: {} }}", v11.is_some()),
            Self::Gcm(_) => f.write_str("ChromiumKey::Gcm"),
        }
    }
}

impl Drop for ChromiumKey {
    fn drop(&mut self) {
        match self {
            Self::Cbc { v10, v11 } => {
                v10.zeroize();
                if let Some(v11) = v11 {
                    v11.zeroize();
                }
            }
            Self::Gcm(key) => key.zeroize(),
        }
    }
}

const MAC_ITERATIONS: u32 = 1003;
const LINUX_ITERATIONS: u32 = 1;
const LINUX_V10_PASSWORD: &str = "peanuts";

pub fn derive_cbc_key(passphrase: &str, iterations: u32) -> [u8; 16] {
    let mut key = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(passphrase.as_bytes(), b"saltysalt", iterations, &mut key);
    key
}

impl ChromiumKey {
    /// The macOS key from a Keychain Safe Storage passphrase.
    pub fn macos(passphrase: &str) -> Self {
        Self::Cbc {
            v10: derive_cbc_key(passphrase, MAC_ITERATIONS),
            v11: None,
        }
    }

    /// The Linux keys: the fixed `v10` key and, when the Secret Service holds
    /// one, the `v11` key.
    pub fn linux(secret_service_password: Option<&str>) -> Self {
        Self::Cbc {
            v10: derive_cbc_key(LINUX_V10_PASSWORD, LINUX_ITERATIONS),
            v11: secret_service_password.map(|password| derive_cbc_key(password, LINUX_ITERATIONS)),
        }
    }
}

/// The outcome of decrypting one stored value.
#[derive(PartialEq, Eq)]
pub enum Decrypted {
    Value(Vec<u8>),
    /// A `v20` App-Bound value: never decrypted, counted by the caller.
    AppBound,
    Invalid,
}

impl fmt::Debug for Decrypted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Value(_) => f.write_str("Decrypted::Value([REDACTED])"),
            Self::AppBound => f.write_str("Decrypted::AppBound"),
            Self::Invalid => f.write_str("Decrypted::Invalid"),
        }
    }
}

impl Drop for Decrypted {
    fn drop(&mut self) {
        if let Self::Value(bytes) = self {
            bytes.zeroize();
        }
    }
}

impl Decrypted {
    /// The plaintext, taken out of the wrapper.
    pub fn take(mut self) -> Option<Vec<u8>> {
        match &mut self {
            Self::Value(bytes) => Some(std::mem::take(bytes)),
            _ => None,
        }
    }
}

const CBC_IV: [u8; 16] = [0x20; 16];

/// Decrypt one stored value. The caller strips any host-hash prefix.
pub fn decrypt_value(key: &ChromiumKey, encrypted: &[u8]) -> Decrypted {
    if encrypted.starts_with(b"v20") {
        return Decrypted::AppBound;
    }
    let (version, body) = if let Some(body) = encrypted.strip_prefix(b"v10") {
        (10, body)
    } else if let Some(body) = encrypted.strip_prefix(b"v11") {
        (11, body)
    } else {
        return Decrypted::Invalid;
    };
    match key {
        ChromiumKey::Cbc { v10, v11 } => {
            let key = match (version, v11) {
                (10, _) => v10,
                (11, Some(v11)) => v11,
                _ => return Decrypted::Invalid,
            };
            match cbc::Decryptor::<Aes128>::new(&(*key).into(), &CBC_IV.into())
                .decrypt_padded_vec::<Pkcs7>(body)
            {
                Ok(plaintext) => Decrypted::Value(plaintext),
                Err(_) => Decrypted::Invalid,
            }
        }
        ChromiumKey::Gcm(key) => {
            if body.len() < 12 + 16 {
                return Decrypted::Invalid;
            }
            let (nonce, ciphertext) = body.split_at(12);
            let Ok(nonce) = Nonce::try_from(nonce) else {
                return Decrypted::Invalid;
            };
            let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
            match cipher.decrypt(&nonce, ciphertext) {
                Ok(plaintext) => Decrypted::Value(plaintext),
                Err(_) => Decrypted::Invalid,
            }
        }
    }
}

/// Strip and verify the `SHA256(host_key)` prefix cookie databases from
/// version 24 on put in front of each value.
pub fn strip_host_hash(mut plaintext: Vec<u8>, host_key: &str) -> Option<Vec<u8>> {
    let expected = Sha256::digest(host_key.as_bytes());
    if plaintext.len() < expected.len() || plaintext[..expected.len()] != expected[..] {
        plaintext.zeroize();
        return None;
    }
    plaintext.drain(..expected.len());
    Some(plaintext)
}

/// The Windows profile key: `Local State` → `os_crypt.encrypted_key` →
/// base64 → `DPAPI` prefix → `CryptUnprotectData`.
pub fn windows_key(
    user_data_dir: &Path,
    secrets: &dyn OsSecrets,
) -> Result<ChromiumKey, ImportError> {
    let raw =
        std::fs::read(user_data_dir.join("Local State")).map_err(|_| ImportError::Decryption)?;
    let json: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| ImportError::Decryption)?;
    let encoded = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(serde_json::Value::as_str)
        .ok_or(ImportError::Decryption)?;
    let wrapped = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ImportError::Decryption)?;
    let blob = wrapped
        .strip_prefix(b"DPAPI")
        .ok_or(ImportError::Decryption)?;
    let mut unwrapped = secrets.dpapi_unprotect(blob)?;
    let key: [u8; 32] = match unwrapped.as_slice().try_into() {
        Ok(key) => key,
        Err(_) => {
            unwrapped.zeroize();
            return Err(ImportError::Decryption);
        }
    };
    unwrapped.zeroize();
    Ok(ChromiumKey::Gcm(key))
}

/// Resolve `browser`'s value key on `os`. `Ok(None)` means the browser has
/// no key material (an empty macOS Safe Storage passphrase): nothing it stored
/// encrypted can be read, and the import reports no matching data.
pub fn resolve_chromium_key(
    browser: Browser,
    os: Os,
    user_data_dir: &Path,
    secrets: &dyn OsSecrets,
) -> Result<Option<ChromiumKey>, ImportError> {
    match os {
        Os::MacOs => {
            let (service, account) = browser
                .mac_safe_storage()
                .ok_or(ImportError::UnsupportedOs)?;
            let mut passphrase = secrets.keychain_password(service, account)?;
            if passphrase.is_empty() {
                return Ok(None);
            }
            let key = ChromiumKey::macos(&passphrase);
            passphrase.zeroize();
            Ok(Some(key))
        }
        Os::Linux => {
            let application = browser
                .linux_secret_application()
                .ok_or(ImportError::UnsupportedOs)?;
            // A missing or unreachable Secret Service only loses the v11
            // values; v10 ("peanuts") rows still import.
            let mut password = match secrets.secret_service_password(application) {
                Ok(password) => password,
                Err(error) => {
                    log::info!("secret service lookup for {application} failed: {error}");
                    None
                }
            };
            let key = ChromiumKey::linux(password.as_deref());
            if let Some(password) = password.as_mut() {
                password.zeroize();
            }
            Ok(Some(key))
        }
        Os::Windows => windows_key(user_data_dir, secrets).map(Some),
        Os::Other => Err(ImportError::UnsupportedOs),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::cell::RefCell;

    use aes::Aes128;
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use cbc::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};

    use super::*;

    pub fn encrypt_cbc(prefix: &[u8], key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
        let ciphertext = cbc::Encryptor::<Aes128>::new(&(*key).into(), &CBC_IV.into())
            .encrypt_padded_vec::<Pkcs7>(plaintext);
        [prefix, ciphertext.as_slice()].concat()
    }

    pub fn encrypt_gcm(
        prefix: &[u8],
        key: &[u8; 32],
        nonce: [u8; 12],
        plaintext: &[u8],
    ) -> Vec<u8> {
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
        let ciphertext = cipher.encrypt(&Nonce::from(nonce), plaintext).unwrap();
        [prefix, nonce.as_slice(), ciphertext.as_slice()].concat()
    }

    /// Fake OS secrets: a fixed Keychain passphrase, "DPAPI" that XORs with
    /// 0x5a, and a fixed Secret Service password.
    #[derive(Default)]
    pub struct FakeSecrets {
        pub keychain: Option<Result<String, ImportError>>,
        pub secret_service: Option<Result<Option<String>, ImportError>>,
        pub dpapi_fails: bool,
        pub calls: RefCell<Vec<String>>,
    }

    pub fn fake_dpapi_wrap(data: &[u8]) -> Vec<u8> {
        data.iter().map(|byte| byte ^ 0x5a).collect()
    }

    impl OsSecrets for FakeSecrets {
        fn keychain_password(&self, service: &str, account: &str) -> Result<String, ImportError> {
            self.calls
                .borrow_mut()
                .push(format!("keychain:{service}:{account}"));
            self.keychain
                .clone()
                .unwrap_or(Err(ImportError::PermissionDenied))
        }

        fn dpapi_unprotect(&self, data: &[u8]) -> Result<Vec<u8>, ImportError> {
            self.calls.borrow_mut().push("dpapi".into());
            if self.dpapi_fails {
                return Err(ImportError::PermissionDenied);
            }
            Ok(fake_dpapi_wrap(data))
        }

        fn secret_service_password(
            &self,
            application: &str,
        ) -> Result<Option<String>, ImportError> {
            self.calls
                .borrow_mut()
                .push(format!("secret-service:{application}"));
            self.secret_service.clone().unwrap_or(Ok(None))
        }
    }

    pub fn write_windows_local_state(dir: &Path, key: &[u8; 32]) {
        let wrapped = [b"DPAPI".as_slice(), fake_dpapi_wrap(key).as_slice()].concat();
        let encoded = base64::engine::general_purpose::STANDARD.encode(wrapped);
        std::fs::write(
            dir.join("Local State"),
            serde_json::json!({ "os_crypt": { "encrypted_key": encoded } }).to_string(),
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn derives_the_documented_macos_key() {
        assert_eq!(
            hex::encode(derive_cbc_key("test-passphrase", 1003)),
            "1520ca2d2c5dceeeebcd3a50818a46c7"
        );
    }

    #[test]
    fn decrypts_macos_v10() {
        let key = ChromiumKey::macos("pass");
        let ChromiumKey::Cbc { v10, .. } = &key else {
            unreachable!()
        };
        let encrypted = encrypt_cbc(b"v10", v10, b"value");
        assert_eq!(decrypt_value(&key, &encrypted).take().unwrap(), b"value");
        // macOS has no v11 key.
        let v11 = encrypt_cbc(b"v11", v10, b"value");
        assert_eq!(decrypt_value(&key, &v11), Decrypted::Invalid);
    }

    #[test]
    fn decrypts_linux_v10_with_peanuts_and_v11_with_the_secret_service_password() {
        let key = ChromiumKey::linux(Some("keyring-pass"));
        let v10 = encrypt_cbc(b"v10", &derive_cbc_key("peanuts", 1), b"old");
        let v11 = encrypt_cbc(b"v11", &derive_cbc_key("keyring-pass", 1), b"new");
        assert_eq!(decrypt_value(&key, &v10).take().unwrap(), b"old");
        assert_eq!(decrypt_value(&key, &v11).take().unwrap(), b"new");
        let without = ChromiumKey::linux(None);
        assert_eq!(decrypt_value(&without, &v11), Decrypted::Invalid);
        assert_eq!(decrypt_value(&without, &v10).take().unwrap(), b"old");
    }

    #[test]
    fn decrypts_windows_gcm_and_counts_app_bound() {
        let key_bytes = [7_u8; 32];
        let key = ChromiumKey::Gcm(key_bytes);
        let v10 = encrypt_gcm(b"v10", &key_bytes, [1; 12], b"gcm-value");
        assert_eq!(decrypt_value(&key, &v10).take().unwrap(), b"gcm-value");
        let v11 = encrypt_gcm(b"v11", &key_bytes, [2; 12], b"v11-value");
        assert_eq!(decrypt_value(&key, &v11).take().unwrap(), b"v11-value");
        let app_bound = encrypt_gcm(b"v20", &key_bytes, [3; 12], b"bound");
        assert_eq!(decrypt_value(&key, &app_bound), Decrypted::AppBound);
        let mut tampered = v10.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(decrypt_value(&key, &tampered), Decrypted::Invalid);
        assert_eq!(decrypt_value(&key, b"v10short"), Decrypted::Invalid);
        assert_eq!(decrypt_value(&key, b"plain"), Decrypted::Invalid);
    }

    #[test]
    fn host_hash_prefix_is_verified() {
        let with_hash = [Sha256::digest(b".example.com").as_slice(), b"value"].concat();
        assert_eq!(
            strip_host_hash(with_hash.clone(), ".example.com").unwrap(),
            b"value"
        );
        assert_eq!(strip_host_hash(with_hash, ".other.com"), None);
        assert_eq!(strip_host_hash(b"short".to_vec(), ".example.com"), None);
    }

    #[test]
    fn resolves_macos_key_from_the_keychain_and_skips_empty_passphrases() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = FakeSecrets {
            keychain: Some(Ok("pass".into())),
            ..Default::default()
        };
        let key = resolve_chromium_key(Browser::Vivaldi, Os::MacOs, dir.path(), &secrets)
            .unwrap()
            .unwrap();
        assert_eq!(key, ChromiumKey::macos("pass"));
        assert_eq!(
            secrets.calls.borrow().as_slice(),
            ["keychain:Vivaldi Safe Storage:Vivaldi"]
        );
        let empty = FakeSecrets {
            keychain: Some(Ok(String::new())),
            ..Default::default()
        };
        assert_eq!(
            resolve_chromium_key(Browser::Chrome, Os::MacOs, dir.path(), &empty).unwrap(),
            None
        );
        let denied = FakeSecrets::default();
        assert_eq!(
            resolve_chromium_key(Browser::Chrome, Os::MacOs, dir.path(), &denied),
            Err(ImportError::PermissionDenied)
        );
    }

    #[test]
    fn resolves_linux_keys_even_when_the_secret_service_fails() {
        let dir = tempfile::tempdir().unwrap();
        let ok = FakeSecrets {
            secret_service: Some(Ok(Some("pw".into()))),
            ..Default::default()
        };
        assert_eq!(
            resolve_chromium_key(Browser::Brave, Os::Linux, dir.path(), &ok).unwrap(),
            Some(ChromiumKey::linux(Some("pw")))
        );
        assert_eq!(ok.calls.borrow().as_slice(), ["secret-service:brave"]);
        let failing = FakeSecrets {
            secret_service: Some(Err(ImportError::PermissionDenied)),
            ..Default::default()
        };
        assert_eq!(
            resolve_chromium_key(Browser::Chrome, Os::Linux, dir.path(), &failing).unwrap(),
            Some(ChromiumKey::linux(None))
        );
        assert_eq!(
            resolve_chromium_key(Browser::Arc, Os::Linux, dir.path(), &failing),
            Err(ImportError::UnsupportedOs)
        );
    }

    #[test]
    fn resolves_the_windows_key_through_dpapi() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = FakeSecrets::default();
        assert_eq!(
            resolve_chromium_key(Browser::Edge, Os::Windows, dir.path(), &secrets),
            Err(ImportError::Decryption)
        );
        write_windows_local_state(dir.path(), &[9; 32]);
        assert_eq!(
            resolve_chromium_key(Browser::Edge, Os::Windows, dir.path(), &secrets).unwrap(),
            Some(ChromiumKey::Gcm([9; 32]))
        );
        let failing = FakeSecrets {
            dpapi_fails: true,
            ..Default::default()
        };
        assert_eq!(
            resolve_chromium_key(Browser::Edge, Os::Windows, dir.path(), &failing),
            Err(ImportError::PermissionDenied)
        );
        std::fs::write(
            dir.path().join("Local State"),
            r#"{"os_crypt":{"encrypted_key":"bm9wcmVmaXg="}}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_chromium_key(Browser::Edge, Os::Windows, dir.path(), &secrets),
            Err(ImportError::Decryption)
        );
    }

    #[test]
    fn debug_output_never_contains_key_material() {
        let key = ChromiumKey::Gcm([0xab; 32]);
        assert!(!format!("{key:?}").contains("171"));
        assert_eq!(
            format!("{:?}", Decrypted::Value(b"secret".to_vec())),
            "Decrypted::Value([REDACTED])"
        );
        assert_eq!(
            format!("{:?}", ChromiumKey::linux(Some("x"))),
            "ChromiumKey::Cbc { v11: true }"
        );
    }
}
