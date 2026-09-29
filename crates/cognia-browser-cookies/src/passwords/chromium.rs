//! Chromium's saved passwords (`Login Data`, and `Login Data For Account` for
//! account-store passwords). Values use the same `os_crypt` key as cookies,
//! without a host-hash prefix.

use std::path::{Path, PathBuf};

use zeroize::Zeroize;

use super::{normalize_origin, CredentialBatch, ImportedCredential};
use crate::chromium::{chrome_time_to_unix_ms, open_immutable, snapshot_database, table_columns};
use crate::crypto::{decrypt_value, ChromiumKey, Decrypted};
use crate::secret::SecretString;
use crate::ImportError;

/// Read every login database of a profile. A database that cannot be read is
/// recorded in `errors` when another one could be; if none can, the first
/// error is returned.
pub fn read_login_databases(
    databases: &[PathBuf],
    key: Option<&ChromiumKey>,
) -> Result<CredentialBatch, ImportError> {
    let mut batch = CredentialBatch::default();
    let mut first_error = None;
    let mut read_any = false;
    for database in databases {
        match read_login_database(database, key, &mut batch) {
            Ok(()) => read_any = true,
            Err(error) => {
                batch.errors.push(error.code().to_owned());
                first_error.get_or_insert(error);
            }
        }
    }
    match (read_any, first_error) {
        (false, Some(error)) => Err(error),
        _ => Ok(batch),
    }
}

