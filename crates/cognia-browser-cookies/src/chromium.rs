//! Chromium cookie databases: find, snapshot, read and decrypt.
//!
//! The selected database and its `-wal` / `-shm` / `-journal` companions are
//! copied to an auto-cleaned temporary directory and opened read-only and
//! immutable there, so a running browser's locks never matter (except on
//! Windows, where a running Chromium holds the file exclusively: that is the
//! typed [`ImportError::DatabaseLocked`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use zeroize::Zeroize;

use crate::crypto::{decrypt_value, strip_host_hash, ChromiumKey, Decrypted};
use crate::import::CookieBatch;
use crate::scope::ScopeFilter;
use crate::{ImportError, ImportedCookie, SameSite};

pub use crate::scope::registrable_domain;

pub fn find_cookie_database(profile_dir: &Path) -> Option<PathBuf> {
    [
        profile_dir.join("Network/Cookies"),
        profile_dir.join("Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn classify_copy_error(error: &std::io::Error) -> ImportError {
    // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION: the running browser
    // holds the database exclusively (Chromium on Windows).
    if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) {
        return ImportError::DatabaseLocked;
    }
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => ImportError::PermissionDenied,
        _ => ImportError::Database,
    }
}

/// A database copied aside with its journal companions. The directory (and
/// the copy) disappear when this drops.
pub struct DatabaseSnapshot {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

pub fn snapshot_database(source: &Path) -> Result<DatabaseSnapshot, ImportError> {
    let dir = tempfile::tempdir().map_err(|_| ImportError::Database)?;
    let file_name = source.file_name().ok_or(ImportError::Database)?;
    let destination = dir.path().join(file_name);
    std::fs::copy(source, &destination).map_err(|error| classify_copy_error(&error))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let companion = PathBuf::from(format!("{}{suffix}", source.display()));
        if companion.is_file() {
            let copied = PathBuf::from(format!("{}{suffix}", destination.display()));
            std::fs::copy(companion, copied).map_err(|error| classify_copy_error(&error))?;
        }
    }
    Ok(DatabaseSnapshot {
        _dir: dir,
        path: destination,
    })
}

fn immutable_database_uri(database: &Path) -> Result<String, ImportError> {
    let mut uri = url::Url::from_file_path(database).map_err(|_| ImportError::Database)?;
    uri.set_query(Some("mode=ro&immutable=1"));
    Ok(uri.to_string())
}

/// Open a snapshot read-only and immutable.
pub fn open_immutable(database: &Path) -> Result<Connection, ImportError> {
    Connection::open_with_flags(
        immutable_database_uri(database)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|_| ImportError::Database)
}

pub fn table_columns(
    connection: &Connection,
    table: &str,
) -> Result<BTreeSet<String>, ImportError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| ImportError::Database)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| ImportError::Database)?
        .filter_map(Result::ok)
        .collect();
    Ok(columns)
}

fn chrome_expires_to_unix(expires_utc: i64) -> Option<i64> {
    (expires_utc != 0).then(|| expires_utc / 1_000_000 - 11_644_473_600)
}

/// Chromium's 1601-based microsecond timestamps as Unix milliseconds.
pub fn chrome_time_to_unix_ms(value: i64) -> Option<i64> {
    (value > 0).then(|| value / 1_000 - 11_644_473_600_000)
}

fn same_site_from(value: i64) -> SameSite {
    match value {
        0 => SameSite::None,
        1 => SameSite::Lax,
        2 => SameSite::Strict,
        _ => SameSite::Unspecified,
    }
}

fn database_version(connection: &Connection) -> Result<i64, ImportError> {
    Ok(connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| ImportError::Database)?
        .unwrap_or(0))
}

