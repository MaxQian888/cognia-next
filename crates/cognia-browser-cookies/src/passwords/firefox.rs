//! Firefox's saved passwords: `logins.json` fields decrypted with the key in
//! `key4.db` (see [`super::nss`]).

use std::path::Path;

use serde::Deserialize;

use super::nss::load_keys;
use super::{normalize_origin, CredentialBatch, ImportedCredential};
use crate::secret::SecretString;
use crate::ImportError;

#[derive(Deserialize)]
struct LoginsFile {
    #[serde(default)]
    logins: Vec<Login>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    hostname: String,
    #[serde(default)]
    http_realm: Option<String>,
    encrypted_username: String,
    encrypted_password: String,
    #[serde(default)]
    time_created: Option<i64>,
    #[serde(default)]
    time_last_used: Option<i64>,
}

/// Import every login of a profile directory holding `logins.json` and
/// `key4.db`. A primary password stops the import with
/// [`ImportError::PrimaryPasswordSet`].
pub fn read_profile(profile_dir: &Path) -> Result<CredentialBatch, ImportError> {
    let key4 = profile_dir.join("key4.db");
    if !key4.is_file() {
        return Err(ImportError::NoProfile);
    }
    let keys = load_keys(&key4)?;
    let raw = std::fs::read(profile_dir.join("logins.json")).map_err(|_| ImportError::NoProfile)?;
    let file: LoginsFile = serde_json::from_slice(&raw).map_err(|_| ImportError::InvalidFormat)?;
    let mut batch = CredentialBatch::default();
    for login in file.logins {
        let Some(origin) = normalize_origin(&login.hostname) else {
            batch.skipped += 1;
            continue;
        };
        let (Ok(username), Ok(password)) = (
            keys.decrypt_field(&login.encrypted_username),
            keys.decrypt_field(&login.encrypted_password),
        ) else {
            batch.skipped += 1;
            continue;
        };
        if password.is_empty() {
            batch.skipped += 1;
            continue;
        }
        batch.credentials.push(ImportedCredential {
            origin,
            realm: login.http_realm.filter(|realm| !realm.is_empty()),
            username,
            password: SecretString::from(password),
            created_at: login.time_created.filter(|time| *time > 0),
            last_used_at: login.time_last_used.filter(|time| *time > 0),
            note: None,
        });
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::super::nss::test_support::{encrypt_field, write_key4};
    use super::*;
    use crate::browsers::{Browser, HostDirs, Os};

    fn write_logins(dir: &Path, key: &[u8]) {
        let logins = serde_json::json!({
            "nextId": 4,
            "logins": [
                {
                    "hostname": "https://accounts.example.com",
                    "httpRealm": null,
                    "formSubmitURL": "https://accounts.example.com",
                    "encryptedUsername": encrypt_field(key, "alice", false),
                    "encryptedPassword": encrypt_field(key, "wonderland", true),
                    "timeCreated": 1_700_000_000_000_i64,
                    "timeLastUsed": 1_700_000_100_000_i64
                },
                {
                    "hostname": "https://intranet.example.com",
                    "httpRealm": "Staff",
                    "encryptedUsername": encrypt_field(key, "bob", false),
                    "encryptedPassword": encrypt_field(key, "builder", false),
                    "timeCreated": 0
                },
                {
                    "hostname": "chrome://FirefoxAccounts",
                    "encryptedUsername": encrypt_field(key, "x", false),
                    "encryptedPassword": encrypt_field(key, "y", false)
                },
                {
                    "hostname": "https://broken.example.com",
                    "encryptedUsername": "!!",
                    "encryptedPassword": encrypt_field(key, "y", false)
                }
            ]
        });
        std::fs::write(dir.join("logins.json"), logins.to_string()).unwrap();
    }

    #[test]
    fn decrypts_logins_with_the_key4_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = [0x31_u8; 32];
        write_key4(&dir.path().join("key4.db"), b"", &key, false);
        write_logins(dir.path(), &key);
        let batch = read_profile(dir.path()).unwrap();
        assert_eq!(batch.credentials.len(), 2);
        let first = &batch.credentials[0];
        assert_eq!(first.origin, "https://accounts.example.com");
        assert_eq!(first.username, "alice");
        assert_eq!(first.password.expose(), "wonderland");
        assert_eq!(first.created_at, Some(1_700_000_000_000));
        assert_eq!(first.last_used_at, Some(1_700_000_100_000));
        assert_eq!(batch.credentials[1].realm.as_deref(), Some("Staff"));
        assert_eq!(batch.credentials[1].created_at, None);
        assert_eq!(batch.skipped, 2);
    }

    #[test]
    fn a_primary_password_stops_the_import() {
        let dir = tempfile::tempdir().unwrap();
        let key = [0x31_u8; 32];
        write_key4(&dir.path().join("key4.db"), b"primary", &key, true);
        write_logins(dir.path(), &key);
        assert_eq!(
            read_profile(dir.path()).map(|b| b.skipped),
            Err(ImportError::PrimaryPasswordSet)
        );
    }

    #[test]
    fn imports_through_profiles_ini_discovery() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Windows);
        let root = home.path().join("AppData/Roaming/Mozilla/Firefox");
        let relative = crate::firefox::test_support::write_root(&root, &home.path().join("abs"));
        let key = [0x42_u8; 32];
        write_key4(&relative.join("key4.db"), b"", &key, false);
        write_logins(&relative, &key);
        let batch = crate::passwords::import_browser_passwords(
            Browser::Firefox,
            "Profiles/abc.default-release",
            Os::Windows,
            &dirs,
            &crate::crypto::test_support::FakeSecrets::default(),
        )
        .unwrap();
        assert_eq!(batch.credentials.len(), 2);
    }

    #[test]
    fn malformed_logins_json_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        write_key4(&dir.path().join("key4.db"), b"", &[1; 32], false);
        std::fs::write(dir.path().join("logins.json"), "not json").unwrap();
        assert_eq!(
            read_profile(dir.path()).map(|b| b.skipped),
            Err(ImportError::InvalidFormat)
        );
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            read_profile(empty.path()).map(|b| b.skipped),
            Err(ImportError::NoProfile)
        );
    }
}