fn read_login_database(
    source: &Path,
    key: Option<&ChromiumKey>,
    batch: &mut CredentialBatch,
) -> Result<(), ImportError> {
    let snapshot = snapshot_database(source)?;
    let connection = open_immutable(&snapshot.path)?;
    let columns = table_columns(&connection, "logins")?;
    if columns.is_empty() {
        return Err(ImportError::Database);
    }
    let optional = |name: &str, fallback: &'static str| -> String {
        if columns.contains(name) {
            name.to_owned()
        } else {
            fallback.to_owned()
        }
    };
    let sql = format!(
        "SELECT origin_url, username_value, password_value, {}, {}, {}, {} FROM logins",
        optional("signon_realm", "''"),
        optional("date_created", "0"),
        optional("date_last_used", "0"),
        optional("blacklisted_by_user", "0"),
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|_| ImportError::Database)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|_| ImportError::Database)?;
    for row in rows {
        let Ok((origin_url, username, encrypted, signon_realm, created, last_used, blocklisted)) =
            row
        else {
            batch.skipped += 1;
            continue;
        };
        if blocklisted != 0 || encrypted.is_empty() {
            batch.skipped += 1;
            continue;
        }
        let Some(origin) = normalize_origin(&origin_url) else {
            batch.skipped += 1;
            continue;
        };
        let Some(key) = key else {
            batch.skipped += 1;
            continue;
        };
        let password = match decrypt_value(key, &encrypted) {
            Decrypted::AppBound => {
                batch.skipped_app_bound += 1;
                continue;
            }
            decrypted => match decrypted.take().map(String::from_utf8) {
                Some(Ok(password)) if !password.is_empty() => SecretString::from(password),
                Some(Err(error)) => {
                    error.into_bytes().zeroize();
                    batch.skipped += 1;
                    continue;
                }
                _ => {
                    batch.skipped += 1;
                    continue;
                }
            },
        };
        // A form login's signon_realm is its origin plus "/"; anything else
        // (`https://host/ Realm`) is an HTTP-auth realm.
        let realm = signon_realm
            .strip_prefix(&origin)
            .map(|rest| rest.trim_start_matches('/').trim())
            .filter(|rest| !rest.is_empty())
            .map(str::to_owned);
        batch.credentials.push(ImportedCredential {
            origin,
            realm,
            username,
            password,
            created_at: chrome_time_to_unix_ms(created),
            last_used_at: chrome_time_to_unix_ms(last_used),
            note: None,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::browsers::{Browser, HostDirs, Os};
    use crate::crypto::derive_cbc_key;
    use crate::crypto::test_support::{
        encrypt_cbc, encrypt_gcm, write_windows_local_state, FakeSecrets,
    };

    const SCHEMA: &str =
        "CREATE TABLE logins(origin_url TEXT, action_url TEXT, username_value TEXT, \
        password_value BLOB, signon_realm TEXT, date_created INTEGER, blacklisted_by_user INTEGER, \
        date_last_used INTEGER);";

    fn insert(
        conn: &Connection,
        origin: &str,
        user: &str,
        password: &[u8],
        realm: &str,
        blocklisted: i64,
    ) {
        conn.execute(
            "INSERT INTO logins VALUES(?1,'',?2,?3,?4,11644473601000000,?5,11644473602000000)",
            rusqlite::params![origin, user, password, realm, blocklisted],
        )
        .unwrap();
    }

    #[test]
    fn reads_linux_logins_and_skips_what_cannot_be_filled() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("Login Data");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let v10 = derive_cbc_key("peanuts", 1);
        let v11 = derive_cbc_key("kr", 1);
        insert(
            &conn,
            "https://github.com/login",
            "me",
            &encrypt_cbc(b"v10", &v10, b"pw1"),
            "https://github.com/",
            0,
        );
        insert(
            &conn,
            "https://intranet.example.com/",
            "u",
            &encrypt_cbc(b"v11", &v11, b"pw2"),
            "https://intranet.example.com/ Staff",
            0,
        );
        insert(
            &conn,
            "https://blocked.com/",
            "",
            b"",
            "https://blocked.com/",
            1,
        );
        insert(
            &conn,
            "android://hash@com.app/",
            "x",
            &encrypt_cbc(b"v10", &v10, b"pw"),
            "android://hash@com.app/",
            0,
        );
        insert(
            &conn,
            "https://bad.com/",
            "x",
            b"v10garbage",
            "https://bad.com/",
            0,
        );
        drop(conn);

        let key = ChromiumKey::linux(Some("kr"));
        let batch = read_login_databases(&[db], Some(&key)).unwrap();
        assert_eq!(batch.credentials.len(), 2);
        let github = &batch.credentials[0];
        assert_eq!(github.origin, "https://github.com");
        assert_eq!(github.username, "me");
        assert_eq!(github.password.expose(), "pw1");
        assert_eq!(github.realm, None);
        assert_eq!(github.created_at, Some(1_000));
        assert_eq!(github.last_used_at, Some(2_000));
        assert_eq!(batch.credentials[1].realm.as_deref(), Some("Staff"));
        assert_eq!(batch.skipped, 3);
        assert_eq!(batch.skipped_app_bound, 0);
    }

    #[test]
    fn imports_windows_profiles_and_counts_app_bound_rows() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Windows);
        let root = home
            .path()
            .join("AppData/Local/BraveSoftware/Brave-Browser/User Data");
        let profile = root.join("Default");
        std::fs::create_dir_all(&profile).unwrap();
        let key = [5_u8; 32];
        write_windows_local_state(&root, &key);
        for (name, prefix) in [("Login Data", b"v10"), ("Login Data For Account", b"v20")] {
            let conn = Connection::open(profile.join(name)).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            insert(
                &conn,
                "https://a.com/",
                "me",
                &encrypt_gcm(prefix, &key, [1; 12], b"pw"),
                "https://a.com/",
                0,
            );
        }
        let batch = crate::passwords::import_browser_passwords(
            Browser::Brave,
            "Default",
            Os::Windows,
            &dirs,
            &FakeSecrets::default(),
        )
        .unwrap();
        assert_eq!(batch.credentials.len(), 1);
        assert_eq!(batch.credentials[0].password.expose(), "pw");
        assert_eq!(batch.skipped_app_bound, 1);
    }

    #[test]
    fn without_a_key_every_row_is_skipped_and_bad_databases_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("Login Data");
        let conn = Connection::open(&good).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        insert(
            &conn,
            "https://a.com/",
            "me",
            b"v10xxxxxxxxxxxxxxxx",
            "https://a.com/",
            0,
        );
        drop(conn);
        let bad = dir.path().join("Login Data For Account");
        Connection::open(&bad)
            .unwrap()
            .execute_batch("CREATE TABLE other(x);")
            .unwrap();

        let batch = read_login_databases(&[good, bad.clone()], None).unwrap();
        assert_eq!(batch.credentials.len(), 0);
        assert_eq!(batch.skipped, 1);
        assert_eq!(batch.errors, ["database_unreadable"]);
        assert!(matches!(
            read_login_databases(&[bad], None),
            Err(ImportError::Database)
        ));
    }
}