/// Read every admitted cookie from a snapshot. Rows that fail to decrypt are
/// skipped individually; `v20` rows are counted in `skipped_app_bound`.
/// `key == None` reads only rows stored in plaintext.
pub fn read_cookie_database(
    database: &Path,
    filter: &ScopeFilter,
    key: Option<&ChromiumKey>,
) -> Result<CookieBatch, ImportError> {
    let connection = open_immutable(database)?;
    let db_version = database_version(&connection)?;
    let columns = table_columns(&connection, "cookies")?;
    if columns.is_empty() {
        return Err(ImportError::Database);
    }
    let value_column = if columns.contains("value") {
        "value"
    } else {
        "''"
    };
    let partition_filter = if columns.contains("top_frame_site_key") {
        " WHERE COALESCE(top_frame_site_key, '') = ''"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT host_key,name,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,{value_column} \
             FROM cookies{partition_filter}"
        ))
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
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|_| ImportError::Database)?;

    let mut batch = CookieBatch::default();
    for row in rows {
        let Ok((
            host_key,
            name,
            encrypted,
            path,
            expires_utc,
            secure,
            httponly,
            same_site,
            mut plain,
        )) = row
        else {
            continue;
        };
        if !filter.admits(&host_key) {
            plain.zeroize();
            continue;
        }
        let value = if encrypted.is_empty() {
            std::mem::take(&mut plain)
        } else {
            plain.zeroize();
            let Some(key) = key else {
                continue;
            };
            match decrypt_value(key, &encrypted) {
                Decrypted::AppBound => {
                    batch.skipped_app_bound += 1;
                    continue;
                }
                decrypted => {
                    let Some(mut bytes) = decrypted.take() else {
                        continue;
                    };
                    if db_version >= 24 {
                        match strip_host_hash(bytes, &host_key) {
                            Some(stripped) => bytes = stripped,
                            None => continue,
                        }
                    }
                    match String::from_utf8(bytes) {
                        Ok(value) => value,
                        Err(error) => {
                            error.into_bytes().zeroize();
                            continue;
                        }
                    }
                }
            }
        };
        batch.cookies.push(ImportedCookie {
            host_key,
            name,
            value,
            path,
            expires_unix: chrome_expires_to_unix(expires_utc),
            is_secure: secure != 0,
            is_httponly: httponly != 0,
            same_site: same_site_from(same_site),
        });
    }
    Ok(batch)
}

/// Cookie counts per stored host, read without touching any value.
pub fn cookie_host_counts(database: &Path) -> Result<BTreeMap<String, u32>, ImportError> {
    let connection = open_immutable(database)?;
    let columns = table_columns(&connection, "cookies")?;
    if columns.is_empty() {
        return Err(ImportError::Database);
    }
    let partition_filter = if columns.contains("top_frame_site_key") {
        " WHERE COALESCE(top_frame_site_key, '') = ''"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT host_key, COUNT(*) FROM cookies{partition_filter} GROUP BY host_key"
        ))
        .map_err(|_| ImportError::Database)?;
    let counts = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })
        .map_err(|_| ImportError::Database)?
        .filter_map(Result::ok)
        .collect();
    Ok(counts)
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};

    use crate::crypto::test_support::{encrypt_cbc, encrypt_gcm};
    use crate::crypto::{derive_cbc_key, ChromiumKey};

    pub const SCHEMA: &str = "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
         INSERT INTO meta(key,value) VALUES('version',24);\
         CREATE TABLE cookies(\
           host_key TEXT, name TEXT, value TEXT DEFAULT '', encrypted_value BLOB, path TEXT, expires_utc INTEGER,\
           is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT DEFAULT ''\
         );";

    /// Encrypt `value` the way `key`'s platform stores a v24 cookie.
    pub fn encrypt_cookie(
        key: &ChromiumKey,
        prefix: &[u8],
        host_key: &str,
        value: &str,
    ) -> Vec<u8> {
        let plaintext = [
            Sha256::digest(host_key.as_bytes()).as_slice(),
            value.as_bytes(),
        ]
        .concat();
        match key {
            ChromiumKey::Cbc { v10, v11 } => {
                let key = if prefix == b"v11" { v11.unwrap() } else { *v10 };
                encrypt_cbc(prefix, &key, &plaintext)
            }
            ChromiumKey::Gcm(key) => encrypt_gcm(prefix, key, [4; 12], &plaintext),
        }
    }

    pub fn mac_encrypt(passphrase: &str, host_key: &str, value: &str) -> Vec<u8> {
        let key = derive_cbc_key(passphrase, 1003);
        let plaintext = [
            Sha256::digest(host_key.as_bytes()).as_slice(),
            value.as_bytes(),
        ]
        .concat();
        encrypt_cbc(b"v10", &key, &plaintext)
    }

    pub fn insert(conn: &Connection, host: &str, name: &str, encrypted: &[u8], plain: &str) {
        conn.execute(
            "INSERT INTO cookies(host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite) \
             VALUES(?1,?2,?3,?4,'/',0,1,1,1)",
            rusqlite::params![host, name, plain, encrypted],
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::test_support::*;
    use super::*;
    use crate::crypto::derive_cbc_key;
    use crate::crypto::test_support::encrypt_cbc;
    use crate::scope::CookieScope;

    fn site(domain: &str) -> ScopeFilter {
        ScopeFilter::new(&CookieScope::Site {
            domain: domain.into(),
        })
        .unwrap()
    }

    #[test]
    fn converts_chromium_expirations_and_sessions() {
        assert_eq!(chrome_expires_to_unix(0), None);
        assert_eq!(chrome_expires_to_unix(11_644_473_600_000_000), Some(0));
        assert_eq!(chrome_expires_to_unix(11_644_473_601_500_000), Some(1));
        assert_eq!(chrome_time_to_unix_ms(0), None);
        assert_eq!(chrome_time_to_unix_ms(11_644_473_601_500_000), Some(1_500));
    }

    #[test]
    fn builds_an_encoded_immutable_read_only_database_uri() {
        let uri = immutable_database_uri(Path::new("/tmp/Profile 1/Cookies")).unwrap();
        assert_eq!(uri, "file:///tmp/Profile%201/Cookies?mode=ro&immutable=1");
    }

    #[test]
    fn reads_matching_rows_and_skips_malformed_ciphertext() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
             INSERT INTO meta(key,value) VALUES('version',24);\
             CREATE TABLE cookies(\
               host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,\
               is_secure INTEGER, is_httponly INTEGER, samesite INTEGER\
             );",
        )
        .unwrap();
        let good = mac_encrypt("pass", ".github.com", "secret");
        conn.execute(
            "INSERT INTO cookies VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                ".github.com",
                "session",
                good,
                "/",
                11_644_473_601_000_000_i64,
                1,
                1,
                2
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cookies VALUES('.github.com','broken',x'00','/',0,0,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cookies VALUES('.example.com','other',x'00','/',0,0,0,0)",
            [],
        )
        .unwrap();
        drop(conn);

        let batch = read_cookie_database(
            &db,
            &site("www.github.com"),
            Some(&ChromiumKey::macos("pass")),
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(batch.cookies[0].name, "session");
        assert_eq!(batch.cookies[0].value, "secret");
        assert_eq!(batch.cookies[0].expires_unix, Some(1));
        assert_eq!(batch.cookies[0].same_site, SameSite::Strict);
        assert_eq!(batch.skipped_app_bound, 0);
    }

    #[test]
    fn legacy_databases_have_no_host_hash_prefix() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(&SCHEMA.replace("VALUES('version',24)", "VALUES('version',23)"))
            .unwrap();
        let key = derive_cbc_key("pass", 1003);
        insert(
            &conn,
            ".github.com",
            "legacy",
            &encrypt_cbc(b"v10", &key, b"old"),
            "",
        );
        drop(conn);
        let batch = read_cookie_database(&db, &ScopeFilter::All, Some(&ChromiumKey::macos("pass")))
            .unwrap();
        assert_eq!(batch.cookies[0].value, "old");
    }

    #[test]
    fn skips_partitioned_cookies_in_modern_schemas() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (name, partition) in [("regular", ""), ("partitioned", "https://top.example")] {
            let encrypted = mac_encrypt("pass", ".github.com", name);
            conn.execute(
                "INSERT INTO cookies(host_key,name,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,top_frame_site_key) \
                 VALUES('.github.com',?1,?2,'/',0,1,1,1,?3)",
                rusqlite::params![name, encrypted, partition],
            )
            .unwrap();
        }
        drop(conn);

        let batch = read_cookie_database(
            &db,
            &site("www.github.com"),
            Some(&ChromiumKey::macos("pass")),
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(batch.cookies[0].name, "regular");
        assert_eq!(
            cookie_host_counts(&db).unwrap().get(".github.com"),
            Some(&1)
        );
    }

    #[test]
    fn windows_databases_decrypt_gcm_and_count_app_bound_rows() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let key = ChromiumKey::Gcm([3; 32]);
        insert(
            &conn,
            ".example.com",
            "gcm",
            &encrypt_cookie(&key, b"v10", ".example.com", "v"),
            "",
        );
        insert(
            &conn,
            ".example.com",
            "bound",
            &encrypt_cookie(&key, b"v20", ".example.com", "x"),
            "",
        );
        insert(
            &conn,
            ".example.com",
            "bound2",
            &encrypt_cookie(&key, b"v20", ".example.com", "y"),
            "",
        );
        insert(
            &conn,
            ".other.com",
            "bound3",
            &encrypt_cookie(&key, b"v20", ".other.com", "z"),
            "",
        );
        drop(conn);
        let filter = ScopeFilter::new(&CookieScope::Domains {
            domains: vec!["example.com".into()],
        })
        .unwrap();
        let batch = read_cookie_database(&db, &filter, Some(&key)).unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(batch.cookies[0].value, "v");
        assert_eq!(batch.skipped_app_bound, 2);
    }

    #[test]
    fn linux_databases_mix_v10_v11_and_plaintext_rows() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let key = ChromiumKey::linux(Some("kr"));
        insert(
            &conn,
            "a.com",
            "v10",
            &encrypt_cookie(&key, b"v10", "a.com", "one"),
            "",
        );
        insert(
            &conn,
            "a.com",
            "v11",
            &encrypt_cookie(&key, b"v11", "a.com", "two"),
            "",
        );
        insert(&conn, "a.com", "plain", &[], "three");
        drop(conn);
        let mut values = read_cookie_database(&db, &ScopeFilter::All, Some(&key))
            .unwrap()
            .cookies
            .iter()
            .map(|cookie| cookie.value.clone())
            .collect::<Vec<_>>();
        values.sort();
        assert_eq!(values, ["one", "three", "two"]);
        let plain_only = read_cookie_database(&db, &ScopeFilter::All, None).unwrap();
        assert_eq!(plain_only.cookies.len(), 1);
    }

    #[test]
    fn counts_hosts_without_decrypting() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for host in [".github.com", ".github.com", "api.github.com", "x.org"] {
            insert(&conn, host, "n", b"v10garbage", "");
        }
        drop(conn);
        let counts = cookie_host_counts(&db).unwrap();
        assert_eq!(counts.get(".github.com"), Some(&2));
        assert_eq!(counts.get("api.github.com"), Some(&1));
        assert_eq!(counts.get("x.org"), Some(&1));
    }

    #[test]
    fn a_database_without_a_cookies_table_is_unreadable() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("Cookies");
        Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE other(x);")
            .unwrap();
        assert!(matches!(
            read_cookie_database(&db, &ScopeFilter::All, None),
            Err(ImportError::Database)
        ));
        assert!(matches!(
            cookie_host_counts(&db),
            Err(ImportError::Database)
        ));
    }

    #[test]
    fn locates_network_and_legacy_cookie_databases() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("Default");
        std::fs::create_dir_all(profile.join("Network")).unwrap();
        std::fs::write(profile.join("Cookies"), []).unwrap();
        assert_eq!(
            find_cookie_database(&profile),
            Some(profile.join("Cookies"))
        );
        std::fs::write(profile.join("Network/Cookies"), []).unwrap();
        assert_eq!(
            find_cookie_database(&profile),
            Some(profile.join("Network/Cookies"))
        );
    }

    #[test]
    fn copies_wal_shm_and_journal_companions() {
        let source_dir = tempdir().unwrap();
        let source = source_dir.path().join("Cookies");
        std::fs::write(&source, b"db").unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            std::fs::write(format!("{}{suffix}", source.display()), suffix.as_bytes()).unwrap();
        }
        let snapshot = snapshot_database(&source).unwrap();
        assert_eq!(std::fs::read(&snapshot.path).unwrap(), b"db");
        for suffix in ["-wal", "-shm", "-journal"] {
            assert_eq!(
                std::fs::read(format!("{}{suffix}", snapshot.path.display())).unwrap(),
                suffix.as_bytes()
            );
        }
        let copied = snapshot.path.clone();
        drop(snapshot);
        assert!(!copied.exists());
        assert!(matches!(
            snapshot_database(&source_dir.path().join("missing")),
            Err(ImportError::Database)
        ));
    }

    #[test]
    fn classifies_copy_errors() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(classify_copy_error(&denied), ImportError::PermissionDenied);
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(classify_copy_error(&missing), ImportError::Database);
    }
}
